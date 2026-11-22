/**
 * ui/dom.js —— 极小的字符串模板工具 + 图形素材。
 * 不引入框架：所有视图都返回 HTML 字符串，由 app.js 统一替换。
 */

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const pad = (n) => String(n).padStart(2, '0');

/** 倒计时 hh:mm:ss */
export function fmtCountdown(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDay(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`;
}

export function humanMs(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 60000));
  if (total < 60) return `${total} 分钟`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function sessionRange(startAt, endAt) {
  const sameDay = new Date(startAt).toDateString() === new Date(endAt).toDateString();
  return `${fmtClock(startAt)} – ${sameDay ? '' : '次日 '}${fmtClock(endAt)}`;
}

/**
 * 花朵图标：优先用上传的真实插画（assets/flowers/*.png），
 * 单文件版会通过 window.__FLOWER_ASSETS 注入 data URI；
 * 万一图片缺失，退回代码绘制的小花，功能不受影响。
 */
export function flowerArt(species, { size = 64, dim = false } = {}) {
  const inline = typeof window !== 'undefined' ? window.__FLOWER_ASSETS : null;
  const src = (inline && species?.id && inline[species.id]) || (species?.image ? `assets/flowers/${species.image}` : null);
  const alt = esc(species?.name || '花');
  if (src) {
    const dimStyle = dim ? 'filter:grayscale(1) brightness(.6);opacity:.55;' : '';
    return `<img class="flower-art" src="${src}" width="${size}" height="${size}" alt="${alt}" draggable="false" loading="lazy" style="${dimStyle}" />`;
  }
  const color = species?.color || '#c9c2d8';
  const petals = species?.rarity === 'legend' ? 8 : species?.rarity === 'epic' ? 6 : 5;
  const piece = 360 / petals;
  const shapes = Array.from({ length: petals }, (_, i) => {
    const rotate = i * piece;
    return `<ellipse cx="24" cy="13.5" rx="7.2" ry="10.5" transform="rotate(${rotate} 24 24)" fill="${color}" opacity="0.92"/>`;
  }).join('');
  const center = species?.rarity === 'legend' ? '#ffe9a3' : '#ffd479';
  return `<svg class="flower-art" width="${size}" height="${size}" viewBox="0 0 48 48" role="img" aria-label="${alt}" style="${
    dim ? 'filter:grayscale(1) brightness(.6);opacity:.55' : ''
  }">
    <g>${shapes}<circle cx="24" cy="24" r="5.1" fill="${center}"/><circle cx="24" cy="24" r="2.1" fill="#b97a2c" opacity=".55"/></g>
  </svg>`;
}

/** 狐狸立绘：优先用内联资源（单文件版），其次工作区 PNG，最后 emoji 兜底 */
export function foxArt(kind, { assets, cls = 'fox-figure', alt = '小狐狸', emojiSize = 92 } = {}) {
  const map = { collect: 'fox-collect.png', happy: 'fox-happy.png', sad: 'fox-sad.png' };
  const inline = typeof window !== 'undefined' ? window.__FOX_ASSETS : null;
  const src = inline?.[kind] || (assets && assets.ready ? `assets/fox/${map[kind] || map.collect}` : null);
  if (src) {
    return `<img class="${cls}" src="${src}" alt="${esc(alt)}" draggable="false" />`;
  }
  const emoji = kind === 'happy' ? '🦊' : kind === 'sad' ? '🥺' : '🦊';
  const anim = kind === 'happy' ? 'fox-hop' : kind === 'sad' ? 'fox-tremble' : 'fox-breathe';
  return `<div class="${cls}" style="animation:${anim} 2.6s var(--ease) infinite;font-size:${emojiSize}px;text-align:center;line-height:1.1" role="img" aria-label="${esc(alt)}">${emoji}</div>`;
}

export function toggleSwitch({ pressed, act, path, label, disabled = false }) {
  return `<button class="switch" type="button" role="switch" aria-checked="${pressed ? 'true' : 'false'}"
    aria-pressed="${pressed ? 'true' : 'false'}" aria-label="${esc(label || '')}" ${disabled ? 'disabled' : ''}
    data-act="${act}" data-path="${esc(path || '')}"></button>`;
}

export function stepper({ value, path, min, max, step = 1, unit = '', label = '' }) {
  return `<div class="stepper" role="group" aria-label="${esc(label)}">
    <button type="button" data-act="step" data-path="${esc(path)}" data-delta="-${step}" data-min="${min}" data-max="${max}" data-step="${step}" aria-label="减少">−</button>
    <span class="value" data-live="step-value" data-path="${esc(path)}">${value}${unit}</span>
    <button type="button" data-act="step" data-path="${esc(path)}" data-delta="${step}" data-min="${min}" data-max="${max}" data-step="${step}" aria-label="增加">+</button>
  </div>`;
}

export function segmented({ value, path, options, label = '', act = 'segment' }) {
  return `<div class="segmented" role="group" aria-label="${esc(label)}">
    ${options
      .map(
        (opt) =>
          `<button type="button" data-act="${esc(act)}" data-path="${esc(path || '')}" data-level="${esc(opt.value)}" data-value="${esc(opt.value)}" aria-pressed="${String(opt.value) === String(value)}">${esc(opt.label)}</button>`,
      )
      .join('')}
  </div>`;
}

export function row({ title, desc, control, sub }) {
  return `<div class="row">
    <div class="row-main">
      <div class="row-title">${esc(title)}${sub ? ` <span class="tiny">${esc(sub)}</span>` : ''}</div>
      ${desc ? `<div class="row-desc">${esc(desc)}</div>` : ''}
    </div>
    ${control || ''}
  </div>`;
}
