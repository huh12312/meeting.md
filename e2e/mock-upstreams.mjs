// Stand-ins for the STT and LLM endpoints so the pipeline can be tested offline.
import http from 'node:http';
let utterance = 0;
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/audio/transcriptions')) {
    return res.end(JSON.stringify({ text: `mock utterance ${++utterance} (${body.length} bytes)` }));
  }
  if (req.url.endsWith('/chat/completions')) {
    const json = JSON.parse(body.toString());
    const hasImage = JSON.stringify(json.messages).includes('image_url');
    const content = hasImage ? 'mock scene: a test card' : `mock reply from ${json.model}`;
    if (json.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: json.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
  res.statusCode = 404; res.end('{}');
}).listen(9911, process.env.MOCK_HOST || '127.0.0.1', () => console.log('mock upstreams on 9911'));
