import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, reduce, PHASE, toSnapshot, restore, effectiveEndAt, pausedMs } from '../src/core/engine.js';
import { defaultSettings, validateSettings } from '../src/core/settings.js';
import { toDateKey } from '../src/core/collection.js';

const AT = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime();
const NIGHT = [{ id: 'night', label: '夜间', start: '22:30', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6], enabled: true }];
const MIN = 60 * 1000;

function makeSettings(overrides = {}) {
  const s = defaultSettings();
  s.windows = NIGHT.map((w) => ({ ...w }));
  if (overrides.windows) s.windows = overrides.windows;
  if (overrides.prewarnMinutes != null) s.prewarnMinutes = overrides.prewarnMinutes;
  for (const key of ['tasks', 'matrix', 'grayscale', 'interrupt']) {
    if (overrides[key]) s.features[key] = { ...s.features[key], ...overrides[key] };
  }
  return validateSettings(s).settings;
}

function harness({ settings = makeSettings(), now = AT(2026, 11, 21, 21, 0), testMode = false } = {}) {
  let state = createState({ settings, now, testMode });
  const all = [];
  const send = (type, payload = {}) => {
    const event = { type, now: payload.now ?? state.now, ...payload };
    const r = reduce(state, event);
    state = r.state;
    all.push(...r.effects);
    return r;
  };
  const tick = (t) => send('TICK', { now: t });
  return {
    get state() {
      return state;
    },
    get effects() {
      return all;
    },
    send,
    tick,
    drain() {
      const copy = [...all];
      all.length = 0;
      return copy;
    },
    hasEffect(type) {
      return all.some((e) => e.type === type);
    },
  };
}

test('预警：开始前 10 分钟进入 prewarn，到点进入 locked', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 19));
  assert.equal(h.state.phase, PHASE.IDLE, '22:19 还没到预警窗口');
  h.tick(AT(2026, 11, 21, 22, 20));
  assert.equal(h.state.phase, PHASE.PREWARN);
  assert.ok(h.hasEffect('enter-prewarn'));
  h.tick(AT(2026, 11, 21, 22, 30));
  assert.equal(h.state.phase, PHASE.LOCKED);
  assert.equal(h.state.session.startAt, AT(2026, 11, 21, 22, 30));
  assert.equal(h.state.session.endAt, AT(2026, 11, 22, 7, 0));
});

test('进入锁定会打开灰度、启动狐狸、播放音效', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  const effects = h.drain();
  assert.ok(effects.some((e) => e.type === 'grayscale' && e.on === true));
  assert.ok(effects.some((e) => e.type === 'enter-locked'));
  assert.ok(effects.some((e) => e.type === 'sound' && e.name === 'start'));
  assert.equal(h.state.session.fox.state, 'collecting');
});

test('灰度开关关闭时进入锁定不打开灰度', () => {
  const h = harness({ settings: makeSettings({ grayscale: { enabled: false } }) });
  h.tick(AT(2026, 11, 21, 22, 30));
  const effects = h.drain();
  assert.ok(effects.some((e) => e.type === 'grayscale' && e.on === false));
  assert.ok(h.state.session);
});

test('狐狸按时间收集羽毛和花朵', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.tick(AT(2026, 11, 21, 22, 30) + 20 * 1000);
  assert.equal(h.state.session.fox.feathers, 1);
  h.tick(AT(2026, 11, 21, 22, 30) + 5 * MIN);
  assert.ok(h.state.session.fox.feathers >= 15);
  assert.equal(h.state.session.fox.flowers, 1);
});

test('限制中途离开 → 狐狸失败并给出哭泣反馈', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  const t = AT(2026, 11, 21, 23, 0);
  h.tick(t);
  h.send('FOX_LEAVE', { now: t + 1000, reason: 'hidden' });
  assert.equal(h.state.session.fox.state, 'failed');
  assert.equal(h.state.session.fox.reason, 'hidden');
  assert.ok(h.hasEffect('fox-failed'));
  assert.equal(h.state.session.leaves.length, 1);
});

