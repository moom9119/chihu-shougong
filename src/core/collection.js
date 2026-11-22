/**
 * collection.js —— 花朵图鉴、稀有度抽取、连续天数。
 *
 * 规则：每成功坚持完一次限制 → 收获一朵花（按稀有度权重抽取）+ 刷新连续天数。
 * 失败 / 主动关闭 不发花，也不打断连续天数（只按"最近一次成功日期"计算）。
 */
import { DAY } from './clock.js';
import { startOfLocalDay } from './schedule.js';

export const RARITY_META = {
  common: { label: '一星', stars: 1, color: '#9fd7b6', weightText: '容易遇见' },
  rare: { label: '二星', stars: 2, color: '#8fb8ff', weightText: '偶尔遇见' },
  epic: { label: '三星', stars: 3, color: '#c4a6ff', weightText: '不太好遇见' },
  legend: { label: '四星', stars: 4, color: '#ffd479', weightText: '很难遇见' },
};

/**
 * 图鉴：花名 / 星级 / 抽取权重 / 插画文件 / 花语 / 介绍语。
 * 插画放在 assets/flowers/，单文件版打包时会内联成 data URI。
 */
export const FLOWERS = [
  {
    id: 'daisy',
    name: '小雏菊',
    rarity: 'common',
    weight: 16,
    color: '#f7f1d0',
    image: 'daisy.png',
    language: '纯真',
    desc: '小狐狸俯身草间，拾起纯真的欢喜。',
  },
  {
    id: 'sunflower',
    name: '向日葵',
    rarity: 'common',
    weight: 15,
    color: '#ffd23f',
    image: 'sunflower.png',
    language: '仰望与忠诚',
    desc: '小狐狸追着暖阳，找到仰望的温柔。',
  },
  {
    id: 'periwinkle',
    name: '长春花',
    rarity: 'common',
    weight: 15,
    color: '#d9b8f0',
    image: 'periwinkle.png',
    language: '永恒青春',
    desc: '小狐狸寻回旧时光，青春永不褪去。',
  },
  {
    id: 'lily',
    name: '百合',
    rarity: 'rare',
    weight: 10,
    color: '#f7d9dc',
    image: 'lily.png',
    language: '纯洁祝福',
    desc: '小狐狸拨开叶丛，捧出纯洁的祝愿。',
  },
  {
    id: 'hydrangea',
    name: '绣球花',
    rarity: 'rare',
    weight: 9,
    color: '#b9a7e8',
    image: 'hydrangea.png',
    language: '团圆美满',
    desc: '小狐狸抱住圆满，团团簇簇皆欢喜。',
  },
  {
    id: 'lavender',
    name: '薰衣草',
    rarity: 'rare',
    weight: 9,
    color: '#b9a2e0',
    image: 'lavender.png',
    language: '等待与思念',
    desc: '小狐狸循着紫香，等到思念开花。',
  },
  {
    id: 'rose',
    name: '玫瑰',
    rarity: 'epic',
    weight: 6,
    color: '#e8436f',
    image: 'rose.png',
    language: '真爱',
    desc: '小狐狸穿过荆棘，寻得热烈真心一朵。',
  },
  {
    id: 'apple-blossom',
    name: '苹果花',
    rarity: 'epic',
    weight: 5,
    color: '#f6b7c4',
    image: 'apple-blossom.png',
    language: '温柔甜美',
    desc: '小狐狸踮起脚尖，摘下甜美的温柔。',
  },
  {
    id: 'clover',
    name: '四叶草',
    rarity: 'legend',
    weight: 1,
    color: '#6fae4f',
    image: 'clover.png',
    language: '幸运',
    desc: '小狐狸找遍草地，终遇那份幸运。',
  },
];

export const FLOWER_MAP = new Map(FLOWERS.map((f) => [f.id, f]));

export function emptyCollection() {
  return {
    flowers: {}, // speciesId -> {count, firstAt, lastAt}
    feathers: 0,
    successes: 0,
    failures: 0,
    streakDays: 0,
    bestStreak: 0,
    lastSuccessDate: null,
    firstAt: null,
  };
}

/**
 * 老版本的 9 种花（改版前）→ 新版对应花种，避免升级后收藏凭空消失。
 * 找不到对应的（比如当时没有的）就直接丢弃。
 */
const LEGACY_FLOWERS = {
  buttercup: 'sunflower',
  cosmos: 'lily',
  poppy: 'hydrangea',
  moonflower: 'apple-blossom',
  starlily: 'rose',
  aurora: 'clover',
};

