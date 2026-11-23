import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, current, ENGINE_MODES } from '../lib/config.js'
import { AcpTurn, classifyAgentNotice } from '../lib/conversation.js'
import { formatSafeBridgeGuidelines, inputPrompt } from '../lib/history.js'
import { sanitizeChildEnv, STRIPPED_AUTH_ENV_KEYS } from '../lib/preflight.js'
import {
  answerPermission,
  filterToolsForEngineMode,
  isBridgeServerName,
  recordReportedToolCall,
  renderToolSignature,
  renderToolSignatures,
  sanitizeMcpToolArguments,
  stripAgentToolPrefix,
  toBridgeTools,
  validateRequiredToolArguments,
} from '../lib/tool-bridge.js'

const READ_TOOL = {
  name: 'read',
  description: 'Read a file from disk.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      offset: { type: 'number' },
    },
    required: ['file_path'],
  },
}

const RUN_CODE_TOOL = {
  name: 'run_code',
  description: 'Run programmatic tool calling code.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string' },
    },
    required: ['code'],
  },
}

test('Config defaults engineMode to safe-bridge and enables circuitBreakerOn429', () => {
  assert.ok(ENGINE_MODES.includes('safe-bridge'))
  assert.equal(current(Config({}).engineMode), 'safe-bridge')
  assert.equal(current(Config({}).circuitBreakerOn429), true)
  assert.equal(current(Config({}).autoPatch), false)
})

test('sanitizeChildEnv clears ambient Gemini API key and ADC env vars while keeping HOME/proxy', () => {
  const sanitized = sanitizeChildEnv({
    HOME: '/Users/demo',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    GEMINI_API_KEY: 'secret-key',
    GOOGLE_API_KEY: 'secret-google',
    AGY_ADC_AUTH: '1',
    DSH_AGY_LOCAL_KEY: 'local',
  })
  assert.equal(sanitized.HOME, '/Users/demo')
  assert.equal(sanitized.HTTPS_PROXY, 'http://127.0.0.1:7890')
  for (const key of STRIPPED_AUTH_ENV_KEYS) {
    assert.equal(sanitized[key], undefined)
  }
})

test('formatSafeBridgeGuidelines neutralizes third-party persona, discourages brain/ artifacts, and embeds signatures', () => {
  const rawSystem = 'You are an AI agent powered by DeepSeek Harness.\nFollow workspace rules carefully.'
  const sigs = renderToolSignatures([READ_TOOL, RUN_CODE_TOOL])
  const out = formatSafeBridgeGuidelines(rawSystem, sigs, true)
  assert.ok(out.startsWith('<workspace_guidelines>'))
  assert.ok(!out.includes('You are an AI agent powered by'))
  assert.ok(out.includes('Follow workspace rules carefully.'))
  assert.ok(out.includes('brain/'))
  assert.ok(out.includes('read(file_path: string, offset?: number)'))
  assert.ok(out.includes('run_code(code: string)'))
})

test('safe-bridge keeps all DSH tools with antigravity/alwaysLoad metadata', () => {
  const filtered = filterToolsForEngineMode([READ_TOOL, RUN_CODE_TOOL], 'safe-bridge')
  assert.equal(filtered.length, 2)
  const bridged = toBridgeTools(filtered, 'safe-bridge')
  assert.equal(bridged.length, 2)
  assert.equal(bridged[0]._meta['antigravity/alwaysLoad'], true)
})