test('刚进入锁定的宽限期内切换不算失败', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('FOX_LEAVE', { now: AT(2026, 11, 21, 22, 30) + 300, reason: 'blur' });
  assert.equal(h.state.session.fox.state, 'collecting');
});

test('坚持到结束 → outcome=success 并写收藏记录', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.tick(AT(2026, 11, 22, 7, 0));
  assert.equal(h.state.phase, PHASE.RESULT);
  assert.equal(h.state.result.outcome, 'success');
  const finalize = h.effects.find((e) => e.type === 'finalize');
  assert.ok(finalize, '应当发出 finalize 副作用');
  assert.equal(finalize.record.outcome, 'success');
  assert.equal(finalize.record.label, '夜间');
  assert.equal(finalize.record.date, undefined);
});

test('离开过的人到结束 → outcome=left，不发花', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  const t = AT(2026, 11, 21, 23, 0);
  h.tick(t);
  h.send('FOX_LEAVE', { now: t + 1000, reason: 'hidden' });
  h.tick(AT(2026, 11, 22, 7, 0));
  assert.equal(h.state.result.outcome, 'left');
  const finalize = h.effects.filter((e) => e.type === 'finalize').at(-1);
  assert.equal(finalize.record.outcome, 'left');
});

test('任务达标 → 进入休息，灰度恢复；休息结束回到锁定', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('TASK_ADD', { text: '写复盘', now: AT(2026, 11, 21, 22, 31) });
  h.send('TASK_ADD', { text: '读 20 分钟', now: AT(2026, 11, 21, 22, 31) });
  assert.equal(h.state.session.tasks.length, 2);
  const [a, b] = h.state.session.tasks;
  h.send('TASK_TOGGLE', { id: a.id, now: AT(2026, 11, 21, 22, 40) });
  h.send('TASK_TOGGLE', { id: b.id, now: AT(2026, 11, 21, 22, 41) });
  h.drain();
  h.tick(AT(2026, 11, 21, 22, 42));
  assert.equal(h.state.phase, PHASE.REST);
  assert.ok(h.effects.some((e) => e.type === 'grayscale' && e.on === false), '休息要解除灰度');
  assert.equal(h.state.session.rest.untilAt, AT(2026, 11, 21, 22, 52));

  h.tick(AT(2026, 11, 21, 22, 53));
  assert.equal(h.state.phase, PHASE.LOCKED);
  assert.ok(h.effects.some((e) => e.type === 'grayscale' && e.on === true), '休息结束灰度恢复');
  assert.equal(h.state.session.rest.usedMs, 11 * MIN);
});

test('休息期间切屏不算狐狸失败', () => {
  const h = harness({ settings: makeSettings({ tasks: { threshold: 1 } }) });
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('TASK_ADD', { text: '一件事' });
  h.send('TASK_TOGGLE', { id: h.state.session.tasks[0].id, now: AT(2026, 11, 21, 22, 35) });
  h.tick(AT(2026, 11, 21, 22, 36));
  assert.equal(h.state.phase, PHASE.REST);
  h.send('FOX_LEAVE', { now: AT(2026, 11, 21, 22, 37), reason: 'hidden' });
  assert.equal(h.state.session.fox.state, 'paused');
  h.tick(AT(2026, 11, 21, 22, 50));
  assert.equal(h.state.phase, PHASE.LOCKED);
  assert.equal(h.state.session.fox.state, 'collecting');
  assert.ok(h.state.session.leaves.length === 0);
});

