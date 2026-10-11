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
 * 账本 = { v:4, days: { 'YYYY-MM-DD': { hearts:{菜品id:次数}, downs:{…}, skips:{…} } } }，
 * 只存在各自浏览器的 localStorage。
 *
 * 三态各自独立记「次数」：
 *   hearts = 点亮红心（喜欢）；downs = 点亮差评（不想再看到）；skips = 「重新推荐」换掉的那一道
 *
 * 为什么**按天分桶**（2026-10-11 从「一个扁平计数」升到 v4）：页面要提供「好感重置」——
 * 只清空**最近 7 天**造成的权重变化。扁平计数没有时间信息，表达不出「近 7 天」。
 * 分桶后：权重仍是所有桶求和（行为不变），而重置只要丢掉窗口内的桶即可（精确、可测试）。
 * 为什么放在纯逻辑层：命令行测试能直接断言账本行为（含两台设备互不影响），页面只负责读写存储。
 */
export const LEDGER_VERSION = 4;
export const LEDGER_KINDS = ['hearts', 'downs', 'skips'];
/** 老桶最多留这么久（权重够用，又不会无限膨胀） */
export const LEDGER_KEEP_DAYS = 180;
/** 「好感重置」默认清空的窗口 */
export const LEDGER_RESET_DAYS = 7;

