/**
 * engine.js —— 核心状态机（纯函数 reducer）。
 *
 *   reduce(state, event) -> { state, effects }
 *
 * 规则：
 *  - engine 里不碰 DOM、不读 Date.now()、不写 localStorage；
 *  - 时间一律从 event.now 进来；
 *  - 副作用（灰度、通知、音效、持久化、写收藏）全部变成 effects 描述，
 *    由 main.js 统一执行。这样同一套状态机可以搬到 Android 端复用。
 */
import { MINUTE, HOUR } from './clock.js';
import { enabledWindows } from './settings.js';
import { activeSession, nextSession } from './schedule.js';
import { normalizeTasks, taskProgress, qualifiesForRest, addTask } from './tasks.js';
import { createFox, tickFox, pauseFox, resumeFox, failFox, foxCanLeaveFail, foxOutcome } from './fox.js';

export const PHASE = { IDLE: 'idle', PREWARN: 'prewarn', LOCKED: 'locked', REST: 'rest', RESULT: 'result' };
export const SNAPSHOT_VERSION = 1;

export const PHASE_LABEL = {
  idle: '自由时间',
  prewarn: '即将开始',
  locked: '限制中',
  rest: '休息中',
  result: '结算',
};

export function createState({ settings, now = 0, preview = false, testMode = false }) {
  return {
    phase: PHASE.IDLE,
    now,
    settings,
    session: null,
    preparedTasks: [],
    result: null,
    suppressedStartAt: null,
    /** 用户长按"提前结束"跳过的那个会话（startAt），本轮限制内不再重新锁定 */
    skippedStartAt: null,
    /** 测试模式：只由 URL 参数 ?test=1 打开，完全不自动进入限制（不写盘） */
    testMode: Boolean(testMode),
    preview,
    snapshotVersion: SNAPSHOT_VERSION,
  };
}

// ------------------------------------------------------------------ 小工具

const done = (state) => ({ state, effects: [] });
const fx = (...items) => items.filter(Boolean);

function makeSession({ windowId, label, startAt, endAt, now, tasks, preview }) {
  return {
    id: `s_${startAt}_${windowId}`,
    windowId,
    label: label || '限制时段',
    startAt,
    endAt,
    phaseStartedAt: now,
    tasks: normalizeTasks(tasks),
    rest: { grantedAt: null, untilAt: null, enteredAt: null, usedMs: 0 },
    fox: createFox(now),
    matrix: { openAt: null, cooldownUntil: 0, solved: 0, triggers: 0 },
    /** 重要联系人消息把计时"冻结"在这里；恢复时把暂停时长补回结束时间 */
    pause: { active: false, since: null, totalMs: 0, reason: null, count: 0 },
    lastIncoming: null,
    leaves: [],
    preview: Boolean(preview),
  };
}

/** 本次会话因为"消息中断"被冻结的时长 */
export function pausedMs(session, now) {
  const p = session?.pause;
  if (!p) return 0;
  return (p.totalMs || 0) + (p.active ? Math.max(0, now - p.since) : 0);
}

/** 实际结束时间 = 计划结束 + 暂停时长（暂停期间会随 now 一起增长，等于冻结） */
export function effectiveEndAt(session, now) {
  return session.endAt + pausedMs(session, now);
}

/** 休息结束时间同样要顺延 */
export function effectiveRestUntil(session, now) {
  const base = session.rest?.untilAt ?? session.endAt;
  return base + pausedMs(session, now);
}

function updateSession(state, patch) {
  if (!state.session) return state;
  return { ...state, session: { ...state.session, ...patch } };
}

