import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyCollection,
  normalizeCollection,
  pickFlower,
  recordSuccess,
  recordFailure,
  collectionStats,
  collectionView,
  toDateKey,
  FLOWERS,
  FLOWER_MAP,
  RARITY_META,
} from '../src/core/collection.js';
import { summarizeHistory, dailyBuckets, recentRecords } from '../src/core/stats.js';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const rngFrom = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test('每种花都有花语和一句由来', () => {
  const expected = {
    rose: ['真爱', '小狐狸穿过荆棘，寻得热烈真心一朵。'],
    daisy: ['纯真', '小狐狸俯身草间，拾起纯真的欢喜。'],
    lavender: ['等待与思念', '小狐狸循着紫香，等到思念开花。'],
    periwinkle: ['永恒青春', '小狐狸寻回旧时光，青春永不褪去。'],
    sunflower: ['仰望与忠诚', '小狐狸追着暖阳，找到仰望的温柔。'],
    lily: ['纯洁祝福', '小狐狸拨开叶丛，捧出纯洁的祝愿。'],
    hydrangea: ['团圆美满', '小狐狸抱住圆满，团团簇簇皆欢喜。'],
    clover: ['幸运', '小狐狸找遍草地，终遇那份幸运。'],
    'apple-blossom': ['温柔甜美', '小狐狸踮起脚尖，摘下甜美的温柔。'],
  };
  for (const f of FLOWERS) {
    assert.ok(f.language && f.language.length <= 8, `${f.id} 缺花语`);
    assert.ok(f.desc && f.desc.startsWith('小狐狸'), `${f.id} 缺由来`);
    if (expected[f.id]) {
      assert.equal(f.language, expected[f.id][0], `${f.id} 花语不对`);
      assert.equal(f.desc, expected[f.id][1], `${f.id} 由来不对`);
    }
  }
  assert.equal(Object.keys(expected).length, FLOWERS.length, '不要漏掉任何一种花');
});

test('collectionView 把花语和由来一起传给界面', () => {
  const view = collectionView(normalizeCollection({ flowers: { rose: { count: 1, firstAt: 1 } } }));
  const rose = view.find((f) => f.id === 'rose');
  assert.equal(rose.language, '真爱');
  assert.ok(rose.desc.includes('荆棘'));
  assert.equal(rose.owned, true);
});

test('星级按需求配置：雏菊/向日葵/长春花=1，百合/绣球/薰衣草=2，玫瑰/苹果花=3，四叶草=4', () => {
  const stars = (id) => RARITY_META[FLOWER_MAP.get(id).rarity].stars;
  assert.equal(FLOWERS.length, 9);
  for (const id of ['daisy', 'sunflower', 'periwinkle']) assert.equal(stars(id), 1, `${id} 应为一星`);
  for (const id of ['lily', 'hydrangea', 'lavender']) assert.equal(stars(id), 2, `${id} 应为二星`);
  for (const id of ['rose', 'apple-blossom']) assert.equal(stars(id), 3, `${id} 应为三星`);
  assert.equal(stars('clover'), 4, '四叶草应为四星');
  // 每个花种都要有插画文件，且文件名是 ascii
  for (const f of FLOWERS) {
    assert.match(f.image, /^[a-z-]+\.png$/, `${f.id} 的插画名不对：${f.image}`);
  }
  // 星级越高越难抽：一星总权重应明显大于四星
  const w = (rarity) => FLOWERS.filter((f) => f.rarity === rarity).reduce((s, f) => s + f.weight, 0);
  assert.ok(w('common') > w('rare') * 1.5);
  assert.ok(w('rare') > w('epic'));
  assert.ok(w('epic') > w('legend') * 3);
});

test('pickFlower 按权重抽取且总能返回合法对象', () => {
  assert.equal(pickFlower(rngFrom([0])).id, 'daisy');
  assert.equal(pickFlower(rngFrom([0.999999])).id, 'clover');
  for (let i = 0; i < 200; i += 1) {
    const f = pickFlower(Math.random);
    assert.ok(FLOWERS.includes(f));
  }
});

