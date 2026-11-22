/**
 * ui/views/session.js —— 限制主屏：倒计时 + 狐狸收集 + 任务进度 + 操作
 */
import { esc, fmtClock, foxArt } from '../dom.js';
import { taskProgress } from '../../core/tasks.js';
import { foxStatusText } from '../../core/fox.js';
import { appMeta } from '../../core/settings.js';
import { taskListHtml, taskInputHtml } from './task-list.js';

/** 狐狸头顶那句话（app.js 的 paintLive 也会调用，保证每秒跟着状态变） */
export function foxBubbleText(state, session, now) {
  const fox = session.fox;
  if (fox.state === 'failed') return '呜…你刚才离开了，收集失败了';
  if (state.phase === 'rest') return '休息一下，我在这儿等你';
  const left = session.endAt - now;
  if (left < 10 * 60 * 1000) return '快坚持到底了，我把羽毛收好';
  if (fox.feathers > 0 && fox.feathers % 3 === 0) return `已经捡到 ${fox.feathers} 根羽毛啦`;
  return foxStatusText(fox);
}

export function sessionView(ctx) {
  const { state, settings } = ctx;
  const s = state.session;
  if (!s) return '';
  const isRest = state.phase === 'rest';
  const t = settings.features.tasks;
  const m = settings.features.matrix;
  const g = settings.features.grayscale;
  const progress = taskProgress(s.tasks);
  const fox = s.fox;
  const bubbleText = foxBubbleText(state, s, ctx.now);
  const bubbleSad = fox.state === 'failed';
  const paused = Boolean(s.pause?.active);
  const pauseMeta = paused ? appMeta(s.pause.reason?.app) : null;
  const pauseContact = paused ? s.pause.reason?.contact || '联系人' : '';

  const taskPanel = t.enabled
    ? `<div class="session-task-panel">
        <div class="stp-head">
          <span class="t">今天的任务</span>
          <span class="p" data-live="task-percent"></span>
        </div>
        <div class="bar"><span data-live="task-bar" style="width:0%"></span></div>
        ${taskListHtml(s.tasks, { editable: true, listClass: 'stp-tasks', emptyText: '还没有任务，现在加一条也行' })}
        ${s.tasks.length ? `<p class="stp-note">${
          s.rest.grantedAt
            ? '休息奖励已经用过了，接下来安静地待一会儿吧。'
            : t.restEnabled
              ? `完成 ${t.restThresholdPercent}% 可以休息 ${t.restMinutes} 分钟。`
              : '休息奖励已关闭，勾选只用来记录进度。'
        }</p>` : ''}
        <div style="margin-top:10px">${taskInputHtml({ placeholder: '再加一条…' })}</div>
      </div>`
    : '';

  return `<div class="layer session">
    <div class="session-inner">
      <div class="session-top">
        ${
          paused
            ? `<div class="interrupt-banner">
                 <span class="app-badge" style="--app:${pauseMeta.color}">${esc(pauseMeta.name)}</span>
                 <div class="ib-main">
                   <p class="ib-title">${esc(pauseContact)} 发来消息</p>
                   <p class="tiny">计时已暂停 <span data-live="pause-elapsed">00:00</span> · 恢复后结束时间自动顺延</p>
                 </div>
               </div>`
            : ''
        }
        <span class="session-tag ${paused ? 'paused' : isRest ? 'rest' : ''}">
          ${paused ? '已暂停' : isRest ? '休息中' : '限制中'} · ${esc(s.label)}${s.preview ? ' · 演练' : ''}
        </span>
        <div class="session-countdown" data-live="session-countdown"></div>
        <p class="session-caption">
          ${
            paused
              ? '重要消息优先处理，回来点「恢复计时」继续'
              : isRest
                ? `设备恢复可用 · ${esc(fmtClock(s.rest.untilAt ?? s.endAt))} 回到限制`
                : `距结束 · 灰度${g.enabled ? '已开启' : '未开启'} · 离开即失败`
          }
        </p>
      </div>

      <div class="fox-stage">
        <canvas data-fox-canvas aria-hidden="true"></canvas>
        ${foxArt(fox.state === 'failed' ? 'sad' : isRest ? 'collect' : 'collect', { assets: ctx.assets, alt: '小狐狸' })}
        <div class="fox-bubble ${bubbleSad ? 'sad' : ''}" data-live="fox-bubble"></div>
        <div class="collect-hud">
          <div class="hud-cell">
            <span class="ico">🪶</span>
            <div>
              <div class="num" data-live="feathers">0</div>
              <div class="lbl">羽毛</div>
            </div>
          </div>
          <div class="hud-cell">
            <span class="ico">🌸</span>
            <div>
              <div class="num" data-live="flowers">0</div>
              <div class="lbl">花朵</div>
            </div>
          </div>
        </div>
      </div>

      ${taskPanel}

      <div class="session-actions">
        ${
          paused
            ? `<button class="btn primary block" data-act="resume-timer">我处理完了，恢复计时</button>`
            : isRest
              ? `<button class="btn primary block" data-act="rest-skip">休息好了，继续</button>`
              : m.enabled
                ? `<button class="btn primary block" data-act="matrix-trigger">我用手机了 →</button>`
                : `<p class="tiny" style="text-align:center">数字矩阵已在设置里关闭，本次不弹小游戏。</p>`
        }
        ${
          ctx.testMode && !paused
            ? `<button class="btn ghost block" data-act="mock-message">模拟收到一条重要消息（测试）</button>`
            : ''
        }
        <button class="hold-btn" type="button" data-act="emergency" data-hold="${settings.emergency.holdSeconds}">
          <span class="hold-fill"></span>
          <span>按住 ${settings.emergency.holdSeconds} 秒：跳过本次限制</span>
        </button>
        <p class="tiny" style="text-align:center">
          跳过后这一段不会再锁你（本次不发花），下一段照常。${isRest ? '休息期间离开不算失败。' : ''}
        </p>
      </div>
    </div>
  </div>`;
}