const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
/** 本地日历日（YYYY-MM-DD） */
export function ledgerDay(when = Date.now()) {
  const d = new Date(when);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** 日期串加减天数（只做「日」的整数运算，用 UTC 计算避开夏令时） */
function shiftDay(day, delta) {
  const [y, m, d] = String(day).split('-').map(Number);
  const t = new Date(Date.UTC(y, (m || 1) - 1, d || 1) + delta * DAY_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

export function emptyLedger() {
  return { v: LEDGER_VERSION, days: {} };
}

/** 单个桶的清洗：只留合法 id 与正整数次数 */
function cleanBucket(raw) {
  const bucket = { hearts: {}, downs: {}, skips: {} };
  LEDGER_KINDS.forEach((kind) => {
    const source = raw && raw[kind] && typeof raw[kind] === 'object' ? raw[kind] : {};
    Object.entries(source).forEach(([id, n]) => {
      const count = Math.floor(Number(n));
      if (typeof id === 'string' && id && Number.isFinite(count) && count > 0) bucket[kind][id] = count;
    });
  });
  return bucket;
}

const bucketEmpty = (bucket) => LEDGER_KINDS.every((k) => Object.keys(bucket[k]).length === 0);

/**
 * 清洗任何来路不明的账本（旧版本 / 被手改过 / 存坏的）。
 * v3（扁平计数、没有日期）平滑迁移：按「今天」入桶 —— 站点上线不久，这些计数实际就是最近发生的。
 */
export function normalizeLedger(raw, when = Date.now()) {
  const next = emptyLedger();
  if (!raw || typeof raw !== 'object') return next;
  if (raw.days && typeof raw.days === 'object') {
    Object.entries(raw.days).forEach(([day, bucket]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      const clean = cleanBucket(bucket);
      if (!bucketEmpty(clean)) next.days[day] = clean;
    });
    return next;
  }
  const legacy = cleanBucket(raw);                 // v3 及更早：扁平计数
  if (!bucketEmpty(legacy)) next.days[ledgerDay(when)] = legacy;
  return next;
}

/** 记一次表态（kind: hearts | downs | skips），返回新账本（不改动传入对象） */
export function ledgerAdd(ledger, dishId, kind = 'hearts', when = Date.now()) {
  const next = normalizeLedger(ledger, when);
  if (typeof dishId !== 'string' || !dishId || !LEDGER_KINDS.includes(kind)) return next;
  const day = ledgerDay(when);
  if (!next.days[day]) next.days[day] = { hearts: {}, downs: {}, skips: {} };
  next.days[day][kind][dishId] = (next.days[day][kind][dishId] || 0) + 1;
  return next;
}

/** 撤销一次：再点一次实心图标 = 反悔，净零写入（给误点留出口）；从最近的桶往前找 */
export function ledgerRemove(ledger, dishId, kind = 'hearts') {
  const next = normalizeLedger(ledger);
  if (!LEDGER_KINDS.includes(kind)) return next;
  const days = Object.keys(next.days).sort().reverse();
  for (const day of days) {
    if (next.days[day][kind][dishId]) {
      next.days[day][kind][dishId] -= 1;
      if (next.days[day][kind][dishId] <= 0) delete next.days[day][kind][dishId];
      if (bucketEmpty(next.days[day])) delete next.days[day];
      break;
    }
  }
  return next;
}

export function ledgerCount(ledger, dishId, kind = 'hearts') {
  const clean = normalizeLedger(ledger);
  if (!LEDGER_KINDS.includes(kind)) return 0;
  return Object.values(clean.days).reduce((sum, bucket) => sum + (bucket[kind][dishId] || 0), 0);
}

/** 这道菜在这一类表态上被点过吗（页面据此决定图标空心还是实心） */
export function ledgerHas(ledger, dishId, kind = 'hearts') {
  return ledgerCount(ledger, dishId, kind) > 0;
}

export function ledgerTotal(ledger) {
  const clean = normalizeLedger(ledger);
  return Object.values(clean.days).reduce((sum, bucket) => (
    sum + LEDGER_KINDS.reduce((a, kind) => a + Object.values(bucket[kind]).reduce((x, y) => x + y, 0), 0)
  ), 0);
}

/**
 * 账本 → 菜 id 为键的计数表（weightTable / 测试用）。
 * `since` 给出起始日（含）时只统计该日及之后的桶 —— 「好感重置」的窗口语义靠它。
 */
export function ledgerToCounts(ledger, { since = null, until = null, when = Date.now() } = {}) {
  const clean = normalizeLedger(ledger, when);
  const map = new Map();
  Object.keys(clean.days).forEach((day) => {
    if (since && day < since) return;
    if (until && day > until) return;
    const bucket = clean.days[day];
    LEDGER_KINDS.forEach((kind) => {
      Object.keys(bucket[kind]).forEach((id) => {
        if (!map.has(id)) map.set(id, { hearts: 0, downs: 0, skips: 0 });
        map.get(id)[kind] += bucket[kind][id];
      });
    });
  });
  return map;
}

/**
 * 「好感重置」：丢掉**最近 days 天**（含今天）的桶，更早的偏好留着。
 * 返回新账本；调用方负责写回存储。
 */
export function ledgerResetRecent(ledger, days = LEDGER_RESET_DAYS, when = Date.now()) {
  const next = normalizeLedger(ledger, when);
  const from = shiftDay(ledgerDay(when), -(Math.max(1, Math.floor(days)) - 1));
  Object.keys(next.days).forEach((day) => { if (day >= from) delete next.days[day]; });
  return next;
}

/** 一天最多有多少次「重新推荐」真正计入降权（超出只换菜） */
export const SKIP_DAILY_CAP = 12;

/**
 * 「重新推荐」记一次跳过，**带当日上限**：一天最多 12 次真正计入降权，
 * 超出的仍然换菜（推荐结果照刷）、也照样进推荐记录，但**不再继续压低权重**。
 *
 * 为什么要有这道闸：手快连点「重新推荐」时，过去的实现会让一批菜在几十秒内一起掉到地板，
 * 权重更迭速度远超用户真实偏好的变化速度。上限让「今天不想吃」的累积效应有边界。
 */
export function ledgerAddSkip(ledger, dishId, when = Date.now(), cap = SKIP_DAILY_CAP) {
  const clean = normalizeLedger(ledger, when);
  const today = clean.days[ledgerDay(when)] || { hearts: {}, downs: {}, skips: {} };
  const used = Object.values(today.skips).reduce((a, b) => a + b, 0);
  if (used >= cap) return clean;              // 今日额度用完：只换菜，不再降权
  return ledgerAdd(clean, dishId, 'skips', when);
}

/** 今天已经计入过多少次「重新推荐」（页面用来提示额度） */
export function skipsToday(ledger, when = Date.now()) {
  const clean = normalizeLedger(ledger, when);
  const today = clean.days[ledgerDay(when)];
  return today ? Object.values(today.skips).reduce((a, b) => a + b, 0) : 0;
}

/** 只保留库里还存在的菜，并按 LEDGER_KEEP_DAYS 丢掉过老的桶（防止账本无限膨胀） */
export function ledgerPrune(ledger, dishes, { keepDays = LEDGER_KEEP_DAYS, when = Date.now() } = {}) {
  const alive = new Set((Array.isArray(dishes) ? dishes : []).map((d) => d.id));
  const oldest = shiftDay(ledgerDay(when), -keepDays);
  const clean = normalizeLedger(ledger, when);
  const next = emptyLedger();
  Object.entries(clean.days).forEach(([day, bucket]) => {
    if (day < oldest) return;
    const kept = cleanBucket({
      hearts: Object.fromEntries(Object.entries(bucket.hearts).filter(([id]) => alive.has(id))),
      downs: Object.fromEntries(Object.entries(bucket.downs).filter(([id]) => alive.has(id))),
      skips: Object.fromEntries(Object.entries(bucket.skips).filter(([id]) => alive.has(id))),
    });
    if (!bucketEmpty(kept)) next.days[day] = kept;
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
 * 冷却档位：rank 1 = 最近推荐过的那一道。**软冷却**（2026-10-11 由硬排除改来，系数经月确认）。
 *
 * 为什么不再用硬排除：候选池小的时候（例如「主食=饼」只有 5 道）会把「新鲜池」打到 0，
 * 于是从「绝对避开」一步跳到「完全不避开」—— 不是渐变，是崩塌；实测占比：全库 576 道时
 * 硬排除 = 0.00%，软冷却 = 0.32%；「小吃」（26 道）0.00% → 7.89%。见 tools/sim-cooldown.mjs。
 */
export const COOLDOWN_LADDER = [0.02, 0.08, 0.2, 0.5, 1];
/** 点过红心 ⇒ **提前释放**：只有「刚出现过的那一道」仍按第一档压（防连点），往后不再压 */
export const COOLDOWN_LIKED_FACTOR_BY_RANK = (rank, ladder) => (rank > 0 ? 1 : ladder[0]);
/** 点过差评 ⇒ **窗内再加重**（窗外由权重机制自己负责，这里不重复计） */
export const COOLDOWN_DISLIKED_FACTOR = 0.3;

/**
 * 冷却系数：给出这道菜在「最近推荐」里的名次，返回它的权重乘数。
 * rank 为 null 或超出窗口 ⇒ 1（不在冷却里，不动）。
 */
export function cooldownCoef(rank, { liked = false, disliked = false } = {}, ladder = COOLDOWN_LADDER) {
  if (rank === null || rank === undefined || rank < 0 || rank >= ladder.length) return 1;
  let coef = liked ? COOLDOWN_LIKED_FACTOR_BY_RANK(rank, ladder) : ladder[rank];
  if (disliked) coef *= COOLDOWN_DISLIKED_FACTOR;
  return coef;
}

/**
 * 加权随机：p = w / Σw（在候选集内归一）。**冷却只改系数，不从池子里删菜**。
 *
 * - weightById：菜 id → 权重（由 weightTable 算出）
 * - recentIds：最近推荐过的菜 id，**按由近到远排序**；越近压低越多，越远越快回升
 * - random：随机数函数，默认 Math.random；测试里换成固定序列即可复现
 * - feedback：{ likedIds, dislikedIds }（本机账本）—— 点过红心的提前释放、点过差评的窗内再加重
 *
 * 返回 { dish, reason, repeated, totalWeight, cooldownWeight }
 *   reason = 'ok' | 'repeated'（**所有**候选都在冷却窗内，必然重复）| 'empty'（没有候选）
 *   cooldownWeight ＝ 候选里处于冷却窗内那几道菜的（乘系数后的）权重合计，供测试与诊断
 */
export function pickDish(candidates, weightById, recentIds = [], random = Math.random, feedback = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { dish: null, reason: 'empty', repeated: false, totalWeight: 0, cooldownWeight: 0 };
  }
  const rankOf = new Map();
  recentIds.forEach((id, i) => { if (!rankOf.has(id)) rankOf.set(id, i); });   // 同一道菜重复出现时取更近的名次
  const asSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));
  const liked = asSet(feedback.likedIds);
  const disliked = asSet(feedback.dislikedIds);

  const weightOf = (d) => {
    const raw = weightById instanceof Map ? weightById.get(d.id) : undefined;
    const base = Number.isFinite(raw) && raw > 0 ? raw : WEIGHT_RULES.base;
    const rank = rankOf.has(d.id) ? rankOf.get(d.id) : null;
    return base * cooldownCoef(rank, { liked: liked.has(d.id), disliked: disliked.has(d.id) });
  };

  let total = 0;
  let cooldownWeight = 0;
  for (const d of candidates) {
    const w = weightOf(d);
    total += w;
    if (rankOf.has(d.id)) cooldownWeight += w;
  }

  // 走「按权重扣减」的经典写法：随机点落在哪个区间就取哪一道。
  // random() 理论上不会返回 1，仍然用兜底保证不越界。
  let r = Math.min(Math.max(Number(random()), 0), 1) * total;
  let picked = candidates[candidates.length - 1];
  for (const d of candidates) {
    r -= weightOf(d);
    if (r < 0) { picked = d; break; }
  }

  const freshCount = candidates.filter((d) => !rankOf.has(d.id)).length;
  return {
    dish: picked,
    reason: freshCount > 0 ? 'ok' : 'repeated',
    repeated: freshCount === 0,
    totalWeight: total,
    cooldownWeight,
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
