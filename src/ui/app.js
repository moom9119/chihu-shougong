/**
 * ui/app.js —— 应用外壳：路由、渲染、事件委托、实时数值刷新、矩阵弹窗与狐狸舞台的挂载。
 *
 * 渲染策略：
 *  - 视图函数只产出"结构"，所有随时间变化的数字都留空的 [data-live] 占位；
 *  - render() 只在结构字符串变化时替换 innerHTML，避免每秒重建 DOM；
 *  - paintLive() 每帧只改 textContent / style.width，便宜且不打断动画和输入焦点。
 */
import { fmtCountdown } from './dom.js';
import { homeView } from './views/home.js';
import { settingsView } from './views/settings.js';
import { prewarnView } from './views/prewarn.js';
import { sessionView, foxBubbleText } from './views/session.js';
import { resultView } from './views/result.js';
import { collectionViewPage } from './views/collection.js';
import { statsView } from './views/stats.js';
import { createMatrixBoard } from './components/matrix-board.js';
import { createFoxScene } from './fox-scene.js';
import { taskProgress } from '../core/tasks.js';
import { enabledWindows, ensureNightWindow } from '../core/settings.js';
import { nextSession, startOfLocalDay, nextLocalDay } from '../core/schedule.js';
import { effectiveEndAt, effectiveRestUntil } from '../core/engine.js';

// 底部引导栏顺序：首页 · 记录 · 收藏 · 设置（设置放最右，避免误触）
const TABS = [
  { id: 'home', label: '首页', icon: '🏠' },
  { id: 'stats', label: '记录', icon: '📊' },
  { id: 'collection', label: '收藏', icon: '🌸' },
  { id: 'settings', label: '设置', icon: '⚙︎' },
];

const PHASE_TEXT = { idle: '自由时间', prewarn: '即将开始', locked: '限制中', rest: '休息中', result: '结算' };

