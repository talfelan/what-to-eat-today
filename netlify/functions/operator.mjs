/**
 * 运营者看板（不公开）：只进不出的那个「出」—— 只有持 OPERATOR_TOKEN 的人能看到聚合数据。
 *
 * 固定网址：`/dashboard`（netlify.toml 里把 /dashboard 重写到本函数），所以不用记长地址。
 * 鉴权：token 可放在 `?token=`（兼容旧链接、方便一次性打开），也可放在请求头 `x-operator-token`
 *      —— 页面用后者，**登录之后地址栏里就不再带口令**，口令只存在你自己的浏览器里。
 * 路由：
 *   GET  /dashboard                      → 交互页面（令牌输入 + 数据表 + 单选/多选/全选删除）
 *   GET  /dashboard?data=1&days=N        → JSON 数据
 *   POST /dashboard  {action:'delete', dishIds:[...] | all:true, days:N} → 删除事件
 * 数据来源：feedback.mjs 写下的**追加式事件键** `e:<day>:<dishId>:<kind>:<rand>`；
 *          本视图在读取时按前缀统计（写侧不做读-改-写，所以并发既不覆盖也不丢）。
 * 兼容：更早的两代布局（`c:<day>:<dishId>` 计数键、`day:<YYYY-MM-DD>` 一天的 JSON）也会被算进来。
 */

import { getStore } from '@netlify/blobs';

const KINDS = ['like', 'dislike', 'unlike', 'undislike'];
const EVENT_PREFIX = 'e';
const COUNTER_PREFIX = 'c';
const LEGACY_PREFIX = 'day';

const dayString = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);

/** 取窗口内所有事件键（含两代旧布局），返回 事件项 与 按菜聚合的行 */
async function collect(store, want) {
  const events = [];
  const legacyKeys = [];
  const rows = new Map();
  const bump = (dishId, kind, n = 1) => {
    if (!dishId || !KINDS.includes(kind)) return;
    const cur = rows.get(dishId) || { dishId, like: 0, dislike: 0, unlike: 0, undislike: 0 };
    cur[kind] += n;
    rows.set(dishId, cur);
  };

  for (let i = 0; i < want; i += 1) {
    const d = dayString(i);
    /* eslint-disable no-await-in-loop */
    const { blobs } = await store.list({ prefix: `${EVENT_PREFIX}:${d}:` });
    blobs.forEach((b) => {
      const [, , dishId, kind] = b.key.split(':');
      events.push({ key: b.key, day: d, dishId, kind });
      bump(dishId, kind);
    });
    const counters = await store.list({ prefix: `${COUNTER_PREFIX}:${d}:` });
    for (const b of counters.blobs) {
      const rec = await store.get(b.key, { type: 'json' });
      if (rec) { KINDS.forEach((k) => bump(b.key.split(':')[2], k, Number(rec[k] || 0))); legacyKeys.push(b.key); }
    }
    const legacy = await store.get(`${LEGACY_PREFIX}:${d}`, { type: 'json' });
    if (legacy && legacy.counts) {
      Object.entries(legacy.counts).forEach(([id, c]) => KINDS.forEach((k) => bump(id, k, Number(c[k] || 0))));
      legacyKeys.push(`${LEGACY_PREFIX}:${d}`);
    }
  }
  return { events, legacyKeys, rows };
}

const withNet = (rows) => [...rows.values()]
  .map((r) => ({ ...r, net: r.like - r.unlike, netDown: r.dislike - r.undislike, total: r.like + r.dislike + r.unlike + r.undislike }))
  .sort((a, b) => (b.total - a.total) || a.dishId.localeCompare(b.dishId));

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const readToken = (req, url, body) => {
  const raw = url.searchParams.get('token')
    || req.headers.get('x-operator-token')
    || (body && typeof body.token === 'string' ? body.token : '')
    || '';
  return raw.trim();
};

