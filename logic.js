/**
 * logic.js —— 纯逻辑层（只做计算，不碰页面）
 *
 * 沿用项目原有的分层：app.js 管页面、logic.js 管算法、data.js 管数据。
 * 这样 tests/run-tests.mjs 能直接 import 同一份逻辑来断言，页面和测试跑的永远是同一套代码。
 *
 * 本文件承载四件事：
 *   1) 六个模块里「筛选」那一半（价格三档 / 地点 / 口味两组 / 主食分类）
 *   2) 「推荐一道」的加权随机（p = w / Σw，在候选集内归一）
 *   3) 权重演化三入口：红心（渐近逼近**自己基准的 3 倍**）、差评（渐近逼近 0）、跳过（有 60% 地板）
 *   4) 按设备的偏好账本（hearts / downs / skips 三态）——纯函数，命令行测试可直接断言
 *
 * 约定：所有函数都是「进来什么、出去什么」，不改动传入的数组和对象。
 */

import { DISHES, DATA_META, PLACES, STORES, TAXONOMY } from './data.js';

/* ============================ 权重 ============================ */

export const WEIGHT_RULES = DATA_META.weightRules;

/** 相对上限：**这道菜自己**基准权重的 3 倍（渐近方向，不是硬截断） */
export const capOf = (baseWeight, rules = WEIGHT_RULES) => baseWeight * rules.capRatio;

/** 跳过（点了推荐却把上一道换掉、且当时没表态）累计最多压掉基准权重的 40% —— 防手快连点误伤 */
export const skipFloorOf = (baseWeight, rules = WEIGHT_RULES) => baseWeight * (1 - rules.skipFloorRatio);

const round3 = (n) => Math.round(n * 1000) / 1000;
/** 步长一律**向下取整**到 3 位小数：宁可少走一小步，也绝不让「永不到达」被舍入误差打破 */
const floor3 = (n) => Math.floor(n * 1000 + 1e-9) / 1000;

/**
 * 点亮一颗红心（喜欢）：名义 +1；离上限不足 2 时只补「剩余距离的一半」。
 * ⇒ 10 → 11 → 12 … → 29 → 29.5 → 29.75 → …（步长逐步减半，3 位小数精度处自然停住）
 *   最终稳定在 29.999 这类值上：**永远逼近上限而不达**，任何菜都不会变成「必定被推荐」。
 */
export function heartDelta(currentWeight, cap, rules = WEIGHT_RULES) {
  if (!Number.isFinite(currentWeight) || currentWeight >= cap) return 0;
  return floor3(Math.min(rules.heartNominal, (cap - currentWeight) / 2));
}

/**
 * 点亮一个差评：名义 −2（负反馈力度取正反馈的两倍）；
 * 接近 0 时改为「砍掉当前值的一半」⇒ 降到极低但**永不为 0**（收敛在 0.001）——
 * 与红心完全镜像：没有菜会被永久屏蔽，也没有菜会被永久锁定。
 */
export function downDelta(currentWeight, rules = WEIGHT_RULES) {
  if (!Number.isFinite(currentWeight) || currentWeight <= 0) return 0;
  return -floor3(Math.min(rules.downStep, currentWeight / 2));
}

/** 跳过：名义 −0.5，并在「基准 × 60%」处停住 —— 手快连点不会把菜打穿 */
export function skipDelta(currentWeight, baseWeight, rules = WEIGHT_RULES) {
  const floor = skipFloorOf(baseWeight, rules);
  if (!Number.isFinite(currentWeight) || currentWeight <= floor) return 0;
  return -floor3(Math.min(rules.skipStep, currentWeight - floor));
}

/**
 * 由「基准权重 + 三类反馈计数」算出当前权重。
 *
 * 折算顺序固定为 **基准 → 跳过 → 差评 → 红心**：与点的先后无关
 * （同样的计数必定得到同样的权重），因此权重可预测、可复算、可测试，
 * 也不会因为「先点红心还是先点差评」而漂移。
 */
