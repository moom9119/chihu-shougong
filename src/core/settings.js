/**
 * settings.js —— 用户设置的结构、默认值、校验与规范化。
 *
 * 设计原则：
 *  - 任何来自 localStorage / 表单 / URL 的设置都必须先过 validateSettings()，
 *    坏数据不能让应用崩溃，只能被"修正 + 提示"。
 *  - 默认值面向真实使用：夜里 22:30–07:00 一段、四个功能全开、阈值 100%。
 */

export const SCHEMA_VERSION = 1;

export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

export const MATRIX_LIMITS = { gridSize: [3, 6], maxNumber: [9, 144], timeLimitSec: [0, 300], maxErrors: [1, 10], cooldownMinutes: [0, 120] };
export const GRID_SIZES = [3, 4, 5, 6];

/** 支持"重要联系人"提醒的三个 IM */
export const INTERRUPT_APPS = [
  { id: 'wechat', name: '微信', color: '#3eb575' },
  { id: 'qq', name: 'QQ', color: '#3a9bf0' },
  { id: 'dingtalk', name: '钉钉', color: '#2f7ef0' },
];

export function appMeta(id) {
  return INTERRUPT_APPS.find((a) => a.id === id) || INTERRUPT_APPS[0];
}

let idSeq = 0;
export function newId(prefix = 'id') {
  idSeq += 1;
  return `${prefix}_${idSeq.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function defaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    windows: [
      {
        id: 'w_default_night',
        label: '夜间休息',
        start: '22:30',
        end: '07:00',
        days: [0, 1, 2, 3, 4, 5, 6],
        enabled: true,
      },
    ],
    prewarnMinutes: 10,
    features: {
      tasks: {
        enabled: true,
        restEnabled: true,
        restMinutes: 10,
        restThresholdPercent: 100,
        templates: ['完成今天的工作复盘', '阅读 20 分钟', '整理明天的待办', '拉伸放松 5 分钟'],
      },
      matrix: {
        enabled: true,
        gridSize: 4,
        maxNumber: 16,
        timeLimitSec: 30,
        maxErrors: 3,
        cooldownMinutes: 5,
      },
      grayscale: {
        enabled: true,
        intensityPercent: 100,
        dimPercent: 10,
      },
      interrupt: {
        enabled: true,
        autoPause: true,
        ringTimes: 3,
        ringIntervalMs: 700,
        cooldownSeconds: 20,
        contacts: [],
      },
    },
    fox: {
      graceLeaveMs: 3000,
    },
    emergency: {
      holdSeconds: 3,
    },
    ui: {
      theme: 'auto',
      reduceMotion: false,
      sound: true,
    },
  };
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const toInt = (v, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
};
const toBool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function isValidTime(str) {
  return typeof str === 'string' && TIME_RE.test(str.trim());
}

export function normalizeTime(str, fallback = '22:00') {
  if (!isValidTime(str)) return fallback;
  const [h, m] = str.trim().split(':');
  return `${String(Number(h)).padStart(2, '0')}:${m}`;
}

function normalizeWindow(raw, fallbackLabel = '限制时段') {
  if (!raw || typeof raw !== 'object') return null;
  const start = normalizeTime(raw.start, '');
  const end = normalizeTime(raw.end, '');
  if (!start || !end) return null;
  let days = Array.isArray(raw.days)
    ? [...new Set(raw.days.map((d) => toInt(d, -1)).filter((d) => d >= 0 && d <= 6))]
    : [];
  days.sort((a, b) => a - b);
  if (days.length === 0) days = [0, 1, 2, 3, 4, 5, 6];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('w'),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 24) : fallbackLabel,
    start,
    end,
    days,
    enabled: toBool(raw.enabled, true),
  };
}

/**
 * 校验并规范化任意输入。
 * @returns {{settings: object, issues: string[]}}
 */
export function validateSettings(raw) {
  const issues = [];
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') {
    return { settings: base, issues: ['设置数据缺失，已使用默认设置'] };
  }

  const out = { ...base };
  out.schemaVersion = SCHEMA_VERSION;
  out.enabled = toBool(raw.enabled, base.enabled);

  // ---- 时间窗口 ----
  if (Array.isArray(raw.windows)) {
    const list = [];
    for (const item of raw.windows) {
      const w = normalizeWindow(item);
      if (w) list.push(w);
      else issues.push('有一个时间段格式不合法，已忽略');
      if (list.length >= 12) {
        issues.push('时间段最多 12 段，多余的已忽略');
        break;
      }
    }
    out.windows = list;
    if (list.length === 0) {
      out.windows = [];
    }
  } else {
    out.windows = base.windows;
  }

  // ---- 预警提前量 ----
  const prewarn = toInt(raw.prewarnMinutes, base.prewarnMinutes);
  out.prewarnMinutes = clamp(prewarn, 0, 60);
  if (prewarn !== out.prewarnMinutes) issues.push('“提前提醒”已限制在 0–60 分钟');

  // ---- 任务 / 休息 ----
  const t = raw.features?.tasks ?? {};
  const dTask = base.features.tasks;
  out.features.tasks = {
    enabled: toBool(t.enabled, dTask.enabled),
    restEnabled: toBool(t.restEnabled, dTask.restEnabled),
    restMinutes: clamp(toInt(t.restMinutes, dTask.restMinutes), 1, 180),
    restThresholdPercent: clamp(toInt(t.restThresholdPercent, dTask.restThresholdPercent), 10, 100),
    templates: Array.isArray(t.templates)
      ? t.templates.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 40)).slice(0, 12)
      : [...dTask.templates],
  };

  // ---- 数字矩阵 ----
  const m = raw.features?.matrix ?? {};
  const dMat = base.features.matrix;
  let gridSize = clamp(toInt(m.gridSize, dMat.gridSize), MATRIX_LIMITS.gridSize[0], MATRIX_LIMITS.gridSize[1]);
  if (!GRID_SIZES.includes(gridSize)) {
    gridSize = GRID_SIZES.reduce((best, s) => (Math.abs(s - gridSize) < Math.abs(best - gridSize) ? s : best), 4);
  }
  const cellCount = gridSize * gridSize;
  let maxNumber = clamp(toInt(m.maxNumber, dMat.maxNumber), MATRIX_LIMITS.maxNumber[0], MATRIX_LIMITS.maxNumber[1]);
  if (maxNumber < cellCount) {
    maxNumber = Math.min(MATRIX_LIMITS.maxNumber[1], cellCount);
    issues.push(`矩阵最大数字不能小于格子数，已改为 ${maxNumber}`);
  }
  out.features.matrix = {
    enabled: toBool(m.enabled, dMat.enabled),
    gridSize,
    maxNumber,
    timeLimitSec: clamp(toInt(m.timeLimitSec, dMat.timeLimitSec), 0, MATRIX_LIMITS.timeLimitSec[1]),
    maxErrors: clamp(toInt(m.maxErrors, dMat.maxErrors), MATRIX_LIMITS.maxErrors[0], MATRIX_LIMITS.maxErrors[1]),
    cooldownMinutes: clamp(toInt(m.cooldownMinutes, dMat.cooldownMinutes), 0, MATRIX_LIMITS.cooldownMinutes[1]),
  };

  // ---- 灰度 ----
  const g = raw.features?.grayscale ?? {};
  const dGray = base.features.grayscale;
  out.features.grayscale = {
    enabled: toBool(g.enabled, dGray.enabled),
    intensityPercent: clamp(toInt(g.intensityPercent, dGray.intensityPercent), 0, 100),
    dimPercent: clamp(toInt(g.dimPercent, dGray.dimPercent), 0, 60),
  };

  // ---- 重要联系人提醒 ----
  const it = raw.features?.interrupt ?? {};
  const dInt = base.features.interrupt;
  const seen = new Set();
  const contacts = [];
  if (Array.isArray(it.contacts)) {
    for (const c of it.contacts) {
      if (!c || typeof c !== 'object') continue;
      const name = typeof c.name === 'string' ? c.name.trim().slice(0, 24) : '';
      if (!name) continue;
      const app = INTERRUPT_APPS.some((a) => a.id === c.app) ? c.app : 'wechat';
      const key = `${app}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      contacts.push({ id: typeof c.id === 'string' && c.id ? c.id : newId('c'), app, name, enabled: toBool(c.enabled, true) });
      if (contacts.length >= 50) {
        issues.push('重要联系人最多 50 个，多余的已忽略');
        break;
      }
    }
  }
  out.features.interrupt = {
    enabled: toBool(it.enabled, dInt.enabled),
    autoPause: toBool(it.autoPause, dInt.autoPause),
    ringTimes: clamp(toInt(it.ringTimes, dInt.ringTimes), 1, 10),
    ringIntervalMs: clamp(toInt(it.ringIntervalMs, dInt.ringIntervalMs), 200, 3000),
    cooldownSeconds: clamp(toInt(it.cooldownSeconds, dInt.cooldownSeconds), 5, 600),
    contacts,
  };

  // ---- 狐狸 ----
  const f = raw.fox ?? {};
  out.fox = { graceLeaveMs: clamp(toInt(f.graceLeaveMs, base.fox.graceLeaveMs), 0, 60000) };

  // ---- 紧急退出 ----
  const e = raw.emergency ?? {};
  out.emergency = { holdSeconds: clamp(toInt(e.holdSeconds, base.emergency.holdSeconds), 1, 10) };

  // ---- 界面 ----
  const u = raw.ui ?? {};
  out.ui = {
    theme: ['auto', 'dark', 'light'].includes(u.theme) ? u.theme : base.ui.theme,
    reduceMotion: toBool(u.reduceMotion, base.ui.reduceMotion),
    sound: toBool(u.sound, base.ui.sound),
  };

  return { settings: out, issues };
}

