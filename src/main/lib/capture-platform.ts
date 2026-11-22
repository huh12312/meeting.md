/**
 * Platforms with a capture binary: the SDK's own for macOS and Windows, and the
 * `capture-linux` helper (installed by scripts/install-linux-capture.js) for Linux.
 */

const SUPPORTED_TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']);

export function getRecordingPlatformSupport(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): { supported: boolean; reason?: string } {
  const target = `${platform}-${arch}`;
  if (SUPPORTED_TARGETS.has(target)) return { supported: true };

  return {
    supported: false,
    reason:
      `Recording is not available on ${target}. The installed VideoDB capture SDK ` +
      `supports ${[...SUPPORTED_TARGETS].join(', ')}.`,
  };
}
