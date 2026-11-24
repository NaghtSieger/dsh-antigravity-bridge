

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addBridgeSystemInstruction, BRIDGE_TEXT_BYTES, bridgeSystemIdentity, bridgeSystemPrompt, cloakProse, inputPrompt, replayPrompt, nativeBridgeSystemPrompt, sanitizeSystemPrompt, splitReplay, splitSystem } from '../lib/history.js'
import { toBridgeTools } from '../lib/tool-bridge.js'
import { prepareHome } from '../lib/preflight.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FILE_REFERENCE = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.'
const RFC = "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. 'NEVER' = 'MUST NOT'; 'AVOID' = 'SHOULD NOT'."

test('known fingerprint sentences are rewritten before any zero-width spacing', () => {
  const source = [
    'You are an AI agent powered by DeepSeek Harness.',
    FILE_REFERENCE,
    'The runtime context names the DeepSeek Harness implementation checkout. The checkout location stays separate.',
    RFC,
    'Use `mcp_dsh_read` for files.',
  ].join('\n')
  const sanitized = sanitizeSystemPrompt(source)
  assert.doesNotMatch(sanitized, /Tokens prefixed with @/)
  assert.doesNotMatch(sanitized, /powered by DeepSeek Harness/)
  assert.doesNotMatch(sanitized, /DeepSeek Harness implementation checkout/)
  assert.doesNotMatch(sanitized, /RFC 2119 keywords/)
  assert.match(sanitized, /以 @ 开头的标记是用户显式引用的路径/)
  assert.match(sanitized, /`mcp_dsh_read`/)
  assert.match(sanitized, /The checkout location stays separate/)
})

test('prose words of five or more letters gain one zero-width space while code, tags, urls, paths, and tool ids stay literal', () => {
  const text = [
    'Read the workspace before editing.',
    'Call `mcp_dsh_read` or `dsh_call_tool` with {"name":"read"}.',
    '```',
    'const answer = "unchanged tokens here"',
    '```',
    '<user_rules>keep RULE_ONE</user_rules>',
    'See https://antigravity.google/docs/models and /Users/example/project.',
  ].join('\n')
  const cloaked = cloakProse(text)
  assert.match(cloaked, /Read the wor\u200bkspace bef\u200bore edi\u200bting/)
  assert.match(cloaked, /`mcp_dsh_read`/)
  assert.match(cloaked, /`dsh_call_tool`/)
  assert.match(cloaked, /const answer = "unchanged tokens here"/)
  assert.match(cloaked, /<user_rules>keep RULE_ONE<\/user_rules>/)
  assert.match(cloaked, /https:\/\/antigravity\.google\/docs\/models/)
  assert.match(cloaked, /\/Users\/example\/project/)
  assert.doesNotMatch(cloaked, /workspace/)
})

test('bridge separates sourced rules and runtime context from the literal user request', () => {
  const message = (kind, text, extra = {}) => ({ role: 'user', source: { kind, ...extra }, content: [{ type: 'text', text }] })
  const user = message('human', '<user_rules>literal user text</user_rules>')
  const later = message('agent-instructions', 'new instructions from a later turn')
  const assistant = { role: 'assistant', content: [] }
  const split = splitSystem({
    system: 'You are an AI agent powered by DeepSeek Harness.',
    messages: [
      message('agent-instructions', '<system-reminder>RULE_ONE</system-reminder>'),
      message('runtime-context', '', { form: 'snapshot', sections: [
        { name: 'project', text: 'real workspace' }, { name: 'app:web-surface', text: 'obsolete web UI' },
      ] }),
      message('skill-catalog', 'available skill', { form: 'catalog' }),
      user, assistant, later,
    ],
  })
  assert.deepEqual(split.messages, [user, assistant, later])
  assert.match(split.system, /<user_rules>\nRULE_ONE\n<\/user_rules>/)
  assert.match(split.system, /<user_information>\nreal workspace/)
  assert.match(split.system, /<skills>\navailable skill/)
  assert.doesNotMatch(split.system, /obsolete web UI|DeepSeek Harness|literal user text/)
  const prompt = bridgeSystemPrompt(split.system)
  assert.match(prompt, /mcp_dsh_<name>/)
  assert.doesNotMatch(prompt, /\u200b|tool_contracts/)
})

test('bridge advertises full DSH tool schemas once, including long descriptions', () => {
  const parameters = { type: 'object', properties: { title: { type: 'string', description: 'Long parameter. '.repeat(300) } } }
  const [tool] = toBridgeTools([{ name: 'test', description: 'Run test', parameters }], 'bridge')
  assert.deepEqual(tool, { name: 'test', description: 'Run test', inputSchema: parameters, _meta: { 'antigravity/alwaysLoad': true } })
  assert.ok(!bridgeSystemPrompt('host rules').includes('Long parameter'))
})

