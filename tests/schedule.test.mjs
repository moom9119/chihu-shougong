import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHHMM,
  formatHHMM,
  windowDurationMin,
  isOvernight,
  instancesForDay,
  mergeIntervals,
  sessionsInRange,
  activeSession,
  nextSession,
  sessionsOnDay,
  startOfLocalDay,
} from '../src/core/schedule.js';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const win = (start, end, days = [0, 1, 2, 3, 4, 5, 6], enabled = true, id = 'w1') => ({ id, start, end, days, enabled, label: 't' });

test('parseHHMM / formatHHMM', () => {
  assert.equal(parseHHMM('23:05'), 23 * 60 + 5);
  assert.equal(parseHHMM('7:05'), 7 * 60 + 5);
  assert.equal(parseHHMM('24:00'), null);
  assert.equal(parseHHMM('2:5'), null);
  assert.equal(parseHHMM(''), null);
  assert.equal(parseHHMM(null), null);
  assert.equal(formatHHMM(0), '00:00');
  assert.equal(formatHHMM(1380), '23:00');
  assert.equal(formatHHMM(1500), '01:00');
});

test('时长：普通 / 跨午夜 / 24 小时', () => {
  assert.equal(windowDurationMin(win('09:00', '10:30')), 90);
  assert.equal(windowDurationMin(win('23:00', '07:00')), 480);
  assert.equal(windowDurationMin(win('09:00', '09:00')), 1440);
  assert.equal(isOvernight(win('23:00', '07:00')), true);
  assert.equal(isOvernight(win('09:00', '10:00')), false);
});

test('星期过滤：只在周一生效', () => {
  const monday = at(2026, 11, 23); // 2026-11-23 是周一
  const list = instancesForDay(monday, [win('09:00', '10:00', [1])]);
  assert.equal(list.length, 1);
  const tuesday = at(2026, 11, 24);
  assert.equal(instancesForDay(tuesday, [win('09:00', '10:00', [1])]).length, 0);
});

test('禁用的窗口不产生实例', () => {
  assert.equal(instancesForDay(at(2026, 11, 23), [win('09:00', '10:00', [0, 1, 2, 3, 4, 5, 6], false)]).length, 0);
});

test('跨午夜：23:30 处于 22:30–07:00 中，结束时间是次日 07:00', () => {
  const now = at(2026, 11, 21, 23, 30);
  const s = activeSession(now, [win('22:30', '07:00')]);
  assert.ok(s, '应当处于限制中');
  assert.equal(s.startAt, at(2026, 11, 21, 22, 30));
  assert.equal(s.endAt, at(2026, 11, 22, 7, 0));
});

test('跨午夜：次日 06:00 仍在限制中', () => {
  const now = at(2026, 11, 22, 6, 0);
  const s = activeSession(now, [win('22:30', '07:00')]);
  assert.ok(s);
  assert.equal(s.startAt, at(2026, 11, 21, 22, 30));
});

test('跨午夜：次日 08:00 不在限制中，下一段是当天 22:30', () => {
  const now = at(2026, 11, 22, 8, 0);
  assert.equal(activeSession(now, [win('22:30', '07:00')]), null);
  const next = nextSession(now, [win('22:30', '07:00')]);
  assert.equal(next.startAt, at(2026, 11, 22, 22, 30));
  assert.equal(next.endAt, at(2026, 11, 23, 7, 0));
});

test('重叠窗口合并为一个 session，不重复结算', () => {
  const now = at(2026, 11, 21, 23, 30);
  const s = activeSession(now, [win('22:00', '23:00', undefined, true, 'a'), win('23:00', '01:00', undefined, true, 'b')]);
  assert.ok(s);
  assert.equal(s.startAt, at(2026, 11, 21, 22, 0));
  assert.equal(s.endAt, at(2026, 11, 22, 1, 0));
  assert.deepEqual(s.windowIds.sort(), ['a', 'b']);
  assert.equal(s.merged, true);
});

test('mergeIntervals 处理乱序与包含关系', () => {
  const merged = mergeIntervals([
    { windowId: 'b', startAt: 100, endAt: 300 },
    { windowId: 'a', startAt: 50, endAt: 150 },
    { windowId: 'c', startAt: 800, endAt: 900 },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual([merged[0].startAt, merged[0].endAt], [50, 300]);
  assert.deepEqual([merged[1].startAt, merged[1].endAt], [800, 900]);
});

test('一天两段不重叠：各自成为独立 session', () => {
  const windows = [win('08:00', '09:00', undefined, true, 'morning'), win('20:00', '21:00', undefined, true, 'evening')];
  const day = at(2026, 11, 21);
  const list = sessionsInRange(day, day + 24 * 3600 * 1000, windows);
  assert.equal(list.length, 2);
  assert.equal(activeSession(at(2026, 11, 21, 8, 30), windows).windowId, 'morning');
  assert.equal(activeSession(at(2026, 11, 21, 20, 30), windows).windowId, 'evening');
  assert.equal(activeSession(at(2026, 11, 21, 12, 0), windows), null);
});

test('sessionsOnDay 返回与今天有交集的段（凌晨尾巴 + 晚上开始）', () => {
  const now = at(2026, 11, 22, 6, 0);
  const list = sessionsOnDay(now, [win('22:30', '07:00')]);
  assert.equal(list.length, 2);
  assert.equal(list[0].startAt, at(2026, 11, 21, 22, 30));
  assert.equal(list[0].endAt, at(2026, 11, 22, 7, 0));
  assert.equal(list[1].startAt, at(2026, 11, 22, 22, 30));
});

test('空窗口列表不崩溃', () => {
  assert.equal(activeSession(at(2026, 11, 22, 6, 0), []), null);
  assert.equal(nextSession(at(2026, 11, 22, 6, 0), []), null);
  assert.deepEqual(sessionsInRange(0, 1000, []), []);
});

test('startOfLocalDay 落在本地 00:00', () => {
  const d = new Date(startOfLocalDay(at(2026, 11, 22, 15, 42)));
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test('跨周：周日 22:00 的限制延续到周一 07:00', () => {
  const sunday = at(2026, 11, 22, 22, 30);
  const s = activeSession(sunday, [win('22:00', '07:00', [0])]);
  assert.ok(s, '周日晚应处于限制中');
  assert.equal(s.endAt, at(2026, 11, 23, 7, 0));
  // 周一晚上没有设置，不该有
  assert.equal(activeSession(at(2026, 11, 23, 22, 30), [win('22:00', '07:00', [0])]), null);
});