export function createHandler({ getStore: getStoreImpl = getStore, operatorToken = null } = {}) {
  // 生产环境不传 operatorToken：按**请求**读环境变量（部署后改 env 只需重新部署，不必重新打包逻辑）
  const tokenOf = () => (operatorToken === null ? process.env.OPERATOR_TOKEN : operatorToken);
  return async (req) => {
    const url = new URL(req.url);

    // —— 读请求：页面与数据 ——
    if (req.method === 'GET' || req.method === 'HEAD') {
      const wantsData = url.searchParams.get('data') === '1';
      const token = readToken(req, url);
      const expected = tokenOf();
      const okToken = Boolean(expected) && token === expected;

      if (wantsData) {
        if (!okToken) return new Response('', { status: 404, headers: { 'cache-control': 'no-store' } });
        const want = Math.min(30, Math.max(1, Number((url.searchParams.get('days') || '7').replace(/[^0-9]/g, '')) || 7));
        try {
          const store = getStoreImpl('feedback');
          const { rows } = await collect(store, want);
          return json({ ok: true, days: want, rows: withNet(rows) });
        } catch {
          return json({ ok: false, error: '读取失败（存储暂时不可用）' }, 503);
        }
      }

      // 页面本身：**不含 token**（口令由页面问你，存在你自己的浏览器里）
      return new Response(page(want1(url)), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
      });
    }

    // —— 写请求：删除选中条目 ——
    if (req.method === 'POST') {
      let body = null;
      try { body = JSON.parse(await req.text()); } catch { body = null; }
      const token = readToken(req, url, body);
      if (!body || typeof body !== 'object') return new Response('', { status: 400 });
      const expected = tokenOf();
      if (!expected || token !== expected) return new Response('', { status: 404, headers: { 'cache-control': 'no-store' } });

      const want = Math.min(30, Math.max(1, Number(body.days) || 7));
      const all = body.all === true;
      const wanted = Array.isArray(body.dishIds) ? body.dishIds.filter((x) => typeof x === 'string') : [];
      if (!all && wanted.length === 0) return new Response('', { status: 400 });

      try {
        const store = getStoreImpl('feedback');
        const { events, legacyKeys } = await collect(store, want);
        const pick = events.filter((e) => all || wanted.includes(e.dishId));
        for (const e of pick) { /* eslint-disable no-await-in-loop */ await store.delete(e.key); }
        // 旧布局的整键删除只在「全删」时做（它们无法按菜拆分）
        let legacyDeleted = 0;
        if (all) { for (const k of legacyKeys) { await store.delete(k); legacyDeleted += 1; } }
        return json({ ok: true, deleted: pick.length, legacyDeleted, dishIds: all ? null : wanted });
      } catch {
        return json({ ok: false, error: '删除失败（存储暂时不可用）' }, 503);
      }
    }

    return new Response('', { status: 405, headers: { allow: 'GET, POST' } });
  };
}

const want1 = (url) => Math.min(30, Math.max(1, Number((url.searchParams.get('days') || '7').replace(/[^0-9]/g, '')) || 7));

/**
 * Netlify Functions 的入口：**必须有默认导出**，否则函数加载不了、整条路由 502
 * （2026-10-11 实测踩过：重写时只留了 createHandler，线上立刻变 502）。
 */
export default createHandler();

