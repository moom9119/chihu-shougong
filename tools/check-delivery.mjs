/**
 * tools/check-delivery.mjs —— 评审交付版（赤狐收工.html）的验收。
 *
 * 和 check-single.mjs（原型演示页）的区别：这里查的是"交出去的作品"该有的样子——
 *   · 没有演示栏、没有测试模式、没有 seed 数据、没有 window.__fox 调试句柄
 *   · 首次打开不武装（不会一打开就锁在黑屏上），但有清晰的三步引导
 *   · 没有本机消息桥：没有任何 fetch 请求，宿主消息走 window.FoxLock.notify
 *   · 真实的「试跑 60 秒」链路：锁定 → 灰度 → 矩阵 → 长按提前结束 → 结算 → 收下
 *   · 预览会话不落盘：刷新不会莫名其妙回到锁定现场
 *   · 把文件拷到另一个目录、改个文件名，照样能双击打开（不依赖原路径/服务/环境）
 *
 * 用法：node tools/check-delivery.mjs [file]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] || path.join(ROOT, '赤狐收工.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9481;
const PROFILE = path.join(os.tmpdir(), `foxdeliv-${Date.now()}`);

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
const requests = [];
cdp.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const e = m.params.entry;
    const t = `${e.url || ''} ${e.text || ''}`;
    if (!/favicon|QQBrowser/i.test(t)) errors.push(t);
  }
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
});
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Network.enable');

const ev = async (expression, awaitPromise = false) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: false });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

async function openPage(url) {
  await cdp.send('Page.navigate', { url });
  await sleep(1400);
  return ev(
    `new Promise((res) => { if (window.FoxLock) return res(true);
      const t = setInterval(() => { if (window.FoxLock) { clearInterval(t); res(true); } }, 40);
      setTimeout(() => { clearInterval(t); res(false); }, 15000); })`,
    true,
  );
}

async function click(selector, label) {
  const ok = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false; el.click(); return true; })()`);
  assert(ok, `找不到 ${label || selector}`);
  await sleep(450);
}

const phase = async () => (await ev('window.FoxLock.getState().phase'));
const stat = async () => ev('window.FoxLock.getState()');

// 真实的按住 3 秒（CDP 的鼠标事件才会触发 pointerdown 长按逻辑）
async function holdFor(selector, ms) {
  const box = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  assert(box, `找不到 ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(ms);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(400);
}

const url = pathToFileURL(FILE).href;
console.log(`\n评审交付版验收\n  文件 ${FILE}\n  URL  ${url}\n`);

await cdp.send('Network.clearBrowserCache');
await openPage(url);

await check('双击 file:// 就能启动（无服务、无构建步骤）', async () => {
  const info = await ev(`({ title: document.title, cards: document.querySelectorAll('#page .card').length,
    boot: Boolean(document.querySelector('.boot-splash')) })`);
  assert(info.cards > 0, '页面没渲染出内容');
  assert(!info.boot, '停在启动画面上（boot 没完成）');
  assert(info.title.includes('赤狐收工'), `标题=${info.title}`);
  return `${info.title} · ${info.cards} 张卡片`;
});

await check('原型专用的东西都不在：演示栏 / 测试模式 / seed / __fox', async () => {
  const info = await ev(`({
    rail: Boolean(document.querySelector('.demo-rail')),
    test: typeof window.__FOX_TEST,
    seed: typeof window.__FOX_SEED,
    fox: typeof window.__fox,
    prod: window.__FOX_PROD === true
  })`);
  assert(!info.rail, '还有演示栏');
  assert(info.test === 'undefined', '还注入了 __FOX_TEST');
  assert(info.seed === 'undefined', '还注入了 __FOX_SEED');
  assert(info.fox === 'undefined', '还留着 window.__fox 调试句柄');
  assert(info.prod === true, '没有 __FOX_PROD 标记');
  return '干净：无演示栏 / 无测试模式 / 无调试句柄';
});

await check('宿主集成接口 FoxLock 就位（替代原来的本机 HTTP 桥）', async () => {
  const info = await ev(`({ version: window.FoxLock.version, notify: typeof window.FoxLock.notify,
    getState: typeof window.FoxLock.getState })`);
  assert(/^\d+\.\d+\.\d+$/.test(info.version), `版本=${info.version}`);
  assert(info.notify === 'function' && info.getState === 'function', JSON.stringify(info));
  const out = await ev(`window.FoxLock.notify({ app: 'wechat', contact: '张老师' })`);
  assert(out && out.ok === false, '不在限制中竟然受理了消息');
  return `v${info.version} · 非限制期正确拒绝`;
});

await check('首次打开不武装（不会被自己的默认夜间时段锁在黑屏）', async () => {
  const s = await stat();
  assert(s.phase === 'idle', `phase=${s.phase}`);
  assert(s.enabled === false, '总开关默认开着，会突然锁屏');
  const hint = await ev(`document.querySelector('#page')?.textContent || ''`);
  assert(hint.includes('第一次使用'), '首页没有首次使用引导');
  return '总开关关着 + 三步引导';
});

await check('没有任何外部请求（说明没有依赖模拟接口/服务）', async () => {
  const external = requests.filter((u) => !/^data:/.test(u) && !u.startsWith(url));
  assert(external.length === 0, `多余的请求：${external.slice(0, 3).join(' , ')}`);
  return `${requests.length} 个请求全部是 data: / 本文件自身`;
});

await check('「试跑 60 秒」→ 锁定 + 灰度 + 狐狸 + 矩阵', async () => {
  await click('[data-act="demo-start"]', '试跑按钮');
  const info = await ev(`({ phase: window.FoxLock.getState().phase,
    layer: Boolean(document.querySelector('.layer.session')),
    gray: document.getElementById('app').classList.contains('is-gray'),
    fox: Boolean(document.querySelector('.fox-figure') || document.querySelector('[data-fox-canvas]')) })`);
  assert(info.phase === 'locked', `phase=${info.phase}`);
  assert(info.layer && info.gray && info.fox, JSON.stringify(info));

  await click('[data-act="matrix-trigger"]', '「我用手机了」');
  const matrix = await ev(`({ open: Boolean(document.querySelector('.matrix-layer')), cells: document.querySelectorAll('.matrix-cell').length })`);
  assert(matrix.open, '矩阵没弹出');
  assert(matrix.cells === 16, `矩阵 ${matrix.cells} 格`);

  // 像真实用户那样按升序点完，顺便确认通关后矩阵会自己关掉
  await ev(
    `(async () => {
      const list = [...document.querySelectorAll('.matrix-cell')]
        .map((el) => ({ el, v: Number(el.dataset.v) }))
        .sort((a, b) => a.v - b.v);
      for (const c of list) { c.el.click(); await new Promise((r) => setTimeout(r, 60)); }
      return true;
    })()`,
    true,
  );
  await sleep(600);
  const stillOpen = await ev(`Boolean(document.querySelector('.matrix-layer'))`);
  assert(!stillOpen, '按升序点完后矩阵没关闭');
  return `锁定 + 灰度 + 狐狸 + ${matrix.cells} 格矩阵（已通关）`;
});

await check('重要联系人消息 → 暂停计时（集成接口真的能驱动业务）', async () => {
  const out = await ev(`window.FoxLock.notify({ app: 'wechat', contact: '张老师' })`);
  assert(out && out.ok === true, `宿主消息被拒：${JSON.stringify(out)}`);
  const s = await stat();
  assert(s.paused === true, '消息没有让限制暂停');
  const banner = await ev(`Boolean(document.querySelector('.interrupt-banner'))`);
  assert(banner, '没有暂停横幅');
  await click('[data-act="resume-timer"]', '恢复计时');
  const after = await ev(`window.FoxLock.getState()`);
  assert(after.paused === false, '没有恢复');
  return '暂停 → 手动恢复';
});

await check('长按 3 秒 → 提前结束 → 结算 → 回到首页', async () => {
  await holdFor('[data-act="emergency"]', 3400);
  const p1 = await phase();
  assert(p1 === 'result', `长按后 phase=${p1}`);
  const result = await ev(`({ title: document.querySelector('.result-title')?.textContent || '',
    hasAck: Boolean(document.querySelector('[data-act="result-ack"]')) })`);
  assert(result.hasAck, '结算页没有「收下」按钮');
  await click('[data-act="result-ack"]', '收下');
  const p2 = await phase();
  assert(p2 === 'idle', `收下后 phase=${p2}`);
  return `${result.title || '提前结束'} → idle`;
});

await check('试跑不计入统计、不落盘（刷新不会回到锁定）', async () => {
  const hist = await ev(`(() => { try { return JSON.parse(localStorage.getItem('foxlock.history') || '[]').length; } catch (e) { return -1; } })()`);
  assert(hist === 0, `历史里多了 ${hist} 条预览记录`);
  const runtime = await ev(`(() => { try { return localStorage.getItem('foxlock.runtime'); } catch (e) { return 'err'; } })()`);
  assert(!runtime, `预览会话被写进了 runtime 快照：${String(runtime).slice(0, 160)}`);
  await cdp.send('Page.reload');
  await sleep(1600);
  const p = await phase();
  assert(p === 'idle', `刷新后 phase=${p}`);
  return '历史 0 条 · runtime 已清空';
});

await check('记录页：时段能新增 / 关闭 / 删除（删除两步确认）', async () => {
  await click('.tab[data-view="stats"]', '记录 tab');
  const readWin = () =>
    ev(`(() => {
      let s = null;
      try { s = JSON.parse(localStorage.getItem('foxlock.settings') || 'null'); } catch (e) {}
      const del = document.querySelector('[data-act="win-del"]');
      return {
        cards: document.querySelectorAll('.win-card').length,
        stored: s ? s.windows.length : 0,
        enabled: s ? s.windows.map((w) => w.enabled) : [],
        label: del ? del.textContent.trim() : '',
        pressed: document.querySelector('.switch[data-act="win-toggle"]')?.getAttribute('aria-pressed') || ''
      };
    })()`);

  const before = await readWin();
  assert(before.cards >= 1, `初始没有时段卡：${JSON.stringify(before)}`);

  // 新增
  await click('[data-act="win-add"]', '新增时段');
  const added = await readWin();
  assert(added.cards === before.cards + 1, `新增后卡片 ${added.cards}`);
  assert(added.stored === before.cards + 1, '新增没有落盘');

  // 关闭 / 打开
  await click('.switch[data-act="win-toggle"]', '第一个时段的开关');
  const off = await readWin();
  assert(off.enabled[0] === false, '开关关不掉');
  assert(off.pressed === 'false', '开关样式没跟上');
  await click('.switch[data-act="win-toggle"]', '第一个时段的开关');
  const on = await readWin();
  assert(on.enabled[0] === true, '开关打不开');

  // 删除：第一次只点亮确认，第二次才执行
  await click('[data-act="win-del"]', '删除这段');
  const armed = await readWin();
  assert(armed.cards === added.cards, '第一次点就删掉了（应该要求确认）');
  assert(armed.label.includes('确认'), `按钮文案=${armed.label}`);
  await click('[data-act="win-del"]', '确认删除');
  const deleted = await readWin();
  assert(deleted.cards === added.cards - 1, `删除后卡片 ${deleted.cards}`);
  assert(deleted.stored === added.cards - 1, '删除没有落盘');
  return `新增 ${before.cards}→${added.cards} · 开关正常 · 删除后 ${deleted.stored} 段`;
});

await check('设置页：版本 / 交付版标识 / 集成说明三处都对', async () => {
  await click('.tab[data-view="settings"]', '设置 tab');
  const text = await ev(`document.querySelector('#page')?.innerText || ''`);
  assert(text.includes('评审交付版'), '没看到交付版标识');
  assert(/v\d+\.\d+\.\d+/.test(text), '没看到版本号');
  assert(text.includes('FoxLock.notify'), '重要联系人提示还是原型里的本机桥');
  assert(!text.includes('api/interrupt'), '还留着 /api/interrupt 说明');
  return '版本 + DELIVERY 标签 + FoxLock.notify 说明';
});

await check('拷到别的目录、换个文件名也能打开（真正的可搬迁）', async () => {
  const dir = path.join(os.tmpdir(), `评审副本-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  const copy = path.join(dir, '赤狐收工-副本.html');
  await fs.copyFile(FILE, copy);
  const ok = await openPage(pathToFileURL(copy).href);
  assert(ok, '副本打不开');
  const s = await stat();
  assert(s.phase === 'idle', `副本 phase=${s.phase}`);
  const cards = await ev(`document.querySelectorAll('#page .card').length`);
  assert(cards > 0, '副本没渲染');
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return `临时目录副本正常（${cards} 张卡片）`;
});

await check('顶栏音乐按钮（含音频的构建才验证切档）', async () => {
  const has = await ev(`Boolean(document.querySelector('.music-btn'))`);
  if (!has) {
    await click('.tab[data-view="settings"]', '设置 tab');
    const note = await ev(`document.body.textContent.includes('没有内联音频')`);
    assert(note, '没有音乐按钮，设置页也没说明原因');
    await click('.tab[data-view="home"]', '首页 tab');
    return '本次构建无内联音频（--no-bgm）：按钮已隐藏，设置页有说明';
  }
  const label = await ev(`document.querySelector('.music-btn')?.textContent || ''`);
  assert(label.includes('30%'), `按钮=${label}`);
  await ev(`document.querySelector('.music-btn').click()`);
  await sleep(500);
  const next = await ev(`document.querySelector('.music-btn')?.textContent || ''`);
  assert(next.includes('50%'), `切换后=${next}`);
  const saved = await ev(`(() => { try { return localStorage.getItem('foxlock.bgm'); } catch (e) { return 'err'; } })()`);
  assert(saved === 'high', `落盘=${saved}`);
  return `${label.replace(/\s+/g, '')} → ${next.replace(/\s+/g, '')}`;
});

await check('全程 0 条 JS 异常', () => {
  assert(errors.length === 0, errors.slice(0, 3).join(' | '));
  return '0 条';
});

proc.kill();
await fs.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) process.exitCode = 1;
