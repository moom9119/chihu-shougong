/**
 * fox.js —— 小狐狸的收集与成败判定。
 *
 * 状态：collecting（收集）→ success（坚持到最后）/ failed（中途离开）
 *       rest 期间 paused，离开不算失败。
 *
 * 收集是"自动"的：每 20 秒一根羽毛、每 5 分钟一朵花。故意不做成需要盯着屏幕的玩法，
 * 否则等于用另一种方式把人绑在屏幕上。
 */

export const FEATHER_INTERVAL_MS = 20 * 1000;
export const FLOWER_INTERVAL_MS = 5 * 60 * 1000;
export const FEATHER_CAP = 150;
export const FLOWER_CAP = 8;

export function createFox(now, extra = {}) {
  return {
    state: 'collecting',
    feathers: 0,
    flowers: 0,
    startedAt: now,
    lastDropAt: now,
    lastFlowerAt: now,
    pausedAt: null,
    resumeGraceUntil: now + 1200,
    failedAt: null,
    reason: null,
    ...extra,
  };
}

/** 时间驱动的收集；返回新的 fox（无变化时返回原对象引用，便于浅比较） */
export function tickFox(fox, now) {
  if (!fox || fox.state !== 'collecting') return fox;
  let next = fox;
  const dtF = now - fox.lastDropAt;
  if (dtF >= FEATHER_INTERVAL_MS && fox.feathers < FEATHER_CAP) {
    const gained = Math.min(Math.floor(dtF / FEATHER_INTERVAL_MS), FEATHER_CAP - fox.feathers);
    next = {
      ...next,
      feathers: fox.feathers + gained,
      lastDropAt: fox.lastDropAt + gained * FEATHER_INTERVAL_MS,
    };
  }
  const dtW = now - fox.lastFlowerAt;
  if (dtW >= FLOWER_INTERVAL_MS && next.flowers < FLOWER_CAP) {
    const gained = Math.min(Math.floor(dtW / FLOWER_INTERVAL_MS), FLOWER_CAP - next.flowers);
    next = {
      ...next,
      flowers: next.flowers + gained,
      lastFlowerAt: fox.lastFlowerAt + gained * FLOWER_INTERVAL_MS,
    };
  }
  return next;
}

export function pauseFox(fox, now) {
  if (!fox || fox.state !== 'collecting') return fox;
  return { ...fox, state: 'paused', pausedAt: now };
}

export function resumeFox(fox, now, graceMs = 1500) {
  if (!fox || fox.state !== 'paused') return fox;
  return {
    ...fox,
    state: 'collecting',
    pausedAt: null,
    // 从休息回到锁定，给一小段宽限，避免"刚回来还没聚焦"就被判失败
    resumeGraceUntil: now + graceMs,
    lastDropAt: now,
    lastFlowerAt: fox.lastFlowerAt,
  };
}

export function failFox(fox, now, reason = 'leave') {
  if (!fox || fox.state === 'failed') return fox;
  return { ...fox, state: 'failed', failedAt: now, reason };
}

export function foxCanLeaveFail(fox, now) {
  if (!fox || fox.state !== 'collecting') return false;
  return now >= fox.resumeGraceUntil;
}

export function foxOutcome(fox) {
  if (!fox) return 'left';
  return fox.state === 'failed' ? 'left' : 'success';
}

/** 用于 UI 的一句话状态 */
export function foxStatusText(fox) {
  if (!fox) return '';
  switch (fox.state) {
    case 'collecting':
      return '正在收集羽毛和花朵';
    case 'paused':
      return '休息中，先歇一会儿';
    case 'failed':
      return '收集失败了…';
    case 'success':
      return '满载而归！';
    default:
      return '';
  }
}