test('休息只发一次：取消勾选再勾满不会重复发放', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('TASK_ADD', { text: '任务A' });
  const id = h.state.session.tasks[0].id;
  h.send('TASK_TOGGLE', { id, now: AT(2026, 11, 21, 22, 31) });
  h.tick(AT(2026, 11, 21, 22, 32));
  assert.equal(h.state.phase, PHASE.REST);
  h.send('REST_SKIP', { now: AT(2026, 11, 21, 22, 33) });
  assert.equal(h.state.phase, PHASE.LOCKED);
  h.send('TASK_TOGGLE', { id, now: AT(2026, 11, 21, 22, 34) });
  assert.equal(h.state.session.tasks[0].done, false);
  h.send('TASK_TOGGLE', { id, now: AT(2026, 11, 21, 22, 35) });
  h.tick(AT(2026, 11, 21, 22, 36));
  assert.equal(h.state.phase, PHASE.LOCKED, '第二次达标不再发休息');
});

test('任务功能关闭 → 勾满也不进入休息', () => {
  const h = harness({ settings: makeSettings({ tasks: { enabled: false } }) });
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('TASK_ADD', { text: '任务A' });
  const id = h.state.session.tasks[0].id;
  h.send('TASK_TOGGLE', { id, now: AT(2026, 11, 21, 22, 31) });
  h.tick(AT(2026, 11, 21, 22, 32));
  assert.equal(h.state.phase, PHASE.LOCKED);
});

test('只关休息、保留任务：进度照常但不发休息', () => {
  const h = harness({ settings: makeSettings({ tasks: { restEnabled: false } }) });
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('TASK_ADD', { text: '任务A' });
  h.send('TASK_TOGGLE', { id: h.state.session.tasks[0].id, now: AT(2026, 11, 21, 22, 31) });
  h.tick(AT(2026, 11, 21, 22, 32));
  assert.equal(h.state.phase, PHASE.LOCKED);
  assert.equal(h.state.session.tasks[0].done, true);
});

test('阈值 50%：勾一半就能休息', () => {
  const h = harness({ settings: makeSettings({ tasks: { restThresholdPercent: 50 } }) });
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('TASK_ADD', { text: 'A' });
  h.send('TASK_ADD', { text: 'B' });
  h.send('TASK_TOGGLE', { id: h.state.session.tasks[0].id, now: AT(2026, 11, 21, 22, 31) });
  h.tick(AT(2026, 11, 21, 22, 32));
  assert.equal(h.state.phase, PHASE.REST);
});

test('休息时长会被限制结束时间截断', () => {
  const h = harness({ settings: makeSettings({ tasks: { restMinutes: 120 } }) });
  const start = AT(2026, 11, 21, 22, 30);
  h.tick(start);
  h.send('TASK_ADD', { text: 'A' });
  h.send('TASK_TOGGLE', { id: h.state.session.tasks[0].id, now: start + MIN });
  const nearEnd = AT(2026, 11, 22, 6, 50);
  h.tick(nearEnd);
  assert.equal(h.state.phase, PHASE.REST);
  assert.equal(h.state.session.rest.untilAt, AT(2026, 11, 22, 7, 0));
});

test('矩阵：触发 → 打开；冷却期内不重复弹；通关后进入冷却', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.drain();
  h.send('MATRIX_TRIGGER', { now: AT(2026, 11, 21, 23, 0) });
  assert.ok(h.effects.some((e) => e.type === 'matrix-open'));
  assert.equal(h.state.session.matrix.triggers, 1);
  h.send('MATRIX_SOLVED', { now: AT(2026, 11, 21, 23, 1) });
  assert.ok(h.effects.some((e) => e.type === 'matrix-close' && e.solved === true));
  assert.equal(h.state.session.matrix.cooldownUntil, AT(2026, 11, 21, 23, 1) + 5 * MIN);
  h.drain();
  h.send('MATRIX_TRIGGER', { now: AT(2026, 11, 21, 23, 3) });
  assert.equal(h.effects.length, 0, '冷却期内不弹');
  h.send('MATRIX_TRIGGER', { now: AT(2026, 11, 21, 23, 10) });
  assert.ok(h.effects.some((e) => e.type === 'matrix-open'));
});

test('矩阵关闭时触发无效', () => {
  const h = harness({ settings: makeSettings({ matrix: { enabled: false } }) });
  h.tick(AT(2026, 11, 21, 22, 30));
  h.drain();
  h.send('MATRIX_TRIGGER', { now: AT(2026, 11, 21, 23, 0) });
  assert.equal(h.effects.length, 0);
});