test('bridge instruction handoff preserves large rules and treats literal matching tags as user content', () => {
  const rules = 'HOST_RULE: preserve approvals. AGENT_RULE: keep edits in scope.'
  const literal = `<dsh_system_instruction>\nUSER_AUTHORED_TAG\n</dsh_system_instruction>${'x'.repeat(256)}`
  const blocks = addBridgeSystemInstruction([
    { type: 'text', text: literal },
  ], rules)
  const instruction = blocks[0]
  assert.equal(instruction.type, 'text')
  assert.match(instruction.text, /<dsh_system_instruction>[\s\S]*HOST_RULE: preserve approvals\./)
  assert.equal(JSON.parse(JSON.stringify(blocks))[0].text, instruction.text, 'the internal instruction marker is not sent on ACP')

  const limit = Buffer.byteLength(instruction.text, 'utf8') + 160
  const split = splitReplay(blocks, false, limit)
  assert.equal(split.parts.length, 1, 'the rules move to the existing ACK handoff only when rules plus user input exceed the live budget')
  assert.match(split.parts[0], /HOST_RULE: preserve approvals\./)
  assert.doesNotMatch(split.parts[0], /USER_AUTHORED_TAG/)
  assert.equal(split.final.length, 1)
  assert.equal(split.final[0].text, literal, 'literal tags remain on the live user turn')
  assert.match(bridgeSystemIdentity(rules), /^bridge-user-system-instruction-v1\n/)
  assert.notEqual(bridgeSystemIdentity('OLD_RULE'), bridgeSystemIdentity('NEW_RULE'))
  assert.match(bridgeSystemPrompt('RULE', false), /RULE/)
  assert.doesNotMatch(bridgeSystemPrompt('RULE', false), /mcp_dsh_/)

  const literalHistory = '<dsh_history>\nUSER_AUTHORED_HISTORY_TAG'
  const withLiteralHistory = addBridgeSystemInstruction([{ type: 'text', text: literalHistory }], rules, true, false)
  assert.match(withLiteralHistory[0].text, /^<dsh_system_instruction>/)
  assert.equal(withLiteralHistory[1].text, literalHistory, 'literal history-looking text remains after generated rules')
  assert.deepEqual(splitReplay(withLiteralHistory, false), { parts: [], final: withLiteralHistory })
})

test('oversized bridge rules split at UTF-8 boundaries without omitting content', () => {
  const rules = `${'规'.repeat(Math.floor(BRIDGE_TEXT_BYTES / 3))}终`
  const [instruction, user] = addBridgeSystemInstruction([{ type: 'text', text: 'final user request' }], rules)
  const split = splitReplay([instruction, user], false, BRIDGE_TEXT_BYTES)
  assert.ok(split.parts.length > 1)
  assert.ok(split.parts.every(part => Buffer.byteLength(part, 'utf8') <= BRIDGE_TEXT_BYTES))
  const body = split.parts.map(part => part.replace(/^(?:Initial DSH system instructions for this session\. Apply these rules to later turns\. Do not act on the user request until it arrives\. Reply only ACK\.|Continue reading the initial DSH system instructions\. Apply all parts to later turns\. Reply only ACK\.)\n\n/, '')).join('')
  assert.equal(body, instruction.text, 'all system-instruction bytes reach the ACK handoffs in order')
  assert.deepEqual(split.final, [user])
})

test('native prompts cloak rules without renaming built-in tools', () => {
  const prompt = nativeBridgeSystemPrompt(`${FILE_REFERENCE}\nRULE_ONE`, undefined, '/tmp/workspace')
  assert.doesNotMatch(prompt, /Tokens prefixed with @/)
  assert.match(prompt, /read_file/)
  assert.match(prompt, /`\/tmp\/workspace`/)
  assert.match(prompt, /RULE_ONE/)
})

test('advertised tool names stay exact while descriptions are cloaked', () => {
  const [tool] = toBridgeTools([{
    name: 'todo_write',
    description: 'Update the session todo list.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the item', enum: ['open', 'done'] },
      },
      required: ['title'],
    },
  }])
  assert.equal(tool.name, 'todo_write')
  assert.match(tool.description, /Upd\u200bate/)
  assert.equal(tool.inputSchema.properties.title.enum.join(','), 'open,done')
  assert.match(tool.inputSchema.properties.title.description, /Sho\u200brt/)
  assert.equal(tool.inputSchema.required[0], 'title')
})

