/**
 * aggregate.js —— 匿名的「只进不出」反馈计数（客户端那一半）
 *
 * 三条纪律：
 *   1) **只进不出**：本文件**只有 POST**，没有任何读取路径 —— 聚合数据永远不回灌个人推荐。
 *   2) **事件最小化**：只发 {v, dishId, kind, day, tz}；不含设备 id、cookie、IP、UA、点击序列。
 *   3) **失败静默**：离线 / DNT / 网络失败一律直接丢弃，不重试、不排队、不阻塞 UI。
 *
 * **默认空转**：端点没配置（WHAT_TO_EAT_AGGREGATE.endpoint 为空）时，一个字节都不发。
 *
 * **后端无关（2026-10-12 做的隔离）**：本模块**不认识任何后端** —— 端点只从显式配置读，
 * 绝不按宿主名（netlify.app / workers.dev / …）去推断该往哪发。
 * 为什么拆掉这条兜底：按宿主推断等于把两条反馈链耦合在客户端里，一方改名/停用/断连会**静默**
 * 改变另一方的去向（真实事故：Netlify 副本的 endpoint 为空，兜底把它指到了已停用的旧函数，
 * 那批学生的红心全进了另一个库，看板一直看不到）。
 * 现役后端 = Cloudflare Worker（见 `worker/`）；`netlify/` 是弃子模块，客户端不再提它。
 *
 * 关掉上报：localStorage 里把 whatToEat.aggregate.optOut 设成 '1'（页面上有开关）。
 */
(function (root) {
  const CFG = (root && root.WHAT_TO_EAT_AGGREGATE) || {};

  /**
   * 端点解析：**只有一条规则** —— 显式配置 `window.WHAT_TO_EAT_AGGREGATE.endpoint` 有值就用它，
   * 没有就空转（一个字节都不发）。
   *
   * 为什么不按宿主推断（这里曾经有过第二条规则「部署在 Netlify 上就自动指到本站函数」）：
   * 那会让客户端同时认识两条反馈链，任何一侧改名、停用或断连都会**静默改变另一侧的归属**。
   * 想让某个页面指向某个后端，就在它的 index.html 里写死那个端点 ——
   * **配置是唯一的耦合点**，看得见、可 diff、可回滚。
   * 每次发送前重新解析，所以改配置立刻生效。
   */
  function resolveEndpoint() {
    const cfg = (root && root.WHAT_TO_EAT_AGGREGATE) || CFG;
    const raw = cfg && cfg.endpoint;
    return typeof raw === 'string' ? raw.trim() : '';
  }
  let ENDPOINT = resolveEndpoint();
  const OPT_OUT_KEY = 'whatToEat.aggregate.optOut';

  const ACTIONS = {
    hearts: { added: 'like', removed: 'unlike' },
    downs: { added: 'dislike', removed: 'undislike' },
  };

  function optedOut() {
    try { return root.localStorage.getItem(OPT_OUT_KEY) === '1'; } catch { return true; }
  }

  /** 组装一条最小事件；day 用**本机日期**，tz 是分钟偏移 */
  function buildEvent(dishId, kind, action, now) {
    const map = ACTIONS[kind];
    if (!map || !map[action]) return null;
    if (typeof dishId !== 'string' || !/^d\d{4}$/.test(dishId)) return null;
    const d = now || new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return {
      v: 1,
      dishId,
      kind: map[action],
      day: local.toISOString().slice(0, 10),
      tz: d.getTimezoneOffset() * -1,
    };
  }

  /** 该不该发：端点存在、没关上报、在线、没开 DNT */
  function shouldSend(env) {
    const e = env || {};
    if (!ENDPOINT) return false;
    if (optedOut()) return false;
    if (e.onLine === false) return false;
    if (String(e.doNotTrack || '') === '1') return false;
    if (typeof e.sendBeacon !== 'function') return false;
    return true;
  }

  /**
   * 发送用的内容类型必须是 **CORS 简单类型**（text/plain）。
   *
   * 2026-10-11 实测（隔离实验，判据是服务端 /healthz 的增量）：
   *   · sendBeacon + application/json（跨域）→ **事件被浏览器静默丢弃**，而 sendBeacon 仍返回 true
   *   · sendBeacon + text/plain                     → 送达 ✅
   *   · fetch keepalive + 任意类型                  → 送达 ✅
   * 所以这里固定用 text/plain（服务端按 JSON 解析 body，不依赖 content-type）。
   * 门禁 tools/verify-feedback-gate.mjs 有对应判据，防它回归。
   */
  const BEACON_TYPE = 'text/plain;charset=UTF-8';

  function enqueue(input) {
    ENDPOINT = resolveEndpoint();
    const event = buildEvent(input && input.dishId, input && input.kind, input && input.action);
    if (!event) return 'skipped';
    const nav = root.navigator || {};
    const env = { onLine: nav.onLine, doNotTrack: nav.doNotTrack || root.doNotTrack, sendBeacon: nav.sendBeacon && nav.sendBeacon.bind(nav) };
    if (!shouldSend(env)) return 'skipped';
    const body = JSON.stringify(event);
    try {
      const ok = nav.sendBeacon(ENDPOINT, new Blob([body], { type: BEACON_TYPE }));
      return ok ? 'sent' : 'dropped';
    } catch {
      return 'dropped';                       // 失败静默：绝不重试、绝不入队
    }
  }

  function setOptOut(value) {
    try { root.localStorage.setItem(OPT_OUT_KEY, value ? '1' : '0'); } catch { /* 隐私模式：忽略 */ }
    return optedOut();
  }

  root.aggregate = {
    enqueue,
    setOptOut,
    isOptedOut: optedOut,
    get endpoint() { return resolveEndpoint(); },            // 活值：改配置后立刻反映（不是加载时的快照）
    _buildEvent: buildEvent,
    _shouldSend: shouldSend,
  };
})(typeof window !== 'undefined' ? window : globalThis);
