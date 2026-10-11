/**
 * app.js —— 页面交互层：六个模块的联动、按设备的偏好账本、长上下文框的两态
 *
 * 分层不变：算法在 logic.js、数据在 data.js，这里只做「搬运 + 渲染 + 存储」。
 * 三件事值得先说明白：
 *   1) 权重按**设备**隔离：红心/差评/跳过只写进这台浏览器的 localStorage，
 *      服务端（局域网版与公网版）都是纯静态，没有任何写入接口。
 *   2) 三类反馈各有一个入口：红心（喜欢）、差评（不想再看到）、跳过（点了推荐却把上一道换掉、
 *      且当时没表态）。跳过是「隐式」的，所以它有 60% 地板，不会因为手快把一堆菜打穿。
 *   3) 连点保护：上一条记录若还没表态、且存活不足 700ms，会被新的一条**取代**而不是追加，
 *      既不会把历史刷屏，也不会给「没被真正看过」的菜记跳过惩罚。
 */

import {
  DISHES, DATA_META, PLACES, TAXONOMY, OILINESS_OPTIONS, SPICY_OPTIONS,
} from './data.js';
import {
  normalizeCriteria, filterDishes, pickDish, describeCriteria, suggestRelaxation, priceTiers,
  zonesInUse, floorsInUse, floorLabel, taxonomyInUse, flavorCoverage, stapleOf, taxonomyLabel,
  emptyLedger, normalizeLedger, ledgerAdd, ledgerRemove, ledgerHas, ledgerCount, ledgerPrune,
  ledgerTotal, ledgerResetRecent, LEDGER_RESET_DAYS, ledgerAddSkip, skipsToday, SKIP_DAILY_CAP,
  weightTable, pickProbability, WEIGHT_RULES, weightOf, COOLDOWN_LADDER,
} from './logic.js';

/* ---------------- 常量 ---------------- */

const CRITERIA_KEY = 'whatToEat.criteria.v3';     // 筛选条件
const LEDGER_KEY = 'whatToEat.preference.v3';     // 偏好账本（红心 / 差评 / 跳过）
const HISTORY_KEY = 'whatToEat.history.v3';       // 推荐记录
const HISTORY_LIMIT = 200;                        // 本机最多保留 200 条（全屏显示的就是它）
const REVEAL_MS = 260;                            // 与 styles.css 的 pop-in 对齐
const MERGE_MS = 700;                             // 连点合并窗口：上一条存活不足这么久且未表态 ⇒ 被取代
const TAP_SLOP = 8;                               // 手指/鼠标位移超过这么多像素就算滑动，不算点击

const DEFAULT_CRITERIA = {
  priceTier: 'all', zone: 'all', floor: null, oiliness: 'all', spicy: 'all', taxonomyId: 'all',
};

/** 联系方式不在源码里出现裸字符串（防批量爬虫），人类肉眼无感 */
const CONTACT = ['talfelan', '@qq', '.com'].join('');
const PAGE_VERSION = 'v2';

const SVG_HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
const SVG_THUMB_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>';

/* ---------------- 本地存储（读不到 / 写不了都不能让页面崩） ---------------- */

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;   // 无痕模式 / 配额满：退化成「本次会话内有效」，页面照常工作
  }
}

/* ---------------- 状态 ---------------- */

let criteria = normalizeCriteria(loadJSON(CRITERIA_KEY, DEFAULT_CRITERIA));
let ledger = normalizeLedger(loadJSON(LEDGER_KEY, null));
let history = loadJSON(HISTORY_KEY, []);
if (!Array.isArray(history)) history = [];
history = history
  .filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string')
  .map((r) => ({
    id: r.id,
    name: r.name,
    storeName: typeof r.storeName === 'string' ? r.storeName : '',
    price: Number.isFinite(r.price) ? r.price : null,
    at: Number.isFinite(r.at) ? r.at : 0,
    acted: { hearts: r.acted && r.acted.hearts ? 1 : 0, downs: r.acted && r.acted.downs ? 1 : 0 },
  }))
  .slice(0, HISTORY_LIMIT);

