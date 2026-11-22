/**
 * ui/views/result.js —— 结算：成功（开心 + 收花）/ 离开（哭泣）/ 提前结束
 */
import { esc, humanMs, foxArt, flowerArt, fmtClock } from '../dom.js';
import { FLOWER_MAP, RARITY_META } from '../../core/collection.js';

const TITLES = {
  success: '坚持到底！',
  left: '小狐狸哭了…',
  aborted: '本次提前结束',
};

const SUBS = {
  success: '你把整段时间守住了。小狐狸背着收集袋回来，还带回了一朵花。',
  left: '限制期间你离开过，收集的前功尽弃。下一次试试把手机放远一点。',
  aborted: '你长按跳过了这次限制，所以没有花朵 —— 但这一段不会再锁你，下一段照常。',
};

export function resultView(ctx) {
  const r = ctx.state.result;
  if (!r) return '';
  const success = r.outcome === 'success';
  const kind = success ? 'happy' : r.outcome === 'left' ? 'sad' : 'collect';
  const reward = r.reward ? FLOWER_MAP.get(r.reward.flowerId) : null;
  const rarity = reward ? RARITY_META[reward.rarity] : null;

  return `<div class="layer result-layer ${success ? '' : 'bad'}">
    <div class="result-inner">
      ${foxArt(kind, { assets: ctx.assets, cls: 'result-fox', alt: success ? '开心的小狐狸' : '难过的小狐狸' })}
      <h2 class="result-title">${TITLES[r.outcome] || '本次结束'}</h2>
      <p class="result-sub">${SUBS[r.outcome] || ''}</p>

      ${
        reward
          ? `<div class="reward-card">
              ${flowerArt(reward, { size: 56 })}
              <div class="rw-main">
                <div class="rw-name">${esc(reward.name)} <span class="tiny">${rarity.label} · 花语「${esc(reward.language)}」</span>${
                  r.reward.isNewSpecies ? ' <span class="pill-soft ok">首次发现</span>' : ''
                }</div>
                <div class="rw-desc">${esc(reward.desc)}</div>
                <div class="rw-desc">连续 ${r.reward.streakDays} 天。</div>
              </div>
            </div>`
          : ''
      }

      <div class="result-stats">
        <div class="rs-item"><div class="k">时长</div><div class="v">${esc(humanMs(r.durationMs))}</div></div>
        <div class="rs-item"><div class="k">任务</div><div class="v">${r.tasksDone}/${r.tasksTotal || 0}</div></div>
        <div class="rs-item"><div class="k">收集</div><div class="v">${r.feathers}🪶 ${r.flowers}🌸</div></div>
      </div>

      ${
        r.restUsedMs > 0
          ? `<p class="tiny">这次用掉了 ${esc(humanMs(r.restUsedMs))} 休息时间。</p>`
          : ''
      }
      ${
        r.interrupts > 0
          ? `<p class="tiny">期间因重要消息暂停了 ${r.interrupts} 次，共 ${esc(humanMs(r.pausedMs))}（结束时间已顺延）。</p>`
          : ''
      }
      ${
        r.outcome === 'left' && r.leaves?.length
          ? `<p class="tiny">共离开 ${r.leaves.length} 次，最后一次在 ${esc(fmtClock(r.leaves[r.leaves.length - 1].at))}。</p>`
          : ''
      }

      <button class="btn primary block" data-act="result-ack">收下</button>
      <button class="btn ghost block" data-act="result-collection">看看收藏册</button>
    </div>
  </div>`;
}