test('pickFlower 分布：常见远多于传说', () => {
  let common = 0;
  let legend = 0;
  for (let i = 0; i < 5000; i += 1) {
    const f = pickFlower(Math.random);
    if (f.rarity === 'common') common += 1;
    if (f.rarity === 'legend') legend += 1;
  }
  assert.ok(common > legend * 20, `common=${common} legend=${legend}`);
});

test('首次成功：连续天数 1，收藏 +1', () => {
  const { collection, flower, isNewSpecies, streakDays } = recordSuccess(emptyCollection(), {
    now: at(2026, 11, 21, 23, 0),
    rng: rngFrom([0]),
    feathers: 7,
  });
  assert.equal(streakDays, 1);
  assert.equal(isNewSpecies, true);
  assert.equal(flower.id, 'daisy');
  assert.equal(collection.flowers.daisy.count, 1);
  assert.equal(collection.feathers, 7);
  assert.equal(collection.successes, 1);
  assert.equal(collection.lastSuccessDate, '2026-11-21');
});

test('连续两天成功 → streak=2；隔天断签 → 重置为 1', () => {
  const day1 = recordSuccess(emptyCollection(), { now: at(2026, 11, 21, 23, 0), rng: rngFrom([0]) });
  const day2 = recordSuccess(day1.collection, { now: at(2026, 11, 22, 23, 0), rng: rngFrom([0.1]) });
  assert.equal(day2.streakDays, 2);
  assert.equal(day2.collection.bestStreak, 2);
  const day5 = recordSuccess(day2.collection, { now: at(2026, 11, 25, 23, 0), rng: rngFrom([0.2]) });
  assert.equal(day5.streakDays, 1);
  assert.equal(day5.collection.bestStreak, 2);
});

test('同一天两次成功不重复累加连续天数', () => {
  const a = recordSuccess(emptyCollection(), { now: at(2026, 11, 21, 1, 0), rng: rngFrom([0]) });
  const b = recordSuccess(a.collection, { now: at(2026, 11, 21, 23, 0), rng: rngFrom([0.3]) });
  assert.equal(b.streakDays, 1);
  assert.equal(b.collection.successes, 2);
});

test('同种花重复收集累加计数，异种花标记为新', () => {
  const a = recordSuccess(emptyCollection(), { now: at(2026, 11, 21, 23, 0), rng: rngFrom([0]) });
  const b = recordSuccess(a.collection, { now: at(2026, 11, 22, 23, 0), rng: rngFrom([0]) });
  assert.equal(b.isNewSpecies, false);
  assert.equal(b.collection.flowers.daisy.count, 2);
});

test('recordFailure 只加失败次数', () => {
  const col = recordFailure(emptyCollection());
  assert.equal(col.failures, 1);
  assert.equal(col.successes, 0);
});

test('老版本花种会迁移到新图鉴，不会凭空消失', () => {
  const col = normalizeCollection({
    flowers: {
      cosmos: { count: 3, firstAt: 100, lastAt: 200 },
      aurora: { count: 1, firstAt: 300, lastAt: 400 },
      starlily: { count: 2, firstAt: 500, lastAt: 600 },
      daisy: { count: 1, firstAt: 700, lastAt: 800 },
      unknown: { count: 9 },
    },
  });
  assert.equal(col.flowers.lily.count, 3, 'cosmos → 百合');
  assert.equal(col.flowers.lily.firstAt, 100);
  assert.equal(col.flowers.clover.count, 1, 'aurora → 四叶草');
  assert.equal(col.flowers.rose.count, 2, 'starlily → 玫瑰');
  assert.equal(col.flowers.daisy.count, 1);
  assert.equal(Object.keys(col.flowers).length, 4, '未知花种被丢弃');
});

