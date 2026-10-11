/**
 * aggregate.js —— 匿名的「只进不出」反馈计数（客户端那一半）
 *
 * 三条纪律：
 *   1) **只进不出**：本文件**只有 POST**，没有任何读取路径 —— 聚合数据永远不回灌个人推荐。
 *   2) **事件最小化**：只发 {v, dishId, kind, day, tz}；不含设备 id、cookie、IP、UA、点击序列。
 *   3) **失败静默**：离线 / DNT / 网络失败一律直接丢弃，不重试、不排队、不阻塞 UI。
 *
 * **默认空转**：端点没配置（WHAT_TO_EAT_AGGREGATE.endpoint 为空）时，一个字节都不发 ——
 * 线上站点在你部署完函数之前，行为与本模块不存在时完全一致。
 *
 * 关掉上报：localStorage 里把 whatToEat.aggregate.optOut 设成 '1'（页面上有开关）。
 */
(function (root) {
  const CFG = (root && root.WHAT_TO_EAT_AGGREGATE) || {};

  /**
   * 端点解析，三条规则依次判断：
   *   1) **显式配置优先**：window.WHAT_TO_EAT_AGGREGATE.endpoint 有值就用它（本地联调指到 8888 那种）；
   *   2) **部署在 Netlify 上就自动指到本站的 feedback 函数**（含 deploy preview / 分支部署，各自指向自己那一份）；
   *   3) **其它环境一律空转**：file:// 直开、局域网 server.js、GitHub Pages 都保持空 —— 一个字节都不发。
   * 每次发送前重新解析，所以改配置立刻生效。
   */
  function resolveEndpoint() {
    const cfg = (root && root.WHAT_TO_EAT_AGGREGATE) || CFG;
    if (typeof cfg.endpoint === 'string' && cfg.endpoint.trim()) return cfg.endpoint.trim();
    try {
      if (/(^|\.)netlify\.app$/i.test(root.location.hostname)) {
        return `${root.location.origin}/.netlify/functions/feedback`;
      }
    } catch { /* 没有 location（测试环境）：按空转处理 */ }
    return '';
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
