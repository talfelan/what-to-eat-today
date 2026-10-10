/**
 * app.js —— 页面交互层：把筛选、推荐按钮、结果卡片和本地存储串起来
 *
 * 这里只做"搬运"：真正的筛选和随机逻辑在 logic.js，数据在 data.js，
 * 所以想改规则就改那两个文件，不用动这个文件。
 */

import { DISHES, BUDGET_OPTIONS, SPICY_OPTIONS, SPICY_LABELS } from './data.js';
import {
  filterDishes,
  pickDish,
  uniquePlaces,
  describeCriteria,
  suggestRelaxation,
  normalizeCriteria,
} from './logic.js';

const SETTINGS_KEY = 'whatToEat.settings.v1';   // 筛选条件的本地存储键名
const HISTORY_KEY = 'whatToEat.history.v1';     // 最近推荐记录的本地存储键名
const HISTORY_LIMIT = 3;                        // 只记最近 3 次（作业的"进阶挑战"）
const REVEAL_MS = 260;                          // 和 styles.css 里 pop-in 动画时长保持一致

const DEFAULT_CRITERIA = { maxPrice: 0, maxSpicy: 3, place: 'all' };

/* ---------------- 本地存储（读不到/写不了也不能让页面崩） ---------------- */

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
    return false;
  }
}

/* ---------------- 页面状态 ---------------- */

let criteria = normalizeCriteria(loadJSON(SETTINGS_KEY, DEFAULT_CRITERIA));
let history = loadJSON(HISTORY_KEY, []);
if (!Array.isArray(history)) history = [];
history = history.filter((item) => item && typeof item.id === 'string').slice(0, HISTORY_LIMIT);

let pendingRelax = null;  // 空结果时算出来的"放宽后的条件"，给「一键放宽」按钮用
let revealToken = 0;      // 连点保护用的令牌：只让最后一次点击负责收尾

/* ---------------- DOM ---------------- */

const dom = {
  budgetChips: document.getElementById('chips-budget'),
  spicyChips: document.getElementById('chips-spicy'),
  placeChips: document.getElementById('chips-place'),
  recommendBtn: document.getElementById('recommend-btn'),
  resetBtn: document.getElementById('reset-btn'),
  candidateCount: document.getElementById('candidate-count'),
  placeholder: document.getElementById('result-placeholder'),
  card: document.getElementById('result-card'),
  cardLabel: document.getElementById('result-label'),
  name: document.getElementById('result-name'),
  note: document.getElementById('result-note'),
  price: document.getElementById('result-price'),
  place: document.getElementById('result-place'),
  spicy: document.getElementById('result-spicy'),
  type: document.getElementById('result-type'),
  tip: document.getElementById('result-tip'),
  empty: document.getElementById('result-empty'),
  emptyCriteria: document.getElementById('empty-criteria'),
  emptySuggest: document.getElementById('empty-suggest'),
  emptyRelaxBtn: document.getElementById('empty-relax-btn'),
  historyList: document.getElementById('history-list'),
  historyEmpty: document.getElementById('history-empty'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),
};

/* ---------------- 渲染筛选按钮 ---------------- */

function renderChips(container, options, currentValue, onPick) {
  if (!container) return;
  container.textContent = '';
  options.forEach((option) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = option.label;
    btn.dataset.value = String(option.value);
    btn.setAttribute('aria-pressed', String(option.value === currentValue));
    btn.addEventListener('click', () => onPick(option.value));
    container.appendChild(btn);
  });
}

function renderAllControls() {
  const places = uniquePlaces(DISHES);
  renderChips(dom.budgetChips, BUDGET_OPTIONS, criteria.maxPrice, (value) => {
    criteria = { ...criteria, maxPrice: value };
    afterCriteriaChange();
  });
  renderChips(dom.spicyChips, SPICY_OPTIONS, criteria.maxSpicy, (value) => {
    criteria = { ...criteria, maxSpicy: value };
    afterCriteriaChange();
  });
  renderChips(
    dom.placeChips,
    [{ value: 'all', label: '不限' }, ...places.map((p) => ({ value: p, label: p }))],
    criteria.place,
    (value) => {
      criteria = { ...criteria, place: value };
      afterCriteriaChange();
    },
  );
}

/** 筛选条件变化后：存起来、刷新按钮选中态、刷新候选数量 */
function afterCriteriaChange() {
  saveJSON(SETTINGS_KEY, criteria);
  renderAllControls();
  updateCandidateCount();
}

/** 当前有多少道餐品符合条件，直接显示在按钮下面 */
function updateCandidateCount() {
  if (!dom.candidateCount) return;
  const count = filterDishes(DISHES, criteria).length;
  dom.candidateCount.textContent = count > 0
    ? `当前符合条件：${count} / ${DISHES.length} 道`
    : `当前符合条件：0 / ${DISHES.length} 道（试试放宽条件）`;
}

/* ---------------- 结果展示 ---------------- */

