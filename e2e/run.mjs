// Drives the real `videodb` SDK (the code Call.md runs) against the self-hosted
// server, with the Linux capture helper publishing synthetic media.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { connect } = require('videodb');
const { CaptureClient } = require('videodb/capture');

const baseUrl = process.env.API_URL || 'http://localhost:8080';
const apiKey = process.env.API_KEY;
const seconds = Number(process.env.SECONDS || 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name) => console.log(`\n== ${name}`);

step('auth + collections');
await assert.rejects(connect({ apiKey: 'wrong', baseUrl }).getCollection(), 'bad key must be rejected');
const conn = connect({ apiKey, baseUrl });
const def = await conn.getCollection();
let coll = (await conn.getCollections()).find((c) => c.name === 'call.md Recordings');
coll ||= await conn.createCollection('call.md Recordings', 'Meeting recordings from Call.md app', false);
console.log('default', def.id, 'recordings', coll.id);

step('session token + sockets');
const sessionToken = await conn.generateClientToken(3600);
const client = connect({ sessionToken, baseUrl });
const open = async () => (await client.connectWebsocket()).connect();
const [micWs, sysWs, screenWs] = await Promise.all([open(), open(), open()]);
console.log('ws ids', micWs.connectionId, sysWs.connectionId, screenWs.connectionId);
const events = { mic: [], sys: [], screen: [] };
micWs.onMessage((m) => { events.mic.push(m); console.log('  [mic]', JSON.stringify(m)); });
sysWs.onMessage((m) => { events.sys.push(m); console.log('  [sys]', JSON.stringify(m)); });
screenWs.onMessage((m) => { events.screen.push(m); console.log('  [screen]', JSON.stringify(m)); });

step('capture session');
const session = await coll.createCaptureSession({ endUserId: 'e2e', metadata: { name: 'E2E test call' } });
console.log('session', session.id);

const capture = new CaptureClient({ sessionToken, apiUrl: baseUrl });
capture.on('recording:started', (p) => console.log('  event recording:started', p));
capture.on('recording:stopped', (p) => console.log('  event recording:stopped', p));
capture.on('recording:error', (p) => console.log('  event recording:error', p));
const channels = await capture.listChannels();
console.log(String(channels));
const wanted = [channels.mics.default, channels.systemAudio.default, channels.displays.default].filter(Boolean);
await capture.startSession({
  sessionId: session.id,
  channels: wanted.map((c) => ({ channelId: c.id, type: c.type, record: true })),
});

step('wait for rtstreams, start transcription + visual index');
let full;
for (let i = 0; i < 30; i++) {
  full = await conn.getCaptureSession(session.id, coll.id);
  await full.refresh();
  if (full.rtstreams.length === wanted.length) break;
  await sleep(500);
}
console.log('status', full.status, full.rtstreams.map((r) => `${r.channelId}=${r.id}`).join(' '));
const mic = full.rtstreams.find((r) => (r.channelId || '').startsWith('mic'));
const sys = full.getRTStream('system_audio')[0] || full.rtstreams.find((r) => (r.channelId || '').startsWith('system_audio'));
const screen = full.rtstreams.find((r) => (r.channelId || '').includes('display'));
await mic.startTranscript(micWs.connectionId);
if (sys) await sys.startTranscript(sysWs.connectionId);
let sceneIndex;
if (screen) {
  sceneIndex = await screen.indexVisuals({ batchConfig: { type: 'time', value: 5, frameCount: 1 }, prompt: 'Describe the screen.', socketId: screenWs.connectionId });
  console.log('scene index', sceneIndex.rtstreamIndexId, (await screen.listSceneIndexes()).length);
}

step(`recording for ${seconds}s (pause/resume mic midway)`);
await sleep((seconds * 1000) / 2);
await capture.pauseTracks(['mic']);
await sleep(2000);
await capture.resumeTracks(['mic']);
await sleep((seconds * 1000) / 2);

step('stop + export');
if (sceneIndex) await sceneIndex.stop();
await capture.stopSession();
await capture.shutdown();
let videoId;
for (let i = 0; i < 60 && !videoId; i++) {
  const s = await conn.getCaptureSession(session.id, coll.id);
  await s.refresh();
  videoId = s.exportedVideoId;
  if (!videoId) await sleep(1000);
}
assert.ok(videoId, 'session was exported');
const video = await coll.getVideo(videoId);
console.log('video', video.id, 'length', video.length, '\n  stream', video.streamUrl, '\n  player', video.playerUrl);

step('post-call API');
const text = await video.getTranscriptText();
console.log('transcript:', text.slice(0, 200));
console.log('index:', await video.indexSpokenWords());
console.log('download:', await video.download('e2e'));
console.log('generateText:', await coll.generateText('Summarise.', 'ultra'));
const chat = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ model: 'ultra', messages: [{ role: 'user', content: 'hi' }] }),
}).then((r) => r.json());
console.log('chat:', chat.choices[0].message.content);
const head = await fetch(video.streamUrl, { headers: { range: 'bytes=0-99' } });
console.log('media range:', head.status, head.headers.get('content-range'));
console.log('player page:', (await fetch(video.playerUrl.replace('/watch', '/embed'))).status);

step('summary');
const count = (list, ch) => list.filter((m) => m.channel === ch).length;
console.log({ micTranscripts: count(events.mic, 'transcript'), sysTranscripts: count(events.sys, 'transcript'), scenes: count(events.screen, 'scene_index') });
assert.ok(count(events.mic, 'transcript') > 0, 'mic transcripts arrived');
assert.ok(head.status === 206);
await Promise.all([micWs.close(), sysWs.close(), screenWs.close()]);
console.log('\nE2E OK');
process.exit(0);