test('总开关关闭：正在进行的限制被中止，狐狸不判失败', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  const settings = makeSettings();
  settings.enabled = false;
  h.send('SETTINGS', { settings, now: AT(2026, 11, 21, 23, 0) });
  assert.equal(h.state.phase, PHASE.RESULT);
  assert.equal(h.state.result.outcome, 'aborted');
  assert.equal(h.state.result.reason, 'disabled');
  const finalize = h.effects.filter((e) => e.type === 'finalize').at(-1);
  assert.equal(finalize.record.feathers >= 0, true);
});

test('紧急退出：长按结束 → aborted', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('EMERGENCY_EXIT', { now: AT(2026, 11, 21, 23, 0) });
  assert.equal(h.state.phase, PHASE.RESULT);
  assert.equal(h.state.result.outcome, 'aborted');
  assert.equal(h.state.result.reason, 'emergency');
});

test('预览模式不写收藏', () => {
  const h = harness();
  h.send('PREVIEW_START', { durationMs: 60 * 1000, now: AT(2026, 11, 21, 20, 0) });
  assert.equal(h.state.phase, PHASE.LOCKED);
  h.tick(AT(2026, 11, 21, 20, 1));
  assert.equal(h.state.phase, PHASE.RESULT);
  assert.ok(!h.effects.some((e) => e.type === 'finalize'), '演练不写记录');
});

test('在试跑里长按结束，不该把真实时段记成"已跳过"', () => {
  const h = harness();
  h.send('PREVIEW_START', { durationMs: 60 * 1000, now: AT(2026, 11, 21, 20, 0) });
  assert.equal(h.state.phase, PHASE.LOCKED);
  h.send('EMERGENCY_EXIT', { now: AT(2026, 11, 21, 20, 0) + 5000 });
  assert.equal(h.state.phase, PHASE.RESULT);
  h.send('RESULT_ACK', { now: AT(2026, 11, 21, 20, 0) + 6000 });
  assert.equal(h.state.phase, PHASE.IDLE);
  assert.equal(h.state.skippedStartAt, null, '试跑不该污染真实的跳过标记');
});

test('刷新恢复：locked 中断超过宽限 → 狐狸失败但锁定继续', () => {
  const h = harness();
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.tick(t0 + 10 * MIN);
  const snap = toSnapshot(h.state);
  const fresh = harness({ now: t0 + 10 * MIN });
  fresh.send('RESTORE', { snapshot: snap, now: t0 + 10 * MIN + 30 * 1000 });
  assert.equal(fresh.state.phase, PHASE.LOCKED);
  assert.equal(fresh.state.session.fox.state, 'failed');
  assert.equal(fresh.state.session.fox.reason, 'app-closed');
});

test('刷新恢复：断开时间很短不算离开', () => {
  const h = harness();
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  const snap = toSnapshot(h.state);
  const fresh = harness({ now: t0 });
  fresh.send('RESTORE', { snapshot: snap, now: t0 + 400 });
  assert.equal(fresh.state.session.fox.state, 'collecting');
});

test('刷新恢复时限制已结束 → 直接结算为 left', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.tick(AT(2026, 11, 21, 23, 0));
  const snap = toSnapshot(h.state);
  const fresh = harness({ now: AT(2026, 11, 21, 23, 0) });
  fresh.send('RESTORE', { snapshot: snap, now: AT(2026, 11, 22, 8, 0) });
  assert.equal(fresh.state.phase, PHASE.RESULT);
  assert.equal(fresh.state.result.outcome, 'left');
});

