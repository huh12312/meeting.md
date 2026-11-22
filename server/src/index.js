import http from 'node:http';
import { config } from './config.js';
import { run, now } from './db.js';
import { handle, authenticate, reapAbandonedSessions } from './api.js';
import { handleUpgrade } from './ws.js';
import { shutdown } from './media.js';
import { llmDescription } from './llm.js';

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[api] unhandled', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'Internal error' }));
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const owner = url.pathname === '/ws' && authenticate(url.searchParams.get('token') || req.headers['x-access-token']);
  if (!owner) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  handleUpgrade(req, socket, head, owner);
});

// A restart loses the ffmpeg workers, so anything still marked live is over.
run("UPDATE sessions SET status = 'stopped', stopped_at = ? WHERE status IN ('active', 'stopping')", now());
run('UPDATE segments SET ended_at = started_at WHERE ended_at IS NULL');

setInterval(reapAbandonedSessions, 30000).unref();
setInterval(() => run('DELETE FROM tokens WHERE expires_at < ?', now()), 3600000).unref();

server.listen(config.port, config.host, () => {
  console.log(`meeting-md-server listening on ${config.host}:${config.port} (public ${config.publicUrl})`);
  console.log(`  RTSP publish ${config.rtspPublishUrl}, read ${config.rtspInternalUrl}`);
  console.log(`  LLM ${llmDescription()}\n  STT ${config.stt.baseUrl || 'NOT CONFIGURED'}`);
  if (config.generatedKey) console.log(`  API key (enter this in the app): ${config.generatedKey}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await shutdown();
    process.exit(0);
  });
}