test('agy 1.5.15+ 8-hex session-scoped MCP tool names are authorized while native and foreign tools are refused', () => {
  assert.equal(isBridgeServerName('dsh'), true)
  assert.equal(isBridgeServerName('dsh_ce1e1556'), true)
  assert.equal(isBridgeServerName('evil_ce1e1556'), false)
  assert.equal(stripAgentToolPrefix('mcp_dsh_ce1e1556_run_code'), 'run_code')
  assert.equal(stripAgentToolPrefix('mcp_dsh_read'), 'read')

  const reportedToolCalls = new Map()
  const conv = { reportedToolCalls }
  const status = recordReportedToolCall(conv, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    name: 'mcp_dsh_ce1e1556_run_code',
    kind: 'other',
  })
  assert.equal(status, 'created')
  assert.equal(reportedToolCalls.get('tc-1')?.serverName, 'dsh')
  assert.equal(reportedToolCalls.get('tc-1')?.toolName, 'run_code')

  const state = {
    sessionId: 'sess-1',
    tenantKey: 'tenant-1',
    turnLive: true,
    engineMode: 'safe-bridge',
    reportedToolCalls,
    advertisedToolNames: new Set(['read', 'run_code']),
  }
  const options = [
    { optionId: 'allow', kind: 'allow_once' },
    { optionId: 'reject', kind: 'reject_once' },
  ]
  const warnings = []
  const port = { hasHandshake: () => true, warn: m => warnings.push(m) }

  // Scoped agy 1.5.15 DSH tool -> allowed once
  const allowed = answerPermission(state, {
    sessionId: 'sess-1',
    toolCall: { toolCallId: 'tc-1', name: 'mcp_dsh_ce1e1556_run_code' },
    options,
  }, port)
  assert.deepEqual(allowed, { outcome: 'selected', optionId: 'allow' })

  // Native agy read_file / write_file -> refused
  recordReportedToolCall(conv, { sessionUpdate: 'tool_call', toolCallId: 'tc-native', name: 'write_file', kind: 'edit' })
  const deniedNative = answerPermission(state, {
    sessionId: 'sess-1',
    toolCall: { toolCallId: 'tc-native', name: 'write_file', title: 'Write file' },
    options,
  }, port)
  assert.deepEqual(deniedNative, { outcome: 'selected', optionId: 'reject' })

  // Foreign MCP server -> refused
  recordReportedToolCall(conv, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-foreign',
    name: 'mcp_evil_ce1e1556_run_code',
    mcpServerName: 'evil_ce1e1556',
    mcpToolName: 'run_code',
  })
  const deniedForeign = answerPermission(state, {
    sessionId: 'sess-1',
    toolCall: { toolCallId: 'tc-foreign', name: 'mcp_evil_ce1e1556_run_code' },
    options,
  }, port)
  assert.deepEqual(deniedForeign, { outcome: 'selected', optionId: 'reject' })
})

test('attempt-1 circuit breaker trips immediately on upstream 429/403/TOS/401 while dropping transient EOF', () => {
  const r429 = classifyAgentNotice('\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): quota\n')
  assert.equal(r429.kind, 'circuit-break')
  assert.equal(r429.code, 'QUOTA')

  const r403 = classifyAgentNotice('⚠ API error (attempt 1): TOS_VIOLATION (code 403): blocked')
  assert.equal(r403.kind, 'circuit-break')
  assert.equal(r403.code, 'QUOTA')

  const r401 = classifyAgentNotice('⚠ API error (attempt 1): UNAUTHENTICATED (code 401): expired')
  assert.equal(r401.kind, 'circuit-break')
  assert.equal(r401.code, 'AUTH')

  const transientEof = classifyAgentNotice('\n⚠ API error (attempt 1): request failed: EOF\n')
  assert.deepEqual(transientEof, { kind: 'drop' })

  let tripped = null
  const turn = new AcpTurn('deadbeef', false, err => { tripped = err })
  turn.onUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): exhausted' },
  })
  assert.ok(tripped !== null)
  assert.equal(tripped.code, 'QUOTA')
  assert.equal(turn.agentFailure?.code, 'QUOTA')

  // When circuitBreakerOn429 is disabled (no callback), 429 retry notice is dropped instead of aborting the turn.
  const disabledTurn = new AcpTurn('feedface', false)
  disabledTurn.onUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): exhausted' },
  })
  assert.equal(disabledTurn.agentFailure, undefined)
  assert.equal(disabledTurn.retryNotices, 1)
})

test('renderToolSignatures omits empty header when all tools are deferred and formats arrays/unions', () => {
  assert.equal(renderToolSignatures([{ ...READ_TOOL, deferLoading: true }]), '')
  const complexTool = {
    name: 'batch_edit',
    description: 'Edit multiple paths.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        mode: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['paths'],
    },
  }
  assert.equal(renderToolSignature(complexTool), 'batch_edit(paths: string[], mode?: string|number)')
})