test('刷新恢复：休息中刷新不算失败', () => {
  const h = harness();
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.send('TASK_ADD', { text: 'A' });
  h.send('TASK_TOGGLE', { id: h.state.session.tasks[0].id, now: t0 + MIN });
  h.tick(t0 + 2 * MIN);
  assert.equal(h.state.phase, PHASE.REST);
  const snap = toSnapshot(h.state);
  const fresh = harness({ now: t0 + 2 * MIN });
  fresh.send('RESTORE', { snapshot: snap, now: t0 + 3 * MIN });
  assert.equal(fresh.state.phase, PHASE.REST);
  assert.notEqual(fresh.state.session.fox.state, 'failed');
});

test('时钟回拨不会崩溃也不会重放', () => {
  const h = harness();
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.tick(t0 + 5 * MIN);
  const fxBefore = h.state.session.fox.feathers;
  h.tick(t0 + 1 * MIN);
  assert.ok(h.state.session.fox.feathers >= fxBefore);
});

test('任务在预警阶段填写，进入锁定后保留', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 20));
  assert.equal(h.state.phase, PHASE.PREWARN);
  h.send('TASK_ADD', { text: '先写计划' });
  h.send('TASK_IMPORT', { tasks: [{ text: '先写计划' }, { text: '读书' }] });
  assert.equal(h.state.session.tasks.length, 2, '去重后两条');
  h.tick(AT(2026, 11, 21, 22, 30));
  assert.equal(h.state.phase, PHASE.LOCKED);
  assert.equal(h.state.session.tasks.length, 2);
  assert.equal(h.state.session.tasks[1].text, '读书');
});

test('预警可以跳过填写，直接进入锁定（空任务）', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 20));
  h.send('PREWARN_DISMISS', { now: AT(2026, 11, 21, 22, 21) });
  assert.equal(h.state.phase, PHASE.IDLE);
  h.tick(AT(2026, 11, 21, 22, 22));
  assert.equal(h.state.phase, PHASE.IDLE, '跳过后不再反复弹');
  h.tick(AT(2026, 11, 21, 22, 30));
  assert.equal(h.state.phase, PHASE.LOCKED);
  assert.equal(h.state.session.tasks.length, 0);
});

test('RESULT_ACK 回到 idle 并清空会话', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.tick(AT(2026, 11, 22, 7, 0));
  h.send('RESULT_ACK', { now: AT(2026, 11, 22, 7, 1) });
  assert.equal(h.state.phase, PHASE.IDLE);
  assert.equal(h.state.session, null);
  assert.equal(h.state.result, null);
});

test('结果里带上奖励信息', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.tick(AT(2026, 11, 22, 7, 0));
  h.send('RESULT_FINALIZED', { reward: { flowerId: 'rose', isNewSpecies: true, streakDays: 3 } });
  assert.equal(h.state.result.reward.flowerId, 'rose');
  assert.equal(h.state.result.reward.streakDays, 3);
});

test('快照可以原样 round-trip', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('TASK_ADD', { text: 'A' });
  const snap = toSnapshot(h.state);
  const json = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(json.session.tasks, snap.session.tasks);
  assert.equal(json.phase, 'locked');
});

test('长按提前结束 → 本轮不再重新锁定（不会立刻被锁回去）', () => {
  const h = harness();
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  assert.equal(h.state.phase, PHASE.LOCKED);
  h.send('EMERGENCY_EXIT', { now: AT(2026, 11, 21, 23, 0) });
  assert.equal(h.state.phase, PHASE.RESULT);
  const startAt = h.state.result.startedAt;
  h.send('RESULT_ACK', { now: AT(2026, 11, 21, 23, 1) });
  assert.equal(h.state.phase, PHASE.IDLE);
  assert.equal(h.state.skippedStartAt, startAt);
  // 关键：再 tick 不能又把人锁回限制里
  h.tick(AT(2026, 11, 21, 23, 2));
  assert.equal(h.state.phase, PHASE.IDLE);
  h.tick(AT(2026, 11, 21, 23, 30));
  assert.equal(h.state.phase, PHASE.IDLE);
});