test('normalizeCollection 丢弃未知花种与脏数据', () => {
  const col = normalizeCollection({
    flowers: { daisy: { count: 2 }, unknown: { count: 5 }, clover: null },
    feathers: -3,
    streakDays: 'x',
  });
  assert.deepEqual(Object.keys(col.flowers), ['daisy']);
  assert.equal(col.feathers, 0);
  assert.equal(col.streakDays, 0);
  assert.equal(normalizeCollection(null).successes, 0);
});

test('collectionStats 与 collectionView', () => {
  let col = emptyCollection();
  col = recordSuccess(col, { now: at(2026, 11, 21, 23, 0), rng: rngFrom([0]) }).collection;
  col = recordSuccess(col, { now: at(2026, 11, 22, 23, 0), rng: rngFrom([0.999999]) }).collection;
  const stats = collectionStats(col);
  assert.equal(stats.totalFlowers, 2);
  assert.equal(stats.distinctSpecies, 2);
  assert.equal(stats.speciesTotal, FLOWERS.length);
  assert.equal(stats.byRarity.legend, 1);
  const view = collectionView(col);
  assert.equal(view.length, FLOWERS.length);
  assert.equal(view.find((f) => f.id === 'clover').owned, true);
  assert.equal(view.find((f) => f.id === 'rose').owned, false);
});

test('toDateKey 用本地日期', () => {
  assert.equal(toDateKey(at(2026, 11, 5, 0, 5)), '2026-11-05');
});

test('summarizeHistory 统计成功率并忽略演练记录', () => {
  const now = at(2026, 11, 22, 12, 0);
  const history = [
    { endedAt: at(2026, 11, 21, 7, 0), startedAt: at(2026, 11, 20, 22, 30), outcome: 'success', restUsedMs: 600000, feathers: 12, tasksDone: 3, tasksTotal: 3, date: '2026-11-21' },
    { endedAt: at(2026, 11, 20, 7, 0), startedAt: at(2026, 11, 19, 22, 30), outcome: 'left', feathers: 3, tasksDone: 1, tasksTotal: 3, date: '2026-11-20' },
    { endedAt: at(2026, 11, 19, 7, 0), startedAt: at(2026, 11, 18, 22, 30), outcome: 'aborted', date: '2026-11-19' },
    { endedAt: at(2026, 11, 21, 7, 0), outcome: 'success', preview: true, date: '2026-11-21' },
  ];
  const s = summarizeHistory(history, now, 7);
  assert.equal(s.total, 3);
  assert.equal(s.success, 1);
  assert.equal(s.left, 1);
  assert.equal(s.aborted, 1);
  assert.equal(s.successRate, 50);
  assert.equal(s.restMs, 600000);
  assert.equal(s.avgTaskCompletion, 67);
  assert.equal(s.buckets.length, 7);
});

test('dailyBuckets 按天归集且包含最近 7 天', () => {
  const now = at(2026, 11, 22, 12, 0);
  const buckets = dailyBuckets(
    [
      { endedAt: at(2026, 11, 22, 7, 0), outcome: 'success' },
      { endedAt: at(2026, 11, 21, 7, 0), outcome: 'left' },
    ],
    now,
    7,
  );
  assert.equal(buckets.length, 7);
  assert.equal(buckets.at(-1).dateKey, '2026-11-22');
  assert.equal(buckets.at(-1).success, 1);
  assert.equal(buckets.at(-2).left, 1);
});

test('recentRecords 倒序并排除演练', () => {
  const list = recentRecords(
    [
      { endedAt: 100, outcome: 'success' },
      { endedAt: 300, outcome: 'left' },
      { endedAt: 400, outcome: 'success', preview: true },
    ],
    5,
  );
  assert.equal(list.length, 2);
  assert.equal(list[0].endedAt, 300);
});

test('空历史不崩溃', () => {
  const s = summarizeHistory([], at(2026, 11, 22), 7);
  assert.equal(s.total, 0);
  assert.equal(s.successRate, null);
  assert.equal(s.avgTaskCompletion, null);
});
