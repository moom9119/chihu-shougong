/**
 * ui/views/task-list.js —— 任务清单（预警页与锁定页共用）
 */
import { esc } from '../dom.js';

export function taskItemHtml(task, { editable = true } = {}) {
  return `<div class="task-item ${task.done ? 'done' : ''}">
    <button type="button" class="task-toggle" data-act="task-toggle" data-id="${esc(task.id)}"
      aria-pressed="${task.done ? 'true' : 'false'}" aria-label="${task.done ? '取消完成' : '标记完成'}：${esc(task.text)}">
      <span class="box" aria-hidden="true">✓</span>
      <span class="txt">${esc(task.text)}</span>
    </button>
    ${editable ? `<button type="button" class="del" data-act="task-del" data-id="${esc(task.id)}" aria-label="删除任务">×</button>` : ''}
  </div>`;
}

export function taskListHtml(tasks, { editable = true, emptyText = '还没有任务，先加一条吧', listClass = 'task-editor' } = {}) {
  if (!tasks.length) return `<div class="${listClass}"><p class="empty">${esc(emptyText)}</p></div>`;
  return `<div class="${listClass}">${tasks.map((t) => taskItemHtml(t, { editable })).join('')}</div>`;
}

export function taskInputHtml({ placeholder = '例如：写完今天的复盘' } = {}) {
  return `<div class="task-input-row">
    <input class="input" id="task-input" type="text" maxlength="80" placeholder="${esc(placeholder)}"
      autocomplete="off" data-focus="task-input" data-act="task-input-key" />
    <button class="btn primary small" type="button" data-act="task-add">添加</button>
  </div>`;
}
