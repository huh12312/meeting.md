// Minimal Chrome DevTools Protocol driver for poking the Electron renderer.
//   node cdp.mjs shot out.png | eval '<js>' | text | click '<visible text>' | fill '<placeholder substr>' '<value>'
import fs from 'node:fs';
import { createRequire } from 'node:module';

const WebSocket = createRequire(new URL('../server/package.json', import.meta.url))('ws');
const port = process.env.CDP_PORT || 9333;
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
const page =
  targets.find((t) => t.type === 'page' && !t.url.includes('widget')) || targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.on('open', resolve));

let id = 0;
const pending = new Map();
ws.on('message', (data) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    pending.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};

const label = `(e) => (e.innerText || e.getAttribute('aria-label') || e.title || '').trim()`;
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(a, Buffer.from(r.result.data, 'base64'));
} else if (cmd === 'eval') {
  console.log(JSON.stringify(await evaluate(a)));
} else if (cmd === 'text') {
  console.log(await evaluate('document.body.innerText.slice(0, 2500)'));
} else if (cmd === 'click') {
  console.log(
    await evaluate(`(() => {
      const label = ${label};
      const want = ${JSON.stringify(a)}.toLowerCase();
      const els = [...document.querySelectorAll('button, a, [role=button], [role=switch], [role=tab]')].filter((e) => e.offsetParent !== null);
      const el = els.find((e) => label(e).toLowerCase() === want) || els.find((e) => label(e).toLowerCase().includes(want));
      if (!el) return 'NOT FOUND among: ' + els.map((e) => label(e).slice(0, 30)).filter(Boolean).join(' | ');
      el.click();
      return 'clicked ' + label(el).slice(0, 40);
    })()`)
  );
} else if (cmd === 'fill') {
  console.log(
    await evaluate(`(() => {
      const inputs = [...document.querySelectorAll('input, textarea')];
      const el = inputs.find((e) => (e.placeholder + ' ' + e.name + ' ' + e.type).toLowerCase().includes(${JSON.stringify(a)}.toLowerCase()));
      if (!el) return 'NOT FOUND: ' + inputs.map((e) => e.placeholder || e.name || e.type).join(' | ');
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(b)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled ' + (el.placeholder || el.name);
    })()`)
  );
}
ws.close();
