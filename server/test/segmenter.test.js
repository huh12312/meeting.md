import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = (await import('node:fs')).mkdtempSync('/tmp/mmd-test-');
const { Segmenter, SAMPLE_RATE, wav, collapseRepeats } = await import('../src/stt.js');

const tone = (ms, amplitude) => {
  const samples = (SAMPLE_RATE * ms) / 1000;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(i / 5)), i * 2);
  return pcm;
};
const collect = (...chunks) => {
  const segments = [];
  const segmenter = new Segmenter((segment) => segments.push(segment));
  for (const chunk of chunks) segmenter.push(chunk);
  segmenter.flush();
  return segments;
};

test('silence produces no utterances', () => {
  assert.equal(collect(tone(5000, 0)).length, 0);
});

test('a short pause does not split an utterance, a long one does', () => {
  const joined = collect(tone(1000, 8000), tone(800, 0), tone(1000, 8000), tone(3000, 0));
  assert.equal(joined.length, 1);
  const split = collect(tone(1000, 8000), tone(2000, 0), tone(1000, 8000), tone(3000, 0));
  assert.equal(split.length, 2);
  assert.ok(split[1].start > split[0].end - 0.01);
});

test('continuous speech is cut at the maximum segment length', () => {
  const segments = collect(tone(40000, 8000));
  assert.ok(segments.length >= 2);
  assert.ok(segments.every((segment) => segment.end - segment.start <= 15.1));
});

test('clicks shorter than the minimum speech length are dropped', () => {
  assert.equal(collect(tone(2000, 0), tone(100, 8000), tone(3000, 0)).length, 0);
});

test('wav wraps PCM in a 44-byte header', () => {
  const out = wav(Buffer.alloc(320));
  assert.equal(out.length, 364);
  assert.equal(out.toString('ascii', 0, 4), 'RIFF');
  assert.equal(out.readUInt32LE(24), SAMPLE_RATE);
});

test('collapseRepeats removes Whisper loops and leaves normal speech alone', () => {
  assert.equal(
    collapseRepeats('three times. So you get to try out the whiteboard. So you get to try out the whiteboard. So you get to try out the whiteboard. So you get'),
    'three times. So you get to try out the whiteboard. So you get'
  );
  assert.equal(collapseRepeats('no no no no thanks'), 'no thanks');
  assert.equal(collapseRepeats('yeah yeah, that is that'), 'yeah yeah, that is that');
  assert.equal(collapseRepeats('We agreed on the budget and the budget is fixed.'), 'We agreed on the budget and the budget is fixed.');
  assert.equal(collapseRepeats(''), '');
});