function summarize(session, now, outcome, reason) {
  const progress = taskProgress(session.tasks);
  // 实际结束时刻：正常跑完用"顺延后的计划结束"，提前退出才用 now
  const endedAt = Math.min(now, effectiveEndAt(session, now));
  const paused = pausedMs(session, endedAt);
  const restUsedMs = session.rest.usedMs + (session.rest.enteredAt ? Math.max(0, endedAt - session.rest.enteredAt) : 0);
  return {
    outcome,
    reason: reason || null,
    windowId: session.windowId,
    label: session.label,
    startedAt: session.startAt,
    endedAt,
    plannedEndAt: effectiveEndAt(session, now),
    durationMs: Math.max(0, endedAt - session.startAt - paused),
    pausedMs: paused,
    interrupts: session.pause?.count || 0,
    tasksDone: progress.done,
    tasksTotal: progress.total,
    restUsedMs,
    feathers: session.fox.feathers,
    flowers: session.fox.flowers,
    leaves: session.leaves,
    preview: session.preview,
  };
}

// ------------------------------------------------------------------ 进入各阶段

function enterPrewarn(state, upcoming, now) {
  const session = makeSession({
    windowId: upcoming.windowId,
    label: upcoming.window?.label,
    startAt: upcoming.startAt,
    endAt: upcoming.endAt,
    now,
    tasks: state.preparedTasks,
    preview: state.preview,
  });
  const effects = fx(
    { type: 'enter-prewarn', session },
    { type: 'notify', title: '马上要进入限制时段', body: `还有 ${Math.max(1, Math.round((upcoming.startAt - now) / MINUTE))} 分钟，先写下今天想完成的事。` },
    { type: 'persist' },
  );
  return { state: { ...state, phase: PHASE.PREWARN, session }, effects };
}

function enterLocked(state, input, now, extraEffects = []) {
  const session = makeSession({
    windowId: input.windowId,
    label: input.label ?? input.window?.label,
    startAt: input.startAt,
    endAt: input.endAt,
    now,
    tasks: input.tasks ?? state.preparedTasks,
    preview: input.preview ?? state.preview,
  });
  const gray = state.settings.features.grayscale;
  const effects = fx(
    { type: 'enter-locked', session },
    { type: 'grayscale', on: Boolean(gray.enabled) },
    { type: 'sound', name: 'start' },
    session.preview ? null : { type: 'notify', title: '限制开始', body: `「${session.label}」已开始，小狐狸开始收集了。` },
    { type: 'persist' },
    ...extraEffects,
  );
  return { state: { ...state, phase: PHASE.LOCKED, session, preparedTasks: session.tasks }, effects };
}

function enterRest(state, now) {
  const session = state.session;
  if (!session) return done(state);
  const cfg = state.settings.features.tasks;
  const untilAt = Math.min(now + cfg.restMinutes * MINUTE, effectiveEndAt(session, now));
  const next = {
    ...state,
    phase: PHASE.REST,
    session: {
      ...session,
      rest: { ...session.rest, grantedAt: now, untilAt, enteredAt: now },
      fox: pauseFox(session.fox, now),
    },
  };
  const effects = fx(
    { type: 'rest-start', untilAt },
    { type: 'grayscale', on: false },
    { type: 'notify', title: '任务达标，休息一下', body: `设备恢复可用 ${cfg.restMinutes} 分钟。` },
    { type: 'sound', name: 'rest' },
    { type: 'persist' },
  );
  return { state: next, effects };
}

function leaveRest(state, now, reason = 'finished') {
  const session = state.session;
  if (!session) return done(state);
  const used = session.rest.enteredAt ? Math.max(0, now - session.rest.enteredAt) : 0;
  const next = {
    ...state,
    phase: PHASE.LOCKED,
    session: {
      ...session,
      rest: { ...session.rest, untilAt: null, enteredAt: null, usedMs: session.rest.usedMs + used },
      fox: resumeFox(session.fox, now),
    },
  };
  const gray = state.settings.features.grayscale;
  const effects = fx(
    { type: 'rest-end', reason },
    { type: 'grayscale', on: Boolean(gray.enabled) },
    { type: 'persist' },
  );
  return { state: next, effects };
}

