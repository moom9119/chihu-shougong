/**
 * platform/bgm.js —— 背景音乐（浏览器实现）。
 *
 * 职责边界：它只知道"该响的时候响、该停的时候停"，不知道什么是限制时段。
 * 什么时候该响由调用方通过 shouldPlay() 告诉它（本项目 = phase 为 idle，即四个 tab 页面）。
 *
 * 三档音量：关 / 20% / 30% / 50%，选择存在 localStorage（键默认 foxlock.bgm）。
 * 浏览器的自动播放策略要求先有用户交互，所以 play() 失败是正常情况：
 * 这里只做"等下一次点击/按键再试"，不报错、不刷控制台。
 *
 * 单文件演示页把音频内联成 data URI 放在 window.__FOX_BGM，走同一个控制器；
 * 多文件版直接用相对路径 assets/music/bgm.mp3。
 */

export const BGM_STEPS = [
  { key: 'off', label: '关', volume: 0, icon: '🔇' },
  { key: 'low', label: '20%', volume: 0.2, icon: '🔈' },
  { key: 'mid', label: '30%', volume: 0.3, icon: '🔉' },
  { key: 'high', label: '50%', volume: 0.5, icon: '🔊' },
];

const FADE_STEP = 0.05;
const FADE_TICK_MS = 45;

export function createBgm({
  src = '',
  shouldPlay = () => true,
  storageKey = 'foxlock.bgm',
  defaultKey = 'mid',
  onUnavailable = null,
} = {}) {
  let index = Math.max(0, BGM_STEPS.findIndex((s) => s.key === defaultKey));
  let audio = null; // 懒创建：没音源就不造 <audio>
  let unlocked = false; // 浏览器是否已经给了播放许可
  let pending = false; // play() 的 promise 还在路上，这段时间绝不能 pause()
  let broken = false; // 音源解不开（文件丢了 / data URI 坏了）
  let fading = null;
  let disposed = false;
  const listeners = new Set();

  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
    const i = BGM_STEPS.findIndex((s) => s.key === saved);
    if (i >= 0) index = i;
  } catch {
    /* 隐私模式下 localStorage 可能直接抛错，忽略即可 */
  }

  const step = () => BGM_STEPS[index];
  const isOff = () => index === 0;

  function persist() {
    try {
      localStorage.setItem(storageKey, step().key);
    } catch {
      /* 存不了就算了，本次会话照样生效 */
    }
  }

  function emit() {
    const s = state();
    for (const fn of listeners) {
      try {
        fn(s);
      } catch {
        /* 订阅方自己的问题不该影响播放 */
      }
    }
  }

  function state() {
    const s = step();
    return {
      key: s.key,
      label: s.label,
      icon: s.icon,
      level: s.volume,
      off: isOff(),
      playing: Boolean(audio && !audio.paused),
      volume: audio ? Math.round(audio.volume * 100) / 100 : 0,
      unlocked,
      broken,
    };
  }

  function debug() {
    return {
      ...state(),
      pending,
      paused: audio ? audio.paused : true,
      currentTime: audio ? Math.round(audio.currentTime * 100) / 100 : 0,
      loop: audio ? audio.loop : false,
      srcLength: src ? src.length : 0,
    };
  }

  function ensure() {
    if (audio || !src || typeof Audio === 'undefined') return audio;
    try {
      audio = new Audio();
    } catch {
      broken = true;
      return null;
    }
    audio.loop = true;
    audio.preload = 'none';
    audio.volume = 0;
    audio.setAttribute('playsinline', '');
    audio.addEventListener('error', () => {
      if (broken) return;
      broken = true;
      stopFade();
      try {
        onUnavailable?.();
      } catch {
        /* 提示失败无所谓 */
      }
      emit();
    });
    audio.src = src;
    return audio;
  }

  function stopFade() {
    if (fading) {
      clearInterval(fading);
      fading = null;
    }
  }

  function fadeTo(target, done) {
    if (!audio) return;
    if (Math.abs(audio.volume - target) < 0.02) {
      stopFade();
      audio.volume = target;
      if (done) done();
      return;
    }
    stopFade();
    fading = setInterval(() => {
      if (!audio || disposed) {
        stopFade();
        return;
      }
      const v = audio.volume;
      if (Math.abs(target - v) <= FADE_STEP) {
        audio.volume = target;
        stopFade();
        if (done) done();
        return;
      }
      audio.volume = v + (target > v ? FADE_STEP : -FADE_STEP);
    }, FADE_TICK_MS);
  }

  const wanted = () => !isOff() && !broken && !document.hidden && shouldPlay();

  /** 每帧/每次状态变化后调用：把"该不该响"落到 <audio> 上 */
  function sync() {
    if (disposed || broken || !src) return;
    if (wanted()) {
      if (!unlocked) {
        // 还没拿到播放许可：保持安静，等用户点一下
        if (!pending && audio && !audio.paused) audio.pause();
        return;
      }
      ensure();
      if (!audio) return;
      if (audio.paused) {
        audio.volume = 0;
        const p = audio.play();
        if (p && p.catch) p.catch(() => { unlocked = false; });
      }
      if (!audio.paused) fadeTo(step().volume);
    } else if (audio && !audio.paused) {
      fadeTo(0, () => {
        if (audio && !wanted()) audio.pause();
      });
    }
  }

  /** 拿播放许可：必须在用户交互的回调里调用（点击/按键） */
  function unlock() {
    if (disposed || unlocked || broken || pending || isOff() || !src) return;
    ensure();
    if (!audio) return;
    pending = true;
    audio.volume = 0;
    const p = audio.play();
    if (!p || !p.then) {
      pending = false;
      unlocked = true;
      sync();
      emit();
      return;
    }
    p.then(() => {
      pending = false;
      unlocked = true;
      sync();
      emit();
    }).catch(() => {
      pending = false;
      if (audio && !audio.paused) audio.pause();
    });
  }

  function apply(key) {
    const i = BGM_STEPS.findIndex((s) => s.key === key);
    if (i < 0 || i === index) return state();
    index = i;
    persist();
    if (isOff()) {
      if (audio) fadeTo(0, () => { if (audio && isOff()) audio.pause(); });
    } else {
      unlock();
      sync();
    }
    emit();
    return state();
  }

  /** 关 → 20% → 30% → 50% → 关 */
  function cycle() {
    return apply(BGM_STEPS[(index + 1) % BGM_STEPS.length].key);
  }

  function init() {
    if (disposed) return;
    if (!src) {
      broken = true;
      return;
    }
    ensure();
    document.addEventListener('visibilitychange', sync);
    // pointerdown 在捕获阶段就能拿到，比 click 早，切换页面也能顺带解锁
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    // 有的环境（已经交互过的标签页、桌面 PWA）允许直接播放，先试一次
    unlock();
    sync();
  }

  function dispose() {
    disposed = true;
    stopFade();
    document.removeEventListener('visibilitychange', sync);
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
    }
    listeners.clear();
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    init,
    sync,
    unlock,
    cycle,
    apply,
    state,
    debug,
    onChange,
    dispose,
    get audio() {
      return audio;
    },
  };
}
