/**
 * tools/bgm-check.mjs —— 验收背景音乐（单文件演示页 + 正式多文件版都能跑）。
 *
 * 查这几件事：
 *   1. 音源到位（演示页是内联的 data:audio/mpeg；正式版是 assets/music/bgm.mp3）
 *   2. 顶栏有音乐按钮，默认 30%
 *   3. 浏览器不给自动播放时，不硬放、不报错，等第一次交互
 *   4. 一次真实点击之后开始循环播放
 *   5. 三档音量 20% / 30% / 50% + 关，切换真的落到 audio.volume 上
 *   6. 切到「锁定」自动淡出暂停，回首页接着放
 *   7. 设置页的分段控件也能改，选择存进 localStorage
 *
 * 用法：
 *   node tools/bgm-check.mjs                       # 验 演示.html（file://）
 *   node tools/bgm-check.mjs http://127.0.0.1:7317/?test=1   # 验正式版（先起服务）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2] || path.join(ROOT, '演示.html');
const IS_URL = /^https?:\/\//i.test(arg);
const URL_ = IS_URL ? arg : pathToFileURL(arg).href;
const LABEL = IS_URL ? '正式版（http）' : '单文件演示页（file://）';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9479;
const PROFILE = path.join(os.tmpdir(), `foxbgm-${Date.now()}`);

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
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--allow-file-access-from-files',
    // 故意不开 --autoplay-policy：要验的就是"没交互时不许自己放"
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=430,932',
    'about:blank',
  ],
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
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: false });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

// 真实的一次点击：CDP 的 Input 事件是"可信"的，能拿到用户激活权限
// （JS 里合成的 dispatchEvent 不算用户激活，play() 会被浏览器拒掉）
async function realClick(x = 215, y = 120) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const dbg = () => ev('window.__fox && window.__fox.bgm ? window.__fox.bgm.debug() : null');
const phase = () => ev('window.__fox.state.phase');
const clickMusic = () => ev(`document.querySelector('.music-btn').click()`);
const musicLabel = () => ev(`document.querySelector('.music-btn')?.textContent.replace(/\\s+/g, '') || ''`);

async function nav(view) {
  const ok = await ev(`(() => { const b = document.querySelector('[data-act="nav"][data-view="${view}"]');
    if (!b) return false; b.click(); return true; })()`);
  assert(ok, `找不到底部导航「${view}」`);
  await sleep(320);
}

async function goLocked() {
  const hasRail = await ev(`Boolean(document.querySelector('.demo-rail'))`);
  if (hasRail) {
    const ok = await ev(`(() => { const b = [...document.querySelectorAll('.demo-rail button')].find((x) => x.textContent === '锁定');
      if (!b) return false; b.click(); return true; })()`);
    assert(ok, '演示栏里没有「锁定」');
  } else {
    await ev(`window.__fox.dispatch({ type: 'PREVIEW_START', durationMs: 45*60*1000,
      tasks: [{ id: 't1', text: '验收用任务', done: false, doneAt: null }] })`);
  }
  await sleep(1100);
}

async function goIdle() {
  const hasRail = await ev(`Boolean(document.querySelector('.demo-rail'))`);
  if (hasRail) {
    const ok = await ev(`(() => { const b = [...document.querySelectorAll('.demo-rail button')].find((x) => x.textContent === '首页');
      if (!b) return false; b.click(); return true; })()`);
    assert(ok, '演示栏里没有「首页」');
  } else {
    await ev(`(() => { const f = window.__fox;
      if (f.state.phase === 'result') f.dispatch({ type: 'RESULT_ACK' });
      else if (f.state.phase !== 'idle') { f.dispatch({ type: 'EMERGENCY_EXIT' }); f.dispatch({ type: 'RESULT_ACK' }); }
      f.ui.view = 'home'; f.render(); })()`);
  }
  await sleep(1200);
}

console.log(`\n背景音乐验收 · ${LABEL}\n  ${URL_}\n`);

await cdp.send('Page.navigate', { url: URL_ });
await sleep(1400);
const ready = await ev(
  `new Promise((res) => { if (window.__fox && window.__fox.bgm) return res(true);
    const t = setInterval(() => { if (window.__fox && window.__fox.bgm) { clearInterval(t); res(true); } }, 40);
    setTimeout(() => { clearInterval(t); res(false); }, 15000); })`,
  true,
);
assert(ready, '页面没起来（window.__fox.bgm 未就绪）');

await check('音源到位', async () => {
  const info = await ev(`({ inline: (window.__FOX_BGM || '').slice(0, 16), len: (window.__FOX_BGM || '').length })`);
  const d = await dbg();
  if (IS_URL) {
    const src = await ev('window.__fox.bgm.audio ? window.__fox.bgm.audio.getAttribute("src") : ""');
    assert(src === 'assets/music/bgm.mp3', `正式版音源=${src}`);
    return 'assets/music/bgm.mp3（外链，不占单文件体积）';
  }
  assert(info.inline.startsWith('data:audio/mpeg'), `演示页前缀不对：${info.inline}`);
  assert(d.srcLength > 5 * 1024 * 1024, `内联音频只有 ${(d.srcLength / 1048576).toFixed(2)} MB`);
  return `内联 ${(d.srcLength / 1048576).toFixed(2)} MB base64`;
});

await check('顶栏有音乐按钮，默认 30%', async () => {
  const label = await musicLabel();
  assert(label.includes('30%'), `按钮文案：${label}`);
  const d = await dbg();
  assert(d.key === 'mid', `默认档位 ${d.key}`);
  return label;
});

await check('没交互时不硬放（受浏览器自动播放策略约束）', async () => {
  const d = await dbg();
  assert(!d.broken, '音频元素报错（音源解不开？）');
  assert(d.volume <= 0.02, `静默期音量已经有 ${d.volume}`);
  return d.paused ? '等第一次交互' : '本机允许自动播放，已在放';
});

await check('一次真实点击后开始播放，循环 + 30%', async () => {
  await realClick();
  await sleep(1400);
  const d = await dbg();
  assert(d.unlocked, '没拿到播放许可');
  assert(!d.paused, '点击之后仍然没播');
  assert(d.loop === true, '没有设置循环');
  assert(Math.abs(d.volume - 0.3) < 0.03, `音量 ${d.volume} 不是 0.3`);
  return `音量 ${d.volume}，循环 ${d.loop}`;
});

await check('播放进度真的在走（不是假播放）', async () => {
  const t1 = (await dbg()).currentTime;
  await sleep(1300);
  const t2 = (await dbg()).currentTime;
  assert(t2 > t1, `进度没动：${t1} → ${t2}`);
  return `${t1}s → ${t2}s`;
});

await check('点按钮 30% → 50% → 关 → 20% → 30%', async () => {
  const steps = [];
  for (const [key, vol] of [
    ['high', 0.5],
    ['off', 0],
    ['low', 0.2],
    ['mid', 0.3],
  ]) {
    await clickMusic();
    await sleep(700);
    const d = await dbg();
    assert(d.key === key, `期望档位 ${key}，实际 ${d.key}`);
    if (vol === 0) {
      assert(d.paused === true, `关掉后还在放：volume=${d.volume}`);
      assert(d.volume <= 0.02, `关掉后音量还是 ${d.volume}`);
    } else {
      assert(!d.paused, `${key} 档没在放`);
      assert(Math.abs(d.volume - vol) < 0.03, `${key} 档音量 ${d.volume}，期望 ${vol}`);
    }
    steps.push(`${d.label}=${d.volume}`);
  }
  return steps.join(' → ');
});

await check('设置页的分段控件也能切，且写进 localStorage', async () => {
  await nav('settings');
  const ok = await ev(`(() => { const b = document.querySelector('[data-act="bgm-set"][data-level="high"]');
    if (!b) return false; b.click(); return true; })()`);
  assert(ok, '设置页没有背景音乐分段控件');
  await sleep(800);
  const d = await dbg();
  assert(d.key === 'high', `设置页没生效：${d.key}`);
  assert(Math.abs(d.volume - 0.5) < 0.03, `音量 ${d.volume}`);
  const saved = await ev(`(() => { try { return localStorage.getItem('foxlock.bgm'); } catch (e) { return 'err'; } })()`);
  assert(saved === 'high', `存的 ${saved}`);
  const pressed = await ev(`document.querySelector('[data-act="bgm-set"][data-level="high"]').getAttribute('aria-pressed')`);
  assert(pressed === 'true', '选中态没高亮');
  return `50% 已选中并落盘（${saved}）`;
});

await check('切到「锁定」→ 自动淡出暂停', async () => {
  await goLocked();
  const p = await phase();
  assert(p === 'locked', `phase=${p}`);
  const d = await dbg();
  assert(d.paused === true, `锁定后还在放：volume=${d.volume}`);
  return `锁定态静音（volume ${d.volume}）`;
});

await check('回「首页」→ 接着播（音量回到设定档）', async () => {
  await goIdle();
  const p = await phase();
  assert(p === 'idle', `phase=${p}`);
  const d = await dbg();
  assert(d.paused === false, '回首页没继续放');
  assert(Math.abs(d.volume - 0.5) < 0.03, `音量没回到 50%：${d.volume}`);
  return `继续播放，音量 ${d.volume}`;
});

await check('最后还原成 30%（下次打开是默认档）', async () => {
  await nav('settings');
  await ev(`(() => { const b = document.querySelector('[data-act="bgm-set"][data-level="mid"]'); return b ? (b.click(), true) : false; })()`);
  await sleep(700);
  const saved = await ev(`(() => { try { return localStorage.getItem('foxlock.bgm'); } catch (e) { return 'err'; } })()`);
  assert(saved === 'mid', `存的 ${saved}`);
  const d = await dbg();
  assert(Math.abs(d.volume - 0.3) < 0.03, `音量 ${d.volume}`);
  return `30%（${saved}）`;
});

await cdp.send('Page.captureScreenshot', { format: 'png' }).then(async (r) => {
  await fs.mkdir(path.join(ROOT, 'qa'), { recursive: true });
  const name = IS_URL ? 'bgm-app.png' : 'bgm-demo.png';
  await fs.writeFile(path.join(ROOT, 'qa', name), Buffer.from(r.data, 'base64'));
});

await check('全程 0 条 JS 异常', () => {
  assert(errors.length === 0, errors.slice(0, 3).join(' | '));
  return '0 条';
});

proc.kill();
await fs.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) process.exitCode = 1;