function endSession(state, now, outcome, reason) {
  const session = state.session;
  if (!session) {
    return { state: { ...state, phase: PHASE.IDLE, session: null }, effects: [{ type: 'persist' }] };
  }
  const record = summarize(session, now, outcome, reason);
  const nextState = {
    ...state,
    phase: PHASE.RESULT,
    result: { ...record, reward: null },
  };
  const effects = fx(
    { type: 'grayscale', on: false },
    { type: 'matrix-close', auto: true },
    { type: 'sound', name: outcome === 'success' ? 'success' : outcome === 'left' ? 'fail' : 'neutral' },
    session.preview ? null : { type: 'finalize', record },
    { type: 'persist' },
  );
  return { state: nextState, effects };
}

// ------------------------------------------------------------------ tick

function tick(state, now) {
  if (now < state.now) {
    // 时钟回拨：不重放，只记录新的"现在"
    return done({ ...state, now });
  }
  const base = { ...state, now };
  const windows = enabledWindows(base.settings);

  switch (base.phase) {
    case PHASE.IDLE: {
      // 测试模式：只做预览，不自动进入限制
      if (base.testMode) return done(base);
      const active = activeSession(now, windows);
      let cur = base;
      if (active) {
        // 这次会话已经被"长按提前结束"跳过了 → 本轮结束前不再锁
        if (cur.skippedStartAt === active.startAt) return done(cur);
        // 活跃的是另一段（上一段的跳过标记已过期）
        if (cur.skippedStartAt) cur = { ...cur, skippedStartAt: null };
        return enterLocked(cur, active, now);
      }
      // 没有任何活跃会话：说明跳过的那一段已经结束了，清掉标记
      if (cur.skippedStartAt && now > cur.skippedStartAt) cur = { ...cur, skippedStartAt: null };
      const upcoming = nextSession(now, windows);
      if (!upcoming) return done({ ...cur, suppressedStartAt: null, skippedStartAt: null });
      const prewarnMs = cur.settings.prewarnMinutes * MINUTE;
      if (
        prewarnMs > 0 &&
        now >= upcoming.startAt - prewarnMs &&
        now < upcoming.startAt &&
        cur.suppressedStartAt !== upcoming.startAt
      ) {
        return enterPrewarn(cur, upcoming, now);
      }
      return done(cur);
    }

    case PHASE.PREWARN: {
      const session = base.session;
      if (!session) return done({ ...base, phase: PHASE.IDLE });
      if (!base.settings.enabled) return { state: { ...base, phase: PHASE.IDLE, session: null }, effects: [{ type: 'persist' }] };
      if (now >= session.endAt) return { state: { ...base, phase: PHASE.IDLE, session: null }, effects: [{ type: 'persist' }] };
      if (now >= session.startAt) return enterLocked(base, session, now); // 带着预警阶段编辑过的任务进入锁定
      return done(base);
    }

    case PHASE.LOCKED: {
      const session = base.session;
      if (!session) return done({ ...base, phase: PHASE.IDLE });
      // 被重要联系人消息暂停：整个计时冻结，不判定结束、不收集、不弹矩阵
      if (session.pause?.active) return done(base);
      if (now >= effectiveEndAt(session, now)) {
        const outcome = foxOutcome(session.fox);
        return endSession(base, now, outcome, outcome === 'success' ? 'finished' : 'left');
      }
      // 狐狸时间驱动收集
      const foxNext = tickFox(session.fox, now);
      let next = foxNext !== session.fox ? updateSession(base, { fox: foxNext }) : base;

      // 任务达标 → 休息（每个 session 只发一次，防刷）
      const cfg = next.settings.features.tasks;
      if (
        cfg.enabled &&
        cfg.restEnabled &&
        next.session.rest.grantedAt == null &&
        qualifiesForRest(next.session.tasks, cfg.restThresholdPercent)
      ) {
        // 已经到结束时间附近就别发休息了（少于 1 分钟）
        if (next.session.endAt - now > MINUTE) return enterRest(next, now);
      }
      return done(next);
    }

    case PHASE.REST: {
      const session = base.session;
      if (!session) return done({ ...base, phase: PHASE.IDLE });
      if (session.pause?.active) return done(base);
      if (now >= effectiveEndAt(session, now)) {
        // 休息期间结束：只要不是早先失败过，就算坚持到底
        return endSession(base, now, foxOutcome(session.fox), 'finished');
      }
      if (session.rest.untilAt != null && now >= effectiveRestUntil(session, now)) {
        return leaveRest(base, now, 'timer');
      }
      return done(base);
    }

    default:
      return done(base);
  }
}

