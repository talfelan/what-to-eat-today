/**
 * netlify/functions/feedback.mjs —— 匿名反馈的**写入端点**（只进不出）
 *
 * 三条纪律（与 docs/10-云端匿名反馈库方案-待批.md 一一对应）：
 *   1) **只写不读**：本函数永远不回业务数据（成功 204、失败 4xx，体里没有任何计数）。
 *   2) **事件最小化**：只接受 {v, dishId, kind, day, tz}；不收设备 id、不落 IP、不落 UA、不设 cookie。
 *   3) **校验先于写入**：字段白名单 + 枚举 + 格式 + 长度上限，任一不过直接丢弃（不报错细节，防探测）。
 *
 * 计数放在 Netlify Blobs 里，**每次互动一条追加式事件键**（`e:<day>:<dishId>:<kind>:<随机>`），
 * 不做读-改-写 —— 所以并发点击既不覆盖也不会丢（两版计数器实现的失败现场见 docs/12 §十）。
 * 聚合在运营者视图读取时按前缀统计。本地测试用 createHandler({ getStore }) 注入假存储，
 * 所以这份判定逻辑**不需要真部署就能验**（见 tools/verify-feedback-gate.mjs）。
 *
 * 部署后：feedback 函数的地址填进 index.html 的 window.WHAT_TO_EAT_AGGREGATE.endpoint。
 */

const KINDS = new Set(['like', 'dislike', 'unlike', 'undislike']);
const ALLOWED_KEYS = new Set(['v', 'dishId', 'kind', 'day', 'tz']);
const ID_RE = /^d\d{4}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 512;

/** 校验一条事件；不合法返回 null（调用方一律丢弃，不回细节） */
export function validate(body) {
  if (!body || typeof body !== 'object') return null;
  // **严格白名单**：多带任何字段都拒收 —— 这样端点物理上存不下设备 id / UA 之类的额外标识
  if (Object.keys(body).some((k) => !ALLOWED_KEYS.has(k))) return null;
  if (body.v !== 1) return null;
  if (typeof body.dishId !== 'string' || !ID_RE.test(body.dishId)) return null;
  if (typeof body.kind !== 'string' || !KINDS.has(body.kind)) return null;
  if (typeof body.day !== 'string' || !DAY_RE.test(body.day)) return null;
  const tz = Number.isFinite(body.tz) ? Math.max(-840, Math.min(840, Math.trunc(body.tz))) : 0;
  return { dishId: body.dishId, kind: body.kind, day: body.day, tz };
}

/** 限流器（尽力而为，单实例内存；不要当安全边界，只当降噪） */
function makeLimiter(limit = 60, windowMs = 60000) {
  const hits = new Map();
  return (key, nowMs) => {
    const list = (hits.get(key) || []).filter((t) => nowMs - t < windowMs);
    if (list.length >= limit) return false;
    list.push(nowMs);
    hits.set(key, list);
    return true;
  };
}

/**
 * 事件键：**追加式**（`e:<day>:<dishId>:<kind>:<随机后缀>`）。
 *
 * 为什么不存「计数」而存「事件」——线上实测两次教训（2026-10-11）：
 *   ① 计数器 + 读-改-写 ⇒ 快速两次点击**互相覆盖**（d0050 的 like 被 unlike 盖掉）；
 *   ② 计数器 + etag 条件写 ⇒ 刚写过就读到旧值时条件写连续失败，5 次重试后只能丢弃（d0071 的 unlike 丢了）。
 * 追加式只新增键、从不改写，**既不会覆盖也不会冲突**；聚合交给运营者视图在读取时按前缀统计。
 * 代价是键变多（每菜每天每次互动一个键），在这个量级完全可接受。
 */
export const eventKey = (day, dishId, kind) =>
  `e:${day}:${dishId}:${kind}:${Math.random().toString(36).slice(2, 10)}`;

export async function recordEvent(store, event) {
  await store.setJSON(eventKey(event.day, event.dishId, event.kind), { tz: event.tz, at: new Date().toISOString() });
  return true;
}

export function createHandler({ getStore, now = () => new Date(), limit = 60 }) {
  const allow = makeLimiter(limit);
  return async function handler(req) {
    if (req.method !== 'POST') return new Response('', { status: 405 });
    const raw = await req.text().catch(() => '');
    if (!raw || raw.length > MAX_BODY) return new Response('', { status: 400 });

    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { return new Response('', { status: 400 }); }
    const event = validate(parsed);
    if (!event) return new Response('', { status: 400 });

    const ip = (req.headers && (req.headers.get ? req.headers.get('x-nf-client-connection-ip') : null)) || 'unknown';
    if (!allow(ip, now().getTime())) return new Response('', { status: 429 });

    try {
      const store = getStore('feedback');
      await recordEvent(store, event);               // 追加式：不做读-改-写，不存在覆盖/冲突
    } catch {
      return new Response('', { status: 503 });      // 存储故障：让客户端静默丢弃，不重试
    }
    return new Response(null, { status: 204 });       // **永远不回业务数据**
  };
}

export default async function (req) {
  const { getStore } = await import('@netlify/blobs');
  return createHandler({ getStore })(req);
}
