import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, current, ENGINE_MODES } from '../lib/config.js'
import { AcpTurn, classifyAgentNotice } from '../lib/conversation.js'
import { formatSafeBridgeGuidelines } from '../lib/history.js'
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