// ------------------------------------------------------------------ reduce

export function reduce(state, event = {}) {
  const now = Number.isFinite(event.now) ? event.now : state.now;

  switch (event.type) {
    case 'TICK':
      return tick(state, now);

    case 'SETTINGS': {
      const settings = event.settings;
      // 改了设置就清掉"跳过"标记：时间表可能已经变了
      const base = { ...state, settings, now, skippedStartAt: null };
      if (base.phase === PHASE.IDLE) return done(base);
      if (!settings.enabled) return endSession(base, now, 'aborted', 'disabled');
      if (base.phase === PHASE.PREWARN) {
        const upcoming = nextSession(now, enabledWindows(settings));
        if (!upcoming) return { state: { ...base, phase: PHASE.IDLE, session: null }, effects: [{ type: 'persist' }] };
        return done({ ...base, session: { ...base.session, startAt: upcoming.startAt, endAt: upcoming.endAt, label: upcoming.window?.label } });
      }
      if (base.phase === PHASE.LOCKED || base.phase === PHASE.REST) {
        const active = activeSession(now, enabledWindows(settings));
        if (!active) return endSession(base, now, 'aborted', 'schedule-changed');
        // 时间段被改短了就跟新的结束时间对齐（改长了不延长本次，避免无限续期）
        return done(updateSession(base, { endAt: Math.min(base.session.endAt, active.endAt) }));
      }
      return done(base);
    }

    case 'PREWARN_DISMISS':
      if (state.phase !== PHASE.PREWARN || !state.session) return done(state);
      return {
        state: { ...state, phase: PHASE.IDLE, suppressedStartAt: state.session.startAt, session: null, now },
        effects: [{ type: 'persist' }],
      };

    case 'PREWARN_OPEN':
      if (state.phase !== PHASE.PREWARN) return done(state);
      return done({ ...state, now });

    case 'TASK_ADD': {
      const text = String(event.text ?? '');
      const target = state.session ? 'session' : 'prepared';
      const list = target === 'session' ? state.session.tasks : state.preparedTasks;
      const { tasks, added } = addTaskSafe(list, text, now);
      if (!added) return done(state);
      if (target === 'session') return done(updateSession({ ...state, now }, { tasks }));
      return done({ ...state, preparedTasks: tasks, now });
    }

    case 'TASK_TOGGLE': {
      if (state.session) {
        const tasks = state.session.tasks.map((t) => (t.id === event.id ? { ...t, done: !t.done, doneAt: !t.done ? now : null } : t));
        return done(updateSession({ ...state, now }, { tasks }));
      }
      const tasks = state.preparedTasks.map((t) => (t.id === event.id ? { ...t, done: !t.done, doneAt: !t.done ? now : null } : t));
      return done({ ...state, preparedTasks: tasks, now });
    }

    case 'TASK_REMOVE': {
      if (state.session) {
        const tasks = state.session.tasks.filter((t) => t.id !== event.id);
        return done(updateSession({ ...state, now }, { tasks }));
      }
      return done({ ...state, preparedTasks: state.preparedTasks.filter((t) => t.id !== event.id), now });
    }

    case 'TASK_CLEAR': {
      if (state.session) return done(updateSession({ ...state, now }, { tasks: [] }));
      return done({ ...state, preparedTasks: [], now });
    }

    case 'TASK_IMPORT': {
      const incoming = normalizeTasks(event.tasks);
      if (!incoming.length) return done(state);
      if (state.session) {
        const existing = new Set(state.session.tasks.map((t) => t.text));
        const merged = [...state.session.tasks, ...incoming.filter((t) => !existing.has(t.text))];
        return done(updateSession({ ...state, now }, { tasks: merged.slice(0, 30) }));
      }
      const existing = new Set(state.preparedTasks.map((t) => t.text));
      return done({ ...state, preparedTasks: [...state.preparedTasks, ...incoming.filter((t) => !existing.has(t.text))].slice(0, 30), now });
    }

    case 'FOX_LEAVE': {
      if (state.phase !== PHASE.LOCKED || !state.session) return done({ ...state, now });
      // 消息暂停期间离开不算失败（跟休息一样）
      if (state.session.pause?.active) return done({ ...state, now });
      const fox = state.session.fox;
      if (!foxCanLeaveFail(fox, now)) return done({ ...state, now });
      const failed = failFox(fox, now, event.reason || 'leave');
      if (failed === fox) return done({ ...state, now });
      const session = {
        ...state.session,
        fox: failed,
        leaves: [...state.session.leaves, { at: now, reason: event.reason || 'leave' }],
      };
      return {
        state: { ...state, session, now },
        effects: [
          { type: 'fox-failed', reason: event.reason || 'leave' },
          { type: 'sound', name: 'fail' },
          { type: 'persist' },
        ],
      };
    }

    case 'FOX_RETURN':
      return done({ ...state, now });

    case 'INCOMING_MESSAGE': {
      // 重要联系人发来消息：响铃 + （限制期间）自动暂停计时
      const cfg = state.settings.features.interrupt;
      if (!cfg || !cfg.enabled) return done({ ...state, now });
      const appId = String(event.app || 'wechat');
      const contact = String(event.contact ?? '').trim().slice(0, 24) || '某人';
      // 配了名单就只认名单里的人；名单为空时不过滤（方便先用起来）
      const list = cfg.contacts?.filter((c) => c.enabled) || [];
      if (list.length > 0 && !list.some((c) => c.app === appId && c.name === contact)) {
        return done({ ...state, now });
      }
      const ringEffect = { type: 'ring', app: appId, contact, at: now };
      const inSession = (state.phase === PHASE.LOCKED || state.phase === PHASE.REST) && state.session;
      if (!inSession) return { state: { ...state, now }, effects: [ringEffect] };

      const session = state.session;
      const key = `${appId}:${contact}`;
      const last = session.lastIncoming;
      const cooldownMs = Math.max(5, cfg.cooldownSeconds) * 1000;
      if (last && last.key === key && now - last.at < cooldownMs) {
        // 冷却期内同一联系人只响一次，避免被连续消息刷屏
        return done({ ...state, now });
      }

      let next = { ...session, lastIncoming: { key, at: now } };
      const effects = [
        ringEffect,
        { type: 'notify', title: `${contact} 发来消息`, body: cfg.autoPause ? '限制已暂停，处理完记得恢复计时' : '限制继续，别聊太久' },
      ];
      if (cfg.autoPause && !session.pause.active) {
        const reason = { app: appId, contact, at: now };
        next = {
          ...next,
          pause: { active: true, since: now, totalMs: session.pause.totalMs, reason, count: session.pause.count + 1 },
          fox: pauseFox(session.fox, now),
        };
        effects.push({ type: 'grayscale', on: false }, { type: 'pause-start', reason }, { type: 'persist' });
      } else if (session.pause.active) {
        next = { ...next, pause: { ...session.pause, count: session.pause.count + 1, reason: { app: appId, contact, at: now } } };
        effects.push({ type: 'persist' });
      }
      return { state: { ...state, now, session: next }, effects };
    }

    case 'RESUME_FROM_MESSAGE': {
      const session = state.session;
      if (!session || !session.pause?.active) return done({ ...state, now });
      const p = session.pause;
      const delta = Math.max(0, now - p.since);
      const next = {
        ...session,
        pause: { active: false, since: null, totalMs: p.totalMs + delta, reason: null, count: p.count },
        fox: resumeFox(session.fox, now),
      };
      const gray = state.settings.features.grayscale;
      return {
        state: { ...state, now, session: next },
        effects: [
          { type: 'grayscale', on: Boolean(gray.enabled) && state.phase === PHASE.LOCKED },
          { type: 'pause-end', pausedMs: delta },
          { type: 'persist' },
        ],
      };
    }

    case 'SKIP_CURRENT': {      // 只对"正在生效但还没锁/刚恢复"的 idle 状态有意义：
      // 把当前这一段标记为已跳过，今晚不再锁，明天照常。
      if (state.phase !== PHASE.IDLE) return done({ ...state, now });
      const active = activeSession(now, enabledWindows(state.settings));
      if (!active) return done({ ...state, now });
      return { state: { ...state, now, skippedStartAt: active.startAt }, effects: [{ type: 'persist' }] };
    }

    case 'MATRIX_TRIGGER': {
      if (state.phase !== PHASE.LOCKED || !state.session) return done({ ...state, now });
      if (state.session.pause?.active) return done({ ...state, now }); // 暂停时别弹游戏
      const cfg = state.settings.features.matrix;
      if (!cfg.enabled) return done({ ...state, now });
      const m = state.session.matrix;
      if (m.openAt != null) return done({ ...state, now });
      if (now < m.cooldownUntil) return done({ ...state, now });
      const session = { ...state.session, matrix: { ...m, openAt: now, triggers: m.triggers + 1 } };
      return { state: { ...state, session, now }, effects: [{ type: 'matrix-open' }, { type: 'persist' }] };
    }

    case 'MATRIX_SOLVED': {
      if (!state.session) return done({ ...state, now });
      const cfg = state.settings.features.matrix;
      const m = state.session.matrix;
      const session = {
        ...state.session,
        matrix: { ...m, openAt: null, solved: m.solved + 1, cooldownUntil: now + cfg.cooldownMinutes * MINUTE },
      };
      return {
        state: { ...state, session, now },
        effects: [{ type: 'matrix-close', solved: true }, { type: 'sound', name: 'pass' }, { type: 'persist' }],
      };
    }

    case 'MATRIX_ABANDON': {
      if (!state.session) return done({ ...state, now });
      return { state: { ...state, session: { ...state.session, matrix: { ...state.session.matrix, openAt: null } }, now }, effects: [{ type: 'matrix-close' }] };
    }

    case 'REST_SKIP': {
      if (state.phase !== PHASE.REST) return done(state);
      return leaveRest({ ...state, now }, now, 'user');
    }

    case 'EMERGENCY_EXIT': {
      if (state.phase !== PHASE.LOCKED && state.phase !== PHASE.REST) return done(state);
      return endSession({ ...state, now }, now, 'aborted', 'emergency');
    }

    case 'PREVIEW_START': {
      const durationMs = Math.max(5000, Number(event.durationMs) || 60000);
      if (event.phase === 'prewarn') {
        const session = makeSession({
          windowId: 'preview',
          label: '演练限制',
          startAt: now + durationMs,
          endAt: now + durationMs + 8 * HOUR,
          now,
          tasks: event.tasks ?? [],
          preview: true,
        });
        return {
          state: { ...state, now, phase: PHASE.PREWARN, session, preparedTasks: session.tasks, preview: true },
          effects: [{ type: 'persist' }],
        };
      }
      if (event.phase === 'result') {
        const session = makeSession({
          windowId: 'preview',
          label: '演练',
          startAt: now - 8 * HOUR,
          endAt: now,
          now: now - 8 * HOUR,
          tasks: event.tasks ?? [],
          preview: true,
        });
        const fake = {
          ...session,
          fox: { ...session.fox, feathers: 96, flowers: 3 },
          rest: { grantedAt: now - 6 * HOUR, untilAt: null, enteredAt: null, usedMs: 12 * MINUTE },
        };
        const record = summarize(fake, now, event.outcome || 'success', 'preview');
        const fallbackReward = { flowerId: 'rose', isNewSpecies: true, streakDays: 5 };
        const reward = Object.prototype.hasOwnProperty.call(event, 'reward') ? event.reward : fallbackReward;
        return {
          state: { ...state, now, phase: PHASE.RESULT, session: fake, result: { ...record, reward }, preview: true },
          effects: [{ type: 'persist' }],
        };
      }
      const session = makeSession({
        windowId: 'preview',
        label: '演练限制',
        startAt: now,
        endAt: now + durationMs,
        now,
        tasks: event.tasks ?? [],
        preview: true,
      });
      const effects = fx(
        { type: 'grayscale', on: Boolean(state.settings.features.grayscale.enabled) },
        { type: 'persist' },
      );
      return { state: { ...state, now, phase: PHASE.LOCKED, session, preparedTasks: session.tasks, preview: true }, effects };
    }

    case 'RESULT_FINALIZED': {
      if (state.phase !== PHASE.RESULT || !state.result) return done(state);
      return done({ ...state, result: { ...state.result, reward: event.reward ?? null } });
    }

    case 'RESULT_ACK': {
      if (state.phase !== PHASE.RESULT) return done(state);
      // 长按提前结束 = 明确放弃本次 → 这一轮限制不再重新锁你
      // （试跑/预览没有真实时段，别把"跳过"写进真实状态，否则刷新后首页会显示"今晚不会再锁"）
      const isPreview = Boolean(state.preview);
      const wasEmergency = state.result?.outcome === 'aborted' && state.result?.reason === 'emergency';
      return {
        state: {
          ...state,
          phase: PHASE.IDLE,
          session: null,
          result: null,
          preparedTasks: [],
          suppressedStartAt: null,
          skippedStartAt: wasEmergency && !isPreview ? state.result?.startedAt ?? null : null,
          preview: false,
          now,
        },
        effects: [{ type: 'persist' }],
      };
    }

    case 'RESTORE': {
      const restored = restore(state, event.snapshot, now);
      return restored ?? done({ ...state, now });
    }

    default:
      return done({ ...state, now });
  }
}

