import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AcpTurn, classifyAgentNotice, reportsUpstreamAuthOrPolicy } from '../lib/conversation.js'
import { resolveAgyBinary, sanitizeChildEnv, STRIPPED_AUTH_ENV_KEYS } from '../lib/preflight.js'
import { mapError } from '../lib/runtime.js'

test('sanitizeChildEnv clears ambient Gemini API key and ADC env vars while preserving HOME and proxy', () => {
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

test('resolveAgyBinary finds ~/.antigravity/bin/agy on darwin/linux when PATH is empty', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-resolve-'))
  try {
    const binDir = join(fakeHome, '.antigravity', 'bin')
    mkdirSync(binDir, { recursive: true })
    const fakeBin = join(binDir, 'agy')
    writeFileSync(fakeBin, '#!/bin/sh\n')
    const resolved = resolveAgyBinary('', { platform: 'darwin', env: { PATH: '' }, home: fakeHome })
    assert.equal(resolved, fakeBin)
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

test('explicit 401/403/TOS notices cancel immediately without disturbing ordinary 429 or transient EOF', () => {
  assert.equal(reportsUpstreamAuthOrPolicy('UNAUTHENTICATED (code 401): expired'), true)
  assert.equal(reportsUpstreamAuthOrPolicy('401 Unauthorized: expired'), true)
  assert.equal(reportsUpstreamAuthOrPolicy('403 Forbidden: blocked'), true)
  assert.equal(reportsUpstreamAuthOrPolicy('TOS_VIOLATION (code 403): blocked'), true)
  assert.equal(reportsUpstreamAuthOrPolicy('RESOURCE_EXHAUSTED (code 429): rate limited'), false)

  const v429 = classifyAgentNotice('⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Too Many Requests\n')
  assert.equal(v429.kind, 'rate-retry')

  const v401 = classifyAgentNotice('⚠ API error (attempt 1): 401 Unauthorized trace_id=tr-401\n')
  assert.equal(v401.kind, 'auth-policy-retry')

  const v403 = classifyAgentNotice('⚠ API error (attempt 1): TOS_VIOLATION (code 403): please sign in again trace_id=tr-403\n')
  assert.equal(v403.kind, 'auth-policy-retry')

  const vEof = classifyAgentNotice('⚠ API error (attempt 1): request failed: EOF\n')
  assert.equal(vEof.kind, 'drop')

  const turn = new AcpTurn('auth403t', false)
  let cancelled = 0
  let delivered = null
  turn.cancelRateRetry = () => { cancelled++ }
  turn.onRateRetry = msg => { delivered = msg }
  turn.onUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '⚠ API error (attempt 1): TOS_VIOLATION (code 403): please sign in again trace_id=tr-403\n' },
  })
  assert.equal(cancelled, 1)
  assert.equal(turn.upstreamRateLimited, false, '403 policy rejection must not set upstreamRateLimited')
  assert.equal(turn.upstreamPolicyAborted, true, '403 policy rejection must set upstreamPolicyAborted')
  assert.ok(typeof delivered === 'string' && delivered.includes('TOS_VIOLATION'))
  assert.equal(turn.agentFailure?.code, 'PERMISSION_DENIED')
  assert.equal(turn.agentFailure?.failure.status, 403)
  assert.equal(turn.agentFailure?.failure.requestId, 'tr-403')

  const mapped401 = mapError(new Error('401 Unauthorized: token expired trace_id=tr-401'))
  assert.equal(mapped401.code, 'AUTH')
  assert.equal(mapped401.failure.status, 401)
  assert.equal(mapped401.failure.requestId, 'tr-401')

  const mapped403 = mapError(new Error('403 PERMISSION_DENIED: please sign in with an eligible account trace_id=tr-403'))
  assert.equal(mapped403.code, 'PERMISSION_DENIED')
  assert.equal(mapped403.failure.status, 403)
  assert.equal(mapped403.failure.requestId, 'tr-403')
})

test('tool-result continuation keeps pending 401/403 policy abort and never starts a second prompt', async () => {
  const { AntigravityRuntime } = await import('../lib/runtime.js')
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
      engineMode: 'bridge',
    },
    spawnAcp: () => { throw new Error('unused') },
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    readImage: async () => undefined,
    canReadImages: () => false,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  try {
    const turn = new AcpTurn('pol403c1', false)
    turn.pendingCalls.set('call-1', {
      id: 'call-1',
      name: 'read',
      argumentsJson: '{}',
      result: { resolve: () => undefined, reject: () => undefined },
    })
    turn.onUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '⚠ API error (attempt 1): 403 Forbidden trace_id=tr-late\n' },
    })
    assert.equal(turn.finished, true)
    assert.equal(turn.upstreamPolicyAborted, true)
    let promptCalls = 0
    const fakeProc = {
      prompt: async () => { promptCalls++; return { stopReason: 'end_turn' } },
      cancel: () => undefined,
    }
    const conv = {
      key: 'k-pol',
      sessionId: 'sess-pol',
      turn,
      engineMode: 'bridge',
      advertisedToolNames: new Set(['read']),
      knownTools: new Map([['read', 'h']]),
      reportedToolCalls: new Map(),
      promptGen: 0,
      promptSettled: Promise.resolve(),
    }
    const delivered = await runtime.deliverResults(conv, { layout: { geminiDir: '/tmp' } }, [
      { id: 't1', role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }] },
    ], fakeProc, [])
    assert.equal(delivered, true)
    assert.equal(promptCalls, 0, 'must never start a second ACP prompt after 401/403 policy abort')
  } finally {
    await runtime.dispose()
  }
})