export function normalizeCollection(raw) {
  const base = emptyCollection();
  if (!raw || typeof raw !== 'object') return base;
  const out = { ...base };
  if (raw.flowers && typeof raw.flowers === 'object') {
    for (const [id, val] of Object.entries(raw.flowers)) {
      if (!val) continue;
      const targetId = FLOWER_MAP.has(id) ? id : LEGACY_FLOWERS[id];
      if (!targetId || !FLOWER_MAP.has(targetId)) continue;
      const count = Math.max(0, Math.floor(Number(val.count) || 0));
      const prev = out.flowers[targetId];
      const firstAt = prev?.firstAt ?? (Number.isFinite(val.firstAt) ? val.firstAt : null);
      const lastAt = Math.max(prev?.lastAt ?? 0, Number.isFinite(val.lastAt) ? val.lastAt : 0) || null;
      out.flowers[targetId] = { count: (prev?.count ?? 0) + count, firstAt, lastAt };
    }
  }
  for (const key of ['feathers', 'successes', 'failures', 'streakDays', 'bestStreak']) {
    out[key] = Math.max(0, Math.floor(Number(raw[key]) || 0));
  }
  out.lastSuccessDate = typeof raw.lastSuccessDate === 'string' ? raw.lastSuccessDate : null;
  out.firstAt = Number.isFinite(raw.firstAt) ? raw.firstAt : null;
  return out;
}

export function toDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function pickFlower(rng = Math.random) {
  const total = FLOWERS.reduce((sum, f) => sum + f.weight, 0);
  let roll = rng() * total;
  for (const f of FLOWERS) {
    roll -= f.weight;
    if (roll <= 0) return f;
  }
  return FLOWERS[0];
}

/**
 * 记录一次"坚持成功"。
 * @returns {{collection: object, flower: object, isNewSpecies: boolean, streakDays: number}}
 */
export function recordSuccess(collection, { now, rng = Math.random, feathers = 0 }) {
  const col = normalizeCollection(collection);
  const flower = pickFlower(rng);
  const today = toDateKey(now);

  // 连续天数：昨天成功过 → +1；今天已经成功过 → 不重复加；否则重置为 1
  let streakDays = col.streakDays;
  if (col.lastSuccessDate !== today) {
    const lastMs = col.lastSuccessDate ? new Date(`${col.lastSuccessDate}T00:00:00`).getTime() : null;
    const todayStart = startOfLocalDay(now);
    const gapDays = lastMs == null ? Infinity : Math.round((todayStart - startOfLocalDay(lastMs)) / DAY);
    streakDays = gapDays === 1 ? col.streakDays + 1 : 1;
  }

  const prev = col.flowers[flower.id];
  const isNewSpecies = !prev;
  const next = {
    ...col,
    flowers: {
      ...col.flowers,
      [flower.id]: {
        count: (prev?.count ?? 0) + 1,
        firstAt: prev?.firstAt ?? now,
        lastAt: now,
      },
    },
    feathers: col.feathers + Math.max(0, Math.floor(feathers)),
    successes: col.successes + 1,
    streakDays,
    bestStreak: Math.max(col.bestStreak, streakDays),
    lastSuccessDate: today,
    firstAt: col.firstAt ?? now,
  };
  return { collection: next, flower, isNewSpecies, streakDays };
}

export function recordFailure(collection) {
  const col = normalizeCollection(collection);
  return { ...col, failures: col.failures + 1 };
}

export function collectionStats(collection) {
  const col = normalizeCollection(collection);
  const species = Object.keys(col.flowers);
  const byRarity = { common: 0, rare: 0, epic: 0, legend: 0 };
  let total = 0;
  for (const [id, val] of Object.entries(col.flowers)) {
    const f = FLOWER_MAP.get(id);
    if (!f) continue;
    byRarity[f.rarity] += val.count;
    total += val.count;
  }
  return {
    totalFlowers: total,
    distinctSpecies: species.length,
    speciesTotal: FLOWERS.length,
    byRarity,
    feathers: col.feathers,
    successes: col.successes,
    failures: col.failures,
    streakDays: col.streakDays,
    bestStreak: col.bestStreak,
  };
}

/** 图鉴列表（含水合未获得的） */
export function collectionView(collection) {
  const col = normalizeCollection(collection);
  return FLOWERS.map((f) => ({
    ...f,
    rarityLabel: RARITY_META[f.rarity].label,
    stars: RARITY_META[f.rarity].stars,
    count: col.flowers[f.id]?.count ?? 0,
    firstAt: col.flowers[f.id]?.firstAt ?? null,
    owned: Boolean(col.flowers[f.id]),
  }));
}
