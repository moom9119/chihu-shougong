/**
 * platform/web.js —— 浏览器平台适配层。
 *
 * 浏览器能做到的：
 *   ✓ 页面级灰度（CSS filter，覆盖整个应用，等效于"本应用的设备灰度"）
 *   ✓ 离开/切屏检测（visibilitychange / blur / pagehide + 宽限计时）
 *   ✓ 通知提醒、震动、屏幕常亮（Wake Lock，尽量）
 *   ✗ 拦截其他 App —— 浏览器没有这个权限，Android 端见 docs/DESIGN.md
 *
 * 所有平台能力都收敛在这里：换成 Android / Electron 时只要实现同一个接口。
 */

export function createPlatform({ getSettings, onLeave, onReturn }) {
  const rootEl = () => document.getElementById('app');
  let presenceOn = false;
  let leaveTimer = null;
  let leaveReason = null;
  let leftFlag = false;
  let wakeLock = null;
  let audioCtx = null;

  const caps = {
    grayscale: 'simulated',
    appBlocking: false,
    systemWide: false,
    notifications: typeof Notification !== 'undefined',
    wakeLock: typeof navigator !== 'undefined' && 'wakeLock' in navigator,
    vibration: typeof navigator !== 'undefined' && 'vibrate' in navigator,
  };

  // ---------------------------------------------------------------- 灰度

  function setGrayscale(on, { intensityPercent = 100, dimPercent = 0 } = {}) {
    const el = rootEl();
    if (!el) return;
    el.classList.toggle('is-gray', Boolean(on));
    el.classList.toggle('is-dim', Boolean(on) && dimPercent > 0);
    el.style.setProperty('--gray-amount', String(Math.min(100, Math.max(0, intensityPercent)) / 100));
    el.style.setProperty('--dim-amount', String(Math.min(60, Math.max(0, dimPercent)) / 100));
  }

  // ---------------------------------------------------------------- 在场检测

  function graceMs() {
    const v = Number(getSettings()?.fox?.graceLeaveMs);
    return Number.isFinite(v) ? Math.max(0, v) : 3000;
  }

  function emitLeave(reason) {
    if (leftFlag) return;
    leftFlag = true;
    leaveReason = reason;
    onLeave?.({ reason, at: Date.now() });
  }

  function scheduleLeave(reason) {
    if (leftFlag) return;
    if (leaveTimer != null) return;
    const delay = graceMs();
    if (delay <= 0) {
      emitLeave(reason);
      return;
    }
    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      emitLeave(reason);
    }, delay);
  }

  function cancelLeave() {
    if (leaveTimer != null) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    if (leftFlag) {
      leftFlag = false;
      leaveReason = null;
      onReturn?.({ reason: 'return' });
      return true;
    }
    return false;
  }

  function handleVisibility() {
    if (document.hidden) {
      scheduleLeave('hidden');
    } else {
      const back = cancelLeave();
      requestWakeLock();
      if (back) onReturn?.({ reason: 'visible', resumed: true });
    }
  }

  function handleBlur() {
    if (!document.hidden) scheduleLeave('blur');
  }

  function handleFocus() {
    if (!document.hidden) cancelLeave();
  }

  function handlePageHide() {
    // 页面即将销毁：立刻记账，不再等宽限
    if (leaveTimer != null) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    emitLeave('pagehide');
  }

  function startPresence() {
    if (presenceOn) return;
    presenceOn = true;
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pagehide', handlePageHide);
  }

  function stopPresence() {
    if (!presenceOn) return;
    presenceOn = false;
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('blur', handleBlur);
    window.removeEventListener('focus', handleFocus);
    window.removeEventListener('pagehide', handlePageHide);
    if (leaveTimer != null) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    leftFlag = false;
  }

  // ---------------------------------------------------------------- 屏幕常亮

  async function requestWakeLock() {
    if (!caps.wakeLock || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => {
        wakeLock = null;
      });
    } catch {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    try {
      wakeLock?.release?.();
    } catch {
      /* ignore */
    }
    wakeLock = null;
  }

  // ---------------------------------------------------------------- 通知

  function notify(title, body) {
    if (!caps.notifications) return;
    try {
      if (Notification.permission !== 'granted') return;
      new Notification(title, { body, tag: 'foxlock', silent: false });
    } catch {
      /* 某些浏览器在页面隐藏时禁止构造 Notification，忽略 */
    }
  }

  async function requestNotifications() {
    if (!caps.notifications) return 'unsupported';
    try {
      if (Notification.permission === 'granted') return 'granted';
      const res = await Notification.requestPermission();
      return res;
    } catch {
      return 'error';
    }
  }

  function notificationPermission() {
    return caps.notifications ? Notification.permission : 'unsupported';
  }

  // ---------------------------------------------------------------- 音效

  function ensureAudio() {
    if (audioCtx) return audioCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    } catch {
      audioCtx = null;
    }
    return audioCtx;
  }

  /** 用户第一次交互时解锁音频（浏览器自动播放策略） */
  function unlockAudio() {
    const ctx = ensureAudio();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  const TUNES = {
    start: [
      [392, 0.0, 0.18],
      [294, 0.16, 0.32],
    ],
    rest: [
      [523, 0.0, 0.14],
      [659, 0.12, 0.22],
    ],
    pass: [
      [784, 0.0, 0.1],
      [988, 0.08, 0.16],
    ],
    success: [
      [523, 0.0, 0.16],
      [659, 0.13, 0.2],
      [784, 0.27, 0.24],
      [1047, 0.42, 0.34],
    ],
    fail: [
      [330, 0.0, 0.22],
      [247, 0.2, 0.34],
      [196, 0.44, 0.5],
    ],
    neutral: [[440, 0.0, 0.18]],
    /** 重要联系人消息提醒：两段上扬的"叮咚" */
    alert: [
      [880, 0.0, 0.13],
      [1174, 0.14, 0.2],
    ],
  };

  function sound(name) {
    const settings = getSettings();
    if (settings && settings.ui && settings.ui.sound === false) return;
    const tune = TUNES[name];
    if (!tune) return;
    const ctx = ensureAudio();
    if (!ctx || ctx.state === 'suspended') {
      // 没解锁就安静地跳过，不报错
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (ctx && ctx.state === 'suspended') return;
    }
    if (!ctx) return;
    try {
      const t0 = ctx.currentTime;
      for (const [freq, offset, dur] of tune) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + offset);
        gain.gain.exponentialRampToValueAtTime(0.16, t0 + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + dur + 0.02);
      }
    } catch {
      /* 音频失败不影响主流程 */
    }
  }

  function vibrate(pattern = 30) {
    if (!caps.vibration) return;
    // 没有用户交互时调用 vibrate 只会让浏览器在控制台记一条 "Blocked call to navigator.vibrate"，
    // 既震不了也难看 —— 直接跳过
    try {
      if (navigator.userActivation && navigator.userActivation.hasBeenActive === false) return;
    } catch {
      /* 老浏览器没有 userActivation，按老路子调 */
    }
    try {
      navigator.vibrate(pattern);
    } catch {
      /* ignore */
    }
  }

  /** 收到重要联系人消息：连续响若干次 + 震动（浏览器策略下第一次可能被静音） */
  function ring({ times = 3, intervalMs = 700 } = {}) {
    const n = Math.min(10, Math.max(1, Math.round(times)));
    const gap = Math.min(3000, Math.max(200, Math.round(intervalMs)));
    for (let i = 0; i < n; i += 1) setTimeout(() => sound('alert'), i * gap);
    vibrate([80, 90, 80]);
  }

  return {
    caps,
    setGrayscale,
    startPresence,
    stopPresence,
    requestWakeLock,
    releaseWakeLock,
    notify,
    requestNotifications,
    notificationPermission,
    unlockAudio,
    sound,
    ring,
    vibrate,
  };
}