test('sanitizeMcpToolArguments strips undeclared toolSummary and validateRequiredToolArguments catches missing keys', () => {
  const sanitized = sanitizeMcpToolArguments({ file_path: '/tmp/a.txt', toolSummary: 'Read a.txt' }, READ_TOOL)
  assert.deepEqual(sanitized, { file_path: '/tmp/a.txt' })

  const toolDeclaringSummary = {
    name: 'custom_cmd',
    description: 'Custom command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, toolSummary: { type: 'string' } },
      required: ['command'],
    },
  }
  assert.deepEqual(
    sanitizeMcpToolArguments({ command: 'ls', toolSummary: 'List files' }, toolDeclaringSummary),
    { command: 'ls', toolSummary: 'List files' },
  )

  assert.equal(validateRequiredToolArguments(READ_TOOL, { file_path: '/tmp/a.txt' }), undefined)
  const err = validateRequiredToolArguments(READ_TOOL, { offset: 10 })
  assert.ok(typeof err === 'string' && err.includes('file_path') && err.includes(renderToolSignature(READ_TOOL)))
})

test('safe-bridge end-to-end omits --agent dsh-bridge, keeps systemInstruction untouched, sets enabledTools:[], and mounts eagerMcpServers', async () => {
  const { spawn } = await import('node:child_process')
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { AntigravityRuntime } = await import('../lib/runtime.js')
  const { AntigravityAdapter } = await import('../lib/adapter.js')

  const fake = resolve(fileURLToPath(new URL('./fake-agy.mjs', import.meta.url)))
  const home = mkdtempSync(join(tmpdir(), 'agy-safe-bridge-e2e-'))
  const promptLog = join(home, 'prompts.jsonl')
  const argvs = []
  const sentRpc = []
  const config = {
    provider: 'antigravity',
    displayName: 'Antigravity',
    command: fake,
    home,
    accounts: [{ id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 }],
    contextWindow: 0,
    defaultEffort: 'high',
    autoPatch: false,
    patchScript: '',
    maxLiveSessions: 4,
    idleSessionTtlMs: 600_000,
    parkSettleMs: 50,
    keepAliveMs: 1_000,
    longDecodeContinuations: 3,
    warmup: false,
    quotaTtlMs: 60_000,
    engineMode: 'safe-bridge',
    circuitBreakerOn429: true,
  }
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd, env) => {
      argvs.push([...argv])
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], {
        cwd,
        env: { ...process.env, ...env, FAKE_AGY_LOG: promptLog },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
      const origWrite = child.stdin.write.bind(child.stdin)
      child.stdin.write = (chunk, ...rest) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        for (const line of text.split('\n')) {
          if (line.trim()) {
            try { sentRpc.push(JSON.parse(line)) } catch { /* partial */ }
          }
        }
        return origWrite(chunk, ...rest)
      }
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        exited: new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal }))),
        terminate: () => child.kill('SIGTERM'),
        stderrTail: () => stderr,
      }
    },
    runCommand: async (argv) => {
      if (argv.includes('--version')) return { code: 0, stdout: '1.5.15\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    readImage: async () => undefined,
    canReadImages: () => false,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  const adapter = new AntigravityAdapter(runtime, 'Antigravity', () => false)
  try {
    const chunks = []
    for await (const c of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'safe-s1',
      tools: [READ_TOOL],
      messages: [
        { id: 'sys-1', role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.\nKeep answers concise.' }] },
        { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'hello safe bridge' }] },
      ],
    })) {
      chunks.push(c)
    }
    assert.equal(argvs.length, 1)
    assert.equal(argvs[0].includes('--agent'), false, 'safe-bridge must never pass --agent dsh-bridge')
    const newSession = sentRpc.find(entry => entry.method === 'session/new')
    assert.ok(newSession, 'session/new recorded on stdin wire')
    assert.deepEqual(newSession.params._meta.antigravity.enabledTools, [])
    assert.deepEqual(newSession.params._meta.antigravity.eagerMcpServers, ['dsh'])
    assert.equal(newSession.params._meta.antigravity.systemPrompt, undefined, 'safe-bridge must never mutate systemPrompt')
    const promptReq = sentRpc.find(entry => entry.method === 'session/prompt')
    assert.ok(promptReq, 'session/prompt recorded on stdin wire')
    const combinedPrompt = promptReq.params.prompt.map(b => b.text ?? '').join('')
    assert.ok(combinedPrompt.includes('<workspace_guidelines>'))
    assert.ok(!combinedPrompt.includes('You are an AI agent powered by'))
    assert.ok(combinedPrompt.includes('Keep answers concise.'))
    assert.ok(combinedPrompt.includes('read(file_path: string, offset?: number)'))
    assert.ok(combinedPrompt.includes('hello safe bridge'))
  } finally {
    await runtime.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('PTC follow-up user/developer images are forwarded as real MCP image blocks instead of [image sha256:...] placeholders', async () => {
  const { AntigravityRuntime } = await import('../lib/runtime.js')
  const imgBlock = {
    type: 'image',
    attachment: {
      attachmentId: 'sha256:0cd5cb76bddca406987d009daecaee65f46e09422f88150d9c16eec785ee40bb',
      mediaType: 'image/webp',
      width: 317,
      height: 349,
      bytes: 14262,
    },
  }
  const fakeBase64 = Buffer.from('fake-webp-bytes').toString('base64')
  const readImage = async () => ({ data: fakeBase64, mimeType: 'image/webp' })

  // 1. inputPrompt preserves image blocks in tool/developer messages too
  const promptBlocks = await inputPrompt([
    {
      id: 'dev-1',
      role: 'developer',
      content: [
        { type: 'text', text: '<path>/tmp/image.webp</path>' },
        imgBlock,
      ],
    },
  ], readImage)
  assert.ok(promptBlocks.some(b => b.type === 'image' && b.data === fakeBase64 && b.mimeType === 'image/webp'))
  assert.ok(!promptBlocks.some(b => b.type === 'text' && b.text.includes('[image sha256:')))

  // 2. deliverResults forwards images from PTC follow-up user messages into MCP BridgeToolResult
  const runtime = new AntigravityRuntime({
    config: {
      provider: 'antigravity',
      displayName: 'Antigravity',
      command: '',
      home: '',
      accounts: [],
      contextWindow: 0,
      defaultEffort: 'high',
      autoPatch: false,
      patchScript: '',
      maxLiveSessions: 4,
      idleSessionTtlMs: 600_000,
      parkSettleMs: 50,
      keepAliveMs: 1_000,
      longDecodeContinuations: 3,
      warmup: false,
      quotaTtlMs: 60_000,
      engineMode: 'safe-bridge',
      circuitBreakerOn429: true,
    },
    spawnAcp: () => { throw new Error('unused') },
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    readImage,
    canReadImages: () => true,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  try {
    const turn = new AcpTurn('ptcimg01', false)
    let resolvedResult = null
    turn.pendingCalls.set('call-ptc-1', {
      id: 'call-ptc-1',
      name: 'run_code',
      argumentsJson: '{}',
      result: { resolve: value => { resolvedResult = value }, reject: () => undefined },
    })
    const conv = {
      turn,
      engineMode: 'safe-bridge',
      advertisedToolNames: new Set(['run_code']),
      knownTools: new Map([['run_code', 'h']]),
      reportedToolCalls: new Map(),
    }
    const messages = [
      {
        id: 't-1',
        role: 'tool',
        toolCallId: 'call-ptc-1',
        content: [{ type: 'text', text: '{"path":"/Users/raphael/Downloads/image.webp"}' }],
      },
      {
        id: 'u-ptc-1',
        role: 'user',
        content: [
          { type: 'text', text: '<path>/Users/raphael/Downloads/image.webp</path>\n<type>image</type>' },
          imgBlock,
        ],
      },
    ]
    const delivered = await runtime.deliverResults(conv, { layout: { geminiDir: '/tmp' } }, messages, {}, [])
    assert.equal(delivered, true)
    assert.ok(resolvedResult !== null)
    const imageItems = resolvedResult.content.filter(item => item.type === 'image')
    assert.equal(imageItems.length, 1, 'MCP tool result must carry the resolved image block')
    assert.deepEqual(imageItems[0], { type: 'image', data: fakeBase64, mimeType: 'image/webp' })
    const allText = resolvedResult.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
    assert.ok(!allText.includes('[image sha256:'), 'must not leak [image sha256:...] placeholder text when image was resolved')
    assert.ok(allText.includes('/Users/raphael/Downloads/image.webp'))
  } finally {
    await runtime.dispose()
  }
})

test('deliverResults preserves interleaved PTC images, tolerates readImage failures, and wires circuit breaker on fallback turns', async () => {
  const { AntigravityRuntime } = await import('../lib/runtime.js')
  const imgBlock = {
    type: 'image',
    attachment: {
      attachmentId: 'sha256:aaaa1111bbbb2222',
      mediaType: 'image/png',
      width: 64,
      height: 64,
      bytes: 512,
    },
  }
  const fakeBase64 = Buffer.from('png-bytes').toString('base64')
  let shouldThrow = false
  const runtime = new AntigravityRuntime({
    config: {
      provider: 'antigravity',
      displayName: 'Antigravity',
      command: '',
      home: '',
      accounts: [],
      contextWindow: 0,
      defaultEffort: 'high',
      autoPatch: false,
      patchScript: '',
      maxLiveSessions: 4,
      idleSessionTtlMs: 600_000,
      parkSettleMs: 50,
      keepAliveMs: 1_000,
      longDecodeContinuations: 3,
      warmup: false,
      quotaTtlMs: 60_000,
      engineMode: 'safe-bridge',
      circuitBreakerOn429: true,
    },
    spawnAcp: () => { throw new Error('unused') },
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    readImage: async () => {
      if (shouldThrow) throw new Error('ENOENT attachment missing')
      return { data: fakeBase64, mimeType: 'image/png' }
    },
    canReadImages: () => true,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  try {
    // 1. Interleaved PTC user image between two concurrent tool calls is preserved
    const turn1 = new AcpTurn('interlv1', false)
    const resolved = new Map()
    for (const id of ['c1', 'c2']) {
      turn1.pendingCalls.set(id, {
        id,
        name: 'run_code',
        argumentsJson: '{}',
        result: { resolve: value => resolved.set(id, value), reject: () => undefined },
      })
    }
    const conv1 = {
      key: 'k1',
      sessionId: 'sess-1',
      turn: turn1,
      engineMode: 'safe-bridge',
      advertisedToolNames: new Set(['run_code']),
      knownTools: new Map([['run_code', 'h']]),
      reportedToolCalls: new Map(),
      promptGen: 0,
      promptSettled: Promise.resolve(),
    }
    const ok1 = await runtime.deliverResults(conv1, { layout: { geminiDir: '/tmp' } }, [
      { id: 't1', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '{"ok":1}' }] },
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'ptc image between c1 and c2' }, imgBlock] },
      { id: 't2', role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: '{"ok":2}' }] },
    ], {}, [])
    assert.equal(ok1, true)
    assert.ok(resolved.get('c2')?.content.some(item => item.type === 'image' && item.data === fakeBase64))

    // 2. Throwing readImage degrades gracefully instead of leaving parked calls unresolved
    shouldThrow = true
    const turn2 = new AcpTurn('errimg01', false)
    let resolved2 = null
    turn2.pendingCalls.set('c3', {
      id: 'c3',
      name: 'read_image',
      argumentsJson: '{}',
      result: { resolve: value => { resolved2 = value }, reject: () => undefined },
    })
    const conv2 = {
      key: 'k2',
      sessionId: 'sess-2',
      turn: turn2,
      engineMode: 'safe-bridge',
      advertisedToolNames: new Set(['read_image']),
      knownTools: new Map([['read_image', 'h']]),
      reportedToolCalls: new Map(),
    }
    const ok2 = await runtime.deliverResults(conv2, { layout: { geminiDir: '/tmp' } }, [
      { id: 't3', role: 'tool', toolCallId: 'c3', content: [imgBlock] },
    ], {}, [])
    assert.equal(ok2, true)
    assert.ok(resolved2?.content.some(item => item.type === 'text' && item.text.includes('unavailable')))

    // 3. Fallback path (turn.finished === true) forwards images AND attaches 429 circuit breaker
    shouldThrow = false
    const turn3 = new AcpTurn('fallbk01', false)
    turn3.finished = true
    turn3.pendingCalls.set('c4', {
      id: 'c4',
      name: 'run_code',
      argumentsJson: '{}',
      result: { resolve: () => undefined, reject: () => undefined },
    })
    const cancelled = []
    let sentBlocks = null
    const fakeProc = {
      cancel: sid => cancelled.push(sid),
      prompt: async (_sid, blocks) => { sentBlocks = blocks; return { stopReason: 'end_turn' } },
    }
    const conv3 = {
      key: 'k3',
      sessionId: 'sess-3',
      turn: turn3,
      engineMode: 'safe-bridge',
      advertisedToolNames: new Set(['run_code']),
      knownTools: new Map([['run_code', 'h']]),
      reportedToolCalls: new Map(),
      promptGen: 0,
      promptSettled: Promise.resolve(),
    }
    const ok3 = await runtime.deliverResults(conv3, { layout: { geminiDir: '/tmp' } }, [
      { id: 't4', role: 'tool', toolCallId: 'c4', content: [{ type: 'text', text: '{"ok":4}' }] },
      { id: 'u4', role: 'user', content: [imgBlock] },
    ], fakeProc, [])
    assert.equal(ok3, true)
    assert.ok(Array.isArray(sentBlocks) && sentBlocks.some(b => b.type === 'image' && b.data === fakeBase64))
    conv3.turn.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): quota' },
    })
    assert.deepEqual(cancelled, ['sess-3'], 'fallback AcpTurn must still trigger 429 circuit breaker')
  } finally {
    await runtime.dispose()
  }
})

