/**
 * ui/views/window-editor.js —— 限制时间段编辑器。
 * 挂在「记录」页里：总统计之下、明细之上，常驻展开（不做折叠）。
 */
import { isOvernight, windowDurationMin } from '../../core/schedule.js';
import { WEEKDAY_LABELS } from '../../core/settings.js';
import { esc, toggleSwitch, humanMs } from '../dom.js';

function windowCard(w, armed) {
  const overnight = isOvernight(w);
  return `<div class="win-card ${w.enabled ? '' : 'disabled'}">
    <div class="win-top">
      <input class="win-name" type="text" maxlength="24" value="${esc(w.label)}" data-act="win-label" data-id="${esc(w.id)}" aria-label="时段名称" />
      ${toggleSwitch({ pressed: w.enabled, act: 'win-toggle', path: w.id, label: '启用这个时段' })}
    </div>
    <div class="win-times">
      <input type="time" value="${esc(w.start)}" data-act="win-time" data-id="${esc(w.id)}" data-field="start" aria-label="开始时间" />
      <span>→</span>
      <input type="time" value="${esc(w.end)}" data-act="win-time" data-id="${esc(w.id)}" data-field="end" aria-label="结束时间" />
      <span class="tiny">${overnight ? '次日结束' : ''} · ${humanMs(windowDurationMin(w) * 60000)}</span>
    </div>
    <div class="win-days" role="group" aria-label="生效的星期">
      ${WEEKDAY_LABELS.map(
        (label, d) =>
          `<button type="button" class="day-btn" data-act="win-day" data-id="${esc(w.id)}" data-day="${d}"
            aria-pressed="${w.days.includes(d)}">${label}</button>`,
      ).join('')}
    </div>
    <div class="win-foot">
      <button class="btn ${armed ? 'danger' : 'ghost'} small" data-act="win-del" data-id="${esc(w.id)}">${
        armed ? '确认删除？' : '删除这段'
      }</button>
    </div>
  </div>`;
}

/**
 * @param {object} settings
 * @param {string} [confirmKey] 当前处于"等待二次确认"的操作键（win-del:<id>），用来把按钮点亮
 */
export function windowEditorHtml(settings, confirmKey = '') {
  return `<section class="card">
    <div class="card-head">
      <h3>限制时段</h3>
      <span class="sub">${settings.windows.length}/12</span>
      <span class="grow"></span>
      <button class="btn ghost small" type="button" data-act="win-add-night" title="补齐并启用每天 22:30–07:00">＋ 夜间休息</button>
      <button class="btn ghost small" type="button" data-act="win-add">+ 新增</button>
    </div>
    ${
      settings.windows.length
        ? `<div class="win-list">${settings.windows
            .map((w) => windowCard(w, confirmKey === `win-del:${w.id}`))
            .join('')}</div>`
        : `<div class="empty">还没有时段<br /><span class="tiny">加一段 22:30 → 07:00，每天自动生效</span></div>`
    }
    <div class="hint" style="margin-top:12px">
      开始时间晚于结束时间就是<b>跨午夜</b>（如 22:30 → 07:00）。星期按"开始的那一天"计算。<br />
      多段如果有重叠，会合并成一次限制，不会重复结算。
    </div>
  </section>`;
}
