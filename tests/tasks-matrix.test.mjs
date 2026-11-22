import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, normalizeTasks, addTask, removeTask, toggleTask, taskProgress, qualifiesForRest, nextTask } from '../src/core/tasks.js';

test('createTask 去空白、截断、拒绝空串', () => {
  const t = createTask('  写 复盘  ', 100);
  assert.equal(t.text, '写 复盘');
  assert.equal(t.done, false);
  assert.equal(createTask('   '), null);
  assert.equal(createTask('x'.repeat(200)).text.length, 80);
});

test('addTask 去重未完成的同名任务', () => {
  let tasks = [];
  const a = addTask(tasks, '读书');
  tasks = a.tasks;
  const b = addTask(tasks, '读书');
  assert.equal(b.added, null);
  assert.equal(b.duplicate, true);
  assert.equal(b.tasks.length, 1);
});

test('toggleTask 勾选与取消', () => {
  let tasks = [{ id: 't1', text: 'A', done: false, doneAt: null }];
  tasks = toggleTask(tasks, 't1', 500);
  assert.equal(tasks[0].done, true);
  assert.equal(tasks[0].doneAt, 500);
  tasks = toggleTask(tasks, 't1', 600);
  assert.equal(tasks[0].done, false);
  assert.equal(tasks[0].doneAt, null);
});

test('removeTask 只删一条', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(removeTask(tasks, 'a').map((t) => t.id), ['b']);
});

test('taskProgress 计算百分比', () => {
  const tasks = [{ id: '1', done: true }, { id: '2', done: false }, { id: '3', done: true }, { id: '4', done: false }];
  assert.deepEqual(taskProgress(tasks), { done: 2, total: 4, percent: 50, remaining: 2 });
  assert.deepEqual(taskProgress([]), { done: 0, total: 0, percent: 0, remaining: 0 });
});

test('qualifiesForRest：空任务不发放', () => {
  assert.equal(qualifiesForRest([], 50), false);
});

test('qualifiesForRest：100% 必须全勾', () => {
  const half = [{ id: '1', done: true }, { id: '2', done: false }];
  assert.equal(qualifiesForRest(half, 100), false);
  const all = [{ id: '1', done: true }, { id: '2', done: true }];
  assert.equal(qualifiesForRest(all, 100), true);
});

test('qualifiesForRest：阈值按百分比比较', () => {
  const tasks = [{ id: '1', done: true }, { id: '2', done: false }, { id: '3', done: false }];
  assert.equal(qualifiesForRest(tasks, 50), false, '33% 不够 50%');
  assert.equal(qualifiesForRest(tasks, 30), true);
  const two = [{ id: '1', done: true }, { id: '2', done: true }, { id: '3', done: false }];
  assert.equal(qualifiesForRest(two, 60), true, '67% ≥ 60%');
});

test('一项都没勾时不算达标', () => {
  const tasks = [{ id: '1', done: false }, { id: '2', done: false }];
  assert.equal(qualifiesForRest(tasks, 10), false);
});

test('normalizeTasks 过滤脏数据并限长', () => {
  const list = normalizeTasks([{ text: 'A' }, { text: '  ' }, null, { id: 'x', text: 'B', done: 1 }]);
  assert.equal(list.length, 2);
  assert.equal(list[0].text, 'A');
  assert.equal(list[1].done, true);
  assert.equal(normalizeTasks('nope').length, 0);
});

test('nextTask 返回第一个未完成项', () => {
  assert.equal(nextTask([{ id: '1', done: true, text: 'a' }, { id: '2', done: false, text: 'b' }]).id, '2');
  assert.equal(nextTask([]), null);
});
