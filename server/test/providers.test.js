import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

process.env.DATA_DIR = fs.mkdtempSync('/tmp/mmd-test-');
process.env.LLM_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'test-key';

// A stand-in for api.anthropic.com that records the request and streams back
// whatever `reply` holds, in Messages API server-sent-event framing.
let seen;
let reply;
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  seen = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
  if (reply.status) {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: reply.message } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: seen.body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  reply.content.forEach((block, index) => {
    if (block.type === 'text') {
      event('content_block_start', { index, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'thinking') {
      event('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      event('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
    } else {
      event('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    event('content_block_stop', { index });
  });
  event('message_delta', { delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: 7 } });
  event('message_stop', {});
  res.end();
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
test.after(() => upstream.close());

const { forwardChatCompletion } = await import('../src/llm.js');
const { toPrompt } = await import('../src/providers/claude-code.js');

const weatherTool = { type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };

test('anthropic: tier name, system prompt, sampling and token floor are translated', async () => {
  reply = { content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' };
  const res = await forwardChatCompletion({
    model: 'ultra', temperature: 0.7, max_tokens: 4096,
    messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }],
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.choices[0].message.content, 'hello');
  assert.equal(json.choices[0].finish_reason, 'stop');
  assert.deepEqual(json.usage, { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 });

  assert.equal(seen.body.model, 'claude-opus-5-5');
  assert.equal(seen.body.system, 'Be brief.');
  assert.equal(seen.body.max_tokens, 16000);
  assert.equal(seen.body.temperature, undefined);
  assert.deepEqual(seen.body.output_config, { effort: 'medium' });
  assert.equal(seen.body.fallbacks, 'default');
  assert.match(seen.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(seen.body.stream, true);
});

test('anthropic: tool calls round-trip, replaying the thinking block unchanged', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
  reply = { content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }], stop_reason: 'tool_use' };
  const first = await (await forwardChatCompletion({ model: 'pro', tools: [weatherTool], tool_choice: 'auto', messages: [{ role: 'user', content: 'Weather in Paris?' }] })).json();
  const call = first.choices[0].message.tool_calls[0];
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(JSON.parse(call.function.arguments), { city: 'Paris' });
  assert.deepEqual(seen.body.tools, [{ name: 'get_weather', description: 'Weather', input_schema: weatherTool.function.parameters }]);
  assert.equal(seen.body.tool_choice, undefined);

  reply = { content: [{ type: 'text', text: 'Sunny.' }], stop_reason: 'end_turn' };
  await forwardChatCompletion({
    model: 'pro', tools: [weatherTool],
    messages: [
      { role: 'user', content: 'Weather in Paris?' },
      first.choices[0].message,
      { role: 'tool', tool_call_id: call.id, content: '{"temp":21}' },
    ],
  });
  const [, assistant, results] = seen.body.messages;
  assert.equal(assistant.content[0].type, 'thinking');
  assert.equal(assistant.content[0].signature, 'sig-abc');
  assert.equal(assistant.content[1].type, 'tool_use');
  assert.deepEqual(results, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp":21}' }] });
});

test('anthropic: images, JSON mode and streaming responses', async () => {
  reply = { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' };
  const res = await forwardChatCompletion({
    model: 'basic', stream: true, response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] }],
  });
  assert.match(res.headers.get('content-type'), /event-stream/);
  const sse = await res.text();
  assert.match(sse, /"content":"\{\\"ok\\":true\}"/);
  assert.match(sse, /data: \[DONE\]/);
  assert.deepEqual(seen.body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  assert.match(seen.body.system, /single valid JSON object/);
});

test('anthropic: refusals and upstream errors map to OpenAI shapes', async () => {
  reply = { content: [], stop_reason: 'refusal' };
  const refused = await (await forwardChatCompletion({ model: 'ultra', messages: [{ role: 'user', content: 'x' }] })).json();
  assert.equal(refused.choices[0].finish_reason, 'content_filter');

  reply = { status: 400, message: 'bad thing' };
  const res = await forwardChatCompletion({ model: 'ultra', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /bad thing/);

  reply = { status: 401, message: 'invalid x-api-key' };
  assert.equal((await forwardChatCompletion({ model: 'ultra', messages: [{ role: 'user', content: 'x' }] })).status, 502);
});

test('claude-code: prompt, transcript, images and tool schema', () => {
  const single = toPrompt({ messages: [{ role: 'system', content: 'Sys' }, { role: 'user', content: 'Hello' }] });
  assert.equal(single.system, 'Sys');
  assert.deepEqual(single.content, [{ type: 'text', text: 'Hello' }]);
  assert.equal(single.schema, null);

  const multi = toPrompt({
    tools: [weatherTool],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Weather?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '21C' },
    ],
  });
  assert.equal(multi.useTools, true);
  assert.deepEqual(multi.schema.properties.tool_calls.items.properties.name.enum, ['get_weather']);
  assert.match(multi.system, /get_weather: Weather/);
  assert.equal(multi.content[0].type, 'image');
  assert.match(multi.content[1].text, /<tool result \(call_1\)>\n21C/);
  assert.match(multi.content[1].text, /called get_weather \(call_1\)/);
});