/** 交互页面：自包含（无外链），口令只存在你自己的浏览器 localStorage 里 */
function page(days) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>反馈看板（运营者）</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 16px; background: #f6f7f9; color: #1c1c1e; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .muted { color: #6b7280; font-size: 12px; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; }
  button, input, select { font: inherit; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: inherit; }
  button { cursor: pointer; min-height: 40px; }
  button[disabled] { opacity: .5; cursor: not-allowed; }
  button.danger { border-color: #ef4444; color: #b91c1c; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 10px; overflow: hidden; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #eef0f3; text-align: left; white-space: nowrap; }
  th { background: #f3f4f6; font-weight: 600; font-size: 12px; color: #374151; }
  td.num, th.num { text-align: right; }
  tr.sel { background: #fff7ed; }
  .card { background: #fff; border-radius: 10px; padding: 14px; max-width: 520px; }
  .msg { margin-left: auto; font-size: 13px; }
  .msg.ok { color: #047857; } .msg.err { color: #b91c1c; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
</style>
</head>
<body>
<h1>反馈看板（仅运营者可见）</h1>
<p class="muted">只进不出：学生页读不到这里的数据；口令只保存在你自己的浏览器里，不写进页面。</p>

<div id="gate" class="card" hidden>
  <p><strong>请输入运营者口令</strong></p>
  <p class="muted">就是在 Netlify 环境变量里设的那个 <code>OPERATOR_TOKEN</code>。</p>
  <div class="bar">
    <input id="token" type="password" placeholder="口令" autocomplete="off" style="flex:1;min-width:200px">
    <button id="save">进入</button>
  </div>
  <p id="gateMsg" class="muted"></p>
</div>

<div id="app" hidden>
  <div class="bar">
    <label class="muted">统计天数
      <select id="days">
        ${[1, 3, 7, 14, 30].map((n) => `<option value="${n}"${n === days ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </label>
    <button id="refresh">刷新</button>
    <button id="selAll">全选</button>
    <button id="selNone">全不选</button>
    <button id="delSel" class="danger" disabled>删除选中</button>
    <button id="delAll" class="danger">删除全部</button>
    <button id="forget">退出口令</button>
    <span id="msg" class="msg"></span>
  </div>
  <p class="muted" id="summary"></p>
  <div id="tableWrap"></div>
</div>

<script>
(function () {
  var KEY = 'whatToEat.operatorToken';
  var token = localStorage.getItem(KEY) || '';
  // 兼容旧的长链接：地址里带 ?token= 时自动进入，并记到本机（下次访问 /dashboard 就不用再带口令）
  try {
    var fromUrl = new URLSearchParams(location.search).get('token');
    if (fromUrl) { token = fromUrl.trim(); if (token) localStorage.setItem(KEY, token); }
  } catch (e) { /* 忽略 */ }
  var rows = [];
  var picked = new Set();
  var $ = function (id) { return document.getElementById(id); };

  function msg(text, kind) {
    var m = $('msg');
    m.textContent = text || '';
    m.className = 'msg ' + (kind || '');
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    headers['x-operator-token'] = token;
    return fetch(path, Object.assign({}, opts, { headers: headers }));
  }

  function showGate(text) {
    $('app').hidden = true;
    $('gate').hidden = false;
    $('gateMsg').textContent = text || '';
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  var names = {};
  function loadNames() {
    return fetch('/dish-names.json').then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { names = j || {}; }).catch(function () { names = {}; });
  }

  function render() {
    var wrap = $('tableWrap');
    if (!rows.length) {
      wrap.innerHTML = '<div class="card"><p>这个窗口内还没有任何反馈。</p><p class="muted">学生在页面上点红心/差评后，这里约 15–30 秒出现。</p></div>';
      $('summary').textContent = '';
      $('delSel').disabled = true;
      return;
    }
    var head = '<tr><th><input type="checkbox" id="all"></th><th>菜名</th><th>id</th>'
      + '<th class="num">红心</th><th class="num">撤销红心</th><th class="num">差评</th><th class="num">撤销差评</th>'
      + '<th class="num">净</th><th class="num">净踩</th><th class="num">合计</th></tr>';
    var body = rows.map(function (r) {
      var on = picked.has(r.dishId);
      return '<tr class="' + (on ? 'sel' : '') + '">'
        + '<td><input type="checkbox" data-id="' + esc(r.dishId) + '"' + (on ? ' checked' : '') + '></td>'
        + '<td>' + esc(names[r.dishId] || '（名称未找到）') + '</td>'
        + '<td class="muted">' + esc(r.dishId) + '</td>'
        + '<td class="num">' + r.like + '</td><td class="num">' + r.unlike + '</td>'
        + '<td class="num">' + r.dislike + '</td><td class="num">' + r.undislike + '</td>'
        + '<td class="num"><strong>' + r.net + '</strong></td><td class="num">' + r.netDown + '</td><td class="num">' + r.total + '</td></tr>';
    }).join('');
    wrap.innerHTML = '<table>' + head + body + '</table>';
    $('summary').textContent = '共 ' + rows.length + ' 道菜有反馈，已选 ' + picked.size + ' 条。净＝红心−撤销红心，净踩＝差评−撤销差评。';
    $('delSel').disabled = picked.size === 0;
    var all = $('all');
    if (all) {
      all.checked = picked.size === rows.length;
      all.onchange = function () { picked = all.checked ? new Set(rows.map(function (r) { return r.dishId; })) : new Set(); render(); };
    }
    wrap.querySelectorAll('input[data-id]').forEach(function (box) {
      box.onchange = function () {
        if (box.checked) picked.add(box.dataset.id); else picked.delete(box.dataset.id);
        render();
      };
    });
  }

  function load() {
    msg('读取中…');
    return api('?data=1&days=' + $('days').value).then(function (r) {
      if (r.status === 404) { showGate('口令不对，或者环境变量还没设。'); return null; }
      if (!r.ok) { msg('读取失败：' + r.status, 'err'); return null; }
      return r.json();
    }).then(function (j) {
      if (!j) return;
      rows = j.rows || [];
      picked = new Set();
      $('app').hidden = false; $('gate').hidden = true;
      render();
      msg('已更新 ' + new Date().toLocaleTimeString(), 'ok');
    }).catch(function (e) { msg('网络错误：' + e.message, 'err'); });
  }

  function del(payload, label) {
    if (!confirm(label)) return;
    msg('删除中…');
    api('?days=' + $('days').value, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ days: Number($('days').value) }, payload)),
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (j) {
        // 平台的读取路径有延迟（写入约 15–30 秒、**删除约 60 秒**才反映到列表），
        // 所以删除成功后先在本机把这批行移掉，界面立刻是一致的样子；稍后刷新拿到的也是同样的结果。
        if (payload.all) rows = [];
        else if (j.dishIds) rows = rows.filter(function (r) { return j.dishIds.indexOf(r.dishId) < 0; });
        picked = new Set();
        render();
        msg('已删除 ' + j.deleted + ' 条（平台列表延迟约 1 分钟，稍后刷新即完全一致）', 'ok');
      })
      .catch(function (e) { msg('删除失败：' + e.message, 'err'); });
  }

  $('save').onclick = function () {
    token = $('token').value.trim();
    if (!token) { $('gateMsg').textContent = '请先输入口令。'; return; }
    localStorage.setItem(KEY, token);
    load();
  };
  $('forget').onclick = function () { localStorage.removeItem(KEY); token = ''; rows = []; picked = new Set(); showGate('已退出口令。'); };
  $('refresh').onclick = load;
  $('days').onchange = load;
  $('selAll').onclick = function () { picked = new Set(rows.map(function (r) { return r.dishId; })); render(); };
  $('selNone').onclick = function () { picked = new Set(); render(); };
  $('delSel').onclick = function () { del({ dishIds: Array.from(picked) }, '删除选中的 ' + picked.size + ' 道菜的全部反馈？'); };
  $('delAll').onclick = function () { del({ all: true }, '删除该窗口内**全部**反馈？此操作不可撤销。'); };

  loadNames().then(function () {
    if (token) load(); else showGate('');
  });
})();
</script>
</body>
</html>`;
}
