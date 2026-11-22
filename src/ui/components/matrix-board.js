/**
 * ui/components/matrix-board.js —— 数字矩阵小游戏的界面与交互。
 *
 * 放在独立的 #overlay-root 里用命令式管理（而不是跟着整页重渲染），
 * 这样点击的即时反馈不会被每秒的重绘打断。
 */
import { createRound, clickValue, currentTarget, checkTimeout, remainingMs } from '../../core/matrix.js';
import { esc } from '../dom.js';

export function createMatrixBoard({ getSettings, now, onSolved, onSound }) {
  let round = null;
  let host = null;
  let failNote = '';
  let restartTimer = null;
  let wrongTimer = null;
  let opened = false;

  const cfg = () => getSettings().features.matrix;

  function open() {
    clearRestart();
    failNote = '';
    round = createRound(cfg(), now());
    opened = true;
  }

  function clearRestart() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function close() {
    clearRestart();
    if (wrongTimer) clearTimeout(wrongTimer);
    opened = false;
    round = null;
    failNote = '';
    if (host) host.innerHTML = '';
    host = null;
  }

  function gridHtml() {
    const c = cfg();
    return `<div class="matrix-grid" style="grid-template-columns:repeat(${c.gridSize}, minmax(0, 1fr))">
      ${round.cells
        .map(
          (cell) => `<button type="button" class="matrix-cell" data-act="matrix-cell" data-v="${cell.value}"
            aria-label="数字 ${cell.value}">${cell.value}</button>`,
        )
        .join('')}
    </div>`;
  }

  function footHtml() {
    const target = currentTarget(round);
    const left = round.order.length - round.idx;
    return `<div class="matrix-foot">
      <span>下一个 <span class="target" data-live="matrix-target">${target ?? '—'}</span></span>
      <div class="bar thin matrix-progress"><span data-live="matrix-progress" style="width:${(round.idx / round.order.length) * 100}%"></span></div>
      <span>剩 ${left}</span>
    </div>
    ${failNote ? `<p class="matrix-fail-note">${esc(failNote)}</p>` : ''}`;
  }

  function html() {
    const c = cfg();
    return `<div class="layer matrix-layer" role="dialog" aria-modal="true" aria-labelledby="matrix-title">
      <div class="matrix-panel">
        <div class="matrix-head">
          <h3 id="matrix-title">按顺序点数字</h3>
          <span class="timer" data-live="matrix-timer">${
            c.timeLimitSec > 0 ? `${c.timeLimitSec}s` : '不限时'
          }</span>
        </div>
        <p class="matrix-sub">从 <b>${esc(round.order[0])}</b> 开始，按升序点完 ${round.order.length} 个数。点错 ${c.maxErrors} 次要重来。</p>
        <div data-matrix-body>${gridHtml()}${footHtml()}</div>
        <p class="tiny" style="margin-top:10px">这个弹窗没有关闭按钮 —— 通关才能继续用手机。</p>
      </div>
    </div>`;
  }

  function mount(el) {
    host = el;
    host.innerHTML = html();
    round.startedAt = now();
  }

  function updateFoot() {
    if (!host) return;
    const targetEl = host.querySelector('[data-live="matrix-target"]');
    if (targetEl) targetEl.textContent = currentTarget(round) ?? '—';
    const progEl = host.querySelector('[data-live="matrix-progress"]');
    if (progEl) progEl.style.width = `${(round.idx / round.order.length) * 100}%`;
    const foot = host.querySelector('.matrix-foot');
    if (foot) {
      const left = foot.querySelector('span:last-child');
      if (left) left.textContent = `剩 ${round.order.length - round.idx}`;
    }
  }

  function resetRound(note) {
    failNote = note || '';
    round = createRound(cfg(), now());
    if (!host) return;
    const body = host.querySelector('[data-matrix-body]');
    if (body) body.innerHTML = `${gridHtml()}${footHtml()}`;
  }

  function handleCell(value) {
    if (!round || round.status !== 'playing') return;
    const prevStatus = round.status;
    const res = clickValue(round, value, now());
    round = res.round;
    if (!host) return;

    const cell = host.querySelector(`.matrix-cell[data-v="${value}"]`);
    if (res.result === 'ok' || res.result === 'won') {
      cell?.classList.add('done');
      onSound?.('pass');
      updateFoot();
    } else if (res.result === 'wrong' || res.result === 'lost') {
      cell?.classList.add('wrong');
      onSound?.('fail');
      if (wrongTimer) clearTimeout(wrongTimer);
      wrongTimer = setTimeout(() => cell?.classList.remove('wrong'), 320);
      updateFoot();
    }

    if (res.result === 'won') {
      onSolved?.();
      return;
    }
    if (res.result === 'lost') {
      const reason = round.errors >= round.cfg.maxErrors ? `点错 ${round.cfg.maxErrors} 次了，重开一局。` : '超时了，重开一局。';
      const body = host.querySelector('[data-matrix-body]');
      if (body) body.innerHTML = `<p class="matrix-fail-note">${esc(reason)}</p>`;
      clearRestart();
      restartTimer = setTimeout(() => resetRound(''), 1200);
    }
    if (prevStatus === 'playing' && round.status === 'playing') {
      // 正常推进
    }
  }

  /** 每帧/每秒调用：处理超时与倒计时文字 */
  function tick(t) {
    if (!round || !host) return;
    const timerEl = host.querySelector('[data-live="matrix-timer"]');
    if (remainingMs(round, t) !== Infinity) {
      const ms = remainingMs(round, t);
      if (timerEl) timerEl.textContent = `${Math.ceil(ms / 1000)}s`;
      const next = checkTimeout(round, t);
      if (next !== round) {
        round = next;
        const body = host.querySelector('[data-matrix-body]');
        if (body) body.innerHTML = `<p class="matrix-fail-note">超时了，重开一局。</p>`;
        clearRestart();
        restartTimer = setTimeout(() => resetRound(''), 1200);
      }
    }
  }

  return {
    open,
    close,
    html,
    mount,
    handleCell,
    tick,
    get isOpen() {
      return opened;
    },
    get round() {
      return round;
    },
  };
}
