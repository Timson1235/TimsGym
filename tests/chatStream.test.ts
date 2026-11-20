import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChatStream } from '../src/lib/chatStream';

const encode = (events: unknown[]) => ': heartbeat\r\n\r\n' + events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
function response(text: string, size = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i=0; i<bytes.length; i+=size) controller.enqueue(bytes.slice(i,i+size));
    controller.close();
  } }));
}

test('decodes split UTF-8, arbitrary chunks and returns final actions', async () => {
  const events: unknown[] = [];
  const result = await readChatStream(response(encode([
    {type:'status',message:'Checking…'}, {type:'delta',text:'Übung 🏋️'},
    {type:'final',result:{reply:'Übung 🏋️',actionsExecuted:[{type:'set_logged'}]}},
  ])), (e) => events.push(e));
  assert.equal(result.reply, 'Übung 🏋️');
  assert.equal(result.actionsExecuted[0].type,'set_logged');
  assert.deepEqual(events, [{type:'status',message:'Checking…'},{type:'delta',text:'Übung 🏋️'}]);
});

test('forwards resets before replacement-provider text', async () => {
  const events: unknown[] = [];
  await readChatStream(response(encode([
    {type:'delta',text:'Partial'}, {type:'reset'}, {type:'delta',text:'Replacement'},
    {type:'final',result:{reply:'Replacement'}},
  ]), 13), (e) => events.push(e));
  assert.equal((events[1] as any).type, 'reset');
});

test('missing completion or server error rejects instead of retrying a mutation', async () => {
  await assert.rejects(readChatStream(response(encode([{type:'delta',text:'Partial'}])), () => {}), /before the coach confirmed/);
  await assert.rejects(readChatStream(response(encode([{type:'error',message:'Check workout before retrying'}])), () => {}), /Check workout/);
});