test('safe-bridge stages oversized workspace_guidelines, history, and in-history system updates across <= BRIDGE_TEXT_BYTES turns', async () => {
  const { spawn } = await import('node:child_process')
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { AntigravityRuntime } = await import('../lib/runtime.js')
  const { AntigravityAdapter } = await import('../lib/adapter.js')
  const { BRIDGE_TEXT_BYTES } = await import('../lib/history.js')

  const fake = resolve(fileURLToPath(new URL('./fake-agy.mjs', import.meta.url)))
  const home = mkdtempSync(join(tmpdir(), 'agy-safe-bridge-stage-'))
  const promptLog = join(home, 'prompts.jsonl')
  const readPrompts = () => readFileSync(promptLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

  const runtime = new AntigravityRuntime({
    config: {
      provider: 'antigravity',
      displayName: 'Antigravity',
      command: fake,
      home,
      accounts: [{ id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 }],
      contextWindow: 0,
      defaultEffort: 'high',
      autoPatch: false,
      patchScript: '',
      maxLiveSessions: 4,
      idleSessionTtlMs: 600_000,
      parkSettleMs: 50,
      keepAliveMs: 1_000,
      longDecodeContinuations: 3,
      warmup: false,
      quotaTtlMs: 60_000,
      engineMode: 'safe-bridge',
      circuitBreakerOn429: true,
    },
    spawnAcp: (argv, cwd, env) => {
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], {
        cwd,
        env: { ...process.env, ...env, FAKE_AGY_LOG: promptLog, FAKE_AGY_ACK_TEXT: 'ACK.' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        exited: new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal }))),
        terminate: () => child.kill('SIGTERM'),
        stderrTail: () => stderr,
      }
    },
    runCommand: async (argv) => argv.includes('--version')
      ? { code: 0, stdout: '1.5.15\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
    readImage: async () => undefined,
    canReadImages: () => false,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  const adapter = new AntigravityAdapter(runtime, 'Antigravity', () => false)
  const collect = async (iter) => {
    const out = []
    for await (const c of iter) out.push(c)
    return out
  }
  try {
    // 1. Brand-new safe-bridge session with >187KB system prompt and tiny user input (zero history)
    const hugeSystem = `HEADER_RULE\n${'interface ToolA { x: string }\n'.repeat(7500)}FOOTER_RULE`
    assert.ok(Buffer.byteLength(hugeSystem, 'utf8') > BRIDGE_TEXT_BYTES)
    const chunks1 = await collect(adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'stage-fresh',
      tools: [READ_TOOL],
      messages: [
        { id: 'sys-1', role: 'system', content: [{ type: 'text', text: hugeSystem }] },
        { id: 'u-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'LIVE_Q_1' }] },
      ],
    }))
    assert.equal(chunks1.at(-1).reason.kind, 'stop')
    const p1 = readPrompts()
    assert.ok(p1.length >= 2, 'oversized guidelines must be staged across multiple prompts')
    assert.ok(p1.every(entry => Buffer.byteLength(entry.text, 'utf8') <= BRIDGE_TEXT_BYTES), 'every ACP prompt stays within BRIDGE_TEXT_BYTES')
    const allText1 = p1.map(entry => entry.text).join('\n')
    assert.ok(allText1.includes('HEADER_RULE') && allText1.includes('FOOTER_RULE'))
    assert.ok(p1.at(-1).text.includes('LIVE_Q_1'))
    assert.ok(!p1.slice(0, -1).some(entry => entry.text.includes('LIVE_Q_1')), 'live user prompt stays on final answering turn')

    // 2. Rebuilt session with >100KB guidelines + >210KB history + >190KB in-history system update + small user/plugin input
    const beforeCount2 = p1.length
    const sys1 = `OLD_SYS_START\n${'a'.repeat(104_000)}\nOLD_SYS_END`
    const sys2 = `NEW_SYS_START\n${'b'.repeat(190_000)}\nNEW_SYS_END`
    const histBody = `HIST_START\n${'🟢中文'.repeat(25_000)}\nHIST_END`
    const chunks2 = await collect(adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'stage-rebuild',
      tools: [READ_TOOL],
      messages: [
        { id: 's1', role: 'system', content: [{ type: 'text', text: sys1 }] },
        { id: 'u-hist', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: histBody }] },
        { id: 'a-hist', role: 'assistant', source: { kind: 'model', provider: 'antigravity' }, content: [{ type: 'text', text: 'done turn 1' }] },
        { id: 's2', role: 'system', content: [{ type: 'text', text: sys2 }] },
        { id: 'u-2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'LIVE_Q_2' }] },
        { id: 'p-2', role: 'user', source: { kind: 'plugin:dsh-claude-compat', form: 'hook-context' }, content: [{ type: 'text', text: '全程用简体中文' }] },
      ],
    }))
    assert.equal(chunks2.at(-1).reason.kind, 'stop')
    const p2 = readPrompts().slice(beforeCount2)
    assert.ok(p2.length >= 4, '422KB+ rebuild must stage into multiple <= BRIDGE_TEXT_BYTES prompts')
    assert.ok(p2.every(entry => Buffer.byteLength(entry.text, 'utf8') <= BRIDGE_TEXT_BYTES))
    const allText2 = p2.map(entry => entry.text).join('\n')
    assert.ok(allText2.includes('OLD_SYS_START') && allText2.includes('OLD_SYS_END'))
    assert.ok(allText2.includes('HIST_START') && allText2.includes('HIST_END'))
    assert.ok(allText2.includes('NEW_SYS_START') && allText2.includes('NEW_SYS_END'))
    assert.ok(p2.at(-1).text.includes('LIVE_Q_2'))
    assert.ok(p2.at(-1).text.includes('全程用简体中文'))

    // 3. Incremental warm turn with oversized in-history system update (>190KB) keeps session alive and stages update
    const beforeCount3 = readPrompts().length
    const warmSession = p2.at(-1).session
    const sys3 = `WARM_SYS_START\n${'c'.repeat(190_000)}\nWARM_SYS_END`
    const chunks3 = await collect(adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'stage-rebuild',
      tools: [READ_TOOL],
      messages: [
        { id: 's1', role: 'system', content: [{ type: 'text', text: sys1 }] },
        { id: 'u-hist', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: histBody }] },
        { id: 'a-hist', role: 'assistant', source: { kind: 'model', provider: 'antigravity' }, content: [{ type: 'text', text: 'done turn 1' }] },
        { id: 's2', role: 'system', content: [{ type: 'text', text: sys2 }] },
        { id: 'u-2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'LIVE_Q_2' }] },
        { id: 'p-2', role: 'user', source: { kind: 'plugin:dsh-claude-compat', form: 'hook-context' }, content: [{ type: 'text', text: '全程用简体中文' }] },
        { id: 'a-2', role: 'assistant', source: { kind: 'model', provider: 'antigravity' }, content: [{ type: 'text', text: 'turn 2 ok' }] },
        { id: 's3', role: 'system', content: [{ type: 'text', text: sys3 }] },
        { id: 'u-3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'LIVE_Q_3' }] },
      ],
    }))
    assert.equal(chunks3.at(-1).reason.kind, 'stop')
    const p3 = readPrompts().slice(beforeCount3)
    assert.ok(p3.length >= 2)
    assert.ok(p3.every(entry => entry.session === warmSession), 'warm incremental turn must stay in same ACP session')
    assert.ok(p3.every(entry => Buffer.byteLength(entry.text, 'utf8') <= BRIDGE_TEXT_BYTES))
    assert.ok(p3.map(e => e.text).join('\n').includes('WARM_SYS_START'))
    assert.ok(p3.at(-1).text.includes('LIVE_Q_3'))

    // 4. Oversized human user message itself still rejects immediately with CONTEXT_WINDOW_EXCEEDED and zero prompts sent
    const beforeCount4 = readPrompts().length
    await assert.rejects(collect(adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      sessionId: 'stage-over-user',
      messages: [
        { id: 's-small', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }] },
        { id: 'u-big', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '猫'.repeat(66_000) }] },
      ],
    })), { code: 'CONTEXT_WINDOW_EXCEEDED' })
    assert.equal(readPrompts().length, beforeCount4, 'oversized human user message must not call the model')
  } finally {
    await runtime.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('receiveHistory classifies non-ACK prose as TRANSPORT even if reply mentions context or rate limit', async () => {
  const { spawn } = await import('node:child_process')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { AntigravityRuntime } = await import('../lib/runtime.js')
  const { AntigravityAdapter } = await import('../lib/adapter.js')

  const fake = resolve(fileURLToPath(new URL('./fake-agy.mjs', import.meta.url)))
  const home = mkdtempSync(join(tmpdir(), 'agy-non-ack-'))
  const runtime = new AntigravityRuntime({
    config: {
      provider: 'antigravity',
      displayName: 'Antigravity',
      command: fake,
      home,
      accounts: [{ id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 }],
      contextWindow: 0,
      defaultEffort: 'high',
      autoPatch: false,
      patchScript: '',
      maxLiveSessions: 4,
      idleSessionTtlMs: 600_000,
      parkSettleMs: 50,
      keepAliveMs: 1_000,
      longDecodeContinuations: 3,
      warmup: false,
      quotaTtlMs: 60_000,
      engineMode: 'safe-bridge',
      circuitBreakerOn429: true,
    },
    spawnAcp: (argv, cwd, env) => {
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], {
        cwd,
        env: { ...process.env, ...env, FAKE_AGY_ACK_TEXT: 'Understood, retained the context without hitting rate limit.' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        exited: new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal }))),
        terminate: () => child.kill('SIGTERM'),
        stderrTail: () => stderr,
      }
    },
    runCommand: async (argv) => argv.includes('--version')
      ? { code: 0, stdout: '1.5.15\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
    readImage: async () => undefined,
    canReadImages: () => false,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  const adapter = new AntigravityAdapter(runtime, 'Antigravity', () => false)
  try {
    await assert.rejects(async () => {
      for await (const _ of adapter.stream({
        provider: 'antigravity',
        model: 'gemini-4-argon',
        sessionId: 'bad-ack',
        messages: [
          { id: 'sys', role: 'system', content: [{ type: 'text', text: 'S'.repeat(210_000) }] },
          { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
        ],
      })) { /* drain */ }
    }, error => error.code === 'TRANSPORT' && error.message.includes('History fragment was not acknowledged'))
  } finally {
    await runtime.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