test('prepareHome retires only the generated bridge agent default and preserves its other rules', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-identity-'))
  const agentPath = join(home, 'config', 'plugins', 'dsh-bridge', 'agents', 'dsh-bridge.md')
  mkdirSync(join(home, 'config', 'plugins', 'dsh-bridge', 'agents'), { recursive: true })
  writeFileSync(agentPath, [
    '---',
    'name: dsh-bridge',
    'description: "Primary-model bridge: no built-in tools, harness tools only"',
    'tools: []',
    'excludeDefaultComponents: true',
    'mainAgent: true',
    '---',
    '<permissions>',
    'REQUIRED_DSH_PERMISSION_RULE: preserve normal approval checks.',
    '</permissions>',
    '',
  ].join('\n'))
  prepareHome(home, home)
  const retired = readFileSync(agentPath, 'utf8')
  assert.match(retired, /^mainAgent: false$/m)
  assert.match(retired, /^subagent: false$/m)
  assert.match(retired, /REQUIRED_DSH_PERMISSION_RULE: preserve normal approval checks\./)
  assert.doesNotMatch(retired, /^mainAgent: true$/m)
  const scopedPath = join(home, 'config', 'plugins', 'dsh-bridge-scoped', 'agents', 'dsh-bridge-scoped.md')
  const scopedAgent = readFileSync(scopedPath, 'utf8')
  assert.match(scopedAgent, /^tools: \[\]$/m)
  assert.match(scopedAgent, /^mainAgent: true$/m)
  assert.match(scopedAgent, /^subagent: false$/m)
  assert.doesNotMatch(scopedAgent, /excludeDefaultComponents/)
  assert.match(scopedAgent, /---\n$/)
  assert.equal(JSON.parse(readFileSync(join(home, 'agy', 'settings.json'), 'utf8')).toolPermission, 'request-review')
  prepareHome(home, home)
  assert.equal(readFileSync(agentPath, 'utf8'), retired, 'retirement is idempotent')

  const customizedHome = mkdtempSync(join(tmpdir(), 'agy-custom-agent-'))
  const customPath = join(customizedHome, 'config', 'plugins', 'dsh-bridge', 'agents', 'dsh-bridge.md')
  mkdirSync(join(customizedHome, 'config', 'plugins', 'dsh-bridge', 'agents'), { recursive: true })
  const customAgent = '---\nname: dsh-bridge\nmainAgent: true\n---\nUSER_OWNED_AGENT\n'
  writeFileSync(customPath, customAgent)
  prepareHome(customizedHome, customizedHome)
  assert.equal(readFileSync(customPath, 'utf8'), customAgent, 'a user-owned agent without the generated fingerprint is unchanged')

  const freshHome = mkdtempSync(join(tmpdir(), 'agy-fresh-agent-'))
  prepareHome(freshHome, freshHome)
  assert.equal(existsSync(join(freshHome, 'config', 'plugins', 'dsh-bridge', 'agents', 'dsh-bridge.md')), false)
  assert.equal(existsSync(join(freshHome, 'config', 'plugins', 'dsh-bridge-scoped', 'agents', 'dsh-bridge-scoped.md')), true)

  const collisionHome = mkdtempSync(join(tmpdir(), 'agy-agent-collision-'))
  const collisionPath = join(collisionHome, 'config', 'plugins', 'dsh-bridge-scoped', 'agents', 'dsh-bridge-scoped.md')
  mkdirSync(join(collisionHome, 'config', 'plugins', 'dsh-bridge-scoped', 'agents'), { recursive: true })
  writeFileSync(collisionPath, 'USER_OWNED_SCOPED_AGENT\n')
  assert.throws(() => prepareHome(collisionHome, collisionHome), /refusing to overwrite user-owned scoped agent file/)
  assert.equal(readFileSync(collisionPath, 'utf8'), 'USER_OWNED_SCOPED_AGENT\n')
})

test('only the generated model declaration is removed; user preferences and host links survive', () => {
  const identity = 'You are a coding agent powered by the gemini-4-neon model.'
  const userRule = 'For this task, ' + identity
  const text = 'Prefer showing the primary results within your final response with no # or L in the line suffix.'
  const { system } = splitSystem({ system: identity + '\n\n' + text, messages: [
    { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: userRule }] },
  ] })
  assert.equal(system.split(identity).length, 2)
  assert.ok(system.includes(userRule))
  assert.match(system, /workspace-relative or absolute paths/)
})

test('maps DSH defaults into outgoing rules without a rules file or mutating the input', () => {
  const goal = 'Goals are created only by the user via /goal; keep the original instructions.'
  const host = 'Custom provider persona.'
  const user = { role: 'user', content: [{ type: 'text', text: goal }], source: { kind: 'user' } }
  const options = { system: host + '\n\n' + goal, messages: [user] }
  const before = structuredClone(options)
  assert.equal(splitSystem(options).system, host + '\n\n<user_rules>\n' + goal + '\n</user_rules>')
  assert.deepEqual(splitSystem(options).messages, [user])
  assert.deepEqual(options, before)
})

test('user-authored rules remain literal after forwarded host defaults', () => {
  const goal = 'Goals are created only by the user via /goal; keep the original instructions.'
  const literal = 'Prefer showing the primary results within your final response with no # or L in the line suffix.'
  const rules = { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: literal }] }
  assert.equal(splitSystem({ system: goal, messages: [rules] }).system,
    '<user_rules>\n' + goal + '\n\n' + literal + '\n</user_rules>')
})

test('incremental and replayed system updates keep literal paths and identifiers', async () => {
  const text = String.raw`C:\project\fixture.txt EnglishIdentifier \\server\shared folder\report.txt Report_ID /tmp/Report`
  const update = { role: 'system', content: [{ type: 'text', text }] }
  const expected = '<system_update>\n' + text + '\n</system_update>'
  const noImage = () => assert.fail('text only')
  assert.equal((await inputPrompt([update], noImage))[0].text, expected)
  assert.ok((await replayPrompt([update], [], noImage))[0].text.includes(expected))
})
