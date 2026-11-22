import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSettings,
  validateSettings,
  enabledWindows,
  ensureNightWindow,
  SCHEMA_VERSION,
} from '../src/core/settings.js';
import {
  createMemoryBackend,
  createStorage,
  migrateSettings,
  loadSettings,
  saveSettings,
  loadRuntime,
  saveRuntime,
  clearRuntime,
  appendHistory,
  loadHistory,
  patchMeta,
  loadMeta,
  KEYS,
} from '../src/core/persistence.js';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test('重要联系人名单：规范化、去重、非法应用回落、上限', () => {
  const { settings } = validateSettings({
    features: {
      interrupt: {
        enabled: true,
        contacts: [
          { app: 'wechat', name: '  张老师  ' },
          { app: 'wechat', name: '张老师' },
          { app: 'unknown', name: '老板' },
          { app: 'qq', name: '' },
          null,
          { app: 'dingtalk', name: '李工' },
        ],
      },
    },
  });
  const list = settings.features.interrupt.contacts;
  assert.equal(list.length, 3);
  assert.equal(list[0].name, '张老师', '首尾空格要去掉');
  assert.equal(list[1].app, 'wechat', '未知应用回落到微信');
  assert.equal(list[2].app, 'dingtalk');
  assert.ok(list.every((c) => c.id && c.enabled === true));
});

test('ensureNightWindow：缺失时补齐、禁用时启用、已存在时不重复', () => {
  const empty = { windows: [], enabled: false };
  assert.equal(ensureNightWindow(empty), 'created');
  assert.equal(empty.windows.length, 1);
  assert.deepEqual([empty.windows[0].start, empty.windows[0].end, empty.windows[0].enabled], ['22:30', '07:00', true]);
  assert.deepEqual(empty.windows[0].days, [0, 1, 2, 3, 4, 5, 6]);

  const again = { windows: [{ id: 'w_night_default', label: '夜间休息', start: '22:30', end: '07:00', days: [0, 1], enabled: false }] };
  assert.equal(ensureNightWindow(again), 'enabled');
  assert.equal(again.windows[0].enabled, true);
  assert.equal(again.windows.length, 1, '不能重复添加');
  assert.equal(ensureNightWindow(again), 'exists');

  const custom = { windows: [{ id: 'x', label: '', start: '22:30', end: '07:00', days: [1], enabled: true }] };
  ensureNightWindow(custom);
  assert.equal(custom.windows[0].label, '夜间休息', '空名字要补上');
});

test('默认设置自身合法', () => {
  const { settings, issues } = validateSettings(defaultSettings());
  assert.deepEqual(issues, []);
  assert.equal(settings.schemaVersion, SCHEMA_VERSION);
  assert.equal(settings.windows.length, 1);
  assert.equal(settings.features.matrix.gridSize, 4);
});

