/**
 * tools/ui-check.mjs —— 用 Edge 的 DevTools 协议做真实浏览器里的自动化验收。
 *
 * 为什么不用普通单元测试：界面层（灰度 filter、canvas、叠层、事件委托）
 * 只有跑在真浏览器里才测得到。这里不引入 puppeteer，直接用 CDP + Node 自带 WebSocket。
 *
 * 用法：node tools/ui-check.mjs [--base http://127.0.0.1:7317] [--shots]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:7317');
const SHOTS = argv.includes('--shots');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(arg('port', 9433));
const PROFILE = path.join(os.tmpdir(), `foxlock-qa-${Date.now()}`);

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, extra = '') {
  passed += 1;
  console.log(`  ✔ ${name}${extra ? ` — ${extra}` : ''}`);
}
function bad(name, detail) {
  failed += 1;
  failures.push(`${name}: ${detail}`);
  console.log(`  ✖ ${name} — ${detail}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    bad(name, err?.message || String(err));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------- CDP 客户端

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = [];
    let id = 0;
    ws.addEventListener('open', () => {
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
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
      } else {
        for (const fn of listeners) fn(msg);
      }
    });
  });
}

async function waitForEndpoint(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('Edge 调试端口没起来');
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!(await fs.stat(EDGE).catch(() => null))) {
    console.error(`找不到 Edge：${EDGE}`);
    process.exit(2);
  }
  const proc = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--window-size=430,932',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const info = await waitForEndpoint(PORT);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  assert(page?.webSocketDebuggerUrl, '没有找到 page target');
  const cdp = await connect(page.webSocketDebuggerUrl);

  const errors = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description || d.text || '未知异常');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const entry = msg.params.entry;
      const t = `${entry.url || ''} ${entry.text || ''}`.trim();
      // 狐狸立绘缺失是可接受的兜底路径（用 emoji 代替），favicon 404 也无所谓；
      // 没有桥服务时 /api/interrupt 404 属正常（页面会自己停掉轮询）
      if (/QQBrowser|favicon|assets\/fox\/|api\/interrupt/i.test(t)) return;
      errors.push(t);
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  async function ev(expression, opts = {}) {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: Boolean(opts.awaitPromise),
      userGesture: true,
      ...opts,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async function goto(url, waitForApp = true) {
    await cdp.send('Page.navigate', { url });
    await sleep(400);
    if (!waitForApp) return;
    const ready = await ev(
      `new Promise((res) => { if (window.__fox) return res(true);
        const t = setInterval(() => { if (window.__fox) { clearInterval(t); res(true); } }, 40);
        setTimeout(() => { clearInterval(t); res(false); }, 9000); })`,
      { awaitPromise: true },
    );
    assert(ready, '应用没有启动（window.__fox 未就绪）');
    await sleep(250);
  }

  async function click(selector, label) {
    const found = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false; el.click(); return true; })()`);
    assert(found, `找不到元素 ${label || selector}`);
  }

  async function shot(name) {
    if (!SHOTS) return;
    const dir = path.join(ROOT, 'qa');
    await fs.mkdir(dir, { recursive: true });
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(path.join(dir, `${name}.png`), Buffer.from(r.data, 'base64'));
  }

  console.log(`\n赤狐收工 · 浏览器验收（${BASE}）\n`);

  // ---------------- A. 启动与首页
  await goto(`${BASE}/`);
  await check('启动后无 JS 异常', () => {
    assert(errors.length === 0, errors.slice(0, 3).join(' | '));
    return '0 条错误';
  });

  // 让验收与真实时钟解耦：换成一个不会触发的时间段（03:00–03:01）并落盘，
  // 否则晚上 22:30 之后跑验收会一进来就被夜间限制锁住。
  const bootPhase = await ev(`(() => {
    const s = JSON.parse(JSON.stringify(window.__fox.state.settings));
    s.windows = [{ id: 'qa_idle', label: 'QA 空窗', start: '03:00', end: '03:01', days: [0,1,2,3,4,5,6], enabled: true }];
    s.prewarnMinutes = 0;
    window.__fox.dispatch({ type: 'SETTINGS', settings: s });
    if (window.__fox.state.phase === 'result') window.__fox.dispatch({ type: 'RESULT_ACK' });
    try { localStorage.setItem('foxlock.settings', JSON.stringify(s)); } catch {}
    return window.__fox.state.phase;
  })()`);
  await sleep(350);
  console.log(`  · 已把时间表换成不会触发的 QA 空窗（启动时 phase=${bootPhase}）`);
  await check('首页渲染出主卡与 4 个快捷入口', async () => {
    const info = await ev(`({
      hero: document.querySelector('.hero-title')?.textContent?.trim() || '',
      quick: document.querySelectorAll('.quick').length,
      tabs: document.querySelectorAll('.tab').length,
      cards: document.querySelectorAll('.card').length
    })`);
    assert(info.hero.length > 0, '主标题为空');
    assert(info.quick === 4, `快捷入口 ${info.quick} 个`);
    assert(info.tabs === 4, `底部 tab ${info.tabs} 个`);
    return `标题「${info.hero}」· ${info.cards} 张卡片`;
  });
  await check('没有横向溢出（430px 视口）', async () => {
    const info = await ev(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      bodyH: document.body.scrollHeight, innerH: window.innerHeight })`);
    assert(info.sw <= info.iw + 1, `scrollWidth ${info.sw} > ${info.iw}`);
    return `${info.sw}px / ${info.iw}px`;
  });
  await check('底部 tab 切换可用', async () => {
    const order = await ev(`[...document.querySelectorAll('.tab')].map((t) => t.dataset.view)`);
    assert(
      JSON.stringify(order) === JSON.stringify(['home', 'stats', 'collection', 'settings']),
      `引导栏顺序不对：${order.join(' / ')}`,
    );
    await click('.tab[data-view="settings"]', '设置 tab');
    await sleep(200);
    const title = await ev(`document.querySelector('#page .row-title')?.textContent || ''`);
    assert(title.includes('总开关'), `设置页没渲染：${title}`);
    await click('.tab[data-view="home"]', '首页 tab');
    await sleep(150);
    return `顺序 ${order.join(' · ')}`;
  });
  await check('选中的模块是更深更饱和的橙', async () => {
    const info = await ev(`(() => {
      const el = document.querySelector('.tab[aria-current="page"]');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const probe = document.createElement('span');
      document.body.appendChild(probe);
      probe.style.color = 'var(--fox-hot)';
      const hot = getComputedStyle(probe).color;
      probe.style.color = 'var(--fox)';
      const fox = getComputedStyle(probe).color;
      probe.remove();
      return { view: el.dataset.view, color: cs.color, bg: cs.backgroundColor, weight: cs.fontWeight, hot, fox };
    })()`);
    assert(info, '找不到选中的 tab');
    assert(info.color === info.hot, `选中色=${info.color}，--fox-hot=${info.hot}`);
    assert(info.color !== info.fox, `选中色没比 --fox 更深：${info.color}`);
    assert(/^(rgb|rgba)\(/.test(info.bg), `选中底色=${info.bg}`);
    assert(Number(info.weight) >= 600, `字重=${info.weight}`);
    return `${info.view} · ${info.color}（普通态 ${info.fox}）`;
  });
  await shot('01-home');

  // ---------------- B. 试跑：进入锁定
  await check('点「试跑 60 秒」进入限制，灰度与狐狸舞台生效', async () => {
    await click('[data-act="demo-start"]', '试跑按钮');
    await sleep(500);
    const info = await ev(`({
      phase: window.__fox.state.phase,
      layer: Boolean(document.querySelector('.layer.session')),
      gray: document.getElementById('app').classList.contains('is-gray'),
      filter: getComputedStyle(document.getElementById('app')).filter,
      canvas: (() => { const c = document.querySelector('[data-fox-canvas]'); return c ? c.width * c.height : 0; })(),
      countdown: document.querySelector('[data-live="session-countdown"]')?.textContent || '',
      tasks: document.querySelectorAll('.stp-tasks .task-item').length
    })`);
    assert(info.phase === 'locked', `phase=${info.phase}`);
    assert(info.layer, '没有锁定层');
    assert(info.gray, '没有加灰度 class');
    assert(/grayscale/.test(info.filter), `filter=${info.filter}`);
    assert(info.canvas > 0, 'canvas 没有尺寸');
    assert(/\d{2}:\d{2}/.test(info.countdown), `倒计时=${info.countdown}`);
    assert(info.tasks === 3, `任务 ${info.tasks} 条`);
    return `${info.countdown} · canvas ${info.canvas}px²`;
  });
  await shot('02-locked');

  await check('勾选任务后进度条与百分比同步', async () => {
    await click('.stp-tasks .task-toggle', '第一个任务');
    await sleep(250);
    const info = await ev(`({
      pct: document.querySelector('[data-live="task-percent"]')?.textContent || '',
      bar: document.querySelector('[data-live="task-bar"]')?.style.width || ''
    })`);
    assert(info.pct.includes('1/3'), `百分比=${info.pct}`);
    assert(parseFloat(info.bar) > 30, `条宽=${info.bar}`);
    return `${info.pct} · ${info.bar}`;
  });

  await check('限制期间点底部 tab 不会离开锁定层', async () => {
    await click('.tab[data-view="settings"]', '设置 tab');
    await sleep(200);
    const still = await ev(`Boolean(document.querySelector('.layer.session'))`);
    assert(still, '锁定层被切走了');
    return '仍停留在限制页';
  });

  // ---------------- C. 数字矩阵
  await check('点「我用手机了」弹出数字矩阵（16 格）', async () => {
    await click('[data-act="matrix-trigger"]', '矩阵触发');
    await sleep(350);
    const info = await ev(`({
      open: Boolean(document.querySelector('.matrix-layer')),
      cells: document.querySelectorAll('.matrix-cell').length,
      target: document.querySelector('[data-live="matrix-target"]')?.textContent || '',
      closable: Boolean(document.querySelector('.matrix-layer [data-act="matrix-close"]'))
    })`);
    assert(info.open, '矩阵没弹出');
    assert(info.cells === 16, `格子 ${info.cells}`);
    assert(info.target === '1', `第一个目标=${info.target}`);
    assert(!info.closable, '不该有关闭按钮');
    return `${info.cells} 格，目标 ${info.target}`;
  });
  await shot('03-matrix');

  await check('按升序点完 16 个数，弹窗关闭并进入冷却', async () => {
    const values = await ev(`[...document.querySelectorAll('.matrix-cell')].map((b) => Number(b.dataset.v))`);
    values.sort((a, b) => a - b);
    for (const v of values) {
      await ev(`(() => { const el = document.querySelector('.matrix-cell[data-v="${v}"]'); if (el) el.click(); })()`);
      await sleep(30);
    }
    await sleep(400);
    const info = await ev(`({ open: Boolean(document.querySelector('.matrix-layer')),
      solved: window.__fox.state.session.matrix.solved,
      cooldown: window.__fox.state.session.matrix.cooldownUntil })`);
    assert(!info.open, '通关后弹窗还在');
    assert(info.solved === 1, `solved=${info.solved}`);
    assert(info.cooldown > 0, '没有设置冷却');
    return `通关 1 次`;
  });

  await check('点错数字会计错误次数（不判负）', async () => {
    // 上一关留下 5 分钟冷却，这里清掉以便再弹一次（只测关卡逻辑）
    await ev(`(() => {
      window.__fox.state.session.matrix.cooldownUntil = 0;
      window.__fox.dispatch({ type: 'MATRIX_TRIGGER' });
    })()`);
    await sleep(300);
    const before = await ev(`window.__fox.state.session.matrix.openAt != null`);
    const wrong = await ev(`(() => {
      const cells = [...document.querySelectorAll('.matrix-cell')];
      const targetEl = document.querySelector('[data-live="matrix-target"]');
      if (!targetEl) return null;
      const target = Number(targetEl.textContent);
      const bad = cells.find((c) => Number(c.dataset.v) !== target);
      bad.click(); return bad.dataset.v; })()`);
    await sleep(200);
    const info = await ev(`({ open: Boolean(document.querySelector('.matrix-layer')), errors: document.querySelectorAll('.matrix-cell.wrong').length })`);
    assert(before, '触发后没打开');
    assert(wrong !== null, '找不到目标数字');
    assert(info.open, '点错后弹窗不该关闭');
    return `点了 ${wrong}，仍停留在游戏`;
  });

  // ---------------- D. 离开 → 哭泣
  await check('模拟切屏离开 → 狐狸失败并提示哭泣', async () => {
    await ev(`window.__fox.dispatch({ type: 'FOX_LEAVE', reason: 'hidden' })`);
    await sleep(350);
    const info = await ev(`({
      fox: window.__fox.state.session.fox.state,
      bubble: document.querySelector('[data-live="fox-bubble"]')?.textContent || '',
      sad: document.querySelector('.fox-bubble')?.classList.contains('sad')
    })`);
    assert(info.fox === 'failed', `fox=${info.fox}`);
    assert(info.bubble.includes('离开') || info.bubble.includes('失败'), `气泡=${info.bubble}`);
    assert(info.sad, '气泡没有 sad 样式');
    return info.bubble;
  });
  await shot('04-fox-sad');

  await check('提前长按结束（模拟）→ 结算为提前终止', async () => {
    await ev(`window.__fox.dispatch({ type: 'EMERGENCY_EXIT' })`);
    await sleep(350);
    const info = await ev(`({
      phase: window.__fox.state.phase,
      layer: Boolean(document.querySelector('.result-layer')),
      title: document.querySelector('.result-title')?.textContent || '',
      gray: document.getElementById('app').classList.contains('is-gray')
    })`);
    assert(info.phase === 'result', `phase=${info.phase}`);
    assert(info.layer, '没有结算层');
    assert(info.title.includes('提前'), `标题=${info.title}`);
    assert(!info.gray, '结算后应该恢复彩色');
    return info.title;
  });
  await shot('05-result-aborted');

  await check('点「收下」回到首页', async () => {
    await click('[data-act="result-ack"]', '收下');
    await sleep(400);
    const info = await ev(`({ phase: window.__fox.state.phase, hero: Boolean(document.querySelector('.hero-title')) })`);
    assert(info.phase === 'idle', `phase=${info.phase}`);
    assert(info.hero, '没回到首页');
    return 'idle';
  });

  // ---------------- E. 夜间被锁时能不能自己走出来
  await check('长按提前结束 → 跳过本轮，不会被立刻锁回去', async () => {
    await ev(`(() => {
      const pad = (n) => String(n).padStart(2, '0');
      const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
      const now = Date.now();
      const s = JSON.parse(JSON.stringify(window.__fox.state.settings));
      s.windows = [{ id: 'qa_now', label: 'QA 当前', start: hm(new Date(now - 3600000)), end: hm(new Date(now + 3600000)), days: [0,1,2,3,4,5,6], enabled: true }];
      s.prewarnMinutes = 0;
      s.enabled = true;
      window.__fox.dispatch({ type: 'SETTINGS', settings: s });
    })()`);
    await sleep(700);
    const locked = await ev(`window.__fox.state.phase`);
    assert(locked === 'locked', `没有进入锁定：${locked}`);

    await ev(`window.__fox.dispatch({ type: 'EMERGENCY_EXIT' })`);
    await sleep(300);
    await click('[data-act="result-ack"]', '收下');
    await sleep(1600); // 跨过好几次 tick，确认不会被重新锁回去
    const info = await ev(`({
      phase: window.__fox.state.phase,
      skipped: window.__fox.state.skippedStartAt,
      hero: document.querySelector('.hero-title')?.textContent || ''
    })`);
    assert(info.phase === 'idle', `又被锁回去了：${info.phase}`);
    assert(info.skipped, '没有记录「本次已跳过」');
    assert(info.hero.includes('不会再锁'), `首页没提示：${info.hero}`);
    return info.hero;
  });

  // ---------------- F. 休息闭环
  await check('任务勾满 → 进入休息（灰度解除）→ 结束休息回到锁定', async () => {
    await goto(`${BASE}/?preview=locked&ms=3600000`);
    for (let i = 0; i < 3; i += 1) {
      await click('.task-item:not(.done) .task-toggle', `第 ${i + 1} 个任务`);
      await sleep(180);
    }
    await sleep(500);
    const rest = await ev(`({
      phase: window.__fox.state.phase,
      tag: document.querySelector('.session-tag')?.className || '',
      gray: document.getElementById('app').classList.contains('is-gray'),
      skip: Boolean(document.querySelector('[data-act="rest-skip"]')),
      until: window.__fox.state.session.rest.untilAt
    })`);
    assert(rest.phase === 'rest', `勾满后 phase=${rest.phase}`);
    assert(rest.tag.includes('rest'), '缺少休息样式');
    assert(!rest.gray, '休息时应解除灰度');
    assert(rest.skip, '缺少「休息好了」按钮');
    await shot('11-rest');
    await click('[data-act="rest-skip"]', '休息好了');
    await sleep(500);
    const back = await ev(`({ phase: window.__fox.state.phase, gray: document.getElementById('app').classList.contains('is-gray') })`);
    assert(back.phase === 'locked', `回不到锁定：${back.phase}`);
    assert(back.gray, '回锁定后灰度应恢复');
    return `休息至 ${new Date(rest.until).toLocaleTimeString('zh-CN')}，已提前结束`;
  });

  // ---------------- F. 设置写入
  await check('设置页开关能落库，并指向「记录」页的时间表', async () => {
    // 先结束演练会话，否则底部导航被锁定层拦住
    await ev(`window.__fox.dispatch({ type: 'EMERGENCY_EXIT' }); window.__fox.dispatch({ type: 'RESULT_ACK' });`);
    await sleep(300);
    await click('.tab[data-view="settings"]', '设置');
    await sleep(250);
    await click('[data-act="set-bool"][data-path="features.grayscale.enabled"]', '灰度开关');
    await sleep(250);
    const info = await ev(`({
      grayEnabled: window.__fox.state.settings.features.grayscale.enabled,
      stored: JSON.parse(localStorage.getItem('foxlock.settings') || '{}').features?.grayscale?.enabled,
      hintGoStats: Boolean(document.querySelector('[data-act="nav"][data-view="stats"]')),
      editorHere: Boolean(document.querySelector('[data-act="win-add"]'))
    })`);
    assert(info.grayEnabled === false, '内存里没关掉');
    assert(info.stored === false, 'localStorage 没写入');
    assert(info.hintGoStats, '设置页缺少「去记录」入口');
    assert(!info.editorHere, '设置页不该再有时间段编辑器');
    return '灰度已关并持久化，时间表已移走';
  });

  await check('「记录」页：限制时段常驻展开，位于总统计与明细之间', async () => {
    await click('.tab[data-view="stats"]', '记录');
    await sleep(300);
    const info = await ev(`(() => {
      const head = [...document.querySelectorAll('.card-head h3')].find((h) => h.textContent.trim() === '限制时段');
      const statGrid = document.querySelector('.stat-grid');
      const detailHead = [...document.querySelectorAll('.card-head h3')].find((h) => h.textContent.trim() === '明细');
      if (!head || !statGrid || !detailHead) return null;
      const r = (el) => el.getBoundingClientRect().top + window.scrollY;
      return {
        order: r(statGrid) < r(head) && r(head) < r(detailHead),
        hasToggle: Boolean(document.querySelector('[data-act="windows-toggle"]')),
        hasAdd: Boolean(document.querySelector('[data-act="win-add"]')),
        hasNight: Boolean(document.querySelector('[data-act="win-add-night"]')),
        cards: document.querySelectorAll('.win-card').length
      };
    })()`);
    assert(info, '记录页没有找到 总统计 / 限制时段 / 明细');
    assert(info.order, '位置不对（应在总统计之下、明细之上）');
    assert(!info.hasToggle, '限制时段不该有折叠开关');
    assert(info.hasAdd && info.hasNight, '缺少「+ 新增」或「＋ 夜间休息」');
    assert(info.cards >= 1, '没有渲染出任何时段卡');

    await click('[data-act="win-add"]', '新增时段');
    await sleep(300);
    const added = await ev(`({
      windows: window.__fox.state.settings.windows.length,
      storedWindows: JSON.parse(localStorage.getItem('foxlock.settings') || '{}').windows?.length
    })`);
    assert(added.windows === 2, `时段数 ${added.windows}`);
    assert(added.storedWindows === 2, '没有落盘');
    return `常驻展开 · ${info.cards} 段 → 新增到 ${added.windows} 段`;
  });

  await check('时段卡能关闭 / 能删除（删除要两步确认）', async () => {
    await click('.tab[data-view="stats"]', '记录');
    await sleep(250);
    // 关掉第一段
    await click('.switch[data-act="win-toggle"]', '第一个时段的开关');
    await sleep(300);
    const off = await ev(`(() => {
      const w = window.__fox.state.settings.windows[0];
      const sw = document.querySelector('.switch[data-act="win-toggle"]');
      return { enabled: w.enabled, pressed: sw.getAttribute('aria-pressed'), faded: document.querySelector('.win-card').classList.contains('disabled') };
    })()`);
    assert(off.enabled === false, '开关没有真的关掉');
    assert(off.pressed === 'false', '开关样式没跟上');
    assert(off.faded, '关闭后的卡片没有变淡');

    // 再打开
    await click('.switch[data-act="win-toggle"]', '第一个时段的开关');
    await sleep(300);
    const on = await ev(`window.__fox.state.settings.windows[0].enabled`);
    assert(on === true, '打得开但关不回来 / 关得掉但打不开');

    // 删除：第一次只点亮，第二次才执行
    const before = await ev(`window.__fox.state.settings.windows.length`);
    await click('[data-act="win-del"]', '删除这段');
    await sleep(300);
    const armed = await ev(`({
      count: window.__fox.state.settings.windows.length,
      label: document.querySelector('[data-act="win-del"]').textContent.trim(),
      danger: document.querySelector('[data-act="win-del"]').classList.contains('danger')
    })`);
    assert(armed.count === before, '第一次点就删了（应该只是要求确认）');
    assert(armed.label.includes('确认'), `按钮文案=${armed.label}`);
    assert(armed.danger, '确认态没有变红');

    await click('[data-act="win-del"]', '确认删除');
    await sleep(400);
    const after = await ev(`({
      count: window.__fox.state.settings.windows.length,
      stored: JSON.parse(localStorage.getItem('foxlock.settings') || '{}').windows?.length,
      cards: document.querySelectorAll('.win-card').length
    })`);
    assert(after.count === before - 1, `删除后时段数 ${after.count}`);
    assert(after.stored === before - 1, '删除没有落盘');
    assert(after.cards === before - 1, `卡片数 ${after.cards}`);
    return `关闭/启用正常 · 删除 ${before} → ${after.count} 段并落盘`;
  });

  await check('明细默认只展开近三天，更早的折叠可展开', async () => {
    await goto(`${BASE}/?seed=rich&view=stats`);
    await sleep(400);
    const before = await ev(`({
      rows: document.querySelectorAll('.record').length,
      days: [...document.querySelectorAll('.record-day')].map((d) => d.textContent.trim()),
      sub: [...document.querySelectorAll('.card-head .sub')].map((s) => s.textContent).find((t) => t.includes('近三天')) || '',
      btn: document.querySelector('[data-act="records-older"]')?.textContent.trim() || ''
    })`);
    assert(before.rows === 3, `默认应只显示近三天 3 条，实际 ${before.rows}`);
    assert(before.days.length === 3, `分组应有 3 天，实际 ${before.days.join('/')}`);
    assert(before.days[0] === '今天', `第一组应是今天：${before.days[0]}`);
    assert(before.btn.includes('展开更早的'), `折叠按钮不对：${before.btn}`);

    await click('[data-act="records-older"]', '展开更早的记录');
    await sleep(300);
    const after = await ev(`({
      rows: document.querySelectorAll('.record').length,
      btn: document.querySelector('[data-act="records-older"]')?.textContent.trim() || ''
    })`);
    assert(after.rows === 9, `展开后应有 9 条，实际 ${after.rows}`);
    assert(after.btn.includes('收起'), `按钮没变成收起：${after.btn}`);
    return `近三天 3 条（今天/昨天/前天）→ 展开后 ${after.rows} 条`;
  });
  await shot('06-settings');

  await check('设置页可以添加重要联系人', async () => {
    await click('.tab[data-view="settings"]', '设置');
    await sleep(250);
    await ev(`(() => { const i = document.querySelector('#contact-name'); i.value = '张老师'; document.querySelector('[data-act="contact-add"]').click(); })()`);
    await sleep(350);
    const info = await ev(`({
      names: [...document.querySelectorAll('.contact-name')].map((n) => n.textContent.trim()),
      stored: JSON.parse(localStorage.getItem('foxlock.settings') || '{}').features?.interrupt?.contacts?.length
    })`);
    assert(info.names.includes('张老师'), `没加上：${info.names}`);
    assert(info.stored >= 1, '名单没有落盘');
    return `名单：${info.names.join('、')}`;
  });

  await check('刷新后设置仍在', async () => {
    const before = await ev(`({
      windows: window.__fox.state.settings.windows.length,
      gray: window.__fox.state.settings.features.grayscale.enabled
    })`);
    await goto(`${BASE}/`);
    const info = await ev(`({
      windows: window.__fox.state.settings.windows.length,
      gray: window.__fox.state.settings.features.grayscale.enabled
    })`);
    assert(info.windows === before.windows, `刷新后时段 ${info.windows}，刷新前 ${before.windows}`);
    assert(info.gray === before.gray, '刷新后灰度开关丢了');
    return `持久化 OK（时段 ${info.windows} 段）`;
  });

  // ---------------- F. 收藏与统计
  await check('收藏册渲染 9 种花 + 连续天数', async () => {
    await click('.tab[data-view="collection"]', '收藏');
    await sleep(250);
    const info = await ev(`({
      flowers: document.querySelectorAll('.flower').length,
      streak: document.querySelector('.streak-num')?.textContent || '',
      imgs: [...document.querySelectorAll('.flower img.flower-art')].map((i) => ({ ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth }))
    })`);
    assert(info.flowers === 9, `花 ${info.flowers}`);
    assert(info.imgs.length === 9, `插画 ${info.imgs.length} 张`);
    assert(info.imgs.every((i) => i.ok && i.w === 256), `有插画没加载出来：${JSON.stringify(info.imgs.filter((i) => !i.ok))}`);
    return `${info.flowers} 种，插画 256px 已加载，连续 ${info.streak} 天`;
  });
  await shot('07-collection');

  await check('花朵详情：点开能看到花语与由来', async () => {
    await goto(`${BASE}/?seed=rich&view=collection`);
    await sleep(300);
    const id = await ev(`(() => {
      const owned = [...document.querySelectorAll('.flower')].find((b) => b.classList.contains('owned'));
      if (!owned) return null;
      owned.click();
      return owned.dataset.id;
    })()`);
    assert(id, '没有已获得的花可以点开');
    await sleep(350);
    const info = await ev(`({
      open: Boolean(document.querySelector('.flower-detail')),
      name: document.querySelector('.flower-detail h3')?.textContent || '',
      lang: document.querySelector('.fd-lang')?.textContent || '',
      poem: document.querySelector('.fd-poem')?.textContent || ''
    })`);
    assert(info.open, '没有展开详情');
    assert(info.lang.includes('花语'), `花语行不对：${info.lang}`);
    assert(info.poem.startsWith('小狐狸'), `由来不对：${info.poem}`);
    return `${info.name} · ${info.lang.replace('花语 · ', '')}`;
  });

  await check('统计页渲染 7 天柱状图', async () => {
    await click('.tab[data-view="stats"]', '记录');
    await sleep(250);
    const info = await ev(`({ bars: document.querySelectorAll('.bar-col').length, cards: document.querySelectorAll('.stat').length })`);
    assert(info.bars === 7, `柱 ${info.bars}`);
    assert(info.cards >= 6, `统计卡 ${info.cards}`);
    return `${info.bars} 天 / ${info.cards} 张统计卡`;
  });
  await shot('08-stats');

  // ---------------- G. 预警页
  await check('预警页可以加任务并折叠', async () => {
    await goto(`${BASE}/?preview=prewarn&ms=120000`);
    const info = await ev(`({ layer: Boolean(document.querySelector('.layer.prewarn')), countdown: document.querySelector('[data-live="prewarn-countdown"]')?.textContent || '' })`);
    assert(info.layer, '没有预警层');
    await ev(`(() => { const i = document.querySelector('#task-input'); i.value = '测试任务'; document.querySelector('[data-act="task-add"]').click(); })()`);
    await sleep(300);
    const tasks = await ev(`window.__fox.state.session.tasks.length`);
    assert(tasks === 1, `任务 ${tasks}`);
    await click('[data-act="prewarn-done"]', '写好了');
    await sleep(250);
    const collapsed = await ev(`document.querySelectorAll('.task-editor').length === 0 && Boolean(document.querySelector('[data-act="prewarn-expand"]'))`);
    assert(collapsed, '没有折叠成紧凑卡片');
    return `倒计时 ${info.countdown}，任务 ${tasks} 条`;
  });
  await shot('09-prewarn');

  await check('结算预览：失败时显示哭泣反馈', async () => {
    await goto(`${BASE}/?preview=result&outcome=left`);
    const info = await ev(`({
      layer: Boolean(document.querySelector('.result-layer.bad')),
      title: document.querySelector('.result-title')?.textContent || '',
      reward: Boolean(document.querySelector('.reward-card'))
    })`);
    assert(info.layer, '没有失败结算层');
    assert(!info.reward, '失败不该发奖励卡');
    return info.title;
  });

  // ---------------- G2. 真实一轮：按时段自动锁定 → 时间加速到结束 → 发花与记录
  await check('完整一轮：自动锁定 → 坚持到结束 → 收藏 +1 且写入历史', async () => {
    await goto(`${BASE}/?view=home`);
    await ev(`(() => {
      const pad = (n) => String(n).padStart(2, '0');
      const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
      const now = Date.now();
      const s = JSON.parse(JSON.stringify(window.__fox.state.settings));
      s.windows = [{ id: 'qa_w', label: 'QA 时段', start: hm(new Date(now - 60000)), end: hm(new Date(now + 70 * 60000)), days: [0,1,2,3,4,5,6], enabled: true }];
      s.prewarnMinutes = 0;
      s.enabled = true;
      s.features.tasks.enabled = false;
      s.features.grayscale.enabled = true;
      s.features.grayscale.dimPercent = 0;
      window.__fox.dispatch({ type: 'SETTINGS', settings: s });
    })()`);
    await sleep(1200);
    const locked = await ev(`({ phase: window.__fox.state.phase, gray: document.getElementById('app').classList.contains('is-gray') })`);
    assert(locked.phase === 'locked', `没有自动进入锁定：${locked.phase}`);
    assert(locked.gray, '自动锁定时没有灰度');

    // 把时间快进两小时，等到这一轮自然结束
    await ev(`window.__fox.clock.shift(2 * 3600 * 1000)`);
    await sleep(900);
    const info = await ev(`({
      phase: window.__fox.state.phase,
      outcome: window.__fox.state.result?.outcome,
      reward: window.__fox.state.result?.reward,
      rewardCard: Boolean(document.querySelector('.reward-card')),
      flowers: Object.keys(JSON.parse(localStorage.getItem('foxlock.collection') || '{}').flowers || {}).length,
      successes: JSON.parse(localStorage.getItem('foxlock.collection') || '{}').successes,
      history: (JSON.parse(localStorage.getItem('foxlock.history') || '[]')).length,
      streak: JSON.parse(localStorage.getItem('foxlock.collection') || '{}').streakDays
    })`);
    assert(info.phase === 'result', `phase=${info.phase}`);
    assert(info.outcome === 'success', `outcome=${info.outcome}`);
    assert(info.flowers >= 1, '收藏册没有新增花');
    assert(info.successes >= 1, 'successes 没有累加');
    assert(info.history >= 1, '历史没有写入');
    assert(info.rewardCard, '结算页没有奖励卡');
    assert(info.streak >= 1, '连续天数没算');
    return `成功 +1，收藏 ${info.flowers} 种，历史 ${info.history} 条`;
  });
  await shot('12-result-success');

  // 收尾：把时间表换回不会触发的空窗，避免后面的布局检查一启动就被夜间限制锁住
  await ev(`(() => {
    const s = JSON.parse(JSON.stringify(window.__fox.state.settings));
    s.windows = [{ id: 'qa_idle', label: 'QA 空窗', start: '03:00', end: '03:01', days: [0,1,2,3,4,5,6], enabled: true }];
    s.prewarnMinutes = 0;
    try { localStorage.setItem('foxlock.settings', JSON.stringify(s)); } catch {}
    return true;
  })()`);

  // ---------------- H. 布局体检（没有视觉回归工具，就用几何断言兜底）
  async function setViewport(width, height) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  await check('三个常用宽度都没有横向溢出', async () => {
    const sizes = [
      [390, 844],
      [768, 1024],
      [1280, 800],
    ];
    const notes = [];
    for (const [w, h] of sizes) {
      await setViewport(w, h);
      await goto(`${BASE}/`);
      const info = await ev(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })`);
      assert(info.sw <= info.iw + 1, `${w}px 视口溢出：${info.sw} > ${info.iw}`);
      notes.push(`${w}px→${info.sw}`);
    }
    return notes.join('，');
  });

  await check('锁定页：狐狸在舞台内、按钮不越界、整页不用滚', async () => {
    await setViewport(390, 844);
    await goto(`${BASE}/?preview=locked&ms=3600000`);
    const info = await ev(`(() => {
      const stage = document.querySelector('.fox-stage').getBoundingClientRect();
      const foxEl = document.querySelector('.fox-figure');
      const fox = foxEl ? foxEl.getBoundingClientRect() : null;
      const btns = [...document.querySelectorAll('.session-actions button')].map((b) => b.getBoundingClientRect());
      const hud = document.querySelector('.collect-hud')?.getBoundingClientRect();
      const inner = document.querySelector('.session-inner');
      return {
        stage: { top: stage.top, bottom: stage.bottom, left: stage.left, right: stage.right },
        fox: fox ? { top: fox.top, bottom: fox.bottom, left: fox.left, right: fox.right, w: fox.width, h: fox.height } : null,
        hudTop: hud ? hud.top : null,
        btnCount: btns.length,
        minBtnH: btns.length ? Math.min(...btns.map((b) => b.height)) : 0,
        btnOut: btns.some((b) => b.left < -1 || b.right > window.innerWidth + 1),
        innerFits: inner.scrollHeight <= inner.clientHeight + 6,
        innerH: [inner.scrollHeight, inner.clientHeight]
      };
    })()`);
    assert(info.fox, '找不到狐狸元素');
    assert(info.fox.w > 80 && info.fox.h > 80, `狐狸尺寸异常 ${info.fox.w}×${info.fox.h}`);
    assert(info.fox.top >= info.stage.top - 2 && info.fox.bottom <= info.stage.bottom + 2, '狐狸超出舞台');
    assert(info.fox.left >= info.stage.left - 2 && info.fox.right <= info.stage.right + 2, '狐狸超出舞台横向');
    assert(!info.btnOut, '操作按钮横向越界');
    assert(info.minBtnH >= 34, `按钮高度只有 ${info.minBtnH}px`);
    assert(info.innerFits, `锁定页需要滚动：${info.innerH.join('/')}`);
    return `狐狸 ${Math.round(info.fox.w)}×${Math.round(info.fox.h)}，最小按钮 ${Math.round(info.minBtnH)}px`;
  });
  await shot('10-locked-390');

  await check('数字矩阵面板在 390px 下完整可见', async () => {
    await ev(`window.__fox.state.session.matrix.cooldownUntil = 0; window.__fox.dispatch({ type: 'MATRIX_TRIGGER' })`);
    await sleep(350);
    const info = await ev(`(() => {
      const panel = document.querySelector('.matrix-panel')?.getBoundingClientRect();
      const cells = [...document.querySelectorAll('.matrix-cell')].map((c) => c.getBoundingClientRect());
      return panel ? { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right,
        minCell: Math.min(...cells.map((c) => c.width)), count: cells.length,
        inView: panel.top >= 0 && panel.bottom <= window.innerHeight } : null;
    })()`);
    assert(info, '矩阵面板没渲染');
    assert(info.inView, '面板超出视口');
    assert(info.minCell >= 24, `格子太小 ${info.minCell}px`);
    return `${info.count} 格，最小格 ${Math.round(info.minCell)}px`;
  });

  // ---------------- I. 临时放行参数
  await check('?off=1 一键关闭总开关并落盘，?on=1 恢复', async () => {
    await goto(`${BASE}/?off=1`);
    const off = await ev(`({
      enabled: window.__fox.state.settings.enabled,
      stored: JSON.parse(localStorage.getItem('foxlock.settings') || '{}').enabled,
      phase: window.__fox.state.phase
    })`);
    assert(off.enabled === false, '内存里没关掉');
    assert(off.stored === false, '没有落盘');
    assert(off.phase === 'idle', `phase=${off.phase}`);
    await goto(`${BASE}/?on=1`);
    const on = await ev(`JSON.parse(localStorage.getItem('foxlock.settings') || '{}').enabled`);
    assert(on === true, '恢复失败');
    return '关闭 → 恢复';
  });

  await check('?night=1 恢复夜间休息（22:30–07:00），且不会把人立刻锁住', async () => {
    await goto(`${BASE}/?night=1`);
    const info = await ev(`(() => {
      const d = new Date();
      const inWindow = d.getHours() >= 22 || d.getHours() < 7;
      return {
        enabled: window.__fox.state.settings.enabled,
        night: window.__fox.state.settings.windows.filter((w) => w.start === '22:30' && w.end === '07:00' && w.enabled).length,
        phase: window.__fox.state.phase,
        skipped: window.__fox.state.skippedStartAt,
        stored: JSON.parse(localStorage.getItem('foxlock.settings') || '{}').enabled,
        inWindow
      };
    })()`);
    assert(info.enabled === true, '总开关没打开');
    assert(info.night === 1, `夜间时段没恢复（${info.night}）`);
    assert(info.stored === true, '没落盘');
    assert(info.phase === 'idle', `恢复后应保持 idle，实际 ${info.phase}`);
    if (info.inWindow) assert(info.skipped, '当前正好在夜间时段里，应当跳过今晚这一次');
    return `夜间时段 1 段，${info.inWindow ? '今晚已跳过' : '当前不在时段内'}`;
  });

  // ---------------- I2. 重要联系人：真实走一遍 HTTP 桥 → 响铃 → 暂停 → 恢复
  await check('收到重要联系人消息 → 暂停计时 → 手动恢复并顺延', async () => {
    await ev(`(() => {
      const s = JSON.parse(JSON.stringify(window.__fox.state.settings));
      s.features.interrupt = {
        ...s.features.interrupt,
        enabled: true,
        autoPause: true,
        cooldownSeconds: 5,
        contacts: [{ id: 'c1', app: 'wechat', name: '张老师', enabled: true }]
      };
      window.__fox.dispatch({ type: 'SETTINGS', settings: s });
      window.__fox.dispatch({ type: 'PREVIEW_START', durationMs: 30 * 60 * 1000, tasks: [] });
    })()`);
    await sleep(600);
    const before = await ev(`window.__fox.state.phase`);
    assert(before === 'locked', `没进入锁定：${before}`);

    // 外部程序触发：GET /api/interrupt（Tasker / 桌面脚本就是这么调的）
    const res = await fetch(`${BASE}/api/interrupt?app=wechat&contact=${encodeURIComponent('张老师')}`);
    assert(res.ok, '本机消息桥没有响应');
    await sleep(2600); // 页面每 1.5s 轮询一次

    const paused = await ev(`({
      active: window.__fox.state.session?.pause?.active,
      count: window.__fox.state.session?.pause?.count,
      banner: Boolean(document.querySelector('.interrupt-banner')),
      btn: Boolean(document.querySelector('[data-act="resume-timer"]')),
      gray: document.getElementById('app').classList.contains('is-gray')
    })`);
    assert(paused.active === true, '没有自动暂停');
    assert(paused.banner, '没有暂停横幅');
    assert(paused.btn, '没有「恢复计时」按钮');
    assert(!paused.gray, '暂停时应解除灰度');

    // 冻结验证：暂停 2 秒后倒计时不应该变
    const c1 = await ev(`document.querySelector('[data-live="session-countdown"]')?.textContent || ''`);
    await sleep(2000);
    const c2 = await ev(`document.querySelector('[data-live="session-countdown"]')?.textContent || ''`);
    assert(c1 === c2, `暂停期间倒计时仍在走：${c1} → ${c2}`);

    await click('[data-act="resume-timer"]', '恢复计时');
    await sleep(700);
    const after = await ev(`({
      active: window.__fox.state.session?.pause?.active,
      total: window.__fox.state.session?.pause?.totalMs,
      gray: document.getElementById('app').classList.contains('is-gray'),
      phase: window.__fox.state.phase
    })`);
    assert(after.active === false, '没有恢复');
    assert(after.total >= 1500, `暂停时长没记：${after.total}`);
    assert(after.gray, '恢复后应重新变灰');

    // 收尾，别把预览会话留给后面的用例
    await ev(`window.__fox.dispatch({ type: 'EMERGENCY_EXIT' }); window.__fox.dispatch({ type: 'RESULT_ACK' });
      window.__fox.dispatch({ type: 'SETTINGS', settings: JSON.parse(JSON.stringify(window.__fox.state.settings)) });`);
    await sleep(400);
    return `暂停 ${Math.round(after.total / 1000)} 秒后恢复，结束时间已顺延`;
  });

  // ---------------- J. 无异常收尾
  await check('整个流程没有未捕获异常', () => {
    assert(errors.length === 0, errors.slice(0, 4).join(' | '));
    return '0 条';
  });

  cdp.close();
  proc.kill();
  await sleep(300);
  await fs.rm(PROFILE, { recursive: true, force: true }).catch(() => {});

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  if (failed) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error('\n验收脚本异常：', err);
  process.exitCode = 1;
});