ledger = ledgerPrune(ledger, DISHES);   // 库里已经没有的菜，账本里也不留

let pendingRelax = null;
let lastActedId = null;   // 本轮已经点过图标的菜（用于「本轮已表态」的淡标记）
let openingAt = 0;

/* ---------------- DOM ---------------- */

const $ = (id) => document.getElementById(id);
const dom = {
  subtitle: $('app-subtitle'),
  chips: {
    price: $('chips-price'),
    zone: $('chips-zone'),
    floor: $('chips-floor'),
    oiliness: $('chips-oiliness'),
    spicy: $('chips-spicy'),
    taxonomy: $('chips-taxonomy'),
  },
  floorBox: $('floor-box'),
  recommendBtn: $('recommend-btn'),
  rerollBtn: $('reroll-btn'),
  resetBtn: $('reset-btn'),
  ledgerResetBtn: $('ledger-reset-btn'),
  ledgerStatus: $('ledger-status'),
  skipCap: $('skip-cap'),
  candidateCount: $('candidate-count'),
  card: $('result-card'),
  name: $('result-name'),
  price: $('result-price'),
  meta: $('result-meta'),
  tip: $('result-tip'),
  empty: $('result-empty'),
  emptyCriteria: $('empty-criteria'),
  emptySuggest: $('empty-suggest'),
  emptyCoverage: $('empty-coverage'),
  emptyRelaxBtn: $('empty-relax-btn'),
  historyBox: $('history-box'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  historyFull: $('history-full'),
  historyFullList: $('history-full-list'),
  historyFullClose: $('history-full-close'),
  contactMail: $('contact-mail'),
  dataDate: $('data-date'),
};

/* ---------------- 渲染：选项 ---------------- */

/** 选中态：单选组传字符串、多选组传数组，两种都认 */
function renderChips(container, options, current, onPick) {
  if (!container) return;
  container.textContent = '';
  const list = Array.isArray(current) ? current.map(String) : [String(current)];
  options.forEach((option) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = option.label;
    btn.dataset.value = String(option.value);
    const on = list.includes(String(option.value));
    btn.setAttribute('aria-pressed', String(on));
    if (on) btn.classList.add('is-on');
    btn.addEventListener('click', () => onPick(option.value));
    container.appendChild(btn);
  });
}