test('坏输入不崩溃且被修正', () => {
  const { settings, issues } = validateSettings({
    enabled: 'yes',
    windows: [
      { start: '25:00', end: '07:00' },
      { start: '22:00', end: '07:00', days: [9, 1, 1] },
    ],
    prewarnMinutes: 999,
    features: {
      matrix: { gridSize: 4, maxNumber: 5, timeLimitSec: -3 },
      tasks: { restMinutes: 0, restThresholdPercent: 500 },
    },
    fox: { graceLeaveMs: 999999 },
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.windows.length, 1, '非法时间段的窗口被丢弃');
  assert.deepEqual(settings.windows[0].days, [1]);
  assert.equal(settings.prewarnMinutes, 60);
  assert.equal(settings.features.matrix.maxNumber, 16, '最大数字被抬到格子数');
  assert.equal(settings.features.matrix.timeLimitSec, 0);
  assert.equal(settings.features.tasks.restMinutes, 1);
  assert.equal(settings.features.tasks.restThresholdPercent, 100);
  assert.equal(settings.fox.graceLeaveMs, 60000);
  assert.ok(issues.length > 0);
});

test('gridSize 非法时吸附到 4 或最近的合法值', () => {
  assert.equal(validateSettings({ features: { matrix: { gridSize: 3.6 } } }).settings.features.matrix.gridSize, 4);
  assert.equal(validateSettings({ features: { matrix: { gridSize: 6 } } }).settings.features.matrix.gridSize, 6);
});

test('总开关关闭时没有生效窗口', () => {
  const s = validateSettings({ enabled: false, windows: [{ start: '22:00', end: '07:00' }] }).settings;
  assert.deepEqual(enabledWindows(s), []);
  const on = validateSettings({ enabled: true, windows: [{ start: '22:00', end: '07:00' }] }).settings;
  assert.equal(enabledWindows(on).length, 1);
});

test('迁移 v0 → v1 把 from/to 转成 start/end', () => {
  const { settings, issues } = migrateSettings({
    enabled: true,
    windows: [{ from: '21:00', to: '06:30', days: [1, 2] }],
  });
  assert.equal(settings.windows[0].start, '21:00');
  assert.equal(settings.windows[0].end, '06:30');
  assert.deepEqual(settings.windows[0].days, [1, 2]);
  assert.ok(issues.some((i) => i.includes('升级')));
});

test('存储：坏 JSON 被备份并回默认', () => {
  const backend = createMemoryBackend({ [KEYS.settings]: '{not json' });
  const storage = createStorage(backend);
  const result = loadSettings(storage);
  assert.equal(result.recovered, true);
  assert.ok(result.issues[0].includes('损坏'));
  assert.equal(backend.getItem(KEYS.settingsBackup), '{not json');
  assert.equal(result.settings.features.matrix.gridSize, 4);
});

test('存储：首次运行给默认设置', () => {
  const storage = createStorage(createMemoryBackend());
  const result = loadSettings(storage);
  assert.equal(result.firstRun, true);
  assert.equal(result.settings.windows.length, 1);
});

test('存储：设置往返一致', () => {
  const storage = createStorage(createMemoryBackend());
  const settings = defaultSettings();
  settings.windows[0].start = '23:15';
  settings.features.grayscale.enabled = false;
  saveSettings(storage, settings);
  const back = loadSettings(storage).settings;
  assert.equal(back.windows[0].start, '23:15');
  assert.equal(back.features.grayscale.enabled, false);
});

test('runtime 快照读写与清除', () => {
  const storage = createStorage(createMemoryBackend());
  assert.equal(loadRuntime(storage), null);
  saveRuntime(storage, { phase: 'locked', startedAt: at(2026, 11, 21, 22, 30) });
  assert.equal(loadRuntime(storage).phase, 'locked');
  clearRuntime(storage);
  assert.equal(loadRuntime(storage), null);
});

test('history 只保留近 90 天', () => {
  const backend = createMemoryBackend({
    [KEYS.history]: JSON.stringify([
      { endedAt: at(2026, 1, 1) },
      { endedAt: Date.now() - 1000 },
    ]),
  });
  const storage = createStorage(backend);
  const list = loadHistory(storage);
  assert.equal(list.length, 1);
});

test('appendHistory 追加并裁剪到 240 条', () => {
  const storage = createStorage(createMemoryBackend());
  for (let i = 0; i < 260; i += 1) {
    appendHistory(storage, { endedAt: Date.now() - 1000, outcome: 'success', idx: i });
  }
  assert.equal(loadHistory(storage).length, 240);
});

test('存储写满时降级而不是抛出', () => {
  const backend = {
    getItem: () => null,
    setItem: () => {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem: () => {},
  };
  const storage = createStorage(backend);
  const result = saveSettings(storage, defaultSettings());
  assert.equal(result.ok, false);
  assert.equal(result.error, '存储空间已满');
  assert.equal(storage.available(), false);
});

test('meta 打补丁', () => {
  const storage = createStorage(createMemoryBackend());
  patchMeta(storage, { installAt: 123 });
  patchMeta(storage, { lastHeartbeatAt: 456 });
  assert.deepEqual(loadMeta(storage), { installAt: 123, lastHeartbeatAt: 456 });
});