test('跳过一次后，下一段限制仍然正常生效', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('EMERGENCY_EXIT', { now: AT(2026, 11, 21, 23, 0) });
  h.send('RESULT_ACK', { now: AT(2026, 11, 21, 23, 1) });
  h.tick(AT(2026, 11, 22, 8, 0));
  assert.equal(h.state.phase, PHASE.IDLE);
  assert.equal(h.state.skippedStartAt, null, '这一轮结束后跳过标记要清掉');
  h.tick(AT(2026, 11, 22, 22, 31));
  assert.equal(h.state.phase, PHASE.LOCKED, '第二晚仍要锁');
});

test('跳过状态能跨刷新保留（刷新后不会又被锁）', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('EMERGENCY_EXIT', { now: AT(2026, 11, 21, 23, 0) });
  h.send('RESULT_ACK', { now: AT(2026, 11, 21, 23, 1) });
  const snap = JSON.parse(JSON.stringify(toSnapshot(h.state)));
  assert.equal(snap.session, null);
  assert.ok(Number.isFinite(snap.skippedStartAt));

  const fresh = harness({ now: AT(2026, 11, 21, 23, 2) });
  fresh.send('RESTORE', { snapshot: snap, now: AT(2026, 11, 21, 23, 2) });
  assert.equal(fresh.state.phase, PHASE.IDLE);
  fresh.tick(AT(2026, 11, 21, 23, 3));
  assert.equal(fresh.state.phase, PHASE.IDLE, '刷新后不该重新锁定');
});

test('改了设置就清掉跳过标记（改完时间表应立刻按新规则走）', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('EMERGENCY_EXIT', { now: AT(2026, 11, 21, 23, 0) });
  h.send('RESULT_ACK', { now: AT(2026, 11, 21, 23, 1) });
  assert.ok(h.state.skippedStartAt);
  h.send('SETTINGS', { settings: makeSettings(), now: AT(2026, 11, 21, 23, 2) });
  assert.equal(h.state.skippedStartAt, null);
  h.tick(AT(2026, 11, 21, 23, 3));
  assert.equal(h.state.phase, PHASE.LOCKED);
});

test('休息中提前结束也算跳过本轮', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 22, 30));
  h.send('TASK_ADD', { text: 'A' });
  h.send('TASK_TOGGLE', { id: h.state.session.tasks[0].id, now: AT(2026, 11, 21, 22, 35) });
  h.tick(AT(2026, 11, 21, 22, 36));
  assert.equal(h.state.phase, PHASE.REST);
  h.send('EMERGENCY_EXIT', { now: AT(2026, 11, 21, 22, 40) });
  h.send('RESULT_ACK', { now: AT(2026, 11, 21, 22, 41) });
  h.tick(AT(2026, 11, 21, 22, 42));
  assert.equal(h.state.phase, PHASE.IDLE);
});

test('测试模式（?test=1）：到点也不进入限制，但预览仍可用', () => {
  const h = harness({ testMode: true });
  h.tick(AT(2026, 11, 21, 22, 20));
  assert.equal(h.state.phase, PHASE.IDLE, '预警也不该弹');
  h.tick(AT(2026, 11, 21, 22, 31));
  assert.equal(h.state.phase, PHASE.IDLE, '到点也不该锁');
  h.send('PREVIEW_START', { durationMs: 60 * 1000, now: AT(2026, 11, 21, 22, 32) });
  assert.equal(h.state.phase, PHASE.LOCKED, '预览还是能进锁定的');
  h.tick(AT(2026, 11, 21, 22, 33));
  assert.equal(h.state.phase, PHASE.RESULT);
});

test('SKIP_CURRENT：把正在生效的这一段记为已跳过', () => {
  const h = harness();
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  assert.equal(h.state.phase, PHASE.LOCKED);
  // 先退出，回到 idle
  h.send('EMERGENCY_EXIT', { now: t0 + 60000 });
  h.send('RESULT_ACK', { now: t0 + 61000 });
  h.tick(t0 + 62000);
  assert.equal(h.state.phase, PHASE.IDLE);
  const skipped = h.state.skippedStartAt;
  assert.ok(skipped);

  // 再模拟"恢复夜间休息"：SETTINGS 会清掉跳过，SKIP_CURRENT 再把它设回来
  h.send('SETTINGS', { settings: makeSettings(), now: t0 + 120000 });
  assert.equal(h.state.skippedStartAt, null);
  h.send('SKIP_CURRENT', { now: t0 + 121000 });
  h.tick(t0 + 122000);
  assert.equal(h.state.phase, PHASE.IDLE, '跳过之后不应立刻锁定');
});