/** 多选组：点一下加入、再点一下取消 */
function toggleInList(list, value) {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function renderAllControls() {
  const tiers = priceTiers();
  renderChips(
    dom.chips.price,
    [{ value: 'all', label: '不限' }, ...tiers.map((t) => ({ value: t.id, label: t.label }))],
    criteria.priceTier,
    (value) => { criteria = { ...criteria, priceTier: value }; afterCriteriaChange(); },
  );

  renderChips(
    dom.chips.zone,
    [{ value: 'all', label: '不限' }, ...zonesInUse(DISHES).map((z) => ({ value: z, label: z }))],
    criteria.zone,
    (value) => { criteria = { ...criteria, zone: value, floor: null }; afterCriteriaChange(); },
  );

  // 地点的**二级索引**：选了方位区才出现楼层，且只出现该区实际有的楼层
  const floors = floorsInUse(DISHES, criteria.zone);
  if (dom.floorBox) {
    dom.floorBox.hidden = criteria.zone === 'all' || floors.length === 0;
    if (!dom.floorBox.hidden) {
      renderChips(
        dom.chips.floor,
        [{ value: 'all', label: '不限' }, ...floors.map((f) => ({ value: f, label: floorLabel(f) }))],
        criteria.floor == null ? 'all' : String(criteria.floor),
        (value) => { criteria = { ...criteria, floor: value === 'all' ? null : Number(value) }; afterCriteriaChange(); },
      );
    }
  }

  // 口味两组与主食分类都是**多选**：点一下加入、再点一下取消（不需要额外的「不限」按钮，界面更干净）
  renderChips(dom.chips.oiliness, OILINESS_OPTIONS, criteria.oiliness, (value) => {
    criteria = { ...criteria, oiliness: toggleInList(criteria.oiliness, value) };
    afterCriteriaChange();
  });
  renderChips(dom.chips.spicy, SPICY_OPTIONS, criteria.spicy, (value) => {
    criteria = { ...criteria, spicy: toggleInList(criteria.spicy, value) };
    afterCriteriaChange();
  });
  renderChips(dom.chips.taxonomy, taxonomyInUse(DISHES).map((c) => ({ value: c.id, label: c.label })), criteria.taxonomyId, (value) => {
    criteria = { ...criteria, taxonomyId: toggleInList(criteria.taxonomyId, value) };
    afterCriteriaChange();
  });
}

function afterCriteriaChange() {
  saveJSON(CRITERIA_KEY, criteria);
  renderAllControls();
  updateCandidateCount();
}

function updateCandidateCount() {
  if (!dom.candidateCount) return;
  const count = filterDishes(DISHES, criteria).length;
  dom.candidateCount.textContent = count > 0
    ? `当前符合条件：${count} / ${DISHES.length} 道`
    : `当前符合条件：0 / ${DISHES.length} 道（试试放宽条件）`;
  return count;
}

/* ---------------- 渲染：结果 ---------------- */

function hideAllResultBlocks() {
  dom.card.hidden = true;
  dom.empty.hidden = true;
}

function tasteTags(dish) {
  const tags = [];
  if (dish.oiliness) tags.push(dish.oiliness);
  if (dish.spicy) tags.push(dish.spicy);
  const staple = stapleOf(dish);
  if (staple) tags.push(`主食：${staple}`);
  return tags;
}

function showResult(dish, meta) {
  hideAllResultBlocks();
  dom.name.textContent = dish.name;
  dom.price.textContent = `${dish.price} 元`;
  const tags = tasteTags(dish);
  dom.meta.textContent = [dish.storeName || '', ...tags].filter(Boolean).join(' · ');
  if (meta.reason === 'repeated') {
    dom.tip.textContent = '符合条件的餐品不多，而且都刚推荐过 —— 这次会是其中一道。放宽一点条件能换个花样。';
    dom.tip.hidden = false;
  } else {
    dom.tip.hidden = true;
  }
  dom.card.hidden = false;
  playRevealAnimation();
}

function showEmpty() {
  hideAllResultBlocks();
  const relax = suggestRelaxation(DISHES, criteria);
  pendingRelax = relax.criteria;
  dom.emptyCriteria.textContent = describeCriteria(criteria);
  dom.emptySuggest.textContent = relax.texts.length > 0
    ? `可以试试：${relax.texts.join('，')}（放宽后会有 ${relax.count} 道可选）`
    : '试试把条件都放宽。';

  // 口味筛选才有覆盖率问题：只在此时如实说明，不做常驻注解
  const cov = flavorCoverage(DISHES);
  const tasteFiltered = criteria.oiliness.length > 0 || criteria.spicy.length > 0;
  if (tasteFiltered && (cov.oiliness < cov.total || cov.spicy < cov.total)) {
    dom.emptyCoverage.textContent = `口味标注还在补：清淡/油腻 ${cov.oiliness}/${cov.total} 道、辣度 ${cov.spicy}/${cov.total} 道；未标注的菜不参与口味筛选。`;
    dom.emptyCoverage.hidden = false;
  } else {
    dom.emptyCoverage.hidden = true;
  }
  dom.empty.hidden = false;
}

/* ---------------- 连点保护 ---------------- */

let revealToken = 0;

function playRevealAnimation() {
  const token = ++revealToken;
  dom.recommendBtn.classList.remove('is-tapped');
  dom.card.classList.remove('is-revealing');
  void dom.recommendBtn.offsetWidth;   // 强制重排，动画才会重新播放
  void dom.card.offsetWidth;
  dom.recommendBtn.classList.add('is-tapped');
  dom.card.classList.add('is-revealing');
  setTimeout(() => {
    if (token !== revealToken) return; // 期间又点过了，交给新的一次收尾
    dom.recommendBtn.classList.remove('is-tapped');
    dom.card.classList.remove('is-revealing');
  }, REVEAL_MS);
}

/* ---------------- 偏好账本：读—改—写（跨标签页安全） ---------------- */

/**
 * 所有写入都走这里：先重新读一次存储（别的标签页可能刚写过），
 * 再把这次动作施加到**最新**的状态上，最后写回。这样两个标签页不会互相覆盖。
 */
function commitLedger(mutate) {
  const fresh = normalizeLedger(loadJSON(LEDGER_KEY, null));
  const next = mutate(fresh);
  ledger = next;
  saveJSON(LEDGER_KEY, next);
  return next;
}

function currentWeights() {
  return weightTable(DISHES, ledger);
}

/** 记一次表态；返回是否真的写入了 */
function recordAct(row, kind) {
  const already = ledgerHas(ledger, row.id, kind);
  if (already) {
    commitLedger((fresh) => ledgerRemove(fresh, row.id, kind));
    row.acted[kind] = 0;
    reportFeedback(row.id, kind, 'removed');
    return 'removed';
  }
  // 同一条记录上的「红心」与「差评」互斥：点了一个，另一个若是实心就先撤掉（避免自相矛盾的表态）
  const other = kind === 'hearts' ? 'downs' : 'hearts';
  if (ledgerHas(ledger, row.id, other)) {
    commitLedger((fresh) => ledgerRemove(fresh, row.id, other));
    row.acted[other] = 0;
  }
  commitLedger((fresh) => ledgerAdd(fresh, row.id, kind));
  row.acted[kind] = 1;
  reportFeedback(row.id, kind, 'added');
  return 'added';
}

/**
 * 匿名聚合上报（**只进不出**）：只发一个最小事件，本机账本已经写完了才发。
 * 端点没配、离线、开了 DNT、用户关了上报、或发送失败 —— 一律静默丢弃，绝不重试、绝不阻塞 UI。
 * 个人推荐**永远**只读本机 localStorage，聚合数据不回灌（门禁 tools/verify-feedback-gate.mjs 守着这条）。
 */
function reportFeedback(dishId, kind, action) {
  const agg = typeof window !== 'undefined' ? window.aggregate : null;
  if (!agg || typeof agg.enqueue !== 'function') return;
  try { agg.enqueue({ dishId, kind, action }); } catch { /* 上报永远不影响本地功能 */ }
}

/**
 * 「重新推荐」记一次跳过（**带当日上限**，见 logic.js 的 SKIP_DAILY_CAP）。
 * 返回 true 表示这次真的计入了降权；false = 今日额度用完，只换菜。
 */
function recordSkip(row) {
  if (row.acted.hearts || row.acted.downs) return false;   // 已经表过态，不再惩罚
  let counted = false;
  commitLedger((fresh) => {
    const before = skipsToday(fresh);
    const next = ledgerAddSkip(fresh, row.id, Date.now());
    counted = skipsToday(next) > before;
    return next;
  });
  return counted;
}

/**
 * 「好感重置」：只清空**最近 7 天**造成的权重变化，更早的偏好保留。
 *
 * 为什么需要它：踩与跳过会长期压低一道菜；如果只是「这几天不想吃」，不该被永久记账。
 */
function resetRecentPreference() {
  const before = ledgerTotal(ledger);
  ledger = ledgerResetRecent(ledger, LEDGER_RESET_DAYS);
  saveJSON(LEDGER_KEY, ledger);
  // 历史行上的实心图标是账本快照；重置后要跟着账本重算，否则会出现「账本清了、图标还亮着」
  history = history.map((r) => ({
    ...r,
    acted: { hearts: ledgerHas(ledger, r.id, 'hearts') ? 1 : 0, downs: ledgerHas(ledger, r.id, 'downs') ? 1 : 0 },
  }));
  saveHistory();
  renderHistory();
  const removed = before - ledgerTotal(ledger);
  if (dom.ledgerStatus) {
    dom.ledgerStatus.textContent = removed > 0
      ? `已清空最近 ${LEDGER_RESET_DAYS} 天的 ${removed} 条偏好`
      : `最近 ${LEDGER_RESET_DAYS} 天没有偏好记录`;
  }
  return removed;
}

/* ---------------- 推荐记录：两态渲染 ---------------- */

function makeActButton(row, kind, label, svg) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `act act-${kind === 'hearts' ? 'like' : 'down'}`;
  btn.innerHTML = svg;
  const pressed = Boolean(row.acted[kind]);
  btn.setAttribute('aria-pressed', String(pressed));
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', (event) => {
    event.stopPropagation();            // 别把「点图标」当成「点开全屏」
    recordAct(row, kind);
    saveHistory();
    renderHistory();
  });
  return btn;
}

