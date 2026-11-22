/**
 * schedule.js —— 纯时间表计算：把"每日重复 + 星期 + 跨午夜"的设置解析成真实时间区间。
 *
 * 关键约定（文档里也要写清楚）：
 *  - `days` 表示"这一段限制【开始】那一天"的星期，0=周日。
 *  - start > end 视为跨午夜（如 22:30 → 07:00）；
 *  - start === end 视为 24 小时；
 *  - 多段重叠/首尾相接会被合并成一个 session，避免重复结算。
 */
import { DAY, MINUTE } from './clock.js';

export function parseHHMM(str) {
  if (typeof str !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function formatHHMM(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function windowDurationMin(w) {
  const s = parseHHMM(w.start);
  const e = parseHHMM(w.end);
  if (s == null || e == null) return 0;
  const d = ((e - s) % 1440 + 1440) % 1440;
  return d === 0 ? 1440 : d;
}

export function isOvernight(w) {
  const s = parseHHMM(w.start);
  const e = parseHHMM(w.end);
  return s != null && e != null && e <= s;
}

/** 本地当天 00:00 的 ms */
export function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfLocalHour(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

export function nextLocalDay(ms) {
  const d = new Date(ms);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function weekdayOf(ms) {
  return new Date(ms).getDay();
}

/** 某一天（本地 00:00 起）落在哪些窗口里 */
export function instancesForDay(dayStartMs, windows = []) {
  const wd = weekdayOf(dayStartMs);
  const out = [];
  for (const w of windows) {
    if (!w || w.enabled === false) continue;
    if (Array.isArray(w.days) && !w.days.includes(wd)) continue;
    const s = parseHHMM(w.start);
    const e = parseHHMM(w.end);
    if (s == null || e == null) continue;
    const startAt = dayStartMs + s * MINUTE;
    const durMin = windowDurationMin(w);
    out.push({
      windowId: w.id,
      window: w,
      dayStart: dayStartMs,
      startAt,
      endAt: startAt + durMin * MINUTE,
      overnight: isOvernight(w),
    });
  }
  return out;
}

/** 合并重叠/相接区间（跨天也合并） */
export function mergeIntervals(list = []) {
  const sorted = [...list].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
  const out = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    if (last && item.startAt <= last.endAt) {
      if (item.endAt > last.endAt) last.endAt = item.endAt;
      if (!last.windowIds.includes(item.windowId)) last.windowIds.push(item.windowId);
      last.merged = true;
    } else {
      out.push({
        windowId: item.windowId,
        window: item.window,
        windowIds: [item.windowId],
        startAt: item.startAt,
        endAt: item.endAt,
        merged: false,
      });
    }
  }
  return out;
}

export function sessionsInRange(fromMs, toMs, windows = []) {
  if (!windows.length || !(toMs > fromMs)) return [];
  const firstDay = startOfLocalDay(fromMs - DAY);
  const lastDay = startOfLocalDay(toMs);
  const all = [];
  for (let d = firstDay; d <= lastDay; d = nextLocalDay(d)) {
    all.push(...instancesForDay(d, windows));
  }
  return mergeIntervals(all).filter((s) => s.startAt < toMs && s.endAt > fromMs);
}

/** 此刻正在进行的限制 session（已合并） */
export function activeSession(nowMs, windows = []) {
  return sessionsInRange(nowMs, nowMs + 1, windows).find((s) => s.startAt <= nowMs && nowMs < s.endAt) ?? null;
}

/** 下一段尚未开始的 session */
export function nextSession(nowMs, windows = [], horizonDays = 9) {
  const list = sessionsInRange(nowMs, nowMs + horizonDays * DAY, windows);
  return list.find((s) => s.startAt > nowMs) ?? null;
}

/** 接下来的若干段（含正在进行的） */
export function upcomingSessions(nowMs, windows = [], count = 6, horizonDays = 9) {
  const list = sessionsInRange(nowMs, nowMs + horizonDays * DAY, windows);
  return list.filter((s) => s.endAt > nowMs).slice(0, count);
}

/** 某一天（本地日历日）覆盖到的 session，用于今日时间轴 */
export function sessionsOnDay(nowMs, windows = []) {
  const dayStart = startOfLocalDay(nowMs);
  const dayEnd = nextLocalDay(dayStart);
  return sessionsInRange(dayStart, dayEnd, windows).filter((s) => s.endAt > dayStart && s.startAt < dayEnd);
}

export function windowSummary(w) {
  if (!w) return '';
  const days = Array.isArray(w.days) ? w.days : [];
  const dayText = days.length === 7 ? '每天' : days.length === 0 ? '未选' : days.map((d) => '周' + '日一二三四五六'[d]).join('');
  const overnight = isOvernight(w) ? '（次日）' : '';
  return `${dayText} ${w.start} – ${w.end}${overnight}`;
}