test('SKIP_CURRENT 在没有生效时段时什么都不改', () => {
  const h = harness();
  h.tick(AT(2026, 11, 21, 12, 0));
  h.send('SKIP_CURRENT', { now: AT(2026, 11, 21, 12, 1) });
  assert.equal(h.state.skippedStartAt, null);
});

// ---------------------------------------------------------------- 重要联系人

const CONTACT = { id: 'c1', app: 'wechat', name: '张老师', enabled: true };
function withContacts(extra = {}) {
  return makeSettings({
    interrupt: {
      enabled: true,
      autoPause: true,
      ringTimes: 2,
      ringIntervalMs: 500,
      cooldownSeconds: 20,
      contacts: [CONTACT],
      ...extra,
    },
  });
}

test('重要联系人发消息 → 响铃 + 自动暂停计时 + 解除灰度', () => {
  const h = harness({ settings: withContacts() });
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.drain();
  h.send('INCOMING_MESSAGE', { app: 'wechat', contact: '张老师', now: t0 + 5 * MIN });
  assert.equal(h.state.session.pause.active, true);
  assert.equal(h.state.session.pause.reason.contact, '张老师');
  assert.equal(h.state.session.pause.count, 1);
  assert.ok(h.effects.some((e) => e.type === 'ring'), '应当响铃');
  assert.ok(h.effects.some((e) => e.type === 'pause-start'));
  assert.ok(h.effects.some((e) => e.type === 'grayscale' && e.on === false), '暂停时解除灰度');
});

test('暂停期间倒计时冻结：剩余时间不减少', () => {
  const h = harness({ settings: withContacts() });
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  const t1 = t0 + 5 * MIN;
  h.send('INCOMING_MESSAGE', { app: 'wechat', contact: '张老师', now: t1 });
  const remain1 = effectiveEndAt(h.state.session, t1) - t1;
  h.tick(t1 + 40 * MIN);
  assert.equal(h.state.phase, PHASE.LOCKED, '暂停期间不能结束');
  const remain2 = effectiveEndAt(h.state.session, t1 + 40 * MIN) - (t1 + 40 * MIN);
  assert.equal(remain2, remain1, '剩余时间应当一毫秒都不动');
});

test('恢复计时：结束时间自动顺延，暂停时长记进结果', () => {
  const h = harness({ settings: withContacts() });
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  const planEnd = h.state.session.endAt;
  const t1 = t0 + 5 * MIN;
  h.send('INCOMING_MESSAGE', { app: 'wechat', contact: '张老师', now: t1 });
  h.send('RESUME_FROM_MESSAGE', { now: t1 + 30 * MIN });
  assert.equal(h.state.session.pause.active, false);
  assert.equal(h.state.session.pause.totalMs, 30 * MIN);
  assert.equal(h.state.session.endAt, planEnd, '计划结束时间本身不变');
  assert.equal(effectiveEndAt(h.state.session, t1 + 30 * MIN), planEnd + 30 * MIN);

  h.tick(planEnd + MIN);
  assert.equal(h.state.phase, PHASE.LOCKED, '顺延后原来的结束时间点不该结束');
  h.tick(planEnd + 31 * MIN);
  assert.equal(h.state.phase, PHASE.RESULT);
  assert.equal(h.state.result.pausedMs, 30 * MIN);
  assert.equal(h.state.result.interrupts, 1);
  // 时长按"顺延后的计划结束"算：22:30 → 07:00 = 8.5 小时，不含暂停
  assert.ok(Math.abs(h.state.result.durationMs - 8.5 * 60 * MIN) < MIN, `durationMs=${h.state.result.durationMs}`);
});

