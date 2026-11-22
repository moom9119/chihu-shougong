/**
 * clock.js —— 可注入的时间源。
 *
 * 为什么要自己包一层时间：
 *  1. 单元测试需要"可拨动的假时钟"，否则没法测跨午夜、休息到期、心跳超时。
 *  2. 演示需要"时间加速"（?speed=60 让 1 小时像 1 分钟一样过去）。
 *  3. 心跳/休眠检测需要比较"真实流逝"与"逻辑流逝"的差值。
 *
 * 所有 core 模块只通过 now() 取时间，不直接碰 Date.now()。
 */

export function createClock({ source = Date.now, speed = 1 } = {}) {
  let speedValue = Number.isFinite(speed) && speed > 0 ? speed : 1;
  let anchorReal = source();
  let anchorVirtual = anchorReal;

  function now() {
    return anchorVirtual + (source() - anchorReal) * speedValue;
  }

  return {
    /** 当前逻辑时间（epoch ms） */
    now,
    get speed() {
      return speedValue;
    },
    /** 变速但保持时间连续，不产生跳变 */
    setSpeed(next) {
      const current = now();
      anchorVirtual = current;
      anchorReal = source();
      speedValue = Number.isFinite(next) && next > 0 ? next : 1;
    },
    /** 仅供演示/调试：直接跳转逻辑时间 */
    shift(ms) {
      anchorVirtual += Number(ms) || 0;
    },
  };
}

/** 测试用：手动推进的假时钟（speed 恒为 1，没有真实流逝） */
export function createFakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    set(v) {
      t = v;
    },
    advance(ms) {
      t += ms;
      return t;
    },
    setSpeed() {
      /* 假时钟不受速度影响 */
    },
    shift(ms) {
      t += ms;
    },
    get speed() {
      return 1;
    },
  };
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 把毫秒格式化成 时:分:秒 / 分:秒 */
export function formatDuration(ms, { withHours = true } = {}) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0 || withHours) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** 人类友好的"还剩 1 小时 12 分" */
export function humanizeDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h <= 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分`;
}
