import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  sampleDistinct,
  shuffle,
  createRound,
  clickValue,
  currentTarget,
  remainingMs,
  checkTimeout,
  roundProgress,
} from '../src/core/matrix.js';

test('normalizeConfig 纠正非法参数', () => {
  const cfg = normalizeConfig({ gridSize: 9, maxNumber: 2, timeLimitSec: -1, maxErrors: 0, cooldownMinutes: 999 });
  assert.equal(cfg.gridSize, 6);
  assert.equal(cfg.maxNumber, 36);
  assert.equal(cfg.timeLimitSec, 0);
  assert.equal(cfg.maxErrors, 1);
  assert.equal(cfg.cooldownMinutes, 120);
});

test('sampleDistinct 数量正确、不重复、在范围内', () => {
  for (let i = 0; i < 50; i += 1) {
    const list = sampleDistinct(16, 16, Math.random);
    assert.equal(list.length, 16);
    assert.equal(new Set(list).size, 16);
    assert.deepEqual([...list].sort((a, b) => a - b), Array.from({ length: 16 }, (_, k) => k + 1));
  }
  const sparse = sampleDistinct(100, 9, Math.random);
  assert.equal(sparse.length, 9);
  assert.ok(sparse.every((n) => n >= 1 && n <= 100));
});

test('maxNumber 小于格子数时取格子数', () => {
  const cfg = normalizeConfig({ gridSize: 4, maxNumber: 5 });
  assert.equal(cfg.maxNumber, 16);
  assert.equal(cfg.cellCount, 16);
});

test('createRound 生成合法棋盘与升序答案', () => {
  const round = createRound({ gridSize: 4, maxNumber: 16 }, 0, Math.random);
  assert.equal(round.cells.length, 16);
  assert.equal(round.order.length, 16);
  assert.deepEqual(round.order, [...round.order].sort((a, b) => a - b));
  assert.equal(new Set(round.cells.map((c) => c.value)).size, 16);
  assert.equal(round.status, 'playing');
  assert.equal(currentTarget(round), 1);
});

test('按升序点完 → won', () => {
  let round = createRound({ gridSize: 3, maxNumber: 9 }, 0, Math.random);
  for (const value of round.order) {
    const res = clickValue(round, value, 100);
    round = res.round;
  }
  assert.equal(round.status, 'won');
  assert.equal(roundProgress(round), 1);
});

test('点错：错误数累加但不回退进度', () => {
  let round = createRound({ gridSize: 3, maxNumber: 9, maxErrors: 3 }, 0, Math.random);
  round = clickValue(round, 1, 0).round;
  assert.equal(round.idx, 1);
  const bad = clickValue(round, 7, 10);
  assert.equal(bad.result, 'wrong');
  round = bad.round;
  assert.equal(round.idx, 1, '进度不回退');
  assert.equal(round.errors, 1);
  assert.equal(round.status, 'playing');
});

test('错误超过上限 → lost，游戏内可重开', () => {
  let round = createRound({ gridSize: 3, maxNumber: 9, maxErrors: 2 }, 0, Math.random);
  round = clickValue(round, 9, 1).round; // 错的（目标是 1）
  assert.equal(round.errors, 1);
  round = clickValue(round, 8, 2).round;
  assert.equal(round.status, 'lost');
  const again = clickValue(round, 1, 3);
  assert.equal(again.result, 'ignored', '已结束的局不再响应点击');
  const fresh = createRound({ gridSize: 3, maxNumber: 9 }, 3, Math.random);
  assert.equal(fresh.status, 'playing');
});

test('超时判负；不限时不超时', () => {
  const round = createRound({ gridSize: 3, maxNumber: 9, timeLimitSec: 30 }, 1000, Math.random);
  assert.equal(remainingMs(round, 1000 + 29000), 1000);
  assert.equal(checkTimeout(round, 1000 + 31000).status, 'lost');
  assert.equal(checkTimeout(round, 1000 + 1000).status, 'playing');
  const endless = createRound({ gridSize: 3, maxNumber: 9, timeLimitSec: 0 }, 0, Math.random);
  assert.equal(remainingMs(endless, 99999999), Infinity);
  assert.equal(checkTimeout(endless, 99999999).status, 'playing');
});

test('大 maxNumber 稀疏矩阵：答案仍是取出的那批数字', () => {
  const round = createRound({ gridSize: 4, maxNumber: 100 }, 0, Math.random);
  assert.equal(round.order.length, 16);
  assert.equal(round.order.at(-1) <= 100, true);
  assert.deepEqual(
    [...round.cells.map((c) => c.value)].sort((a, b) => a - b),
    [...round.order],
  );
});

test('shuffle 不改变元素集合', () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffle(input, Math.random);
  assert.deepEqual([...out].sort(), input);
  assert.deepEqual(input, [1, 2, 3, 4, 5], '不改原数组');
});
