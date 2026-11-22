/**
 * ui/views/stats.js —— 坚持记录
 */
import { esc, humanMs } from '../dom.js';
import { summarizeHistory, recentRecords, OUTCOME_LABELS } from '../../core/stats.js';
import { toDateKey } from '../../core/collection.js';
import { startOfLocalDay } from '../../core/schedule.js';
import { windowEditorHtml } from './window-editor.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 近三天的起点（含今天在内一共 3 个自然日） */
function threeDaysAgo(now) {
  return startOfLocalDay(now - 2 * DAY_MS);
}

function dayLabel(dateKey, now) {
  const today = toDateKey(now);
  if (dateKey === today) return '今天';
  if (dateKey === toDateKey(now - DAY_MS)) return '昨天';
  if (dateKey === toDateKey(now - 2 * DAY_MS)) return '前天';
  return dateKey.slice(5).replace('-', '/');
}

function recordRow(r) {
  const tag = r.outcome === 'success' ? 'ok' : r.outcome === 'left' ? 'bad' : 'mid';
  const t = new Date(r.endedAt);
  const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return `<div class="record">
    <span class="r-time">${time}</span>
    <span class="r-main">${esc(r.label || '限制时段')} · 任务 ${r.tasksDone || 0}/${r.tasksTotal || 0}</span>
    <span class="r-tag ${tag}">${esc(OUTCOME_LABELS[r.outcome] || r.outcome)}</span>
  </div>`;
}

function groupByDay(records, now) {
  const map = new Map();
  for (const r of records) {
    const key = toDateKey(r.endedAt);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.entries()].map(([key, list]) => ({
    key,
    label: dayLabel(key, now),
    html: list.map(recordRow).join(''),
  }));
}

function barsHtml(buckets) {
  const max = Math.max(1, ...buckets.map((b) => b.success + b.left + b.aborted));
  return `<div class="bars">${buckets
    .map((b) => {
      const total = b.success + b.left + b.aborted;
      const h = (n) => (n / max) * 100;
      return `<div class="bar-col" title="${b.dateKey}：成功 ${b.success} / 离开 ${b.left} / 提前 ${b.aborted}">
        <div class="bar-stack" style="min-height:${total ? 6 : 2}px">
          ${b.aborted ? `<div class="bar-seg" style="height:${h(b.aborted)}%;background:var(--warn)"></div>` : ''}
          ${b.left ? `<div class="bar-seg bad" style="height:${h(b.left)}%"></div>` : ''}
          ${b.success ? `<div class="bar-seg ok" style="height:${h(b.success)}%"></div>` : ''}
        </div>
        <span class="bar-day">${esc(b.label)}</span>
      </div>`;
    })
    .join('')}</div>`;
}

export function statsView(ctx) {
  const summary = summarizeHistory(ctx.history, ctx.now, 7);
  const all = recentRecords(ctx.history, 200);
  const cutoff = threeDaysAgo(ctx.now);
  const recent = all.filter((r) => r.endedAt >= cutoff);
  const older = all.filter((r) => r.endedAt < cutoff);
  const olderOpen = Boolean(ctx.ui?.recordsOlderOpen);
  const recentGroups = groupByDay(recent, ctx.now);
  const olderGroups = olderOpen ? groupByDay(older, ctx.now) : [];

  return `<div class="page-inner">
    <section class="card">
      <div class="card-head">
        <h3>最近 7 天</h3>
        <span class="sub">成功 / 离开 / 提前</span>
      </div>
      ${barsHtml(summary.buckets)}
      <div class="chip-row" style="margin-top:12px">
        <span class="pill-soft ok">成功</span>
        <span class="pill-soft bad">中途离开</span>
        <span class="pill-soft" style="color:var(--warn)">提前结束</span>
      </div>
    </section>

    <section class="card">
      <div class="stat-grid">
        <div class="stat"><div class="k">总完成</div><div class="v">${summary.total}<small> 次</small></div></div>
        <div class="stat"><div class="k">成功率</div><div class="v">${summary.successRate == null ? '—' : `${summary.successRate}<small>%</small>`}</div></div>
        <div class="stat"><div class="k">平均时长</div><div class="v">${summary.total ? esc(humanMs(summary.averageDurationMs)) : '—'}</div></div>
        <div class="stat"><div class="k">任务完成</div><div class="v">${summary.avgTaskCompletion == null ? '—' : `${summary.avgTaskCompletion}<small>%</small>`}</div></div>
        <div class="stat"><div class="k">累计休息</div><div class="v">${esc(humanMs(summary.restMs))}</div></div>
        <div class="stat"><div class="k">羽毛</div><div class="v">${summary.feathers}</div></div>
      </div>
    </section>

    ${windowEditorHtml(ctx.settings, ctx.ui?.confirm?.key || '')}

    <section class="card">
      <div class="card-head">
        <h3>明细</h3>
        <span class="sub">近三天 ${recent.length} 条${older.length ? ` · 共 ${all.length} 条` : ''}</span>
      </div>
      ${
        recent.length
          ? recentGroups
              .map((g) => `<div class="record-day">${esc(g.label)}</div>${g.html}`)
              .join('')
          : `<div class="empty">最近三天还没有记录<br /><span class="tiny">完成一次限制后这里会有数据</span></div>`
      }
      ${
        older.length
          ? `<div class="divider"></div>
             <button class="btn ghost block" type="button" data-act="records-older" aria-expanded="${olderOpen}">
               ${olderOpen ? `收起更早的 ${older.length} 条` : `展开更早的 ${older.length} 条`}
             </button>
             ${
               olderOpen
                 ? `<div class="older-records">${olderGroups
                     .map((g) => `<div class="record-day">${esc(g.label)}</div>${g.html}`)
                     .join('')}</div>`
                 : ''
             }`
          : ''
      }
      ${
        all.length
          ? `<button class="btn ${ctx.ui?.confirm?.key === 'clear-history' ? 'danger' : 'ghost'} block" style="margin-top:12px" data-act="clear-history">${
              ctx.ui?.confirm?.key === 'clear-history' ? '再点一次：确认清空全部记录' : '清空记录'
            }</button>`
          : ''
      }
    </section>

    <p class="tiny" style="text-align:center">所有数据都只存在这台设备的浏览器里，不上传。</p>
  </div>`;
}
