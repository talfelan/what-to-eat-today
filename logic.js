/**
 * logic.js —— 纯逻辑层（只做计算，不碰页面）
 *
 * 为什么单独拆一个文件？
 *   1) 页面（app.js）和自动测试（tests/run-tests.mjs）可以共用同一份逻辑，不会出现
 *      "测试的和页面跑的不是同一套代码"；
 *   2) 这些函数不依赖浏览器，所以可以在命令行里直接跑断言，改逻辑后能立刻知道有没有改坏。
 *
 * 约定：所有函数都是"进来什么、出去什么"，不改动传入的数组和对象。
 */

import { SPICY_LABELS } from './data.js';

/**
 * 把用户的选择整理成标准格式，缺项用默认值补上。
 * 默认 = 什么都不限制。
 *
 * 注意：这里不能写成 normalizeCriteria(input = {}) —— JS 的默认参数只在实参是
 * undefined 时生效，传 null 会直接进函数体然后报错。而浏览器 localStorage 里如果
 * 存过 "null"，读出来就是 null，页面上来就会崩。所以先显式判一次。
 */
export function normalizeCriteria(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    maxPrice: Number.isFinite(source.maxPrice) ? Math.max(0, source.maxPrice) : 0, // 0 = 不限预算
    maxSpicy: Number.isFinite(source.maxSpicy) ? Math.min(3, Math.max(0, source.maxSpicy)) : 3, // 3 = 不限辣度
    place: typeof source.place === 'string' && source.place ? source.place : 'all', // 'all' = 不限地点
  };
}

/** 按「预算 + 辣度上限 + 地点」筛选餐品，返回新数组 */
export function filterDishes(dishes, criteria) {
  if (!Array.isArray(dishes)) return [];
  const { maxPrice, maxSpicy, place } = normalizeCriteria(criteria);
  return dishes.filter((dish) => {
    if (maxPrice > 0 && dish.price > maxPrice) return false;
    if (maxSpicy < 3 && dish.spicyLevel > maxSpicy) return false;
    if (place !== 'all' && dish.place !== place) return false;
    return true;
  });
}

/** 数据里一共出现过哪些地点（给页面生成地点按钮用，保证不会写错地点名） */
export function uniquePlaces(dishes) {
  if (!Array.isArray(dishes)) return [];
  return [...new Set(dishes.map((d) => d.place))];
}

/**
 * 从候选里随机抽一道。
 * - recentIds：最近推荐过的餐品 id，优先避开它们（对应作业的"进阶挑战"）
 * - random：随机数函数，默认 Math.random；测试时可以换成固定序列，让结果可复现
 *
 * 返回 { dish, reason, repeated }
 *   reason = 'ok'      正常抽到（且不是最近推荐过的）
 *   reason = 'repeated' 候选全都被最近推荐过了，只能重复推荐
 *   reason = 'empty'    一条候选都没有
 */
export function pickDish(candidates, recentIds = [], random = Math.random) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { dish: null, reason: 'empty', repeated: false };
  }
  const recent = new Set(recentIds);
  const fresh = candidates.filter((d) => !recent.has(d.id));
  const pool = fresh.length > 0 ? fresh : candidates;

  // 用 Math.floor 取整；万一 random() 返回 1（理论上不会），取模兜底，保证不会越界
  const raw = Math.floor(Number(random()) * pool.length);
  const index = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), pool.length - 1) : 0;

  return {
    dish: pool[index],
    reason: fresh.length > 0 ? 'ok' : 'repeated',
    repeated: fresh.length === 0,
  };
}

/** 把筛选条件翻译成一句人话，例如：预算 16 元内 · 最多中辣 · 一食堂 */
export function describeCriteria(criteria) {
  const { maxPrice, maxSpicy, place } = normalizeCriteria(criteria);
  const priceText = maxPrice > 0 ? `预算 ${maxPrice} 元内` : '预算不限';
  const spicyText = maxSpicy >= 3 ? '辣度不限' : `最多${SPICY_LABELS[maxSpicy]}`;
  const placeText = place === 'all' ? '地点不限' : place;
  return `${priceText} · ${spicyText} · ${placeText}`;
}

/** 生成数组的全部组合（只在 suggestRelaxation 内部用） */
function combinations(items, size) {
  if (size === 0) return [[]];
  if (size > items.length) return [];
  const result = [];
  items.forEach((item, index) => {
    const rest = combinations(items.slice(index + 1), size - 1);
    rest.forEach((combo) => result.push([item, ...combo]));
  });
  return result;
}

/**
 * 一条候选都没有的时候，帮用户找"最少要放宽几个条件、放宽哪些"。
 *
 * 做法：把可以放宽的条件（预算 / 辣度 / 地点）列出所有组合，从放宽 1 个开始试，
 * 找到第一个能抽出餐品的组合就返回它。这样提示不会瞎给，比如"预算太低"这句话
 * 只有真的放宽预算就有效时才会说出口。
 *
 * 返回 { found, criteria, texts, count }
 */
export function suggestRelaxation(dishes, criteria) {
  const base = normalizeCriteria(criteria);
  const relaxers = [];
  if (base.maxPrice > 0) {
    relaxers.push({ text: '把预算改成「不限」', apply: (c) => ({ ...c, maxPrice: 0 }) });
  }
  if (base.maxSpicy < 3) {
    relaxers.push({ text: '把辣度改成「都能吃」', apply: (c) => ({ ...c, maxSpicy: 3 }) });
  }
  if (base.place !== 'all') {
    relaxers.push({ text: '把地点改成「不限」', apply: (c) => ({ ...c, place: 'all' }) });
  }

  for (let size = 1; size <= relaxers.length; size += 1) {
    for (const combo of combinations(relaxers, size)) {
      let next = { ...base };
      combo.forEach((r) => { next = r.apply(next); });
      const list = filterDishes(dishes, next);
      if (list.length > 0) {
        return { found: true, criteria: next, texts: combo.map((r) => r.text), count: list.length };
      }
    }
  }

  // 理论上到不了这里（三个条件全放开就一定抽得到）；实在没有数据时给个兜底
  const all = { maxPrice: 0, maxSpicy: 3, place: 'all' };
  return { found: false, criteria: all, texts: ['全部条件改成「不限」'], count: filterDishes(dishes, all).length };
}
