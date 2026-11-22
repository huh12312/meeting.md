/**
 * The `videodb` SDK only downloads capture binaries for macOS and Windows.
 * On Linux, drop the capture-linux helper into the slot the SDK looks in
 * (node_modules/videodb/bin/capture) so recording works there too.
 */
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'linux') process.exit(0);

const source = process.env.MEETING_MD_CAPTURE_DIR || path.join(__dirname, '..', '..', 'capture-linux');
const target = path.join(__dirname, '..', 'node_modules', 'videodb', 'bin');

if (!fs.existsSync(path.join(source, 'capture'))) {
  console.warn(`[install-linux-capture] ${source}/capture not found; recording will be unavailable`);
  process.exit(0);
}

fs.mkdirSync(target, { recursive: true });
for (const file of ['capture', 'portal-screencast.py']) {
  fs.copyFileSync(path.join(source, file), path.join(target, file));
  fs.chmodSync(path.join(target, file), 0o755);
}
console.log(`[install-linux-capture] installed capture helper into ${target}`);
