/**
 * ui/views/home.js —— 首页：现在是什么状态、今天还有什么、小狐狸的收藏
 */
import { enabledWindows } from '../../core/settings.js';
import { activeSession, nextSession, sessionsOnDay, startOfLocalDay, nextLocalDay } from '../../core/schedule.js';
import { collectionStats, collectionView } from '../../core/collection.js';
import { esc, fmtCountdown, humanMs, sessionRange, fmtDay, foxArt, flowerArt } from '../dom.js';

function heroState(ctx) {
  const { state, settings, now } = ctx;
  const windows = enabledWindows(settings);
  const active = activeSession(now, windows);
  const next = nextSession(now, windows);

  if (state.phase === 'locked' && state.session) {
    return {
      kicker: '限制中',
      title: '小狐狸正在收集',
      sub: `距结束 <strong data-live="hero-countdown"></strong>，之后设备恢复自由。`,
      chips: [
        { text: settings.features.grayscale.enabled ? '灰度已开启' : '灰度未开启', ok: settings.features.grayscale.enabled },
        { text: state.session.rest.grantedAt ? '休息已用过' : '还有一次休息机会' },
      ],
    };
  }
  if (state.phase === 'rest' && state.session) {
    return {
      kicker: '休息中',
      title: '设备暂时可用',
      sub: `休息还剩 <strong data-live="hero-countdown"></strong>，结束后回到限制。`,
      chips: [{ text: '灰度已关闭', ok: true }, { text: '休息期间离开不算失败' }],
    };
  }
  if (active && state.skippedStartAt === active.startAt) {
    return {
      kicker: '本次已跳过',
      title: '今晚不会再锁',
      sub: `你长按结束了这一次。到 ${sessionRange(active.startAt, active.endAt)} 结束前都不会再弹锁定；想彻底关掉就去设置。`,
      chips: [{ text: '本次不发花', bad: true }, { text: '只跳过这一轮' }],
    };
  }
  if (state.testMode) {
    return {
      kicker: '测试模式',
      title: '不会自动锁定',
      sub: active
        ? `时间表其实是生效的（「${esc(active.window?.label || '限制时段')}」${sessionRange(active.startAt, active.endAt)}），但测试模式忽略了它。`
        : `时间表照常在跑，但测试模式不会自动锁你。去掉地址里的 ?test=1 就恢复正常。`,
      chips: [{ text: 'URL：?test=1' }, { text: '仍可点「试跑 60 秒」' }],
    };
  }
  if (active) {
    return {
      kicker: '限制中',
      title: '设备应处于限制状态',
      sub: `这段限制到 ${sessionRange(active.startAt, active.endAt)} 结束。`,
      chips: [],
    };
  }
  if (!settings.enabled) {
    return { kicker: '已关闭', title: '限制功能总开关关着', sub: '打开总开关后，时间表才会生效。', chips: [{ text: '总开关：关', bad: true }] };
  }
  if (next) {
    const label = next.window?.label || '限制时段';
    return {
      kicker: '自由时间',
      title: '现在可以自由使用',
      sub: `距「${esc(label)}」开始 <strong data-live="hero-countdown"></strong>（${sessionRange(next.startAt, next.endAt)}）。`,
      chips: [
        { text: `提前 ${settings.prewarnMinutes} 分钟提醒填任务` },
        { text: `最长 ${humanMs(next.endAt - next.startAt)}` },
      ],
    };
  }
  return {
    kicker: '今天',
    title: '没有排限制时段',
    sub: '去「记录」页加一段时间，或者打开总开关。',
    chips: [{ text: '时间表为空' }],
  };
}

function timelineHtml(ctx) {
  const { settings, now } = ctx;
  const windows = enabledWindows(settings);
  const dayStart = startOfLocalDay(now);
  const dayEnd = nextLocalDay(dayStart);
  const dayMs = dayEnd - dayStart;
  const list = sessionsOnDay(now, windows);

  if (!list.length) {
    return `<div class="empty">今天没有限制时段<br /><span class="tiny">去「记录 → 限制时段」加一段每日重复的时间即可</span></div>`;
  }

  return `<div class="timeline">${list
    .map((s) => {
      const left = Math.max(0, ((Math.max(s.startAt, dayStart) - dayStart) / dayMs) * 100);
      const width = Math.min(100 - left, ((Math.min(s.endAt, dayEnd) - Math.max(s.startAt, dayStart)) / dayMs) * 100);
      const isNow = s.startAt <= now && now < s.endAt;
      return `<div class="tl-item ${isNow ? 'active' : ''}">
        <div class="tl-time">${esc(s.window?.label || '限定')}<br /><span class="mono">${sessionRange(s.startAt, s.endAt)}</span></div>
        <div class="tl-track">
          <span style="left:${left}%;width:${Math.max(1.5, width)}%"></span>
          <i class="tl-now" data-live="nowmark" style="left:50%"></i>
        </div>
        <div class="tl-label">${isNow ? '进行中' : humanMs(s.endAt - s.startAt)}</div>
      </div>`;
    })
    .join('')}</div>`;
}

