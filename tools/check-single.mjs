/**
 * tools/check-single.mjs —— 验证单文件演示页（file:// 直开）能不能正常工作。
 * 用法：node tools/check-single.mjs [file]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] || path.join(ROOT, '演示.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9477;
const PROFILE = path.join(os.tmpdir(), `foxsingle-${Date.now()}`);

let pass = 0;
let fail = 0;

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

async function check(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✖ ${name} — ${err.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const proc = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--allow-file-access-from-files', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=430,932', 'about:blank'],
  { stdio: 'ignore' },
);

for (let i = 0; i < 80; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
  } catch {}
  await sleep(200);
}
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const cdp = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
const errors = [];
cdp.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const e = m.params.entry;
    const t = `${e.url || ''} ${e.text || ''}`;
    if (!/favicon|QQBrowser/i.test(t)) errors.push(t);
  }
});
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');

const ev = async (expression, awaitPromise = false) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const url = pathToFileURL(FILE).href;
console.log(`\n单文件演示页验收\n  文件 ${FILE}\n  URL  ${url}\n`);

await cdp.send('Page.navigate', { url });
await sleep(1200);
const ready = await ev(
  `new Promise((res) => { if (window.__fox) return res(true);
    const t = setInterval(() => { if (window.__fox) { clearInterval(t); res(true); } }, 40);
    setTimeout(() => { clearInterval(t); res(false); }, 8000); })`,
  true,
);

await check('file:// 直接打开能启动（无 ES Module / CORS 问题）', () => {
  assert(ready, 'window.__fox 未就绪');
  return '启动成功';
});

await check('演示页默认测试模式（半夜打开也不会被锁住）', async () => {
  const info = await ev(`({ testMode: window.__fox.testMode, phase: window.__fox.state.phase })`);
  assert(info.testMode === true, '没有进入测试模式');
  assert(info.phase === 'idle', `启动就被锁了：${info.phase}`);
  return 'testMode=true';
});

await check('演示栏与状态按钮都在', async () => {
  const info = await ev(`({ rail: Boolean(document.querySelector('.demo-rail')), btns: document.querySelectorAll('.demo-rail button').length, tour: Boolean(document.querySelector('[data-tour]')) })`);
  assert(info.rail, '演示栏没出现');
  assert(info.btns >= 12, `按钮只有 ${info.btns} 个`);
  assert(info.tour, '没有自动演示按钮');
  return `${info.btns} 个按钮（含自动演示）`;
});

await check('图片是内联的 base64（不依赖外部文件）', async () => {
  const info = await ev(`(() => { const img = document.querySelector('.hero-fox img'); return img ? img.src.slice(0, 22) : 'none'; })()`);
  assert(info.startsWith('data:image/png'), `src=${info}`);
  return 'data:image/png;base64…';
});

async function press(label) {
  const ok = await ev(`(() => { const b = [...document.querySelectorAll('.demo-rail button')].find((x) => x.textContent === ${JSON.stringify(label)});
    if (!b) return false; b.click(); return true; })()`);
  assert(ok, `找不到按钮「${label}」`);
}

async function clickAny(selector, label) {
  const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  assert(ok, `找不到元素 ${label || selector}`);
  await sleep(450);
}

await check('点「锁定」→ 全屏锁定 + 灰度 + 狐狸', async () => {
  await press('锁定');
  await sleep(600);
  const info = await ev(`({ phase: window.__fox.state.phase,
    layer: Boolean(document.querySelector('.layer.session')),
    gray: document.getElementById('app').classList.contains('is-gray'),
    fox: Boolean(document.querySelector('.fox-figure')),
    src: (document.querySelector('.fox-figure') || {}).tagName })`);
  assert(info.phase === 'locked', `phase=${info.phase}`);
  assert(info.layer && info.gray && info.fox, JSON.stringify(info));
  return `phase=${info.phase}，灰度 + ${info.src}`;
});
await cdp.send('Page.captureScreenshot', { format: 'png' }).then(async (r) => {
  await fs.mkdir(path.join(ROOT, 'qa'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'qa', 'single-locked.png'), Buffer.from(r.data, 'base64'));
});

await check('点「矩阵」→ 弹出数字矩阵', async () => {
  await press('矩阵');
  await sleep(900);
  const info = await ev(`({ open: Boolean(document.querySelector('.matrix-layer')), cells: document.querySelectorAll('.matrix-cell').length })`);
  assert(info.open, '矩阵没弹出');
  return `${info.cells} 格`;
});

await check('点「休息」→ 休息态、灰度解除', async () => {
  await press('休息');
  await sleep(800);
  const info = await ev(`({ phase: window.__fox.state.phase, gray: document.getElementById('app').classList.contains('is-gray'), tag: document.querySelector('.session-tag')?.className || '' })`);
  assert(info.phase === 'rest', `phase=${info.phase}`);
  assert(!info.gray, '休息时仍是灰的');
  return '休息中';
});

await check('点「成功结算」→ 奖励卡 + 开心狐狸', async () => {
  await press('成功结算');
  await sleep(500);
  const info = await ev(`({ phase: window.__fox.state.phase, title: document.querySelector('.result-title')?.textContent || '', reward: Boolean(document.querySelector('.reward-card')), img: (document.querySelector('.result-fox') || {}).tagName })`);
  assert(info.phase === 'result', `phase=${info.phase}`);
  assert(info.reward, '没有奖励卡');
  assert(info.img === 'IMG', `狐狸不是 img：${info.img}`);
  return `${info.title} · ${info.img}`;
});
await cdp.send('Page.captureScreenshot', { format: 'png' }).then(async (r) => {
  await fs.writeFile(path.join(ROOT, 'qa', 'single-result.png'), Buffer.from(r.data, 'base64'));
});

await check('收藏册 9 种花，插画都是内联图', async () => {
  await press('收藏');
  await sleep(500);
  const info = await ev(`({
    tiles: document.querySelectorAll('.flower').length,
    imgs: [...document.querySelectorAll('.flower img.flower-art')].map((i) => i.src.slice(0, 15)),
    names: [...document.querySelectorAll('.flower-name')].map((n) => n.textContent.trim())
  })`);
  assert(info.tiles === 9, `花种数 ${info.tiles}`);
  assert(info.imgs.length === 9, `只找到 ${info.imgs.length} 张插画`);
  assert(info.imgs.every((s) => s.startsWith('data:image/png')), '有插画不是内联的');
  const known = info.names.filter((n) => n && n !== '？？？');
  assert(known.length >= 5, `演示数据里已获得的太少：${known.length}`);
  return `${info.tiles} 种，已获得 ${known.length} 种：${known.slice(0, 3).join(' / ')} …`;
});

await check('点开一朵花能看到花语与由来', async () => {
  await clickAny('.flower.owned', '已获得的花朵');
  const info = await ev(`({
    open: Boolean(document.querySelector('.flower-detail')),
    lang: document.querySelector('.fd-lang')?.textContent || '',
    poem: document.querySelector('.fd-poem')?.textContent || ''
  })`);
  assert(info.open, '没有展开详情');
  assert(info.lang.includes('花语'), `花语行不对：${info.lang}`);
  assert(info.poem.startsWith('小狐狸'), `由来不对：${info.poem}`);
  return `${info.lang.replace('花语 · ', '')} · ${info.poem.slice(0, 12)}…`;
});

await check('记录页：时间表常驻，明细默认只展开近三天', async () => {
  await press('统计');
  await sleep(450);
  const before = await ev(`({
    hasToggle: Boolean(document.querySelector('[data-act="windows-toggle"]')),
    hasAdd: Boolean(document.querySelector('[data-act="win-add"]')),
    rows: document.querySelectorAll('.record').length,
    btn: document.querySelector('[data-act="records-older"]')?.textContent.trim() || ''
  })`);
  assert(!before.hasToggle, '时间表不该有折叠开关');
  assert(before.hasAdd, '时间表没有常驻展开');
  assert(before.rows === 3, `默认应只显示近三天 3 条，实际 ${before.rows}`);
  assert(before.btn.includes('展开更早的'), `缺少更早记录的折叠：${before.btn}`);
  await clickAny('[data-act="records-older"]', '展开更早的记录');
  const after = await ev(`document.querySelectorAll('.record').length`);
  assert(after === 9, `展开后应有 9 条，实际 ${after}`);
  return `近三天 3 条 → 展开 ${after} 条`;
});

await check('点「重要消息」→ 响铃并暂停，可手动恢复', async () => {
  await press('重要消息');
  await sleep(1200);
  const paused = await ev(`({
    active: window.__fox.state.session?.pause?.active,
    banner: Boolean(document.querySelector('.interrupt-banner')),
    btn: Boolean(document.querySelector('[data-act="resume-timer"]')),
    gray: document.getElementById('app').classList.contains('is-gray')
  })`);
  assert(paused.active === true, '没有自动暂停');
  assert(paused.banner && paused.btn, '缺少暂停横幅或恢复按钮');
  assert(!paused.gray, '暂停时应解除灰度');
  await clickAny('[data-act="resume-timer"]', '恢复计时');
  await sleep(600);
  const after = await ev(`({ active: window.__fox.state.session?.pause?.active, total: window.__fox.state.session?.pause?.totalMs })`);
  assert(after.active === false, '没有恢复');
  assert(after.total >= 500, '暂停时长没记');
  return `暂停 ${Math.round(after.total / 1000)} 秒后恢复`;
});

await check('点「首页」回到自由时间', async () => {
  await press('首页');
  await sleep(400);
  const info = await ev(`({ phase: window.__fox.state.phase, hero: document.querySelector('.hero-title')?.textContent || '' })`);
  assert(info.phase === 'idle', `phase=${info.phase}`);
  assert(info.hero.includes('不会自动锁定'), `首页没提示测试模式：${info.hero}`);
  return `${info.hero}（测试模式）`;
});

await check('「自动演示」会自动走过多个状态', async () => {
  await press('▶ 自动演示');
  await sleep(1200);
  const first = await ev(`window.__fox.state.phase`);
  await sleep(4200);
  const second = await ev(`({ phase: window.__fox.state.phase, label: document.querySelector('[data-tour]')?.textContent || '' })`);
  assert(second.label.includes('停止'), `按钮没切到停止态：${second.label}`);
  await press('■ 停止演示');
  await sleep(300);
  const stopped = await ev(`document.querySelector('[data-tour]')?.textContent || ''`);
  assert(stopped.includes('自动演示'), '停不下来');
  return `${first} → ${second.phase}，已停止`;
});

await check('全程 0 条 JS 异常', () => {
  assert(errors.length === 0, errors.slice(0, 3).join(' | '));
  return '0 条';
});

proc.kill();
await fs.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) process.exitCode = 1;