export function weightOf(baseWeight, counts = {}, rules = WEIGHT_RULES) {
  const base = Number.isFinite(baseWeight) ? baseWeight : rules.base;
  const cap = capOf(base, rules);
  let w = base;

  const skips = Math.max(0, Math.floor(counts.skips || 0));
  for (let i = 0; i < skips; i += 1) w = round3(w + skipDelta(w, base, rules));

  const downs = Math.max(0, Math.floor(counts.downs || 0));
  for (let i = 0; i < downs; i += 1) w = round3(w + downDelta(w, rules));

  const hearts = Math.max(0, Math.floor(counts.hearts || 0));
  for (let i = 0; i < hearts; i += 1) w = round3(w + heartDelta(w, cap, rules));

  return w;
}

/* ============================ 偏好账本（按设备） ============================ */

/**
 * 账本 = { v, hearts: {菜品id: 次数}, downs: {...}, skips: {...} }，只存在各自浏览器的 localStorage。
 *
 * 三态各自独立记「次数」：
 *   hearts = 点亮红心（喜欢）；downs = 点亮差评（不想再看到）；skips = 被换掉（未表态就点了下一次推荐）
 *
 * 为什么按「次数」而不是存整条事件流：权重只取决于次数；体积有界（菜品数 × 3）；
 * 菜品 id 在导入器里是永久继承的 ⇒ 菜单更新、调价、加菜之后账本依然有效。
 * 为什么放在纯逻辑层：命令行测试能直接断言账本行为（含两台设备互不影响），页面只负责读写存储。
 */
export const LEDGER_VERSION = 3;
export const LEDGER_KINDS = ['hearts', 'downs', 'skips'];

export function emptyLedger() {
  return { v: LEDGER_VERSION, hearts: {}, downs: {}, skips: {} };
}

/** 清洗任何来路不明的账本（旧版本 / 被手改过 / 存坏的），旧版只有 hearts 也能平滑迁移 */
export function normalizeLedger(raw) {
  const next = emptyLedger();
  if (!raw || typeof raw !== 'object') return next;
  LEDGER_KINDS.forEach((kind) => {
    const source = raw[kind] && typeof raw[kind] === 'object' ? raw[kind] : {};
    Object.entries(source).forEach(([id, n]) => {
      const count = Math.floor(Number(n));
      if (typeof id === 'string' && id && Number.isFinite(count) && count > 0) next[kind][id] = count;
    });
  });
  return next;
}

/** 记一次表态（kind: hearts | downs | skips），返回新账本（不改动传入对象） */
export function ledgerAdd(ledger, dishId, kind = 'hearts') {
  const next = normalizeLedger(ledger);
  if (typeof dishId !== 'string' || !dishId || !LEDGER_KINDS.includes(kind)) return next;
  next[kind][dishId] = (next[kind][dishId] || 0) + 1;
  return next;
}

/** 撤销一次：再点一次实心图标 = 反悔，净零写入（给误点留出口） */
export function ledgerRemove(ledger, dishId, kind = 'hearts') {
  const next = normalizeLedger(ledger);
  if (!LEDGER_KINDS.includes(kind) || !next[kind][dishId]) return next;
  next[kind][dishId] -= 1;
  if (next[kind][dishId] <= 0) delete next[kind][dishId];
  return next;
}

export function ledgerCount(ledger, dishId, kind = 'hearts') {
  const clean = normalizeLedger(ledger);
  return LEDGER_KINDS.includes(kind) ? (clean[kind][dishId] || 0) : 0;
}

/** 这道菜在这一类表态上被点过吗（页面据此决定图标空心还是实心） */
export function ledgerHas(ledger, dishId, kind = 'hearts') {
  return ledgerCount(ledger, dishId, kind) > 0;
}

export function ledgerTotal(ledger) {
  const clean = normalizeLedger(ledger);
  return LEDGER_KINDS.reduce((sum, kind) => sum + Object.values(clean[kind]).reduce((a, b) => a + b, 0), 0);
}

