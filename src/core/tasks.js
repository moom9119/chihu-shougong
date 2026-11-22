/**
 * tasks.js —— 任务清单：进度、增删改、达标判定。
 * 纯函数，不改原数组。
 */
import { newId } from './settings.js';

export function createTask(text, now = 0) {
  const clean = String(text ?? '').trim().slice(0, 80);
  if (!clean) return null;
  return { id: newId('t'), text: clean, done: false, doneAt: null, createdAt: now };
}

export function normalizeTasks(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t) => ({
      id: typeof t.id === 'string' && t.id ? t.id : newId('t'),
      text: t.text.trim().slice(0, 80),
      done: Boolean(t.done),
      doneAt: Number.isFinite(t.doneAt) ? t.doneAt : null,
      createdAt: Number.isFinite(t.createdAt) ? t.createdAt : 0,
    }))
    .slice(0, 30);
}

export function addTask(tasks, text, now = 0) {
  const task = createTask(text, now);
  if (!task) return { tasks, added: null };
  if (tasks.some((t) => t.text === task.text && !t.done)) return { tasks, added: null, duplicate: true };
  return { tasks: [...tasks, task], added: task };
}

export function removeTask(tasks, id) {
  return tasks.filter((t) => t.id !== id);
}

export function toggleTask(tasks, id, now = 0) {
  return tasks.map((t) => (t.id === id ? { ...t, done: !t.done, doneAt: !t.done ? now : null } : t));
}

export function taskProgress(tasks = []) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.done).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, percent, remaining: total - done };
}

/**
 * 是否达到"可以休息"的进度。
 * - 没有任务 → 不发放（避免白送）
 * - 阈值 100% → 必须全勾
 * - 阈值 75% → 用 ceil，防止 3 项里勾 2 项（66%）被误判
 */
export function qualifiesForRest(tasks = [], thresholdPercent = 100) {
  const { done, total, percent } = taskProgress(tasks);
  if (total === 0 || done === 0) return false;
  const threshold = Math.min(100, Math.max(1, Math.round(thresholdPercent)));
  if (threshold >= 100) return done === total;
  return percent >= threshold;
}

export function nextTask(tasks = []) {
  return tasks.find((t) => !t.done) ?? null;
}