export function createApp(ctrl) {
  const appEl = document.getElementById('app');
  let shell = null;
  let matrixRoot = null;
  let toastRoot = null;
  let lastOverlayKey = '';
  let lastView = '';
  const hostCache = new Map();
  let holdRaf = 0;
  let holdStart = 0;
  let holdBtn = null;

  const scene = createFoxScene();
  const matrix = createMatrixBoard({
    getSettings: () => ctrl.settings,
    now: () => ctrl.clock.now(),
    onSolved: () => ctrl.dispatch({ type: 'MATRIX_SOLVED' }),
    onSound: (name) => ctrl.platform.sound(name),
  });

  // ---------------------------------------------------------------- 视图

  function pageHtml() {
    const ctx = viewCtx();
    switch (ctrl.ui.view) {
      case 'settings':
        return settingsView(ctx);
      case 'collection':
        return collectionViewPage(ctx);
      case 'stats':
        return statsView(ctx);
      default:
        return homeView(ctx);
    }
  }

  function overlayHtml() {
    const ctx = viewCtx();
    if (ctrl.state.phase === 'prewarn') return prewarnView(ctx);
    if (ctrl.state.phase === 'locked' || ctrl.state.phase === 'rest') return sessionView(ctx);
    if (ctrl.state.phase === 'result') return resultView(ctx);
    return '';
  }

  function viewCtx() {
    return {
      state: ctrl.state,
      settings: ctrl.settings,
      collection: ctrl.collection,
      history: ctrl.history,
      now: ctrl.clock.now(),
      ui: ctrl.ui,
      assets: ctrl.assets,
      caps: ctrl.caps,
      notifyPermission: ctrl.notifyPermission,
      storageAvailable: ctrl.storageAvailable,
      speed: ctrl.clock.speed,
      testMode: ctrl.testMode,
      prod: Boolean(ctrl.prod),
      firstRun: Boolean(ctrl.firstRun),
      version: ctrl.version || '',
      bgm: ctrl.bgm ? ctrl.bgm.state() : null,
    };
  }

  function topbarHtml() {
    const phase = ctrl.state.phase;
    const bgm = ctrl.bgm ? ctrl.bgm.state() : null;
    return `<header class="topbar">
      <div class="brand">
        <span class="brand-mark">🦊</span>
        <span class="brand-text">赤狐收工<small>屏幕时间限制</small></span>
      </div>
      <div class="topbar-spacer"></div>
      <span class="phase-chip" data-phase="${phase}"><i class="dot"></i>${PHASE_TEXT[phase] || ''}</span>
      ${ctrl.testMode ? `<span class="pill-soft ok" title="?test=1 打开：不会自动进入限制">测试模式</span>` : ''}
      ${
        ctrl.clock.speed !== 1
          ? `<span class="pill-soft" title="演示加速">×${ctrl.clock.speed}</span>`
          : ''
      }
      ${
        bgm && !bgm.broken
          ? `<button class="music-btn${bgm.off ? ' is-off' : ''}" type="button" data-act="bgm-cycle" data-level="${bgm.key}"
              aria-label="背景音乐：${bgm.label}，点一下切换音量" title="背景音乐 ${bgm.label}（点一下切换 关 / 20% / 30% / 50%）">
              <span class="music-icon" aria-hidden="true">${bgm.icon}</span><span class="music-label">${bgm.label}</span>
            </button>`
          : ''
      }
    </header>`;
  }

  function tabbarHtml() {
    return `<nav class="tabbar" aria-label="主导航">
      ${TABS.map(
        (t) => `<button class="tab" data-act="nav" data-view="${t.id}" ${ctrl.ui.view === t.id ? 'aria-current="page"' : ''}>
          <span class="tab-icon" aria-hidden="true">${t.icon}</span><span>${t.label}</span>
        </button>`,
      ).join('')}
    </nav>`;
  }

  /**
   * 分片渲染：顶栏 / 页面 / 底栏 / 叠层各自独立比较、独立替换。
   *
   * 为什么必须分片：一个 250ms 的 tick 也会触发 render()，
   * 如果每次都整块重画，锁定层的入场动画、Canvas 粒子、狐狸立绘都会被打断，
   * 视觉上就是"页面一直在跳"。分片之后，只要这一段的结构没变，DOM 就原样不动。
   */
  function host(id) {
    if (!hostCache.has(id)) hostCache.set(id, document.getElementById(id));
    return hostCache.get(id);
  }

  function setHost(id, html, { keepScroll = false } = {}) {
    const el = host(id);
    if (!el) return false;
    if (el.__foxHtml === html) return false;
    el.__foxHtml = html;
    const scrollTop = keepScroll ? el.scrollTop : 0;
    el.innerHTML = html;
    if (keepScroll && scrollTop) el.scrollTop = scrollTop;
    return true;
  }

  // ---------------------------------------------------------------- 渲染

  function captureFocus() {
    const el = document.activeElement;
    if (!el || !shell?.contains(el)) return null;
    const key = el.getAttribute('data-focus') || el.id;
    if (!key) return null;
    return { key, start: el.selectionStart, end: el.selectionEnd };
  }

  function restoreFocus(info) {
    if (!info) return;
    const el = shell.querySelector(`[data-focus="${CSS.escape(info.key)}"]`) || shell.querySelector(`#${CSS.escape(info.key)}`);
    if (!el) return;
    el.focus({ preventScroll: true });
    try {
      if (typeof info.start === 'number' && el.setSelectionRange) el.setSelectionRange(info.start, info.end);
    } catch {
      /* 某些 input 类型不支持选区 */
    }
  }

  function render() {
    if (!shell) return;
    applyTheme();
    const focus = captureFocus();

    setHost('topbar-host', topbarHtml());
    // 只有同一个页面内部的更新才保留滚动位置；换页从顶部开始
    const keepPageScroll = ctrl.ui.view === lastView;
    setHost('page', pageHtml(), { keepScroll: keepPageScroll });
    lastView = ctrl.ui.view;
    setHost('tabbar-host', tabbarHtml());

    const overlayKey = `${ctrl.state.phase}:${ctrl.state.session?.id || ''}`;
    const keyChanged = overlayKey !== lastOverlayKey;
    const prevLayer = host('overlay-host')?.firstElementChild;
    const prevScroll = prevLayer ? prevLayer.scrollTop : 0;
    const overlayChanged = setHost('overlay-host', overlayHtml());
    if (overlayChanged) {
      const layer = host('overlay-host').firstElementChild;
      if (layer) {
        // 只有"换了阶段"才播入场动画；同一个叠层内部重绘（比如勾任务）不重播、也不跳回顶部
        if (keyChanged) layer.classList.add('enter');
        else if (prevScroll) layer.scrollTop = prevScroll;
      }
    }
    lastOverlayKey = overlayKey;

    restoreFocus(focus);
    syncScene();
    paintLive();
  }

  /** Canvas 只在叠层里存在；节点没换就不用重新挂载 */
  function syncScene() {
    const canvas = shell ? shell.querySelector('[data-fox-canvas]') : null;
    if (canvas) scene.mount(canvas);
    else scene.unmount();
  }

  function applyTheme() {
    const theme = ctrl.settings.ui.theme;
    const html = document.documentElement;
    const wantsDark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    html.dataset.theme = wantsDark ? 'dark' : 'light';
    appEl.classList.toggle('reduce-motion', Boolean(ctrl.settings.ui.reduceMotion));
    appEl.dataset.phase = ctrl.state.phase;
  }

  /** 只更新会随时间变化的数字 */
  function paintLive() {
    if (!shell) return;
    const now = ctrl.clock.now();
    const st = ctrl.state;
    const setText = (sel, text) => {
      const el = shell.querySelector(sel);
      if (el && el.textContent !== text) el.textContent = text;
    };
    const setAll = (name, text) => {
      shell.querySelectorAll(`[data-live="${name}"]`).forEach((el) => {
        if (el.textContent !== text) el.textContent = text;
      });
    };

    // 倒计时（首页 / 预警 / 锁定）
    let countdown = '';
    if ((st.phase === 'locked' || st.phase === 'rest') && st.session) {
      const ms =
        st.phase === 'rest'
          ? effectiveRestUntil(st.session, now) - now
          : effectiveEndAt(st.session, now) - now;
      countdown = fmtCountdown(ms);
    } else if (st.phase === 'prewarn' && st.session) {
      countdown = fmtCountdown(st.session.startAt - now);
    } else {
      const next = nextSession(now, enabledWindows(ctrl.settings));
      countdown = next ? fmtCountdown(next.startAt - now) : '—';
    }
    setAll('hero-countdown', countdown);
    setAll('prewarn-countdown', countdown);
    setAll('session-countdown', countdown);

    if (st.session && (st.phase === 'locked' || st.phase === 'rest')) {
      const s = st.session;
      const progress = taskProgress(s.tasks);
      setAll('task-percent', `${progress.done}/${progress.total} · ${progress.percent}%`);
      const bar = shell.querySelector('[data-live="task-bar"]');
      if (bar) bar.style.width = `${progress.percent}%`;
      setAll('feathers', String(s.fox.feathers));
      setAll('flowers', String(s.fox.flowers));
      setAll('fox-bubble', foxBubbleText(st, s, now));
      scene.setMode(s.fox.state === 'failed' ? 'failed' : s.pause?.active || st.phase === 'rest' ? 'paused' : 'collect');
      if (s.pause?.active) {
        const total = Math.max(0, Math.floor((now - s.pause.since) / 1000));
        const mm = String(Math.floor(total / 60)).padStart(2, '0');
        const ss = String(total % 60).padStart(2, '0');
        setAll('pause-elapsed', `${mm}:${ss}`);
      }
    }

    // 首页时间轴上的"现在"指针（只有它每秒会动，所以只改 style，不动 DOM 结构）
    const dayStart = startOfLocalDay(now);
    const dayEnd = nextLocalDay(dayStart);
    const pct = ((now - dayStart) / (dayEnd - dayStart)) * 100;
    shell.querySelectorAll('[data-live="nowmark"]').forEach((el) => {
      el.style.left = `${pct}%`;
    });

    matrix.tick(now);
  }

  // ---------------------------------------------------------------- 事件

  function findAct(target) {
    return target?.closest?.('[data-act]') || null;
  }

  function addContactFromInput() {
    const input = shell.querySelector('#contact-name');
    const name = input?.value?.trim();
    if (!name) {
      input?.focus();
      return;
    }
    const appId = ctrl.ui.contactApp || 'wechat';
    ctrl.patchSettings((draft) => {
      const list = draft.features.interrupt.contacts;
      if (list.length >= 50) return;
      if (list.some((c) => c.app === appId && c.name === name)) return;
      list.push({ id: `c_${Date.now().toString(36)}`, app: appId, name: name.slice(0, 24), enabled: true });
    });
    if (input) input.value = '';
    input?.focus();
  }

  // ---------------------------------------------------------------- 危险操作的两步确认
  //
  // 原来用原生 confirm()：在 file:// 双击、被宿主塞进 iframe、或浏览器"禁止此页再弹窗"之后，
  // 它会被直接吞掉，表现就是"点了没反应"。改成页内两步确认：第一次点亮按钮，5 秒内再点一次才执行。
  const CONFIRM_MS = 5000;
  let confirmTimer = 0;

  function confirmKeyOf(act, id) {
    return id ? `${act}:${id}` : act;
  }

  function needsConfirm(key) {
    const c = ctrl.ui.confirm;
    return Boolean(c && c.key === key && ctrl.clock.now() - c.at < CONFIRM_MS);
  }

  function armConfirm(key) {
    ctrl.ui.confirm = { key, at: ctrl.clock.now() };
    // 超时自动收回"确认删除？"的字样，免得按钮一直亮着却已经过期
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      if (ctrl.ui.confirm && ctrl.ui.confirm.key === key) {
        ctrl.ui.confirm = null;
        render();
      }
    }, CONFIRM_MS + 60);
  }

  function clearConfirm() {
    ctrl.ui.confirm = null;
  }

  function onClick(evt) {
    ctrl.platform.unlockAudio();
    ctrl.bgm?.unlock();
    const el = findAct(evt.target);
    if (!el) {
      clearConfirm();
      return;
    }
    const act = el.dataset.act;
    const now = ctrl.clock.now();
    // 点了别的按钮，就放弃上一次"等待确认"状态
    const pending = ctrl.ui.confirm;
    if (pending && pending.key !== confirmKeyOf(act, el.dataset.id || el.dataset.path)) {
      clearConfirm();
    }

    switch (act) {
      case 'bgm-cycle': {
        const next = ctrl.bgm.cycle();
        ctrl.toast(`背景音乐：${next.label}`, 'info', 1200);
        render();
        return;
      }

      case 'bgm-set': {
        const next = ctrl.bgm.apply(el.dataset.level);
        ctrl.toast(`背景音乐：${next.label}`, 'info', 1200);
        render();
        return;
      }
      case 'nav':
        if (ctrl.state.phase === 'locked' || ctrl.state.phase === 'rest' || ctrl.state.phase === 'prewarn') {
          ctrl.toast('限制期间先专注眼前这段吧', 'info');
          return;
        }
        ctrl.ui.view = el.dataset.view || 'home';
        render();
        return;

      case 'set-bool': {
        const path = el.dataset.path;
        const current = getPath(ctrl.settings, path);
        ctrl.patchSettings((draft) => setPath(draft, path, !current));
        return;
      }

      case 'step': {
        const path = el.dataset.path;
        const delta = Number(el.dataset.delta);
        const min = Number(el.dataset.min);
        const max = Number(el.dataset.max);
        ctrl.patchSettings((draft) => {
          if (path === 'fox.graceLeaveSeconds') {
            const next = clamp((draft.fox.graceLeaveMs / 1000 + delta) | 0, min, max);
            draft.fox.graceLeaveMs = next * 1000;
            return;
          }
          const current = Number(getPath(draft, path)) || 0;
          setPath(draft, path, clamp(current + delta, min, max));
        });
        return;
      }

      case 'segment': {
        const path = el.dataset.path;
        const raw = el.dataset.value;
        const value = raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
        ctrl.patchSettings((draft) => setPath(draft, path, value));
        return;
      }

      case 'win-add-night': {
        ctrl.patchSettings((draft) => {
          draft.enabled = true;
          ensureNightWindow(draft);
        });
        ctrl.toast('已恢复「夜间休息」22:30–07:00（每天）', 'ok', 3800);
        return;
      }

      case 'win-add':
        ctrl.patchSettings((draft) => {
          if (draft.windows.length >= 12) return;
          draft.windows.push(ctrl.newWindowDraft(draft));
        });
        return;

      case 'win-del': {
        const id = el.dataset.id;
        const key = confirmKeyOf('win-del', id);
        if (!needsConfirm(key)) {
          armConfirm(key);
          render();
          ctrl.toast('再点一次「确认删除」（5 秒内）', 'info', 2600);
          return;
        }
        clearConfirm();
        ctrl.patchSettings((draft) => {
          draft.windows = draft.windows.filter((w) => w.id !== id);
        });
        ctrl.toast('已删除这段限制时段', 'ok', 2000);
        return;
      }

      case 'win-toggle': {
        // 开关渲染用的是 data-path（见 dom.js toggleSwitch），这里两种都认，别再踩"点了没反应"
        const id = el.dataset.id || el.dataset.path;
        const target = ctrl.state.settings.windows.find((x) => x.id === id);
        if (!target) {
          ctrl.toast('找不到这段时段，刷新一下页面', 'bad', 2600);
          return;
        }
        ctrl.patchSettings((draft) => {
          const w = draft.windows.find((x) => x.id === id);
          if (w) w.enabled = !w.enabled;
        });
        ctrl.toast(`「${target.label || '限制时段'}」已${target.enabled ? '关闭' : '启用'}`, 'ok', 1800);
        return;
      }

      case 'win-day': {
        const id = el.dataset.id;
        const day = Number(el.dataset.day);
        ctrl.patchSettings((draft) => {
          const w = draft.windows.find((x) => x.id === id);
          if (!w) return;
          if (w.days.includes(day)) {
            if (w.days.length === 1) {
              ctrl.toast('至少要保留一天', 'bad');
              return;
            }
            w.days = w.days.filter((d) => d !== day);
          } else {
            w.days = [...w.days, day].sort((a, b) => a - b);
          }
        });
        return;
      }

      case 'task-add': {
        const input = shell.querySelector('#task-input');
        const text = input?.value?.trim();
        if (!text) {
          input?.focus();
          return;
        }
        ctrl.dispatch({ type: 'TASK_ADD', text });
        if (input) input.value = '';
        input?.focus();
        return;
      }

      case 'task-toggle':
        ctrl.dispatch({ type: 'TASK_TOGGLE', id: el.dataset.id });
        return;

      case 'task-del':
        ctrl.dispatch({ type: 'TASK_REMOVE', id: el.dataset.id });
        return;

      case 'task-template':
        ctrl.dispatch({ type: 'TASK_ADD', text: el.dataset.text });
        ctrl.toast('已加入任务清单', 'ok', 1600);
        return;

      case 'prewarn-done':
        ctrl.ui.prewarnCollapsed = true;
        render();
        return;

      case 'prewarn-expand':
        ctrl.ui.prewarnCollapsed = false;
        render();
        return;

      case 'prewarn-dismiss':
        ctrl.ui.prewarnCollapsed = false;
        ctrl.dispatch({ type: 'PREWARN_DISMISS' });
        return;

      case 'demo-start':
        ctrl.dispatch({
          type: 'PREVIEW_START',
          durationMs: 60 * 1000,
          tasks: ['看一眼今天的计划', '把手机放到桌子另一头', '写下明天的第一件事'].map((text, i) => ({
            id: `demo_${i}`,
            text,
            done: false,
            doneAt: null,
          })),
        });
        return;

      case 'matrix-trigger':
        ctrl.dispatch({ type: 'MATRIX_TRIGGER' });
        return;

      case 'matrix-cell':
        matrix.handleCell(Number(el.dataset.v));
        return;

      case 'rest-skip':
        ctrl.dispatch({ type: 'REST_SKIP' });
        return;

      case 'result-ack': {
        const wasEmergency = ctrl.state.result?.reason === 'emergency';
        ctrl.dispatch({ type: 'RESULT_ACK' });
        ctrl.ui.view = 'home';
        render();
        if (wasEmergency) ctrl.toast('已跳过本次限制，这一段结束前不会再锁', 'ok', 4600);
        return;
      }

      case 'result-collection': {
        const wasEmergency = ctrl.state.result?.reason === 'emergency';
        ctrl.dispatch({ type: 'RESULT_ACK' });
        ctrl.ui.view = 'collection';
        render();
        if (wasEmergency) ctrl.toast('已跳过本次限制，这一段结束前不会再锁', 'ok', 4600);
        return;
      }

      case 'clear-history': {
        if (!needsConfirm('clear-history')) {
          armConfirm('clear-history');
          render();
          ctrl.toast('再点一次确认清空（收藏册不会被删）', 'info', 2600);
          return;
        }
        clearConfirm();
        ctrl.clearHistory();
        return;
      }

      case 'reset-settings': {
        if (!needsConfirm('reset-settings')) {
          armConfirm('reset-settings');
          render();
          ctrl.toast('再点一次确认恢复默认设置', 'info', 2600);
          return;
        }
        clearConfirm();
        ctrl.resetSettings();
        return;
      }

      case 'notify-permission':
        ctrl.platform.requestNotifications().then((res) => {
          ctrl.toast(res === 'granted' ? '通知已开启' : res === 'denied' ? '通知被拒绝了' : '没有拿到通知权限', res === 'granted' ? 'ok' : 'bad');
          ctrl.refresh();
        });
        return;

      // ---------------- 重要联系人 ----------------
      case 'contact-add':
        addContactFromInput();
        return;

      case 'contact-del': {
        const id = el.dataset.id;
        ctrl.patchSettings((draft) => {
          draft.features.interrupt.contacts = draft.features.interrupt.contacts.filter((c) => c.id !== id);
        });
        ctrl.toast('已移除', 'ok', 1600);
        return;
      }

      case 'contact-test': {
        const first = ctrl.settings.features.interrupt.contacts.find((c) => c.enabled) || { app: 'wechat', name: '测试联系人' };
        ctrl.dispatch({ type: 'INCOMING_MESSAGE', app: first.app, contact: first.name || '测试联系人' });
        return;
      }

      case 'records-older':
        ctrl.ui.recordsOlderOpen = !ctrl.ui.recordsOlderOpen;
        render();
        return;

      case 'flower-detail': {
        const id = el.dataset.id;
        ctrl.ui.flowerDetail = ctrl.ui.flowerDetail === id ? null : id;
        render();
        return;
      }

      case 'flower-close':
        ctrl.ui.flowerDetail = null;
        render();
        return;

      case 'mock-message': {
        const list = ctrl.settings.features.interrupt.contacts.filter((c) => c.enabled);
        const c = list[0] || { app: 'wechat', name: '张老师' };
        ctrl.dispatch({ type: 'INCOMING_MESSAGE', app: c.app, contact: c.name });
        return;
      }

      case 'resume-timer':
        ctrl.dispatch({ type: 'RESUME_FROM_MESSAGE' });
        return;

      default:
        return;
    }
  }

  function onChange(evt) {
    const el = findAct(evt.target);
    if (!el) return;
    if (el.dataset.act === 'win-time') {
      const id = el.dataset.id;
      const field = el.dataset.field;
      const value = el.value;
      ctrl.patchSettings((draft) => {
        const w = draft.windows.find((x) => x.id === id);
        if (w) w[field] = value;
      });
    }
    if (el.dataset.act === 'win-label') {
      const id = el.dataset.id;
      const value = el.value.trim();
      if (!value) return;
      ctrl.patchSettings((draft) => {
        const w = draft.windows.find((x) => x.id === id);
        if (w) w.label = value;
      });
    }
    if (el.dataset.act === 'contact-app') {
      ctrl.ui.contactApp = el.value;
      ctrl.refresh();
    }
  }

  function onKeydown(evt) {
    const el = findAct(evt.target);
    if (!el) return;
    if (el.dataset.act === 'task-input-key' && evt.key === 'Enter') {
      evt.preventDefault();
      const input = shell.querySelector('#task-input');
      const text = input?.value?.trim();
      if (text) {
        ctrl.dispatch({ type: 'TASK_ADD', text });
        input.value = '';
      }
      input?.focus();
    }
    if (el.dataset.act === 'contact-name-key' && evt.key === 'Enter') {
      evt.preventDefault();
      addContactFromInput();
    }
  }

  // ---------------------------------------------------------------- 长按提前结束

  function beginHold(el) {
    holdBtn = el;
    holdStart = performance.now();
    el.classList.add('holding');
    const total = Math.max(1, Number(el.dataset.hold) || 3) * 1000;
    const tickHold = () => {
      const pct = Math.min(100, ((performance.now() - holdStart) / total) * 100);
      el.style.setProperty('--hold-progress', `${pct}%`);
      if (pct >= 100) {
        cancelHold();
        ctrl.dispatch({ type: 'EMERGENCY_EXIT' });
        return;
      }
      holdRaf = requestAnimationFrame(tickHold);
    };
    holdRaf = requestAnimationFrame(tickHold);
  }

  function cancelHold() {
    cancelAnimationFrame(holdRaf);
    holdRaf = 0;
    if (holdBtn) {
      holdBtn.classList.remove('holding');
      holdBtn.style.setProperty('--hold-progress', '0%');
      holdBtn = null;
    }
  }

  function onPointerDown(evt) {
    const el = findAct(evt.target);
    if (!el || el.dataset.act !== 'emergency') return;
    evt.preventDefault();
    beginHold(el);
  }

  // ---------------------------------------------------------------- 矩阵弹窗

  function openMatrix() {
    matrix.open();
    if (!matrixRoot) return;
    matrixRoot.innerHTML = '';
    const holder = document.createElement('div');
    holder.innerHTML = matrix.html();
    const node = holder.firstElementChild;
    matrixRoot.appendChild(node);
    matrix.mount(node);
  }

  function closeMatrix() {
    matrix.close();
    if (matrixRoot) matrixRoot.innerHTML = '';
  }

  // ---------------------------------------------------------------- 挂载

  function mount() {
    appEl.innerHTML = `<div class="app-shell" id="shell">
        <div id="topbar-host"></div>
        <main class="page" id="page"></main>
        <div id="tabbar-host"></div>
        <div id="overlay-host"></div>
      </div>
      <div id="matrix-root"></div>
      <div class="toast-stack" id="toast-root" role="status" aria-live="polite"></div>`;
    shell = document.getElementById('shell');
    matrixRoot = document.getElementById('matrix-root');
    toastRoot = document.getElementById('toast-root');
    ctrl.bindToastRoot(toastRoot);

    appEl.addEventListener('click', onClick);
    appEl.addEventListener('change', onChange);
    appEl.addEventListener('keydown', onKeydown);
    appEl.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', cancelHold);
    window.addEventListener('pointercancel', cancelHold);

    render();
  }

  return { mount, render, paintLive, openMatrix, closeMatrix, scene, matrix, get shell() { return shell; } };
}

// ---------------------------------------------------------------- 路径读写

function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
