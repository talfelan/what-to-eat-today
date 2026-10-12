/**
 * netlify/functions/operator.mjs —— 运营者看板（不公开）：只进不出的那个「出」—— 只有持 OPERATOR_TOKEN 的人能看到聚合数据。
 *
 * ⚠️ **已弃用（2026-10-12 定性为弃子）**：现役看板是 Cloudflare Worker 的
 *    https://what-to-eat-feedback.talfelan.workers.dev/dashboard （读 D1，见 `worker/`）。
 * 本函数只剩两条作用：① `/dashboard` **302 跳到现役看板**（老书签继续可用）；
 * ② `?data=1` + 旧口令仍能读 Netlify Blobs 里的**历史数据**。
 * 它不接新反馈、不被任何现役判据读取；自检是 `tools/verify-netlify-legacy.mjs`（不进 verify-all）。
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
/** 看板页面已迁到 Cloudflare Worker（D1）：老的 /dashboard 一律跳到这里 */
const WORKER_DASHBOARD = 'https://what-to-eat-feedback.talfelan.workers.dev/dashboard';
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

export function createHandler({ getStore: getStoreImpl = getStore, operatorToken = null } = {}) {  // 生产环境不传 operatorToken：按**请求**读环境变量（部署后改 env 只需重新部署，不必重新打包逻辑）
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

      // 看板页面已迁到 Cloudflare Worker（D1 存储、免费额度更高）：
      // 这里只做 302 跳转，让老的 /dashboard 书签继续可用，旧的 Blobs 页面不再维护。
      // ?data=1 的 JSON 接口保留（读的是本函数自己的 Blobs，历史数据仍可查）。
      return new Response(null, {
        status: 302,
        headers: { location: WORKER_DASHBOARD, 'cache-control': 'no-store' },
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

/**
 * Netlify Functions 的入口：**必须有默认导出**，否则函数加载不了、整条路由 502
 * （2026-10-11 实测踩过：重写时只留了 createHandler，线上立刻变 502）。
 */
export default createHandler();

/** 交互页面：自包含（无外链），口令只存在你自己的浏览器 localStorage 里 */