/** 账本 → 菜 id 为键的计数表（weightTable / 测试用） */
export function ledgerToCounts(ledger) {
  const clean = normalizeLedger(ledger);
  const map = new Map();
  LEDGER_KINDS.forEach((kind) => {
    Object.keys(clean[kind]).forEach((id) => {
      if (!map.has(id)) map.set(id, { hearts: 0, downs: 0, skips: 0 });
      map.get(id)[kind] = clean[kind][id];
    });
  });
  return map;
}

/** 只保留库里还存在的菜（防止手改存储或旧库残留把账本撑大） */
export function ledgerPrune(ledger, dishes) {
  const alive = new Set((Array.isArray(dishes) ? dishes : []).map((d) => d.id));
  const next = emptyLedger();
  LEDGER_KINDS.forEach((kind) => {
    const source = ledger && ledger[kind] && typeof ledger[kind] === 'object' ? ledger[kind] : {};
    Object.entries(source).forEach(([id, n]) => {
      if (alive.has(id)) next[kind][id] = n;
    });
  });
  return next;
}

/** 当前权重表：菜 id → 权重（基准 + 三类反馈的折算结果） */
export function weightTable(dishes, ledger, rules = WEIGHT_RULES) {
  const counts = ledger instanceof Map ? ledger : ledgerToCounts(ledger);
  const table = new Map();
  (Array.isArray(dishes) ? dishes : []).forEach((d) => {
    table.set(d.id, weightOf(d.weightBase ?? rules.base, counts.get(d.id) || {}, rules));
  });
  return table;
}

/* ============================ 筛选 ============================ */

/** 多选组统一成数组（'all' / 空 / 缺项 = 不限；单选字符串照收 —— 老存档与老调用不会被打破） */
function toList(value) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
  return [...new Set(raw.filter((x) => typeof x === 'string' && x && x !== 'all'))];
}

/** 把用户的选择整理成标准格式；缺项 = 不限。口味两组与主食分类是**多选**（数组），其余是单选 */
export function normalizeCriteria(input) {
  const s = input && typeof input === 'object' ? input : {};
  return {
    priceTier: typeof s.priceTier === 'string' && s.priceTier ? s.priceTier : 'all',
    zone: typeof s.zone === 'string' && s.zone ? s.zone : 'all',
    floor: Number.isInteger(s.floor) ? s.floor : null,
    oiliness: toList(s.oiliness),
    spicy: toList(s.spicy),
    taxonomyId: toList(s.taxonomyId),
  };
}

export function priceTiers() {
  return DATA_META.priceTiers || [];
}

/** 某道菜落在哪个价格档（用于在结果卡片上标档位） */
export function priceTierOf(price, tiers = priceTiers()) {
  if (!Number.isFinite(price)) return null;
  const low = tiers.find((t) => t.id === 'low');
  const mid = tiers.find((t) => t.id === 'mid');
  if (low && price <= low.max) return low;
  if (mid && price > mid.min && price <= mid.max) return mid;
  return tiers.find((t) => t.id === 'high') || null;
}

function matchesPriceTier(dish, tierId, tiers) {
  if (tierId === 'all') return true;
  const tier = tiers.find((t) => t.id === tierId);
  if (!tier) return true;
  if (tier.id === 'low') return dish.price <= tier.max;
  if (tier.id === 'mid') return dish.price > tier.min && dish.price <= tier.max;
  return dish.price > tier.min;
}

/** 多选匹配：条件为空 = 不限；否则菜的值要落在所选集合里 */
function matchesAny(value, list) {
  return list.length === 0 || list.includes(value);
}

/**
 * 筛选。规则是月的明文直接翻译：
 *   - 地点：与库结构同构（方位区 → **楼层** → 店）——方位区与楼层都是二级索引，楼层跟着方位区给
 *   - 口味：清淡/油腻 与 辣度 是**两个互补且独立**的条件，可同时生效；两组都是**多选**（选了「清淡+油腻」= 两者都要）
 *   - 主食分类：**多选**；选「菜」时不叠加「饭」（商家免费提供米饭，主食默认为白米饭）
 * 口味未标注的菜：在用户选了口味条件时不进入候选（否则筛选没有意义），
 * 覆盖率会由页面在选项旁如实标出，且口味字段本身可后写入（标注补齐后自动生效）。
 */