test('名单外的联系人：不响铃、不暂停', () => {
  const h = harness({ settings: withContacts() });
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.drain();
  h.send('INCOMING_MESSAGE', { app: 'wechat', contact: '路人甲', now: t0 + MIN });
  assert.equal(h.effects.length, 0);
  assert.equal(h.state.session.pause.active, false);
});

test('关闭「自动暂停」：只在限制期间响铃，不冻结计时', () => {
  const h = harness({ settings: withContacts({ autoPause: false }) });
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.drain();
  h.send('INCOMING_MESSAGE', { app: 'wechat', contact: '张老师', now: t0 + MIN });
  assert.ok(h.effects.some((e) => e.type === 'ring'));
  assert.equal(h.state.session.pause.active, false);
});

test('功能关闭时完全忽略', () => {
  const h = harness({ settings: withContacts({ enabled: false }) });
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.drain();
  h.send('INCOMING_MESSAGE', { app: 'wechat', contact: '张老师', now: t0 + MIN });
  assert.equal(h.effects.length, 0);
});

test('冷却期内同一联系人只响一次，其他人照常', () => {
  const settings = withContacts({ contacts: [CONTACT, { id: 'c2', app: 'qq', name: '老板', enabled: true }] });
  const h = harness({ settings });
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.send('INCOMING_MESSAGE', { app: 'wechat', contact: '张老师', now: t0 + MIN });
  h.drain();
  h.send('INCOMING_MESSAGE', { app: 'wechat', contact: '张老师', now: t0 + 5 * 1000 });
  assert.equal(h.effects.length, 0, '冷却期内不该重复响');
  h.send('INCOMING_MESSAGE', { app: 'qq', contact: '老板', now: t0 + 6 * 1000 });
  assert.ok(h.effects.some((e) => e.type === 'ring'), '换个人应当照常响');
});

test('暂停期间离开不算狐狸失败，也不弹矩阵', () => {
  const h = harness({ settings: withContacts() });
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.send('INCOMING_MESSAGE', { app: 'wechat', contact: '张老师', now: t0 + MIN });
  h.send('FOX_LEAVE', { reason: 'hidden', now: t0 + 2 * MIN });
  assert.equal(h.state.session.fox.state, 'paused');
  h.drain();
  h.send('MATRIX_TRIGGER', { now: t0 + 2 * MIN });
  assert.equal(h.effects.length, 0, '暂停时不该弹游戏');
});

test('名单为空时不做过滤（方便先用起来）', () => {
  const h = harness({ settings: withContacts({ contacts: [] }) });
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.send('INCOMING_MESSAGE', { app: 'dingtalk', contact: '任何人', now: t0 + MIN });
  assert.equal(h.state.session.pause.active, true);
});

test('休息期间来消息也冻结休息倒计时', () => {
  const h = harness({ settings: withContacts() });
  const t0 = AT(2026, 11, 21, 22, 30);
  h.tick(t0);
  h.send('TASK_ADD', { text: 'A' });
  h.send('TASK_TOGGLE', { id: h.state.session.tasks[0].id, now: t0 + MIN });
  h.tick(t0 + 2 * MIN);
  assert.equal(h.state.phase, PHASE.REST);
  const until = h.state.session.rest.untilAt;
  h.send('INCOMING_MESSAGE', { app: 'wechat', contact: '张老师', now: t0 + 3 * MIN });
  h.tick(t0 + 30 * MIN);
  assert.equal(h.state.phase, PHASE.REST, '暂停期间休息不该结束');
  h.send('RESUME_FROM_MESSAGE', { now: t0 + 30 * MIN });
  assert.equal(h.state.session.rest.untilAt, until, '休息到期时间本身不变');
});

test('日期键与本地时区一致（结果日期用于统计）', () => {
  assert.equal(toDateKey(AT(2026, 11, 22, 7, 0)), '2026-11-22');
});
