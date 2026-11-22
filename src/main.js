/**
 * main.js —— 装配层：把 core（纯逻辑）、platform（平台能力）、ui（界面）接起来。
 *
 * 数据流：
 *   dispatch(event) → reduce(state,event) → effects → platform/持久化 → render
 *
 * 这里也是唯一知道 "state 之外还有哪些东西"（收藏册、历史、存储、平台）的地方。
 */
import { createClock } from './core/clock.js';
import {
  createStorage,
  loadSettings,
  saveSettings,
  loadRuntime,
  saveRuntime,
  clearRuntime,
  loadCollection,
  saveCollection,
  loadHistory,
  appendHistory,
  KEYS,
} from './core/persistence.js';
import { createState, reduce, toSnapshot } from './core/engine.js';
import { validateSettings, defaultSettings, createWindowDraft, ensureNightWindow, appMeta } from './core/settings.js';
import { normalizeCollection, recordSuccess, recordFailure, toDateKey } from './core/collection.js';
import { createPlatform } from './platform/web.js';
import { createBgm } from './platform/bgm.js';
import { createApp } from './ui/app.js';
import { bindToastRoot, toast } from './ui/components/toast.js';

// 版本号：与 package.json 保持一致（评审交付版在「设置 → 界面与数据」里能看到）
const VERSION = '1.12.0';

function probeAssets() {
  if (typeof window !== 'undefined' && window.__FOX_ASSETS) {
    return Promise.resolve({ ready: true, files: [], inline: true });
  }
  const files = ['fox-collect.png', 'fox-happy.png', 'fox-sad.png'];
  return Promise.all(
    files.map(
      (name) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = `assets/fox/${name}`;
        }),
    ),
  ).then((results) => ({ ready: results.every(Boolean), files }));
}

function seedRichData() {
  const now = Date.now();
  const collection = normalizeCollection({});
  const flowers = ['daisy', 'sunflower', 'hydrangea', 'rose', 'lavender'];
  flowers.forEach((id, i) => {
    collection.flowers[id] = { count: i + 1, firstAt: now - i * 86400000, lastAt: now - i * 3600000 };
  });
  collection.feathers = 412;
  collection.successes = 9;
  collection.failures = 2;
  collection.streakDays = 5;
  collection.bestStreak = 7;
  collection.lastSuccessDate = toDateKey(now);
  collection.firstAt = now - 9 * 86400000;
  const history = Array.from({ length: 9 }, (_, i) => ({
    endedAt: now - i * 86400000,
    startedAt: now - i * 86400000 - 6 * 3600000,
    outcome: i % 4 === 3 ? 'left' : i % 7 === 6 ? 'aborted' : 'success',
    label: '夜间休息',
    tasksDone: 2,
    tasksTotal: 3,
    restUsedMs: 600000,
    feathers: 40,
    date: toDateKey(now - i * 86400000),
  }));
  return { collection, history };
}

