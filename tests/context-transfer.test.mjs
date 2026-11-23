
import assert from 'node:assert/strict'
import test from 'node:test'
import { inputPrompt, partitionBridgePrompt, prepareBridgeInput, promptTextBytes, replayPrompt, splitReplay, splitSystem } from '../lib/history.js'

const block = { type: 'plugin-fixture', data: { file: 'C:\\a b\\DEMO_01', flag: false } }
const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const noImage = async () => undefined
const text = blocks => blocks.map(b => b.text).join('')

test('cold handoff partitions only the supplied history and preserves the complete live turn', async () => {
  const history = [user('summary','CHECKPOINT'), { role:'tool', id:'r', toolCallId:'call-1', content:[{type:'text',text:'🟢中文'.repeat(13000)+'END_RESULT'}] }]
  const live = [user('next','盲测问题')]
  const blocks = await replayPrompt(history,live,noImage)
  blocks.push({type:'image',data:'w6k=',mimeType:'image/png'})
  const limit = 1023
  const { parts, final } = splitReplay(blocks,true,limit)
  assert.ok(parts.length>1)
  const prefix = parts[0].slice(0,parts[0].indexOf('<dsh_history>'))
  assert.ok(prefix.length>0)
  assert.ok(parts.every(str=>str.startsWith(prefix) && Buffer.byteLength(str)<=limit))
  assert.equal(parts.map(str=>str.slice(prefix.length)).join('')+text(final.filter(b=>b.type==='text')),text(blocks.filter(b=>b.type==='text')))
  assert.deepEqual(final.at(-1),blocks.at(-1))
  assert.ok(!parts.some(str=>str.includes('盲测问题')))
  assert.ok(Buffer.byteLength(text(final.filter(b=>b.type==='text')))<=limit)
  assert.deepEqual(splitReplay(blocks,false,limit),{parts:[],final:blocks})
  assert.deepEqual(splitReplay(blocks,true,2_000_000),{parts:[],final:blocks})
})

test('a rebuilt conversation carries the full replacement prefix and large tool output', async () => {
  const history = [user('ck', 'CHECKPOINT-A'), { id: 'result', role: 'tool', toolCallId: 'tool-1', content: [{ type: 'text', text: 'B'.repeat(195000) + 'END_RESULT' }] }]
  const wire = text(await replayPrompt(history, [user('live','NEXT')], noImage))
  assert.ok(wire.includes('CHECKPOINT-A'))
  assert.ok(wire.includes('B'.repeat(195000) + 'END_RESULT'))
  assert.ok(wire.endsWith('NEXT'))
})

test('an unknown role and content survive in DSH order on new input and replay', async () => {
  const extension = { id: 'new', role: 'extension-data', content: [block] }
  const messages = [user('u','USER_FIRST'), extension, user('v','USER_LAST')]
  for (const wire of [text(await inputPrompt(messages,noImage)),text(await replayPrompt(messages,[],noImage))]) {
    assert.ok(wire.includes(JSON.stringify(block)))
    assert.ok(wire.includes(extension.role))
    assert.ok(wire.indexOf('USER_FIRST') < wire.indexOf(block.type))
    assert.ok(wire.indexOf(block.type) < wire.indexOf('USER_LAST'))
  }
})

test('a structured extension in a system or known provider message is preserved once', async () => {
  for (const msg of [{role:'system'}, {role:'user',source:{kind:'agent-instructions'}}]) {
    const split = splitSystem({ messages: [{ ...msg, id:'s', content:[{ type:'text',text:'RULE'},block] }] })
    const wire = split.system + text(await inputPrompt(split.messages,noImage))
    assert.equal(wire.split(JSON.stringify(block)).length,2)
    assert.equal(wire.split('RULE').length,2)
  }
})

test('assistant text around a historical tool call keeps its position', async () => {
  const history = [{id:'a',role:'assistant',content:[{type:'text',text:'BEFORE'}, {type:'tool-call',id:'call1',name:'read',arguments:'{}'},block,{type:'text',text:'AFTER'}]}]
  const wire = text(await replayPrompt(history,[],noImage))
  const order = ['BEFORE','call1',block.type,'AFTER'].map(x=>wire.indexOf(x))
  assert.ok(order.every((x,i)=>x>=0 && (i===0 || x>order[i-1])))
})

test('partitionBridgePrompt stages multi-segment guidelines and history safely on UTF-8 boundaries', () => {
  const limit = 1024
  const seg1 = { kind: 'context', text: `<workspace_guidelines>\n${'规则line\n'.repeat(80)}</workspace_guidelines>\n\n` }
  const seg2 = { kind: 'history', text: `<dsh_history>\n${'🟢中文'.repeat(200)}\n</dsh_history>\n\n` }
  const live = [{ type: 'text', text: 'FINAL_Q' }, { type: 'image', data: 'w6k=', mimeType: 'image/png' }]
  const { parts, final } = partitionBridgePrompt([seg1, seg2], live, limit)
  assert.ok(parts.length >= 2)
  assert.ok(parts.every(part => Buffer.byteLength(part, 'utf8') <= limit))
  assert.ok(promptTextBytes(final) <= limit)
  assert.deepEqual(final.at(-1), live[1])
  assert.ok(final.some(block => block.type === 'text' && block.text.includes('FINAL_Q')))
  assert.ok(!parts.some(part => part.includes('FINAL_Q')))

  // Multi-segment case where each segment individually fits inside capacity while combined exceeds limit
  const fitSeg1 = { kind: 'context', text: 'A'.repeat(600) }
  const fitSeg2 = { kind: 'history', text: 'B'.repeat(600) }
  const res = partitionBridgePrompt([fitSeg1, fitSeg2], [{ type: 'text', text: 'LIVE' }], 1024)
  assert.equal(res.parts.length, 1)
  assert.ok(res.parts[0].includes('A'.repeat(600)))
  assert.ok(promptTextBytes(res.final) <= 1024)
  assert.ok(res.final.some(b => b.type === 'text' && b.text.includes('B'.repeat(600))))

  // Oversized live input returns no staged parts so caller can reject without calling the model
  const over = partitionBridgePrompt([fitSeg1], [{ type: 'text', text: 'X'.repeat(1500) }], 1024)
  assert.equal(over.parts.length, 0)
})

test('prepareBridgeInput separates leading and oversized trailing stageable context from human input', async () => {
  const emptyDev = { id: 'e', role: 'developer', content: [] }
  const sys = { id: 's', role: 'system', content: [{ type: 'text', text: 'SYS_BODY' }] }
  const human = user('u', 'HUMAN_Q')
  const bigPlugin = { id: 'p', role: 'user', source: { kind: 'plugin:test' }, content: [{ type: 'text', text: 'P'.repeat(2000) }] }
  const res = await prepareBridgeInput([sys, human, bigPlugin], noImage, { limit: 1024 })
  assert.ok(res.stageableText.includes('<system_update>\nSYS_BODY\n</system_update>'))
  assert.ok(res.stageableText.includes('P'.repeat(2000)))
  assert.equal(text(res.liveBlocks), 'HUMAN_Q')

  // Empty-content stageable messages must not inject a spurious 'Continue.' text
  const emptyRes = await prepareBridgeInput([emptyDev, human], noImage, { limit: 1024 })
  assert.equal(emptyRes.stageableText, '')
  assert.equal(text(emptyRes.liveBlocks), 'HUMAN_Q')
})
