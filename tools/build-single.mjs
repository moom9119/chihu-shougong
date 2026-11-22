/**
 * tools/build-single.mjs —— 把多模块应用打成一个可双击打开的单文件 HTML。
 *
 * 为什么需要：ES Modules 无法从 file:// 加载（CORS），所以要么起本地服务，
 * 要么把模块、样式、图片全部内联。这里做后者。两个产物：
 *
 *   node tools/build-single.mjs            → 演示.html（原型：带演示栏、测试模式、seed 示例数据）
 *   node tools/build-single.mjs --prod     → 赤狐收工.html（评审交付版：无演示栏、无调试通道）
 *
 * 共同点：全部 CSS / JS / 立绘 / 花朵插画 / 背景音乐都内联成 base64，单个文件拷到哪儿都能双击打开。
 *
 * 其他参数：
 *   --out <文件名>   自定义输出文件名
 *   --no-bgm         不内联背景音乐（体积从 ~17 MB 回到 ~2.7 MB，静音版）
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const PROD = argv.includes('--prod');
const NO_BGM = argv.includes('--no-bgm');
const outName = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : PROD ? '赤狐收工.html' : '演示.html';
const OUT = path.join(ROOT, outName);

const ENTRY = 'src/main.js';
const CSS_FILES = ['src/styles/tokens.css', 'src/styles/base.css', 'src/styles/components.css', 'src/styles/views.css', 'src/styles/session.css'];
const IMAGES = { collect: 'assets/fox/fox-collect.png', happy: 'assets/fox/fox-happy.png', sad: 'assets/fox/fox-sad.png' };
// 背景音乐：找第一个存在的文件，装进单文件里（丢了就当没有音乐，演示页照常能跑）
const BGM_CANDIDATES = ['assets/music/bgm.mp3', 'assets/music/bgm.m4a'];

// ---------------------------------------------------------------- 极简打包

const modules = new Map();

function resolveId(fromId, spec) {
  if (!spec.startsWith('.')) throw new Error(`不支持的裸模块引用：${spec}`);
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromId), spec));
}

function transform(id) {
  if (modules.has(id)) return;
  let code = readFileSync(path.join(ROOT, id), 'utf8');
  const deps = [];
  const exports = [];

  code = code.replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm, (m, clause, spec) => {
    const depId = resolveId(id, spec);
    deps.push(depId);
    const inner = clause.trim().replace(/^\{/, '').replace(/\}$/, '');
    const bindings = inner
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [orig, alias] = s.split(/\s+as\s+/);
        return alias ? `${orig}: ${alias}` : orig;
      });
    return `const { ${bindings.join(', ')} } = __req(${JSON.stringify(depId)});`;
  });

  code = code.replace(/^export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/gm, (m, asyncKw, name) => {
    exports.push(name);
    return `${asyncKw || ''}function ${name}`;
  });
  code = code.replace(/^export\s+const\s+([A-Za-z0-9_$]+)/gm, (m, name) => {
    exports.push(name);
    return `const ${name}`;
  });
  code = code.replace(/^export\s+let\s+([A-Za-z0-9_$]+)/gm, (m, name) => {
    exports.push(name);
    return `let ${name}`;
  });
  code = code.replace(/^export\s+class\s+([A-Za-z0-9_$]+)/gm, (m, name) => {
    exports.push(name);
    return `class ${name}`;
  });

  const left = code.match(/^\s*(import|export)\b.*$/m);
  if (left) throw new Error(`${id} 里还有没处理的模块语句：${left[0].trim()}`);

  modules.set(id, { code, deps, exports });
  for (const dep of deps) transform(dep);
}

transform(ENTRY);

const runtime = `
const __mods = {};
const __cache = {};
function __def(id, fn) { __mods[id] = fn; }
function __req(id) {
  if (__cache[id]) return __cache[id];
  const exp = {};
  __cache[id] = exp;
  const fn = __mods[id];
  if (!fn) throw new Error('缺少模块 ' + id);
  fn(exp, __req);
  return exp;
}
`;

const body = [...modules.entries()]
  .map(([id, m]) => {
    const tail = m.exports.map((name) => `  __exports.${name} = ${name};`).join('\n');
    return `__def(${JSON.stringify(id)}, function (__exports, __req) {\n${m.code}\n${tail}\n});`;
  })
  .join('\n\n');

const bundle = `${runtime}\n${body}\n\n__req(${JSON.stringify(ENTRY)});`;

// ---------------------------------------------------------------- 资源

const css = CSS_FILES.map((f) => `/* ===== ${f} ===== */\n${readFileSync(path.join(ROOT, f), 'utf8')}`).join('\n');
const assets = Object.fromEntries(
  Object.entries(IMAGES).map(([kind, file]) => {
    const buf = readFileSync(path.join(ROOT, file));
    return [kind, `data:image/png;base64,${buf.toString('base64')}`];
  }),
);

// 花朵图鉴的插画（assets/flowers/*.png）也一起内联，单文件才真的"单文件"
const FLOWER_DIR = path.join(ROOT, 'assets', 'flowers');
const flowerAssets = {};
for (const file of readdirSync(FLOWER_DIR).sort()) {
  if (!file.endsWith('.png')) continue;
  const id = file.replace(/\.png$/, '');
  flowerAssets[id] = `data:image/png;base64,${readFileSync(path.join(FLOWER_DIR, file)).toString('base64')}`;
}

// 背景音乐（11 MB 的 mp3 → base64 后约 15 MB，单文件会明显变大，
// 但换来"拷走照样有音乐"，对演示页这个取舍是值的）
let bgmUri = '';
let bgmBytes = 0;
const bgmFile = NO_BGM ? null : BGM_CANDIDATES.find((f) => existsSync(path.join(ROOT, f)));
if (bgmFile) {
  const buf = readFileSync(path.join(ROOT, bgmFile));
  bgmBytes = buf.length;
  const mime = bgmFile.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg';
  bgmUri = `data:${mime};base64,${buf.toString('base64')}`;
}

// ---------------------------------------------------------------- 演示栏

const RAIL_CSS = `
.demo-rail {
  position: fixed;
  left: 50%;
  bottom: 76px;
  transform: translateX(-50%);
  z-index: 999;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 5px;
  width: min(94vw, 520px);
  padding: 8px;
  border-radius: 16px;
  background: rgba(14, 12, 22, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(12px);
  font-family: var(--font);
}
.demo-rail[hidden] { display: none; }
.demo-rail button {
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #e9e4f0;
  font-size: 11.5px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.1s ease;
}
.demo-rail button:hover { background: rgba(255, 157, 92, 0.28); }
.demo-rail button:active { transform: scale(0.95); }
.demo-rail .rail-sep { width: 1px; align-self: stretch; background: rgba(255, 255, 255, 0.12); margin: 0 2px; }
.demo-rail .rail-hide { margin-left: 4px; color: #9c95ad; }
.demo-fab {
  position: fixed;
  right: 14px;
  bottom: 80px;
  z-index: 999;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(14, 12, 22, 0.85);
  color: #ffb27a;
  font-size: 18px;
  cursor: pointer;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
}
.demo-fab[hidden] { display: none; }
.demo-tip {
  position: fixed;
  left: 50%;
  bottom: 138px;
  transform: translateX(-50%);
  z-index: 999;
  padding: 7px 12px;
  border-radius: 999px;
  background: rgba(14, 12, 22, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #cfc8db;
  font-size: 11.5px;
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
  font-family: var(--font);
}
.demo-tip.show { opacity: 1; }
`;

const RAIL_JS = `
(function () {
  var TASKS = [
    { id: 'd1', text: '写完今天的工作复盘', done: false, doneAt: null },
    { id: 'd2', text: '读 20 分钟书', done: false, doneAt: null },
    { id: 'd3', text: '把手机放到桌子另一头', done: false, doneAt: null }
  ];
  var rail, fab, tip, tipTimer;
  var tourTimer = null;
  var tourIndex = 0;
  var TOUR = ['home', 'prewarn', 'locked', 'matrix', 'rest', 'success', 'collection'];

  function F() { return window.__fox; }
  function ready() { return !!(window.__fox && window.__fox.state && window.__fox.ui); }

  function tourButton() { return rail ? rail.querySelector('[data-tour]') : null; }
  function stopTour() {
    if (tourTimer) { clearInterval(tourTimer); tourTimer = null; }
    var b = tourButton();
    if (b) b.textContent = '▶ 自动演示';
  }
  function startTour() {
    stopTour();
    tourIndex = 0;
    try { ACTIONS[TOUR[0]](); } catch (e) { console.error(e); }
    tourIndex = 1;
    tourTimer = setInterval(function () {
      if (tourIndex >= TOUR.length) { stopTour(); return; }
      var key = TOUR[tourIndex++];
      try { ACTIONS[key](); } catch (e) { console.error(e); }
    }, 3600);
    var b = tourButton();
    if (b) b.textContent = '■ 停止演示';
  }

  function ensureIdle() {
    var st = F().state;
    if (st.phase === 'result') F().dispatch({ type: 'RESULT_ACK' });
    else if (st.phase !== 'idle') {
      F().dispatch({ type: 'EMERGENCY_EXIT' });
      F().dispatch({ type: 'RESULT_ACK' });
    }
  }
  function go(view) { ensureIdle(); F().ui.view = view; F().render(); }
  function startLocked(done) {
    ensureIdle();
    F().dispatch({
      type: 'PREVIEW_START',
      durationMs: 45 * 60 * 1000,
      tasks: TASKS.map(function (t) {
        return { id: t.id, text: t.text, done: !!done, doneAt: done ? Date.now() : null };
      })
    });
  }
  function toast(text) {
    if (!tip) return;
    tip.textContent = text;
    tip.classList.add('show');
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () { tip.classList.remove('show'); }, 1600);
  }

  var ACTIONS = {
    home: function () { go('home'); },
    settings: function () { go('settings'); },
    collection: function () { go('collection'); },
    stats: function () { go('stats'); },
    prewarn: function () { ensureIdle(); F().dispatch({ type: 'PREVIEW_START', phase: 'prewarn', durationMs: 180000 }); },
    locked: function () { startLocked(false); },
    matrix: function () {
      if (F().state.phase !== 'locked') startLocked(false);
      setTimeout(function () {
        var st = F().state;
        if (st.session) st.session.matrix.cooldownUntil = 0;
        F().dispatch({ type: 'MATRIX_TRIGGER' });
      }, 450);
    },
    rest: function () { startLocked(true); },
    interrupt: function () {
      if (F().state.phase !== 'locked') startLocked(false);
      setTimeout(function () {
        F().dispatch({ type: 'INCOMING_MESSAGE', app: 'wechat', contact: '张老师' });
      }, 400);
    },
    success: function () {
      ensureIdle();
      F().dispatch({ type: 'PREVIEW_START', phase: 'result', reward: { flowerId: 'rose', isNewSpecies: true, streakDays: 5 } });
    },
    fail: function () {
      ensureIdle();
      F().dispatch({ type: 'PREVIEW_START', phase: 'result', outcome: 'left', reward: null });
    },
    tour: function () { if (tourTimer) stopTour(); else startTour(); }
  };

  var BUTTONS = [
    ['首页', 'home'], ['设置', 'settings'], ['收藏', 'collection'], ['统计', 'stats'],
    ['|'],
    ['预警', 'prewarn'], ['锁定', 'locked'], ['矩阵', 'matrix'], ['休息', 'rest'], ['重要消息', 'interrupt'],
    ['|'],
    ['成功结算', 'success'], ['失败结算', 'fail'],
    ['▶ 自动演示', 'tour']
  ];

  function build() {
    rail = document.createElement('div');
    rail.className = 'demo-rail';
    BUTTONS.forEach(function (item) {
      if (item[0] === '|') {
        var sep = document.createElement('span');
        sep.className = 'rail-sep';
        rail.appendChild(sep);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = item[0];
      if (item[1] === 'tour') b.setAttribute('data-tour', '1');
      b.addEventListener('click', function () {
        if (item[1] !== 'tour') stopTour();
        try { ACTIONS[item[1]](); } catch (err) { console.error(err); }
        toast('演示：' + item[0].replace('▶ ', '').replace('■ ', ''));
      });
      rail.appendChild(b);
    });
    var hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'rail-hide';
    hide.textContent = '收起';
    hide.addEventListener('click', function () { rail.hidden = true; fab.hidden = false; });
    rail.appendChild(hide);

    fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'demo-fab';
    fab.textContent = '🎬';
    fab.hidden = true;
    fab.title = '打开演示栏';
    fab.addEventListener('click', function () { rail.hidden = false; fab.hidden = true; });

    tip = document.createElement('div');
    tip.className = 'demo-tip';

    document.body.appendChild(rail);
    document.body.appendChild(fab);
    document.body.appendChild(tip);
  }

  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (ready()) {
      clearInterval(timer);
      build();
      go('home');
    } else if (tries > 100) {
      clearInterval(timer);
    }
  }, 60);
})();
`;

// ---------------------------------------------------------------- 组装

// --prod：评审交付版。去掉演示栏、测试模式、seed 数据、调试句柄，
// 注入 window.__FOX_PROD 让 main.js 关掉所有原型通道（URL 参数 / 本机消息桥）。
const headScripts = PROD
  ? `/* 评审交付版：没有任何调试开关，行为只由「设置」和「时间表」决定 */
window.__FOX_ASSETS = ${JSON.stringify(assets)};
window.__FLOWER_ASSETS = ${JSON.stringify(flowerAssets)};
window.__FOX_PROD = true;`
  : `/* 立绘与花朵插画以 base64 内联，保证整个文件可以单独拷贝、离线打开 */
window.__FOX_ASSETS = ${JSON.stringify(assets)};
window.__FLOWER_ASSETS = ${JSON.stringify(flowerAssets)};
/* 演示页默认测试模式：不会因为默认 22:30–07:00 的时段被锁住，用演示栏手动切状态 */
window.__FOX_TEST = true;
/* 演示页顺带灌一份示例收藏，收藏册里能直接看到九种花的插画 */
window.__FOX_SEED = true;`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark light" />
<meta name="description" content="赤狐收工 · 屏幕时间限制管理器（单文件静态版）" />
<title>${PROD ? '赤狐收工 · 屏幕时间限制' : '赤狐收工 · 单文件演示'}</title>
<style>
${css}
${PROD ? '' : RAIL_CSS}
</style>
</head>
<body>
<div id="app" class="app-root" data-phase="boot">
  <div class="boot-splash">
    <div class="boot-fox">🦊</div>
    <p class="boot-text">正在唤醒小狐狸…</p>
  </div>
</div>

<script>
${headScripts}
</script>

<script>
/* 背景音乐内联（base64 后约 15 MB）。空串 = 这次打包没找到音乐，应用照常能跑 */
window.__FOX_BGM = ${JSON.stringify(bgmUri)};
</script>

<script>
${bundle}
</script>
${PROD ? '' : `<script>\n${RAIL_JS}\n</script>`}
</body>
</html>
`;

writeFileSync(OUT, html, 'utf8');
const size = statSync(OUT).size;
console.log(`已生成 ${outName}（${PROD ? '评审交付版' : '原型演示版'}）`);
console.log(`  模块 ${modules.size} 个 / CSS ${CSS_FILES.length} 个 / 内联图片 ${Object.keys(assets).length + Object.keys(flowerAssets).length} 张（狐狸 ${Object.keys(assets).length} + 花朵 ${Object.keys(flowerAssets).length}）`);
const imgBytes = Object.values(assets).reduce((s, v) => s + v.length, 0) + Object.values(flowerAssets).reduce((s, v) => s + v.length, 0);
console.log(`  体积 ${(size / 1024 / 1024).toFixed(2)} MB（图片占 ${(imgBytes / 1024 / 1024).toFixed(2)} MB）`);
if (bgmFile) {
  console.log(`  背景音乐 ${bgmFile} → base64 ${(bgmUri.length / 1024 / 1024).toFixed(2)} MB（原文件 ${(bgmBytes / 1024 / 1024).toFixed(2)} MB）`);
} else if (NO_BGM) {
  console.log('  背景音乐：按 --no-bgm 跳过（静音版）');
} else {
  console.log(`  背景音乐：没找到（${BGM_CANDIDATES.join(' / ')}），应用不会出声`);
}
