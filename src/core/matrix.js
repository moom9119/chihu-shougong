/**
 * matrix.js —— 数字矩阵小游戏（纯逻辑，渲染在 ui/matrix-board.js）。
 *
 * 规则：
 *  - 从 1..maxNumber 里不重复抽 gridSize² 个数字，打乱铺满格子；
 *  - 按数值升序依次点击；
 *  - 点错 → errors+1（不重置进度），超过 maxErrors 判负重开；
 *  - 超时 → 判负重开；
 *  - 通关 → 关闭弹窗并进入冷却。
 */

const num = (v, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
};

export function normalizeConfig(cfg = {}) {
  const gridSize = Math.min(6, Math.max(3, num(cfg.gridSize, 4)));
  const cellCount = gridSize * gridSize;
  const maxNumber = Math.min(144, Math.max(cellCount, num(cfg.maxNumber, cellCount)));
  return {
    gridSize,
    cellCount,
    maxNumber,
    timeLimitSec: Math.min(300, Math.max(0, num(cfg.timeLimitSec, 0))),
    maxErrors: Math.min(10, Math.max(1, num(cfg.maxErrors, 3))),
    cooldownMinutes: Math.min(120, Math.max(0, num(cfg.cooldownMinutes, 0))),
  };
}

/** 从 1..max 中不重复抽 count 个数字（部分 Fisher-Yates） */
export function sampleDistinct(max, count, rng = Math.random) {
  const pool = Array.from({ length: max }, (_, i) => i + 1);
  const take = Math.min(count, max);
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

export function shuffle(list, rng = Math.random) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function createRound(rawCfg, now = 0, rng = Math.random) {
  const cfg = normalizeConfig(rawCfg);
  const numbers = sampleDistinct(cfg.maxNumber, cfg.cellCount, rng);
  const cells = shuffle(numbers, rng).map((value, index) => ({ index, value }));
  return {
    cfg,
    cells,
    order: [...numbers].sort((a, b) => a - b),
    idx: 0,
    errors: 0,
    status: 'playing',
    startedAt: now,
    finishedAt: null,
    lastWrongAt: null,
    lastWrongValue: null,
  };
}

export function currentTarget(round) {
  if (!round || round.status !== 'playing') return null;
  return round.order[round.idx] ?? null;
}

/** 处理一次点击。返回 {round, result} result ∈ ok | wrong | won | lost | ignored */
export function clickValue(round, value, now = 0) {
  if (!round || round.status !== 'playing') return { round, result: 'ignored' };
  const target = round.order[round.idx];
  if (value === target) {
    const idx = round.idx + 1;
    if (idx >= round.order.length) {
      return {
        round: { ...round, idx, status: 'won', finishedAt: now },
        result: 'won',
      };
    }
    return { round: { ...round, idx, lastWrongAt: null, lastWrongValue: null }, result: 'ok' };
  }
  const errors = round.errors + 1;
  const lost = errors >= round.cfg.maxErrors;
  return {
    round: {
      ...round,
      errors,
      status: lost ? 'lost' : 'playing',
      finishedAt: lost ? now : null,
      lastWrongAt: now,
      lastWrongValue: value,
    },
    result: lost ? 'lost' : 'wrong',
  };
}

export function remainingMs(round, now) {
  if (!round || round.cfg.timeLimitSec <= 0) return Infinity;
  return Math.max(0, round.startedAt + round.cfg.timeLimitSec * 1000 - now);
}

export function checkTimeout(round, now) {
  if (!round || round.status !== 'playing') return round;
  if (remainingMs(round, now) > 0) return round;
  return { ...round, status: 'lost', finishedAt: now };
}

export function roundProgress(round) {
  if (!round) return 0;
  return round.idx / round.order.length;
}
