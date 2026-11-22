/**
 * tools/jank-check.mjs —— 检查"锁定页是不是每帧都在重绘"。
 * 统计 #overlay-host / #page 的直接子节点替换次数，以及关键元素是否被重建。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9499;
const PROFILE = path.join(os.tmpdir(), `foxtick-${Date.now()}`);
const BASE = process.argv[2] || 'http://127.0.0.1:7317';
const TARGET = process.argv[3] || `${BASE}/?preview=locked&ms=1800000`;

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = [];
    let id = 0;
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        on(fn) {
          listeners.push(fn);
        },
      }),
    );
    ws.addEventListener('error', () => reject(new Error('ws fail')));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else for (const fn of listeners) fn(m);
    });
  });
}

for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
  } catch {}
  await sleep(200);
}

const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=430,932', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 80; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
  } catch {}
  await sleep(200);
}
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const cdp = await connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const ev = async (expression, awaitPromise = false) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await cdp.send('Page.navigate', { url: TARGET });
await sleep(1500);
await ev(`new Promise((res) => { if (window.__fox) return res(true);
  const t = setInterval(() => { if (window.__fox) { clearInterval(t); res(true); } }, 40); setTimeout(() => res(false), 8000); })`, true);

const install = await ev(`(() => {
  const oh = document.getElementById('overlay-host');
  const pg = document.getElementById('page');
  if (!oh || !pg) return false;
  window.__probe = { overlay: 0, page: 0, layerEl: document.querySelector('.layer.session'), foxEl: document.querySelector('.fox-figure') };
  new MutationObserver(() => window.__probe.overlay++).observe(oh, { childList: true });
  new MutationObserver(() => window.__probe.page++).observe(pg, { childList: true });
  return true;
})()`);

await sleep(3000);
const result = await ev(`(() => {
  const layer = document.querySelector('.layer.session');
  return {
    overlayRebuilds: window.__probe.overlay,
    pageRebuilds: window.__probe.page,
    layerSame: window.__probe.layerEl === layer,
    foxSame: window.__probe.foxEl === document.querySelector('.fox-figure'),
    countdown: document.querySelector('[data-live="session-countdown"]')?.textContent || document.querySelector('[data-live="hero-countdown"]')?.textContent || '',
    animName: layer ? getComputedStyle(layer).animationName : '（无锁定层）',
    animCount: layer ? layer.getAnimations().length : 0
  };
})()`);

console.log('\n锁定页重绘检查（3 秒窗口）');
console.log('  叠层整块替换次数 :', result.overlayRebuilds);
console.log('  页面整块替换次数 :', result.pageRebuilds);
console.log('  叠层元素是否被重建:', result.layerSame ? '否（稳定）' : '是（被重建）');
console.log('  狐狸元素是否被重建:', result.foxSame ? '否（稳定）' : '是（被重建）');
console.log('  入场动画           :', result.animName, '/ 运行中动画数', result.animCount);
console.log('  倒计时仍在走       :', result.countdown);

const ok = install && result.overlayRebuilds === 0 && result.pageRebuilds === 0 && result.layerSame && result.foxSame;
console.log(ok ? '\n✔ 稳定：没有整块重绘，动画/Canvas 不会被打断\n' : '\n✖ 仍在重绘\n');
proc.kill();
await sleep(200);
await (await import('node:fs')).promises.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
process.exitCode = ok ? 0 : 1;