export function filterDishes(dishes, criteria) {
  const c = normalizeCriteria(criteria);
  const tiers = priceTiers();
  return (Array.isArray(dishes) ? dishes : []).filter((d) => {
    if (!d) return false;
    if (!matchesPriceTier(d, c.priceTier, tiers)) return false;
    if (c.zone !== 'all' && d.zone !== c.zone) return false;
    if (c.floor != null && d.floor !== c.floor) return false;
    if (!matchesAny(d.oiliness, c.oiliness)) return false;
    if (!matchesAny(d.spicy, c.spicy)) return false;
    if (!matchesAny(d.taxonomyId, c.taxonomyId)) return false;
    return true;
  });
}

/** 主食标签：菜档的菜，主食默认白米饭（商家免费提供） */
export function stapleOf(dish) {
  if (!dish) return null;
  if (dish.taxonomyId === 'cai') return '白米饭（免费提供）';
  const cat = TAXONOMY.categories.find((x) => x.id === dish.taxonomyId);
  return cat ? cat.label : null;
}

/** 分类标签查找（页面渲染档位按钮用，保证不会写错名字） */
export function taxonomyLabel(id) {
  const cat = TAXONOMY.categories.find((x) => x.id === id);
  return cat ? cat.label : '未知';
}

/** 库里实际有菜的方位区（页面据此生成地点按钮） */
export function zonesInUse(dishes) {
  const used = new Set((Array.isArray(dishes) ? dishes : []).map((d) => d.zone).filter(Boolean));
  return PLACES.zones.filter((z) => used.has(z.name)).map((z) => z.name);
}

/** 某个方位区实际有菜的楼层（页面据此生成**楼层次级索引**；不传 zone 就是全部楼层） */
export function floorsInUse(dishes, zone = 'all') {
  const used = new Set((Array.isArray(dishes) ? dishes : [])
    .filter((d) => d && Number.isInteger(d.floor) && (zone === 'all' || d.zone === zone))
    .map((d) => d.floor));
  return [...used].sort((a, b) => a - b);
}

/** 楼层标签：页面上写「一楼」，不写「1」 */
export function floorLabel(floor) {
  const cn = { 1: '一楼', 2: '二楼', 3: '三楼', 4: '四楼', 5: '五楼' };
  return cn[floor] || `${floor} 楼`;
}

/** 库里实际有菜的主食档（按 TAXONOMY 顺序返回，预留档不显示在选项里也不隐藏数据） */
export function taxonomyInUse(dishes) {
  const used = new Set((Array.isArray(dishes) ? dishes : []).map((d) => d.taxonomyId).filter(Boolean));
  return TAXONOMY.categories.filter((c) => used.has(c.id));
}

/** 口味/辣度的当前覆盖率（页面如实显示，标注补齐后自动变化） */
export function flavorCoverage(dishes) {
  const all = Array.isArray(dishes) ? dishes : [];
  return {
    total: all.length,
    oiliness: all.filter((d) => d.oiliness).length,
    spicy: all.filter((d) => d.spicy).length,
  };
}

/* ============================ 推荐 ============================ */

/**
 * 加权随机：p = w / Σw（在候选集内归一）。
 *
 * - weightById：菜 id → 权重（由 weightTable 算出）
 * - recentIds：最近推荐过的菜 id，优先避开（沿用上一版的「进阶挑战」行为）
 * - random：随机数函数，默认 Math.random；测试里换成固定序列即可复现
 *
 * 返回 { dish, reason, repeated }
 *   reason = 'ok' | 'repeated'（候选都用过了）| 'empty'（没有候选）
 */
