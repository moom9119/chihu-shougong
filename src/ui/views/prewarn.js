/**
 * ui/views/prewarn.js —— 限制开始前的任务清单（可跳过）
 */
import { esc, fmtCountdown, sessionRange } from '../dom.js';
import { taskListHtml, taskInputHtml } from './task-list.js';

export function prewarnView(ctx) {
  const { state, settings, ui } = ctx;
  const s = state.session;
  if (!s) return '';
  const left = Math.max(0, s.startAt - ctx.now);
  const tasks = s.tasks || [];
  const templates = settings.features.tasks.templates || [];
  const collapsed = Boolean(ui.prewarnCollapsed);

  if (collapsed) {
    return `<div class="layer prewarn" style="justify-content:flex-end;padding-bottom:calc(24px + env(safe-area-inset-bottom))">
      <div class="prewarn-inner">
        <div class="card" style="text-align:center">
          <p class="tiny">「${esc(s.label)}」即将开始</p>
          <div class="session-countdown" data-live="prewarn-countdown" style="font-size:38px"></div>
          <p class="row-desc" style="margin-top:6px">${tasks.length ? `已准备 ${tasks.length} 项任务` : '没有任务，本次不会有休息奖励'}</p>
          <button class="btn ghost block" style="margin-top:12px" data-act="prewarn-expand">继续编辑任务</button>
        </div>
      </div>
    </div>`;
  }

  return `<div class="layer prewarn">
    <div class="prewarn-inner">
      <div class="prewarn-head">
        <span class="count-badge"><span data-live="prewarn-countdown"></span> 后开始</span>
        <h2>先写下要完成的事</h2>
        <p>「${esc(s.label)}」${sessionRange(s.startAt, s.endAt)}<br />做完 ${settings.features.tasks.restThresholdPercent}% 可以让小狐狸陪你去休息。</p>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>任务清单</h3>
          <span class="sub">${tasks.length} 项</span>
        </div>
        ${taskListHtml(tasks, { emptyText: '还没有任务，从下面的模板选一条，或者自己写' })}
        <div style="margin-top:12px">${taskInputHtml()}</div>
        ${
          templates.length
            ? `<div class="divider"></div>
               <p class="tiny" style="margin-bottom:8px">常用模板</p>
               <div class="chip-row">${templates
                 .map((t) => `<button class="chip soft" type="button" data-act="task-template" data-text="${esc(t)}">+ ${esc(t)}</button>`)
                 .join('')}</div>`
            : ''
        }
      </div>

      <button class="btn primary block" data-act="prewarn-done">写好了，等它开始</button>
      <button class="btn ghost block" data-act="prewarn-dismiss">今天跳过填写</button>
      <p class="tiny" style="text-align:center">跳过也能正常进入限制，只是没有任务进度和休息奖励。</p>
    </div>
  </div>`;
}