function collectionPreview(ctx) {
  const stats = collectionStats(ctx.collection);
  const owned = collectionView(ctx.collection).filter((f) => f.owned).slice(0, 6);
  return `<div class="card">
    <div class="card-head">
      <h3>小狐狸的收藏</h3>
      <span class="sub">${stats.distinctSpecies}/${stats.speciesTotal} 种 · 连续 ${stats.streakDays} 天</span>
      <span class="grow"></span>
      <button class="btn ghost small" data-act="nav" data-view="collection">全部</button>
    </div>
    ${
      owned.length
        ? `<div class="flower-grid">${owned
            .map(
              (f) => `<div class="flower owned">
                ${flowerArt(f, { size: 52 })}
                <div class="flower-name">${esc(f.name)}</div>
                <div class="flower-lang">${esc(f.language)}</div>
                <div class="flower-meta">×${f.count}</div>
              </div>`,
            )
            .join('')}</div>`
        : `<div class="empty">还没有收藏<br /><span class="tiny">坚持完一次限制，小狐狸就会带回一朵花</span></div>`
    }
    <div class="divider"></div>
    <div class="chip-row">
      <span class="pill-soft">🪶 羽毛 ${stats.feathers}</span>
      <span class="pill-soft">🌸 花 ${stats.totalFlowers}</span>
      <span class="pill-soft">✅ 成功 ${stats.successes}</span>
      <span class="pill-soft">😢 离开 ${stats.failures}</span>
    </div>
  </div>`;
}

export function homeView(ctx) {
  const hero = heroState(ctx);
  const { settings } = ctx;
  return `<div class="page-inner">
    <section class="card hero">
      <div class="hero-grid">
        <div class="hero-fox">${foxArt('collect', { assets: ctx.assets, cls: '', alt: '小狐狸', emojiSize: 54 })}</div>
        <div>
          <p class="hero-kicker">${esc(hero.kicker)}</p>
          <h1 class="hero-title">${esc(hero.title)}</h1>
          <p class="hero-sub">${hero.sub}</p>
          <div class="hero-meta">
            ${
              settings.enabled
                ? `<span class="pill-soft ok">总开关：开</span>`
                : `<span class="pill-soft bad">总开关：关</span>`
            }
            ${hero.chips.map((c) => `<span class="pill-soft ${c.ok ? 'ok' : c.bad ? 'bad' : ''}">${esc(c.text)}</span>`).join('')}
          </div>
        </div>
      </div>
    </section>

    ${
      ctx.firstRun && !settings.enabled
        ? `<section class="card">
      <div class="card-head"><h3>第一次使用：三步就绪</h3></div>
      <div class="hint" style="margin-bottom:12px">
        <b>1.</b> 去「记录」加一段限制时间（比如每天 23:00–07:00）<br />
        <b>2.</b> 打开「设置」顶部的限制功能总开关<br />
        <b>3.</b> 到点自动锁定：提前提醒填任务 → 灰度 + 小狐狸收集 → 达标可休息
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary small" data-act="nav" data-view="stats">去「记录」加时间</button>
        <button class="btn ghost small" data-act="nav" data-view="settings">去「设置」开总开关</button>
      </div>
    </section>`
        : ''
    }

    <div class="quick-grid">
      <button class="quick accent" data-act="demo-start">
        <span class="q-icon">▶︎</span>
        <span class="q-title">试跑 60 秒</span>
        <span class="q-sub">立刻体验锁定、灰度与狐狸收集（不计入统计）</span>
      </button>
      <button class="quick" data-act="nav" data-view="settings">
        <span class="q-icon">⚙︎</span>
        <span class="q-title">时间与功能设置</span>
        <span class="q-sub">时段、任务、矩阵游戏、灰度</span>
      </button>
      <button class="quick" data-act="nav" data-view="collection">
        <span class="q-icon">🌸</span>
        <span class="q-title">花朵收藏册</span>
        <span class="q-sub">看看小狐狸带回来了什么</span>
      </button>
      <button class="quick" data-act="nav" data-view="stats">
        <span class="q-icon">📊</span>
        <span class="q-title">坚持记录</span>
        <span class="q-sub">成功率、连续天数、休息用量</span>
      </button>
    </div>

    <section class="card">
      <div class="card-head">
        <h3>今日安排</h3>
        <span class="sub">${fmtDay(ctx.now)}</span>
      </div>
      ${timelineHtml(ctx)}
    </section>

    ${collectionPreview(ctx)}
  </div>`;
}
