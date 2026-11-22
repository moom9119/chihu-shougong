/**
 * persistence.js —— localStorage 读写、版本迁移、损坏恢复、配额降级。
 *
 * 存四类数据：
 *   settings   用户设置
 *   runtime    当前会话快照（刷新后恢复 + 判断"是否离开过"）
 *   collection 花朵收藏 / 羽毛 / 连续天数
 *   history    近 90 天记录
 *
 * 任何异常都不许抛出到 UI：坏数据 → 备份 + 回默认；存储不可用 → 内存模式。
 */
import { SCHEMA_VERSION, validateSettings, defaultSettings } from './settings.js';

export const KEYS = {
  settings: 'foxlock.settings',
  settingsBackup: 'foxlock.settings.corrupt',
  runtime: 'foxlock.runtime',
  collection: 'foxlock.collection',
  history: 'foxlock.history',
  meta: 'foxlock.meta',
};

export function createMemoryBackend(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    kind: 'memory',
    available: true,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    keys: () => [...map.keys()],
    clear: () => map.clear(),
  };
}

/** 浏览器里检测 localStorage 是否真的可写（隐私模式会抛异常） */
export function detectBackend() {
  try {
    if (typeof localStorage === 'undefined') return { backend: createMemoryBackend(), available: false };
    const probe = '__foxlock_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return { backend: localStorage, available: true };
  } catch {
    return { backend: createMemoryBackend(), available: false };
  }
}

export function createStorage(backend = detectBackend().backend) {
  let available = true;
  const storage = {
    available: () => available,
    get(key) {
      try {
        return backend.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        backend.setItem(key, value);
        return { ok: true };
      } catch (err) {
        available = false;
        return { ok: false, error: err?.name === 'QuotaExceededError' ? '存储空间已满' : '存储不可用' };
      }
    },
    remove(key) {
      try {
        backend.removeItem(key);
      } catch {
        /* ignore */
      }
    },
    readJSON(key, fallback = null) {
      const raw = storage.get(key);
      if (raw == null) return { value: fallback, corrupted: false, missing: true };
      try {
        return { value: JSON.parse(raw), corrupted: false, missing: false };
      } catch {
        return { value: fallback, corrupted: true, missing: false };
      }
    },
    writeJSON(key, value) {
      return storage.set(key, JSON.stringify(value));
    },
  };
  return storage;
}

// ---------------------------------------------------------------- 迁移

const MIGRATIONS = {
  /** v0：早期原型只存了 {enabled, windows:[{from,to,days}]} */
  0: (raw) => {
    const windows = Array.isArray(raw.windows)
      ? raw.windows.map((w, i) => ({
          id: w.id || `w_migrated_${i}`,
          label: w.label || '限制时段',
          start: w.start || w.from || '22:30',
          end: w.end || w.to || '07:00',
          days: Array.isArray(w.days) ? w.days : [0, 1, 2, 3, 4, 5, 6],
          enabled: w.enabled !== false,
        }))
      : undefined;
    return { ...raw, schemaVersion: 1, windows };
  },
};

export function migrateSettings(raw) {
  if (!raw || typeof raw !== 'object') return { settings: defaultSettings(), issues: ['设置数据缺失，已使用默认设置'] };
  let current = raw;
  let version = Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : 0;
  const issues = [];
  let guard = 0;
  while (version < SCHEMA_VERSION && guard < 10) {
    const step = MIGRATIONS[version];
    if (!step) break;
    current = step(current);
    version = Number.isFinite(current.schemaVersion) ? current.schemaVersion : version + 1;
    issues.push(`设置已从 v${version - 1} 升级到 v${version}`);
    guard += 1;
  }
  const result = validateSettings(current);
  return { settings: result.settings, issues: [...issues, ...result.issues] };
}

export function loadSettings(storage) {
  const { value, corrupted, missing } = storage.readJSON(KEYS.settings, null);
  if (missing) {
    return { settings: defaultSettings(), issues: [], firstRun: true };
  }
  if (corrupted) {
    storage.set(KEYS.settingsBackup, storage.get(KEYS.settings) ?? '');
    return { settings: defaultSettings(), issues: ['设置文件损坏，已备份并恢复默认设置'], recovered: true };
  }
  const { settings, issues } = migrateSettings(value);
  return { settings, issues, migrated: value?.schemaVersion !== SCHEMA_VERSION };
}

export function saveSettings(storage, settings) {
  return storage.writeJSON(KEYS.settings, settings);
}

// ---------------------------------------------------------------- runtime

export function saveRuntime(storage, snapshot) {
  if (!snapshot) return storage.remove(KEYS.runtime);
  return storage.writeJSON(KEYS.runtime, snapshot);
}

export function loadRuntime(storage) {
  const { value, corrupted } = storage.readJSON(KEYS.runtime, null);
  if (corrupted) return null;
  if (!value || typeof value !== 'object') return null;
  return value;
}

export function clearRuntime(storage) {
  storage.remove(KEYS.runtime);
}

// ---------------------------------------------------------------- collection

export function loadCollection(storage) {
  const { value, corrupted } = storage.readJSON(KEYS.collection, null);
  if (corrupted) return null;
  return value;
}

export function saveCollection(storage, collection) {
  return storage.writeJSON(KEYS.collection, collection);
}

// ---------------------------------------------------------------- history

export function loadHistory(storage) {
  const { value } = storage.readJSON(KEYS.history, []);
  if (!Array.isArray(value)) return [];
  const cutoff = Date.now() - 90 * 86400000;
  return value.filter((r) => r && Number.isFinite(r.endedAt) && r.endedAt > cutoff).slice(-240);
}

export function appendHistory(storage, record) {
  const list = loadHistory(storage);
  list.push(record);
  const trimmed = list.slice(-240);
  storage.writeJSON(KEYS.history, trimmed);
  return trimmed;
}

// ---------------------------------------------------------------- meta

export function loadMeta(storage) {
  const { value } = storage.readJSON(KEYS.meta, null);
  return value && typeof value === 'object' ? value : {};
}

export function patchMeta(storage, patch) {
  const next = { ...loadMeta(storage), ...patch };
  storage.writeJSON(KEYS.meta, next);
  return next;
}