function hideAllResultBlocks() {
  dom.placeholder.hidden = true;
  dom.card.hidden = true;
  dom.empty.hidden = true;
}

function showResult(dish, meta) {
  hideAllResultBlocks();
  dom.name.textContent = dish.name;
  dom.note.textContent = dish.note;
  dom.price.textContent = `${dish.price} 元`;
  dom.place.textContent = dish.place;
  dom.spicy.textContent = SPICY_LABELS[dish.spicyLevel] || '未知';
  dom.type.textContent = dish.type;

  if (meta.reason === 'repeated') {
    dom.cardLabel.textContent = '就决定是它了（重复）';
    dom.tip.textContent = `符合条件的餐品只剩这几道，已经推荐过了。放宽一点条件能换个花样。`;
    dom.tip.hidden = false;
  } else {
    dom.cardLabel.textContent = '就决定是它了';
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
  dom.empty.hidden = false;
}

/* ---------------- 连点保护 ---------------- */
/**
 * 连续快速点击推荐按钮时，只在最后一次点击上播放动画。
 * 用令牌（revealToken）判断"这次收尾是不是最新的一次"，旧定时器直接作废，
 * 所以不会出现多个动画叠在一起，也不会残留状态把按钮卡住。
 */
function playRevealAnimation() {
  const token = ++revealToken;

  dom.recommendBtn.classList.remove('is-tapped');
  dom.card.classList.remove('is-revealing');
  void dom.recommendBtn.offsetWidth; // 强制浏览器重排，这样动画才会重新播放
  void dom.card.offsetWidth;
  dom.recommendBtn.classList.add('is-tapped');
  dom.card.classList.add('is-revealing');

  setTimeout(() => {
    if (token !== revealToken) return; // 期间又点过了，交给新的那一次处理
    dom.recommendBtn.classList.remove('is-tapped');
    dom.card.classList.remove('is-revealing');
  }, REVEAL_MS);
}

/* ---------------- 推荐 ---------------- */

function recommend() {
  const candidates = filterDishes(DISHES, criteria);
  if (candidates.length === 0) {
    showEmpty();
    return null;
  }

  const recentIds = history.map((item) => item.id);
  const { dish, reason } = pickDish(candidates, recentIds, Math.random);
  if (!dish) {
    showEmpty();
    return null;
  }

  pushHistory(dish);
  showResult(dish, { reason, candidateCount: candidates.length });
  return dish;
}

function pushHistory(dish) {
  const record = { id: dish.id, name: dish.name, place: dish.place, price: dish.price, at: Date.now() };
  history = [record, ...history.filter((item) => item.id !== dish.id)].slice(0, HISTORY_LIMIT);
  saveJSON(HISTORY_KEY, history);
  renderHistory();
}

function renderHistory() {
  if (!dom.historyList) return;
  dom.historyList.textContent = '';
  history.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = `${item.name}（${item.place} · ${item.price} 元）`;
    dom.historyList.appendChild(li);
  });
  if (dom.historyEmpty) dom.historyEmpty.hidden = history.length > 0;
}

/* ---------------- 重置 ---------------- */

function resetFilters() {
  criteria = { ...DEFAULT_CRITERIA };
  saveJSON(SETTINGS_KEY, criteria);
  renderAllControls();
  updateCandidateCount();
  hideAllResultBlocks();
  dom.placeholder.hidden = false;
  pendingRelax = null;
}

function clearHistory() {
  history = [];
  saveJSON(HISTORY_KEY, history);
  renderHistory();
}

/* ---------------- 事件绑定 ---------------- */

dom.recommendBtn.addEventListener('click', () => recommend());

dom.resetBtn.addEventListener('click', () => resetFilters());

dom.emptyRelaxBtn.addEventListener('click', () => {
  if (!pendingRelax) return;
  criteria = normalizeCriteria(pendingRelax);
  pendingRelax = null;
  saveJSON(SETTINGS_KEY, criteria);
  renderAllControls();
  updateCandidateCount();
  recommend();
});

if (dom.clearHistoryBtn) dom.clearHistoryBtn.addEventListener('click', () => clearHistory());

/* ---------------- 启动 ---------------- */

renderAllControls();
updateCandidateCount();
renderHistory();
if (dom.placeholder) dom.placeholder.hidden = false;

/* 给自动测试（tests/browser-selftest.js）和手动排查用的入口，不影响正常使用 */
window.__whatToEat = {
  version: '1.0.0',
  dishes: DISHES,
  getCriteria: () => ({ ...criteria }),
  setCriteria(next) {
    criteria = normalizeCriteria(next);
    afterCriteriaChange();
  },
  getHistory: () => history.map((item) => ({ ...item })),
  countCandidates: () => filterDishes(DISHES, criteria).length,
  recommend,
  resetFilters,
  clearHistory,
};

/* 浏览器自测：地址后面加 ?selftest=1 时，才加载测试脚本（平时不会加载） */
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
