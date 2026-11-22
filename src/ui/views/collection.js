/**
 * ui/views/collection.js —— 花朵收藏册
 */
import { esc, flowerArt, humanMs, fmtDay } from '../dom.js';
import { collectionStats, collectionView, RARITY_META } from '../../core/collection.js';

export function collectionViewPage(ctx) {
  const view = collectionView(ctx.collection);
  const stats = collectionStats(ctx.collection);
  const detail = view.find((f) => f.id === ctx.ui?.flowerDetail) || null;

  return `<div class="page-inner">
    <div class="streak-banner">
      <div>
        <div class="streak-num">${stats.streakDays}</div>
        <div class="tiny">连续天数</div>
      </div>
      <div>
        <p style="font-size:13.5px;font-weight:600">小狐狸的收集袋</p>
        <p class="tiny" style="margin-top:3px">
          最长连续 ${stats.bestStreak} 天 · 共成功 ${stats.successes} 次 · 失败 ${stats.failures} 次
        </p>
      </div>
    </div>

    ${
      detail
        ? `<section class="card flower-detail">
            <div class="fd-head">
              ${flowerArt(detail, { size: 96, dim: !detail.owned })}
              <div class="fd-main">
                <h3>${detail.owned ? esc(detail.name) : '？？？'}</h3>
                <p class="fd-lang">花语 · ${detail.owned ? esc(detail.language) : '尚未相遇'}</p>
                <p class="fd-stars">${'★'.repeat(detail.stars)}<span class="tiny"> ${RARITY_META[detail.rarity].label}</span></p>
              </div>
              <button class="icon-btn" type="button" data-act="flower-close" aria-label="收起">×</button>
            </div>
            <p class="fd-poem">${detail.owned ? esc(detail.desc) : '坚持完一次限制，小狐狸也许就会把它带回来。'}</p>
            ${
              detail.owned
                ? `<p class="tiny">已收集 ×${detail.count}${detail.firstAt ? ` · 首次获得 ${esc(fmtDay(detail.firstAt))}` : ''}</p>`
                : ''
            }
          </section>`
        : ''
    }

    <section class="card">
      <div class="card-head">
        <h3>图鉴</h3>
        <span class="sub">${stats.distinctSpecies}/${stats.speciesTotal} 种 · 共 ${stats.totalFlowers} 朵</span>
      </div>
      <div class="flower-grid">
        ${view
          .map(
            (f) => `<button type="button" class="flower ${f.owned ? 'owned' : 'locked'}" data-act="flower-detail" data-id="${esc(f.id)}"
              aria-label="${f.owned ? `${esc(f.name)}，花语${esc(f.language)}` : '尚未获得'}">
              <span class="flower-badge">${'★'.repeat(f.stars)}</span>
              ${flowerArt(f, { size: 40, dim: !f.owned })}
              <div class="flower-name">${f.owned ? esc(f.name) : '？？？'}</div>
              <div class="flower-lang">${f.owned ? esc(f.language) : RARITY_META[f.rarity].label}</div>
              ${f.owned ? `<div class="flower-meta">×${f.count}</div>` : ''}
            </button>`,
          )
          .join('')}
      </div>
      <p class="tiny" style="margin-top:10px">点任意一朵，看它的花语与小狐狸的由来。</p>
    </section>

    <section class="card">
      <div class="card-head"><h3>收获明细</h3></div>
      <div class="stat-grid">
        <div class="stat"><div class="k">羽毛</div><div class="v">${stats.feathers}</div></div>
        <div class="stat"><div class="k">花朵</div><div class="v">${stats.totalFlowers}</div></div>
        <div class="stat"><div class="k">最长连续</div><div class="v">${stats.bestStreak}<small> 天</small></div></div>
      </div>
      <div class="divider"></div>
      ${
        stats.totalFlowers
          ? `<p class="tiny">最近一次收获：${esc(
              view
                .filter((f) => f.owned && f.firstAt)
                .sort((a, b) => (b.firstAt || 0) - (a.firstAt || 0))
                .map((f) => `${f.name}`)[0] || '—',
            )}</p>`
          : `<p class="tiny">还没有收获。坚持完一次完整的限制，小狐狸就会带回一朵花。</p>`
      }
    </section>

    <section class="card">
      <div class="hint">
        花朵按稀有度抽取：常见 > 少见 > 稀有 > 传说。中途离开、提前结束都拿不到花，<br />
        所以每天坚持的那一段时间，才是真正的收藏来源。
      </div>
      <button class="btn ghost block" style="margin-top:12px" data-act="nav" data-view="home">回到首页</button>
    </section>
  </div>`;
}