/** 只取启用中的窗口（供 schedule 使用） */
export function enabledWindows(settings) {
  if (!settings?.enabled) return [];
  return (settings.windows || []).filter((w) => w.enabled);
}

export function createWindowDraft(settings) {
  const last = settings?.windows?.[settings.windows.length - 1];
  return {
    id: newId('w'),
    label: '新时段',
    start: last?.start ?? '22:30',
    end: last?.end ?? '07:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    enabled: true,
  };
}

export const NIGHT_WINDOW = { start: '22:30', end: '07:00', label: '夜间休息' };

/**
 * 确保"夜间休息"这一段存在且启用（不会重复添加）。
 * 用于设置页的快捷按钮与 ?night=1 恢复入口。
 * @param {object} draft 可变的设置草稿
 * @returns {'created'|'enabled'|'exists'}
 */
export function ensureNightWindow(draft, { start = NIGHT_WINDOW.start, end = NIGHT_WINDOW.end, label = NIGHT_WINDOW.label } = {}) {
  if (!draft || !Array.isArray(draft.windows)) return 'exists';
  const found = draft.windows.find((w) => w.start === start && w.end === end);
  if (found) {
    const changed = found.enabled === false || !found.label;
    found.enabled = true;
    if (!found.label) found.label = label;
    return changed ? 'enabled' : 'exists';
  }
  draft.windows.push({ id: 'w_night_default', label, start, end, days: [0, 1, 2, 3, 4, 5, 6], enabled: true });
  return 'created';
}