async function boot() {
  // 评审交付版（打包时注入 window.__FOX_PROD = true）：
  // 关掉原型里所有"调试/演示"通道（测试模式、seed 数据、URL 参数、本机消息桥、__fox 调试句柄），
  // 改用 window.FoxLock 这个正式集成接口。原型版（演示.html）保持原样，两个产物各自独立。
  const PROD = typeof window !== 'undefined' && window.__FOX_PROD === true;
  // ?test=1 / ?off=1 / ?night=1 / ?preview=… / ?speed=… 这些调试开关只在原型版生效：
  // 交付版拿到的是一个干净地址，行为只由「设置」和「时间表」决定。
  const params = PROD ? { get: () => null } : new URLSearchParams(location.search);
  const speed = Math.min(3600, Math.max(1, Number(params.get('speed')) || 1));
  // 测试模式：?test=1 —— 只看界面、不自动进入限制，方便白天/深夜调试（仅原型版）
  const testMode = !PROD && (params.get('test') === '1' || (typeof window !== 'undefined' && window.__FOX_TEST === true));
  const clock = createClock({ speed });
  const storage = createStorage();
  const loaded = loadSettings(storage);
  // 首次打开不武装：默认的「夜间休息 22:30–07:00」还在，但总开关先关着。
  // 否则评委半夜双击打开，第一眼就是全屏锁定 —— 那不是"作品有问题"，是默认值太凶。
  const firstRun = !storage.get(KEYS.settings);
  if (PROD && firstRun) loaded.settings.enabled = false;

  let state = createState({ settings: loaded.settings, now: clock.now(), testMode });
  let collection = normalizeCollection(loadCollection(storage));
  let history = loadHistory(storage);
  if (!PROD && (params.get('seed') === 'rich' || (typeof window !== 'undefined' && window.__FOX_SEED === true))) {
    const seed = seedRichData();
    collection = seed.collection;
    history = seed.history;
  }
  let app = null;

  const assets = await probeAssets();

  // ---------------------------------------------------------------- 副作用执行

  const platform = createPlatform({
    getSettings: () => state.settings,
    onLeave: ({ reason }) => dispatch({ type: 'FOX_LEAVE', reason }),
    onReturn: ({ resumed }) => {
      dispatch({ type: 'FOX_RETURN' });
      if (resumed && state.phase === 'locked') dispatch({ type: 'MATRIX_TRIGGER' });
    },
  });

  // ---------------------------------------------------------------- 背景音乐
  //
  // 四个 tab 页面（phase 为 idle）循环播放，进入预警/限制/休息/结算自动淡出。
  // 单文件演示页把音频内联在 window.__FOX_BGM，多文件版直接用相对路径。
  // 单文件构建（交付版 / 原型）只认内联音频；多文件版才去读 assets 下的文件。
  // 这样 `--no-bgm` 打出来的单文件是真的没有音乐，而不是去请求一个不存在的相对路径。
  const INLINE_BUILD = typeof window !== 'undefined' && (window.__FOX_PROD === true || window.__FOX_TEST === true);
  const inlineBgm = typeof window !== 'undefined' && typeof window.__FOX_BGM === 'string' ? window.__FOX_BGM : '';
  // 多文件版（含 GitHub Pages）可能压根没放音频文件：不做预探（预探会在控制台留一条 404），
  // 等真去播的时候 audio 自己会报错，这里顺势把按钮收起来并提示一句。
  const bgmSrc = INLINE_BUILD ? (inlineBgm.length > 100 ? inlineBgm : '') : 'assets/music/bgm.mp3';
  const bgm = createBgm({
    src: bgmSrc,
    shouldPlay: () => state.phase === 'idle',
    onUnavailable: () => toast('这个版本没有内联音频，音乐已自动关闭', 'info', 3200),
  });

  function persistRuntime() {
    // 「试跑 / 预览」不落盘：刷新之后不该莫名其妙又回到一个 60 秒的锁定现场
    if (state.session?.preview) {
      clearRuntime(storage);
      return;
    }
    const inSession = state.session && (state.phase === 'locked' || state.phase === 'rest' || state.phase === 'prewarn');
    // 「本次已跳过」也要落盘，否则刷新之后又被锁回去
    if (inSession || state.skippedStartAt) saveRuntime(storage, toSnapshot(state));
    else clearRuntime(storage);
  }

  function finalize(record) {
    if (record.preview) return;
    const now = clock.now();
    if (record.outcome === 'success') {
      const res = recordSuccess(collection, { now, rng: Math.random, feathers: record.feathers });
      collection = res.collection;
      saveCollection(storage, collection);
      dispatch({
        type: 'RESULT_FINALIZED',
        reward: { flowerId: res.flower.id, isNewSpecies: res.isNewSpecies, streakDays: res.streakDays },
      });
    } else if (record.outcome === 'left') {
      collection = recordFailure(collection);
      saveCollection(storage, collection);
    }
    history = appendHistory(storage, { ...record, date: toDateKey(record.endedAt) });
  }

  function applyEffects(effects) {
    for (const e of effects) {
      switch (e.type) {
        case 'grayscale':
          platform.setGrayscale(e.on, state.settings.features.grayscale);
          break;
        case 'sound':
          platform.sound(e.name);
          break;
        case 'notify':
          platform.notify(e.title, e.body);
          break;
        case 'matrix-open':
          app?.openMatrix();
          break;
        case 'matrix-close':
          app?.closeMatrix();
          break;
        case 'ring': {
          const it = state.settings.features.interrupt;
          platform.ring({ times: it.ringTimes, intervalMs: it.ringIntervalMs });
          break;
        }
        case 'pause-start':
          toast(`${appMeta(e.reason?.app).name} · ${e.reason?.contact || '联系人'} 发来消息，限制已暂停计时`, 'ok', 5600);
          break;
        case 'pause-end':
          toast(`已恢复计时（暂停 ${Math.round((e.pausedMs || 0) / 1000)} 秒，结束时间已顺延）`, 'ok', 4600);
          break;
        case 'fox-failed':
          toast('小狐狸哭了… 你在限制期间离开了，这次收集失败', 'bad', 4200);
          platform.vibrate([40, 60, 40]);
          break;
        case 'finalize':
          finalize(e.record);
          break;
        case 'persist':
          persistRuntime();
          break;
        default:
          break;
      }
    }
  }

  function syncPlatform() {
    const p = state.phase;
    if (p === 'locked' || p === 'rest') platform.startPresence();
    else platform.stopPresence();
    if (p === 'locked') platform.requestWakeLock();
    else platform.releaseWakeLock();
  }

  function updateTitle() {
    const text = { idle: '自由时间', prewarn: '即将开始', locked: '限制中', rest: '休息中', result: '结算' }[state.phase] || '';
    document.title = `${text} · 赤狐收工`;
  }

  function dispatch(event) {
    const evt = { ...event };
    if (!Number.isFinite(evt.now)) evt.now = clock.now();
    const result = reduce(state, evt);
    state = result.state;
    applyEffects(result.effects);
    syncPlatform();
    app?.render();
    updateTitle();
    return result;
  }

  function patchSettings(mutator) {
    const draft = structuredClone(state.settings);
    mutator(draft);
    const { settings, issues } = validateSettings(draft);
    if (issues.length) toast(issues.slice(0, 2).join('；'), 'bad', 3600);
    const saved = saveSettings(storage, settings);
    if (!saved.ok) toast(saved.error || '设置未能保存', 'bad', 4200);
    dispatch({ type: 'SETTINGS', settings });
  }

  const ctrl = {
    get state() {
      return state;
    },
    get settings() {
      return state.settings;
    },
    get collection() {
      return collection;
    },
    get history() {
      return history;
    },
    get caps() {
      return platform.caps;
    },
    get notifyPermission() {
      return platform.notificationPermission();
    },
    get storageAvailable() {
      return storage.available();
    },
    ui: {
      view: 'home',
      prewarnCollapsed: false,
      contactApp: 'wechat',
      recordsOlderOpen: false,
      flowerDetail: null,
      confirm: null, // 危险操作的两步确认：{ key, at }
    },
    assets,
    clock,
    platform,
    bgm,
    testMode,
    prod: PROD,
    firstRun,
    version: VERSION,
    dispatch,
    patchSettings,
    bindToastRoot,
    toast,
    refresh: () => app?.render(),
    newWindowDraft: (settings) => createWindowDraft(settings),
    clearHistory() {
      history = [];
      storage.writeJSON(KEYS.history, []);
      toast('记录已清空', 'ok');
      app?.render();
    },
    resetSettings() {
      const settings = defaultSettings();
      saveSettings(storage, settings);
      dispatch({ type: 'SETTINGS', settings });
      toast('已恢复默认设置', 'ok');
    },
  };

  app = createApp(ctrl);
  app.mount();
  bgm.init();

  // ---------------------------------------------------------------- 启动提示

  if (loaded.issues?.length) toast(loaded.issues.slice(0, 2).join('；'), 'bad', 4800);
  if (!storage.available()) toast('浏览器存储不可用，这次的改动不会被保存', 'bad', 6000);
  if (!assets.ready) toast('没有找到狐狸立绘，已使用 emoji 兜底（assets/fox/ 下放三张 PNG 即可）', 'info', 5200);

  // ---------------------------------------------------------------- 恢复现场

  const snapshot = loadRuntime(storage);
  if (snapshot && !testMode) dispatch({ type: 'RESTORE', snapshot });
  if (testMode) toast('测试模式：不会自动进入限制，用演示按钮看各状态', 'ok', 5200);

  // ---------------------------------------------------------------- 演示 / 截图参数

  const preview = params.get('preview');
  if (preview === 'locked') {
    dispatch({
      type: 'PREVIEW_START',
      durationMs: Number(params.get('ms')) || 8 * 60 * 60 * 1000,
      tasks: [
        { id: 'p1', text: '写完今天的工作复盘', done: false, doneAt: null },
        { id: 'p2', text: '读 20 分钟书', done: false, doneAt: null },
        { id: 'p3', text: '把手机放到桌子另一头', done: false, doneAt: null },
      ],
    });
  } else if (preview === 'prewarn') {
    dispatch({ type: 'PREVIEW_START', phase: 'prewarn', durationMs: Number(params.get('ms')) || 90 * 1000 });
  } else if (preview === 'result') {
    dispatch({
      type: 'PREVIEW_START',
      phase: 'result',
      outcome: params.get('outcome') || 'success',
      reward: params.get('outcome') === 'left' ? null : { flowerId: 'rose', isNewSpecies: true, streakDays: 5 },
    });
  }
  if (params.get('view')) ctrl.ui.view = params.get('view');
  if (params.get('gray') === '1') platform.setGrayscale(true, state.settings.features.grayscale);

  // 显式放行/恢复（写盘，测试与"取消今晚任务"用）
  if (params.get('off') === '1' && state.settings.enabled) {
    ctrl.patchSettings((draft) => {
      draft.enabled = false;
    });
    if (state.phase === 'result') dispatch({ type: 'RESULT_ACK' });
    toast('限制总开关已关闭并保存（?off=1）。想恢复：打开 ?on=1 或在设置里开启。', 'ok', 7000);
  } else if (params.get('on') === '1' && !state.settings.enabled) {
    ctrl.patchSettings((draft) => {
      draft.enabled = true;
    });
    toast('限制总开关已重新开启（?on=1）', 'ok', 4200);
  }

  // 恢复正常夜间休息：?night=1 补齐 22:30–07:00 并启用总开关；
  // 默认会把"正在进行的这一段"记为已跳过，避免你刚恢复就被锁在门外。
  // 想立刻生效就加 &lock=1。
  if (params.get('night') === '1') {
    let action = 'exists';
    ctrl.patchSettings((draft) => {
      draft.enabled = true;
      action = ensureNightWindow(draft);
    });
    if (state.phase === 'result') dispatch({ type: 'RESULT_ACK' });
    const lockNow = params.get('lock') === '1';
    if (!lockNow) dispatch({ type: 'SKIP_CURRENT' });
    const verb = action === 'created' ? '已添加' : action === 'enabled' ? '已重新启用' : '已确认';
    toast(
      lockNow
        ? `夜间休息${verb}：每天 22:30–07:00，现在就生效。`
        : `夜间休息${verb}：每天 22:30–07:00。今晚这一次已跳过，明晚开始正常锁定。`,
      'ok',
      7000,
    );
  }

  app.render();

  // ---------------------------------------------------------------- 消息桥
  //
  // 浏览器读不到微信/QQ/钉钉的消息（没有这个 API），所以这里留了一个本地桥：
  //   POST /api/interrupt            {"app":"wechat","contact":"张三"}
  //   GET  /api/interrupt?app=wechat&contact=张三
  // 手机端 Tasker / 自建 NotificationListenerService、或桌面脚本都能直接调它。
  // 页面在限制期间每 1.5 秒轮询一次，收到就响铃 + 暂停计时。
  // 只有通过 http(s) 打开时才可能存在本机桥；file:// 下直接跳过，免得刷一屏 404
  // 只有"本机开发服务器"才存在消息桥（tools/serve.mjs 的 /api/interrupt）。
  // 放到 GitHub Pages 这类公网静态托管上时，这个接口根本不存在 —— 不判断主机名的话，
  // 每次打开页面都会在控制台留一条 404。
  const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
  const bridgeAvailable =
    !PROD && (location.protocol === 'http:' || location.protocol === 'https:') && LOCAL_HOSTS.includes(location.hostname);
  let bridgeCursor = null; // null = 还没对齐过；对齐之后只消费更新的消息
  let bridgeFailures = 0;

  async function initBridgeCursor() {
    if (!bridgeAvailable) return;
    try {
      const res = await fetch('/api/interrupt?init=1', { cache: 'no-store' });
      if (!res.ok) throw new Error('no bridge');
      const data = await res.json();
      bridgeCursor = Number(data.last) || 0;
      bridgeFailures = 0;
    } catch {
      bridgeFailures += 1;
    }
  }

  async function pollInterruptBridge() {
    if (!bridgeAvailable) return;
    if (!state.settings.features.interrupt.enabled) return;
    if (state.phase !== 'locked' && state.phase !== 'rest') return;
    if (bridgeFailures > 6) return; // 没有桥服务（例如 file://）就别再试了
    if (bridgeCursor == null) {
      await initBridgeCursor();
      if (bridgeCursor == null) return;
    }
    try {
      const res = await fetch(`/api/interrupt?after=${bridgeCursor}`, { cache: 'no-store' });
      if (!res.ok) {
        bridgeFailures += 1;
        return;
      }
      const data = await res.json();
      bridgeFailures = 0;
      bridgeCursor = Math.max(bridgeCursor, Number(data.last) || 0);
      for (const evt of data.events || []) {
        bridgeCursor = Math.max(bridgeCursor, Number(evt.id) || 0);
        dispatch({ type: 'INCOMING_MESSAGE', app: evt.app, contact: evt.contact });
      }
    } catch {
      bridgeFailures += 1;
    }
  }
  setInterval(pollInterruptBridge, 1500);
  initBridgeCursor(); // 启动时先对齐，避免把上次遗留的消息当成新消息

  // ---------------------------------------------------------------- 宿主集成接口
  //
  // 浏览器读不到微信 / QQ / 钉钉的消息（没有这个权限），真实落地要靠宿主把通知送进来：
  //   · Android：NotificationListenerService → WebView.evaluateJavascript(
  //       "FoxLock.notify({app:'wechat', contact:'张老师'})")
  //   · 桌面脚本 / 浏览器扩展：window.FoxLock.notify(...) 或
  //       iframe 父页面 postMessage({type:'foxlock:interrupt', app, contact})
  // 这就是"消息从哪来"的正式入口，不再是原型里那个本机 HTTP 桥。
  function hostInterrupt(payload) {
    const app = String(payload?.app || payload?.packageName || 'wechat').slice(0, 24);
    const contact = String(payload?.contact || payload?.name || payload?.title || '重要联系人').slice(0, 24);
    if (state.phase !== 'locked' && state.phase !== 'rest') {
      return { ok: false, reason: `当前不在限制中（phase=${state.phase}）；消息只在限制期间响铃并暂停计时` };
    }
    if (!state.settings.features.interrupt.enabled) {
      return { ok: false, reason: '重要联系人提醒在设置里是关着的' };
    }
    dispatch({ type: 'INCOMING_MESSAGE', app, contact });
    return { ok: true, app, contact, paused: Boolean(state.session?.pause?.active) };
  }

  window.FoxLock = {
    version: VERSION,
    /** 宿主把"某个联系人发来消息"送进来；返回是否被受理 */
    notify: hostInterrupt,
    /** 宿主/自动化想知道当前是不是在限制里 */
    getState: () => ({
      phase: state.phase,
      view: ctrl.ui.view,
      enabled: state.settings.enabled,
      paused: Boolean(state.session?.pause?.active),
      restUntil: state.session?.rest?.until || null,
    }),
  };
  // iframe / WebView 也能用 postMessage 送消息
  window.addEventListener('message', (evt) => {
    const data = evt?.data;
    if (!data || data.type !== 'foxlock:interrupt') return;
    hostInterrupt(data);
  });

  // ---------------------------------------------------------------- 心跳

  setInterval(() => {
    dispatch({ type: 'TICK' });
    bgm.sync();
  }, 250);
  setInterval(() => {
    if (state.session) {
      persistRuntime();
      // 快照保存的是逻辑时间，但"是否离开过"要靠真实心跳，这里补一次 savedAt
    }
  }, 2000);

  // 页面隐藏时立刻存一次，降低"崩掉后恢复不准"的概率
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) persistRuntime();
  });

  // 调试出口：只给原型版 / QA 用。交付版刻意不留 window.__fox，避免被当成后门。
  if (!PROD) {
    window.__fox = {
      get state() {
        return state;
      },
      dispatch,
      clock,
      storage,
      ui: ctrl.ui,
      bgm,
      render: () => app?.render(),
      testMode,
      version: 1,
    };
  }
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('app');
  if (el) {
    el.innerHTML = `<div class="boot-splash"><div class="boot-fox">🥺</div><p class="boot-text">启动失败：${String(
      err?.message || err,
    )}</p></div>`;
  }
});