// addTask 的保险丝：坏输入不该让状态机抛异常
function addTaskSafe(list, text, now) {
  try {
    return addTask(list, text, now);
  } catch {
    return { tasks: list, added: null };
  }
}

// ------------------------------------------------------------------ 快照

export function toSnapshot(state) {
  const common = {
    v: SNAPSHOT_VERSION,
    phase: state.phase,
    preparedTasks: state.preparedTasks,
    suppressedStartAt: state.suppressedStartAt,
    skippedStartAt: state.skippedStartAt,
    savedAt: state.now,
    preview: state.preview,
  };
  return state.session ? { ...common, session: state.session } : { ...common, session: null };
}

/**
 * 从快照恢复。核心判断：
 *  - 关闭/刷新前处于 locked：视为"离开过"，狐狸失败，但锁定继续到结束；
 *  - 关闭前处于 rest：不算失败（休息本来就是自由使用时间）；
 *  - 恢复时已经过了结束时间：直接结算。
 */
export function restore(state, snapshot, now) {
  if (!snapshot || snapshot.v !== SNAPSHOT_VERSION) return null;
  const skipped = Number.isFinite(snapshot.skippedStartAt) ? snapshot.skippedStartAt : null;
  if (!snapshot.session) {
    // 只有"本次已跳过"这一个信息需要跨刷新保留
    if (!skipped) return null;
    return { state: { ...state, now, phase: PHASE.IDLE, skippedStartAt: skipped }, effects: [{ type: 'persist' }] };
  }
  const settings = state.settings;
  if (snapshot.phase === PHASE.PREWARN) {
    // 预警阶段刷新：回到 idle，tick 会重新触发预警（任务草稿保留）
    return {
      state: { ...state, now, phase: PHASE.IDLE, preparedTasks: normalizeTasks(snapshot.preparedTasks), preview: Boolean(snapshot.preview) },
      effects: [{ type: 'persist' }],
    };
  }
  const gap = Math.max(0, now - (Number(snapshot.savedAt) || now));
  const gapLimit = Math.max(2000, settings.fox.graceLeaveMs + 1500);
  const s = snapshot.session;
  let session = {
    ...s,
    tasks: normalizeTasks(s.tasks),
    leaves: Array.isArray(s.leaves) ? s.leaves : [],
    rest: { grantedAt: null, untilAt: null, enteredAt: null, usedMs: 0, ...(s.rest || {}) },
    matrix: { openAt: null, cooldownUntil: 0, solved: 0, triggers: 0, ...(s.matrix || {}) },
    fox: { ...createFox(now), ...(s.fox || {}) },
  };
  // 恢复时不能带着旧的 openAt，避免弹窗卡死
  session.matrix = { ...session.matrix, openAt: null };

  const phase = snapshot.phase === PHASE.REST ? PHASE.REST : PHASE.LOCKED;
  let base = { ...state, now, session, preparedTasks: normalizeTasks(snapshot.preparedTasks), preview: Boolean(snapshot.preview) };
  if (skipped) base = { ...base, skippedStartAt: skipped };
  if (skipped && skipped === session.startAt) {
    // 这次限制已经跳过过，刷新后不要再把人锁回去
    return { state: { ...base, phase: PHASE.IDLE, session: null }, effects: [{ type: 'persist' }] };
  }

  if (phase === PHASE.LOCKED && gap > gapLimit) {
    session = { ...session, fox: failFox(session.fox, now, 'app-closed'), leaves: [...session.leaves, { at: now, reason: 'app-closed' }] };
    base = { ...base, session };
  }

  const windows = enabledWindows(settings);
  const active = activeSession(now, windows);
  const stillRelevant = now < effectiveEndAt(session, now);

  if (!stillRelevant) {
    const outcome = foxOutcome(session.fox);
    return endSession({ ...base, session, phase }, now, outcome, 'ended-while-away');
  }

  if (!active) {
    // 窗口被删/改掉了
    return endSession({ ...base, session, phase }, now, 'aborted', 'schedule-changed');
  }

  if (phase === PHASE.REST) {
    if (session.rest.untilAt != null && now < session.rest.untilAt) {
      return {
        state: { ...base, phase: PHASE.REST, session },
        effects: [{ type: 'grayscale', on: false }, { type: 'rest-start', untilAt: session.rest.untilAt }, { type: 'persist' }],
      };
    }
    // 休息早该结束了
    return leaveRest({ ...base, phase: PHASE.REST, session }, now, 'restore');
  }

  if (now >= session.endAt) {
    return endSession({ ...base, session, phase: PHASE.LOCKED }, now, foxOutcome(session.fox), 'finished');
  }

  const effects = fx(
    { type: 'grayscale', on: Boolean(settings.features.grayscale.enabled) },
    { type: 'enter-locked', session },
    session.fox.state === 'failed' ? { type: 'fox-failed', reason: session.fox.reason || 'app-closed' } : null,
    { type: 'persist' },
  );
  return { state: { ...base, phase: PHASE.LOCKED, session }, effects };
}

// ------------------------------------------------------------------ 派生视图

export function sessionCountdown(state, now) {
  if (!state.session) return null;
  const s = state.session;
  switch (state.phase) {
    case PHASE.PREWARN:
      return { kind: 'to-start', ms: Math.max(0, s.startAt - now) };
    case PHASE.LOCKED:
      return { kind: 'to-end', ms: Math.max(0, effectiveEndAt(s, now) - now) };
    case PHASE.REST:
      return { kind: 'to-rest-end', ms: Math.max(0, effectiveRestUntil(s, now) - now) };
    default:
      return null;
  }
}

export function progressOf(state) {
  const tasks = state.session?.tasks ?? state.preparedTasks;
  return taskProgress(tasks);
}
