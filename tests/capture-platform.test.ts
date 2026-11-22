import test from 'node:test';
import assert from 'node:assert/strict';
import { getRecordingPlatformSupport } from '../src/main/lib/capture-platform';

test('supports every target shipped by videodb/capture', () => {
  assert.equal(getRecordingPlatformSupport('darwin', 'arm64').supported, true);
  assert.equal(getRecordingPlatformSupport('darwin', 'x64').supported, true);
  assert.equal(getRecordingPlatformSupport('win32', 'x64').supported, true);
});

test('rejects targets without a capture binary', () => {
  const windowsArm = getRecordingPlatformSupport('win32', 'arm64');
  assert.equal(windowsArm.supported, false);
  assert.match(windowsArm.reason ?? '', /win32-arm64/);
});

test('supports Linux through the capture-linux helper', () => {
  assert.equal(getRecordingPlatformSupport('linux', 'x64').supported, true);
  assert.equal(getRecordingPlatformSupport('linux', 'arm64').supported, true);
});
