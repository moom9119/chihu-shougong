/**
 * stats.js —— 把 history 记录聚合成统计页需要的数据。
 */
import { DAY } from './clock.js';
import { startOfLocalDay } from './schedule.js';
import { toDateKey } from './collection.js';

export const OUTCOME_LABELS = {
  success: '坚持到底',
  left: '中途离开',
  aborted: '提前结束',
};

export function summarizeHistory(history = [], nowMs = Date.now(), days = 7) {
  const records = history.filter((r) => r && !r.preview);
  const totals = { total: records.length, success: 0, left: 0, aborted: 0, restMs: 0, feathers: 0, tasksDone: 0, tasksTotal: 0 };
  for (const r of records) {
    if (r.outcome === 'success') totals.success += 1;
    else if (r.outcome === 'left') totals.left += 1;
    else totals.aborted += 1;
    totals.restMs += Math.max(0, Number(r.restUsedMs) || 0);
    totals.feathers += Math.max(0, Number(r.feathers) || 0);
    totals.tasksDone += Math.max(0, Number(r.tasksDone) || 0);
    totals.tasksTotal += Math.max(0, Number(r.tasksTotal) || 0);
  }
  const decided = totals.success + totals.left;
  const successRate = decided === 0 ? null : Math.round((totals.success / decided) * 100);

  return {
    ...totals,
    successRate,
    avgTaskCompletion: totals.tasksTotal === 0 ? null : Math.round((totals.tasksDone / totals.tasksTotal) * 100),
    averageDurationMs: records.length
      ? Math.round(records.reduce((s, r) => s + Math.max(0, (r.endedAt || 0) - (r.startedAt || 0)), 0) / records.length)
      : 0,
    buckets: dailyBuckets(records, nowMs, days),
  };
}

/** 最近 N 天每天的成功/失败条数（按本地日期） */
export function dailyBuckets(records = [], nowMs = Date.now(), days = 7) {
  const todayStart = startOfLocalDay(nowMs);
  const buckets = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dayStart = todayStart - i * DAY;
    buckets.push({
      dateKey: toDateKey(dayStart),
      label: `${new Date(dayStart).getMonth() + 1}/${new Date(dayStart).getDate()}`,
      dayStart,
      success: 0,
      left: 0,
      aborted: 0,
      restMs: 0,
    });
  }
  const byKey = new Map(buckets.map((b) => [b.dateKey, b]));
  for (const r of records) {
    const key = r.date || (r.endedAt ? toDateKey(r.endedAt) : null);
    const bucket = key ? byKey.get(key) : null;
    if (!bucket) continue;
    if (r.outcome === 'success') bucket.success += 1;
    else if (r.outcome === 'left') bucket.left += 1;
    else bucket.aborted += 1;
    bucket.restMs += Math.max(0, Number(r.restUsedMs) || 0);
  }
  return buckets;
}

export function recentRecords(history = [], limit = 12) {
  return history
    .filter((r) => r && !r.preview)
    .slice()
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
    .slice(0, limit);
}