export function pickDish(candidates, weightById, recentIds = [], random = Math.random) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { dish: null, reason: 'empty', repeated: false, totalWeight: 0 };
  }
  const recent = new Set(recentIds);
  const fresh = candidates.filter((d) => !recent.has(d.id));
  const pool = fresh.length > 0 ? fresh : candidates;

  const weightOf = (d) => {
    const w = weightById instanceof Map ? weightById.get(d.id) : undefined;
    return Number.isFinite(w) && w > 0 ? w : WEIGHT_RULES.base;
  };
  const total = pool.reduce((sum, d) => sum + weightOf(d), 0);

  // 走「按权重扣减」的经典写法：随机点落在哪个区间就取哪一道。
  // random() 理论上不会返回 1，仍然用兜底保证不越界。
  let r = Math.min(Math.max(Number(random()), 0), 1) * total;
  let picked = pool[pool.length - 1];
  for (const d of pool) {
    r -= weightOf(d);
    if (r < 0) { picked = d; break; }
  }

  return {
    dish: picked,
    reason: fresh.length > 0 ? 'ok' : 'repeated',
    repeated: fresh.length === 0,
    totalWeight: total,
  };
}

/** 加权随机的理论占比（给信息提示用；不是随机结果） */
export function pickProbability(dishId, candidates, weightById) {
  if (!Array.isArray(candidates) || candidates.length === 0) return 0;
  const w = (d) => {
    const v = weightById instanceof Map ? weightById.get(d.id) : undefined;
    return Number.isFinite(v) && v > 0 ? v : WEIGHT_RULES.base;
  };
  const total = candidates.reduce((s, d) => s + w(d), 0);
  const self = candidates.find((d) => d.id === dishId);
  return total > 0 && self ? w(self) / total : 0;
}

/* ============================ 文案 ============================ */

/** 把筛选条件翻成一句人话，例如：12–15 元 · 清淡 · 微辣 · 面 */
export function describeCriteria(criteria) {
  const c = normalizeCriteria(criteria);
  const parts = [];
  const tier = priceTiers().find((t) => t.id === c.priceTier);
  parts.push(tier ? tier.label : '价格不限');
  parts.push(c.zone === 'all' ? '地点不限' : (c.floor != null ? `${c.zone} ${c.floor} 楼` : c.zone));
  parts.push(c.oiliness.length ? c.oiliness.join('/') : '口味不限');
  parts.push(c.spicy.length ? c.spicy.join('/') : '辣度不限');
  if (c.taxonomyId.length) parts.push(c.taxonomyId.map(taxonomyLabel).join('/'));
  return parts.join(' · ');
}

/** 空结果时：找出「最少放宽哪一项就能有结果」，避免瞎给建议 */
export function suggestRelaxation(dishes, criteria) {
  const base = normalizeCriteria(criteria);
  const relaxers = [];
  if (base.priceTier !== 'all') relaxers.push({ text: '把价格改成「不限」', apply: (c) => ({ ...c, priceTier: 'all' }) });
  if (base.zone !== 'all') relaxers.push({ text: '把地点改成「不限」', apply: (c) => ({ ...c, zone: 'all', floor: null }) });
  if (base.oiliness.length) relaxers.push({ text: `把口味「${base.oiliness.join('/')}」取消`, apply: (c) => ({ ...c, oiliness: [] }) });
  if (base.spicy.length) relaxers.push({ text: `把辣度「${base.spicy.join('/')}」取消`, apply: (c) => ({ ...c, spicy: [] }) });
  if (base.taxonomyId.length) relaxers.push({ text: '把主食分类改成「不限」', apply: (c) => ({ ...c, taxonomyId: [] }) });

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
  const all = normalizeCriteria({});
  return { found: false, criteria: all, texts: ['全部条件改成「不限」'], count: filterDishes(dishes, all).length };
}

/** 组合枚举（只在 suggestRelaxation 内部用） */
function combinations(items, size) {
  if (size === 0) return [[]];
  if (size > items.length) return [];
  const result = [];
  items.forEach((item, index) => {
    combinations(items.slice(index + 1), size - 1).forEach((combo) => result.push([item, ...combo]));
  });
  return result;
}

/** 给页面与测试用的默认导出入口（数据来自 data.js，页面不再自己持有数据） */
export const DATA = { DISHES, STORES, PLACES, TAXONOMY, META: DATA_META };