function renderRow(row) {
  const li = document.createElement('li');
  li.className = 'history-row';
  if (row.acted.hearts || row.acted.downs) li.classList.add('is-acted');

  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = row.name;
  main.appendChild(name);
  if (row.storeName) {
    const store = document.createElement('span');
    store.className = 'row-store';
    store.textContent = row.storeName;
    main.appendChild(store);
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(makeActButton(row, 'hearts', '喜欢：提高下次推荐它的概率', SVG_HEART));
  actions.appendChild(makeActButton(row, 'downs', '差评：降低下次推荐它的概率', SVG_THUMB_DOWN));

  li.appendChild(main);
  li.appendChild(actions);
  return li;
}

function fillList(container) {
  if (!container) return;
  const frag = document.createDocumentFragment();
  history.forEach((row) => frag.appendChild(renderRow(row)));
  container.textContent = '';
  container.appendChild(frag);
}

function renderHistory() {
  fillList(dom.historyList);
  if (!dom.historyFull.hidden) fillList(dom.historyFullList);
  if (dom.historyEmpty) dom.historyEmpty.hidden = history.length > 0;
}

function saveHistory() {
  saveJSON(HISTORY_KEY, history.slice(0, HISTORY_LIMIT));
}

/* ---------------- 推荐 ---------------- */

/**
 * 推荐一道（`reroll` 为 false）／重新推荐（`reroll` 为 true）。
 *
 * 两者的区别只在**权重**上：
 *   · 再点「推荐一道」＝只是换一道（重摇），**不动权重** —— 手快点几下不该被记账；
 *   · 「重新推荐」＝明确表示“这道我不想吃”（又不想给它差评），记一次**跳过**，力度与过去「推荐一道」一致。
 * 两者的共同点：都能刷新推荐结果、都会把新菜记进推荐记录（也就进入了冷却窗口）。
 */
function recommend(opts = {}) {
  const reroll = opts.reroll === true;
  const candidates = filterDishes(DISHES, criteria);
  if (candidates.length === 0) {
    showEmpty();
    return null;
  }

  const weights = currentWeights();
  // 最近推荐过的菜：交给软冷却按名次压低（不再硬排除）；点过红心的提前释放、点过差评的窗内再加重
  const recentIds = history.slice(0, COOLDOWN_LADDER.length).map((r) => r.id);
  const likedIds = new Set();
  const dislikedIds = new Set();
  Object.values(ledger.days || {}).forEach((bucket) => {
    Object.keys(bucket.hearts).forEach((id) => likedIds.add(id));
    Object.keys(bucket.downs).forEach((id) => dislikedIds.add(id));
  });
  const { dish, reason } = pickDish(candidates, weights, recentIds, Math.random, { likedIds, dislikedIds });
  if (!dish) {
    showEmpty();
    return null;
  }

  const now = Date.now();
  const previous = history[0];
  if (reroll && previous) {
    const counted = recordSkip(previous);          // 「重新推荐」才记跳过，且带当日上限
    if (dom.ledgerStatus) {
      dom.ledgerStatus.textContent = counted
        ? ''
        : `今天「重新推荐」的降权次数已用完（${SKIP_DAILY_CAP} 次），继续换菜不影响权重`;
    }
  }

  const mergeable = previous
    && now - previous.at < MERGE_MS
    && !previous.acted.hearts && !previous.acted.downs
    && previous.id !== dish.id;

  if (mergeable && !reroll) {
    // 连点合并：上一条还没被真正看过（存活不足 700ms 且未表态）⇒ 直接被取代，不刷屏
    history[0] = { id: dish.id, name: dish.name, storeName: dish.storeName || '', price: dish.price, at: now, acted: { hearts: 0, downs: 0 } };
  } else {
    history.unshift({ id: dish.id, name: dish.name, storeName: dish.storeName || '', price: dish.price, at: now, acted: { hearts: 0, downs: 0 } });
    if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
  }

  saveHistory();
  renderHistory();
  showResult(dish, { reason });

  const w = weights.get(dish.id);
  if (Number.isFinite(w)) {
    // 给自动测试与排查留的读数：这道菜当前权重 / 在候选集里的理论占比（**冷却前的占比**）
    dom.card.dataset.weight = String(w);
    dom.card.dataset.share = pickProbability(dish.id, candidates, weights).toFixed(4);
  }
  return dish;
}

/* ---------------- 长上下文框：半屏 ⇄ 全屏 ---------------- */

function openFull() {
  if (history.length === 0) return;
  openingAt = Date.now();
  fillList(dom.historyFullList);
  dom.historyFull.hidden = false;
  document.body.classList.add('is-locked');
  dom.historyFullClose.focus();
}

function closeFull() {
  if (dom.historyFull.hidden) return;
  dom.historyFull.hidden = true;
  document.body.classList.remove('is-locked');
  dom.historyBox.focus();
}

/* ---------------- 重置 ---------------- */

function resetFilters() {
  criteria = { ...DEFAULT_CRITERIA };
  saveJSON(CRITERIA_KEY, criteria);
  renderAllControls();
  updateCandidateCount();
  hideAllResultBlocks();
  pendingRelax = null;
}

/* ---------------- 事件绑定 ---------------- */

dom.recommendBtn.addEventListener('click', () => recommend());
dom.rerollBtn.addEventListener('click', () => recommend({ reroll: true }));
dom.ledgerResetBtn.addEventListener('click', () => {
  if (!confirm(`清空最近 ${LEDGER_RESET_DAYS} 天的偏好？更早的偏好会保留。`)) return;
  resetRecentPreference();
});
dom.resetBtn.addEventListener('click', () => resetFilters());

dom.emptyRelaxBtn.addEventListener('click', () => {
  if (!pendingRelax) return;
  criteria = normalizeCriteria(pendingRelax);
  pendingRelax = null;
  saveJSON(CRITERIA_KEY, criteria);
  renderAllControls();
  updateCandidateCount();
  recommend();
});

// 半屏框：滑动是滑动、点击才展开全屏（位移超过 8px 就不算点击）
let pointerStart = null;
dom.historyBox.addEventListener('pointerdown', (event) => { pointerStart = { x: event.clientX, y: event.clientY }; });
dom.historyBox.addEventListener('click', (event) => {
  if (event.target.closest('.act')) return;
  if (pointerStart) {
    const moved = Math.abs(event.clientX - pointerStart.x) + Math.abs(event.clientY - pointerStart.y);
    pointerStart = null;
    if (moved > TAP_SLOP) return;
  }
  openFull();
});
dom.historyBox.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFull(); }
});
dom.historyFullClose.addEventListener('click', () => closeFull());
dom.historyFull.addEventListener('click', (event) => { if (event.target === dom.historyFull) closeFull(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeFull(); });

// 跨标签页：另一个标签改了账本，这里跟着同步（否则两边会各持一份旧副本）
window.addEventListener('storage', (event) => {
  if (event.key === LEDGER_KEY) {
    ledger = normalizeLedger(loadJSON(LEDGER_KEY, null));
    renderHistory();
  } else if (event.key === HISTORY_KEY) {
    const next = loadJSON(HISTORY_KEY, []);
    if (Array.isArray(next)) { history = next; renderHistory(); }
  }
});

/* ---------------- 启动 ---------------- */

(function boot() {
  // 标题副行：校区 · 方位区 · 菜品数（全部来自库，不写死）
  const zones = zonesInUse(DISHES);
  const campus = (PLACES && PLACES.campus) || '校园';
  dom.subtitle.textContent = [campus, zones.join(' / '), `共 ${DISHES.length} 道菜`].filter(Boolean).join(' · ');

  // 联系方式与数据日期（联系方式由两段拼出来，源码里没有裸字符串）
  if (dom.contactMail) {
    dom.contactMail.textContent = CONTACT;
    const subject = encodeURIComponent('今天吃什么 · 反馈');
    const body = encodeURIComponent(`\n\n——\n页面版本：${PAGE_VERSION}\n数据版本：${String(DATA_META.generatedAt || '').slice(0, 10)}\n`);
    dom.contactMail.href = `mailto:${CONTACT}?subject=${subject}&body=${body}`;
  }
  if (dom.dataDate) {
    dom.dataDate.textContent = `数据更新：${String(DATA_META.generatedAt || '').slice(0, 10)}`;
  }
  // 注解里的限额从代码取，避免「文案写 12、实现改成 8」这种脱节
  if (dom.skipCap) dom.skipCap.textContent = String(SKIP_DAILY_CAP);

  renderAllControls();
  updateCandidateCount();
  renderHistory();
})();

/* 给自动测试（tests/browser-selftest.js）与手动排查用的入口，不影响正常使用 */
window.__whatToEat = {
  version: '2.0.0',
  dishes: DISHES,
  meta: DATA_META,
  taxonomyLabel,
  weightRules: WEIGHT_RULES,
  getCriteria: () => ({ ...criteria }),
  setCriteria(next) { criteria = normalizeCriteria(next); afterCriteriaChange(); },
  countCandidates: () => filterDishes(DISHES, criteria).length,
  getLedger: () => JSON.parse(JSON.stringify(ledger)),
  getHistory: () => history.map((r) => ({ ...r, acted: { ...r.acted } })),
  weightOfDish: (id) => {
    const dish = DISHES.find((d) => d.id === id);
    if (!dish) return null;
    return weightOf(dish.weightBase, {
      hearts: ledgerCount(ledger, id, 'hearts'),
      downs: ledgerCount(ledger, id, 'downs'),
      skips: ledgerCount(ledger, id, 'skips'),
    });
  },
  weights: () => Object.fromEntries(currentWeights()),
  recommend,
  reroll: () => recommend({ reroll: true }),
  resetFilters,
  resetRecentPreference,
  clearHistory() { history = []; saveHistory(); renderHistory(); },
  clearLedger() { ledger = emptyLedger(); saveJSON(LEDGER_KEY, ledger); renderHistory(); },
  openFull,
  closeFull,
  contact: CONTACT,
};

/* 浏览器自测：地址后面加 ?selftest=1 时才加载测试脚本（平时不加载，公网版没有这个文件也不会报错） */
if (new URLSearchParams(location.search).has('selftest')) {
  import('./tests/browser-selftest.js')
    .then((mod) => mod.runBrowserSelfTest(window.__whatToEat))
    .catch((err) => {
      const pre = document.createElement('pre');
      pre.id = 'selftest-output';
      pre.textContent = `SELFTEST-IMPORT-FAILED: ${err && err.message}`;
      document.body.appendChild(pre);
    });
}
