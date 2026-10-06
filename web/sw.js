/*!
 * ZY影视 网页版 —— Service Worker 本地代理(相当于 App 里的 core/LocalProxy)
 *
 * 路径: /p?t=<令牌>&q=<base64url(真实地址)>&r=<Referer>&c=<Cookie>
 *   (老写法 &u=<URL> 仍然认, 但**不要用**: Cloudflare 的 WAF 会拦"参数里带 URL"的请求,
 *    q=<base64> 实测能正常放行 —— 详见 web/proxy/worker.js 里的说明)
 *   · 清单(m3u8): 先跑 adfilter.js 清洗广告, 再把里面每条地址(含 #EXT-X-KEY/MAP/MEDIA 的 URI、
 *     master 里的变体地址)改写成同样走本代理的地址 —— 这样分片也能带上 Referer/Cookie;
 *   · 分片/普通文件: 透传字节(保留 Range/206/Content-Range), 因为播放器要靠它做断点与拖进度。
 *
 * 为什么非要这一层: 浏览器里页面**不能**给媒体请求加 Referer/User-Agent(禁止头),
 * 也不能改写响应体(唯一的办法就是 Service Worker)。广告过滤要改 m3u8, 就必须走这里。
 */
'use strict';
importScripts('adfilter.js');

const SWTOKEN = 'zyweb';          // 与 bridge.js 里的 SWTOKEN 无关: 这个只防随手枚举
const CACHE_MAX = 40;             // 自建清单缓存(把"没有分区地址的清单"拼成完整清单时用)

function b64u(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  try {
    const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (e) { return ''; }
}

function q(url) {
  const u = new URL(url);
  const enc = u.searchParams.get('q') || '';
  return {
    u: enc ? unb64u(enc) : (u.searchParams.get('u') || ''),
    r: u.searchParams.get('r') || '',
    c: u.searchParams.get('c') || '',
    t: u.searchParams.get('t') || ''
  };
}
/* 上游要不要走 CORS 代理(Cloudflare Worker):
   直播源/部分片源**没有 CORS 头**, Service Worker 直接 fetch 会拿到不透明响应(读不到字节) ——
   表现就是"视频黑屏、直播完全看不了"。由 Worker 去取就没这个问题, 顺带还能代填 Referer/UA。
   配置来源两条: ① 页面 bridge.js 用 postMessage 送过来(能带上运行时改过的值); ② 自己读 /webconfig.js 兜底。 */
let PROXY = '', PROXY_TOKEN = 'zyweb', cfgTried = false;
function normProxy(p) {
  p = String(p || '').trim().replace(/\/+$/, '');
  if (p && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = 'https://' + p;
  return p;
}
let cfgAt = 0;
async function loadCfgFile() {
  if (PROXY) return;
  if (cfgTried && Date.now() - cfgAt < 30000) return;   // 失败过就 30 秒后再试(以前失败一次就永远不试了)
  cfgTried = true; cfgAt = Date.now();
  try {
    const txt = await (await fetch('/webconfig.js', { cache: 'no-store' })).text();
    const mp = /proxy:\s*saved\.proxy\s*\|\|\s*'([^']*)'/.exec(txt) || /proxy:\s*'([^']*)'/.exec(txt);
    const mt = /token:\s*saved\.token\s*\|\|\s*'([^']*)'/.exec(txt) || /token:\s*'([^']*)'/.exec(txt);
    if (mp) PROXY = normProxy(mp[1]);
    if (mt && mt[1]) PROXY_TOKEN = mt[1];
    try { console.log('[ZY影视 SW] 上游出口 = ' + (PROXY || '(未配置, 直连)')); } catch (e2) {}
  } catch (e) {}
}
self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type === 'proxycfg') {
    const p = normProxy(d.proxy);
    if (p) PROXY = p;
    if (d.token) PROXY_TOKEN = String(d.token);
  }
});
// 站点与代理同一台时用同源(少一次跨域); 分开部署时仍用 PROXY
function proxyBase() {
  try { if (PROXY && (new URL(PROXY)).host === self.location.host) return self.location.origin; } catch (e) {}
  return PROXY;
}
function proxyUrl(u, path, r, c) {
  return proxyBase() + path + '?t=' + encodeURIComponent(PROXY_TOKEN) + '&q=' + b64u(u)
    + (r ? '&r=' + encodeURIComponent(r) : '') + (c ? '&c=' + encodeURIComponent(c) : '');
}

function isM3u8(url, ctype) {
  return /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(ctype || '');
}
function abs(base, rel) {
  try { return new URL(rel, base).toString(); } catch (e) { return rel; }
}
function selfUrl(u, r, c) {
  // 清单里可能已经是"Worker 改写过的绝对地址"(/f? 或 /p?) —— 那层代理已经很好了, 别再套一层。
  // 同源那一份必须**无条件**认出来(不依赖 PROXY 配置是否读到), 否则会包成"代理的代理"→
  // Worker 去 fetch 自己 → 522。
  var _self = '';
  try { _self = self.location.origin + self.location.pathname.replace(/[^/]*$/, ''); } catch (e) {}
  var _u = String(u);
  if (_self && (_u.indexOf(_self + 'f?') === 0 || _u.indexOf(_self + 'p?') === 0)) return u;
  var _pb = proxyBase();
  if (_pb && (_u.indexOf(_pb + '/f?') === 0 || _u.indexOf(_pb + '/p?') === 0)) return u;
  if (PROXY && (_u.indexOf(PROXY + '/f?') === 0 || _u.indexOf(PROXY + '/p?') === 0)) return u;
  const qs = 'p?t=' + SWTOKEN + '&q=' + b64u(u)
    + (r ? '&r=' + encodeURIComponent(r) : '') + (c ? '&c=' + encodeURIComponent(c) : '');
  return new URL(qs, self.location.origin + self.location.pathname.replace(/[^/]*$/, '')).toString();
}

/** 清洗 + 改写一份 m3u8 */
function rewrite(text, base, referer, cookie) {
  const res = AdFilterJS.filter(text, base);
  const lines = String(res.text).split(/\r?\n/);
  const out = lines.map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.charAt(0) === '#') {
      // 带 URI="…" 的标签(KEY / MAP / MEDIA / I-FRAME-STREAM-INF)也要走代理
      const m = /URI="([^"]+)"/.exec(t);
      if (m) return line.replace(m[1], selfUrl(abs(base, m[1]), referer, cookie));
      return line;
    }
    return selfUrl(abs(base, t), referer, cookie);
  });
  return { text: out.join('\n'), dropped: res.dropped, note: res.note };
}

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.endsWith('/p') || url.pathname.endsWith('p')) {
    if (!url.searchParams.get('q') && !url.searchParams.get('u')) return;
    event.respondWith(handle(event.request, url));
  }
});

async function handle(request, url) {
  let { u, r, c } = q(url.toString());
  if (!u) return new Response('bad request', { status: 400 });
  // 名单里的地址可能是"Worker 改写过的自家地址"(同源 /f?… 或 /p?…)。
  // 那种地址直接交给 Worker 就等于**跳过了"先直连(用户自己的 IP)"这一步** ——
  // 国内 CDN 挡 Cloudflare 时就会 403(用户反馈的"有些源还是 403")。
  // 这里把它解开, 拿真正的目标继续走下面的"直连优先 / Worker 兜底"。
  try {
    const selfBase = self.location.origin + self.location.pathname.replace(/[^/]*$/, '');
    if (u.indexOf(selfBase + 'f?') === 0 || u.indexOf(selfBase + 'p?') === 0) {
      const inner = q(u);
      if (inner.u && inner.u !== u) {
        u = inner.u;
        if (!r && inner.r) r = inner.r;
        if (!c && inner.c) c = inner.c;
      }
    }
  } catch (e) {}
  await loadCfgFile();
  const headers = {};
  if (r) headers['Referer'] = r;
  if (c) headers['Cookie'] = c;
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  // 看起来像清单吗? 带 .m3u8 后缀 -> 是; 完全没有后缀(很多直播/分片地址长这样) -> 也按清单试一次
  const looksPlaylist = /\.m3u8(\?|$)/i.test(u) || !/\.[a-z0-9]{2,4}(\?|$)/i.test(u);

  /** 原样透传(状态码 + 关键头 + 字节流都保住; Range/206 不能丢) */
  function passthrough(up) {
    const h = new Headers();
    ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Cache-Control', 'Last-Modified']
      .forEach(k => { const v = up.headers.get(k); if (v) h.set(k, v); });
    h.set('Access-Control-Allow-Origin', '*');
    return new Response(up.body, { status: up.status, headers: h });
  }

  // 取上游的顺序很重要(实测踩出来的):
  //   ① **先直连**: 用用户自己的网络。国内 CDN/直播源经常只认国内家宽 IP, 而我们的
  //      Cloudflare 出口会被 403(甚至端口不被允许) —— 之前"先走 Worker"就会整片播不了;
  //   ② 直连失败(跨域被拦/混合内容 http/https)再走 Worker: 由服务端代取, 并代填 Referer/UA。
  let upstream = null;
  try { upstream = await tryFetch(u, headers); } catch (e) { upstream = null; }
  if (!upstream || !upstream.ok) {
    const keep = upstream;                       // 直连虽然不 ok, 但它的状态码/正文对排查有用
    // 兜底出口: 优先用配置里的代理; **配置还没读到也没关系** —— 线上本站自己就是 Worker,
    // 同源 /f|/p 一样能取(豆瓣图床那种"不带 Referer 就 418"的资源就是靠这一跳救回来的)。
    const fbBase = proxyBase() || (self.location.origin + self.location.pathname.replace(/[^/]*$/, ''));
    if (fbBase) {
      try {
        upstream = await tryFetch(proxyUrl(u, looksPlaylist ? '/f' : '/p', r, c), range ? { Range: range } : {});
      } catch (e) { upstream = keep; }
    } else { upstream = keep; }
  }
  if (!upstream) return new Response('上游取不到(直连与代理都失败)', { status: 504 });

  const ctype = upstream.headers.get('Content-Type') || '';
  if (isM3u8(u, ctype) || looksPlaylist) {
    // ★ 用 clone 偷看开头, 判完再决定走哪条路 ——
    //   以前这里直接 await upstream.text(): 万一这地址根本不是清单(比如没有后缀的分片),
    //   二进制会被 UTF-8 解坏再吐给播放器, 表现就是"分片拿到了但播不动"。
    let text = '';
    try { text = await upstream.clone().text(); } catch (e) { text = ''; }
    if (text.indexOf('#EXTM3U') >= 0) {
      const res = rewrite(text, u, r, c);
      return new Response(res.text, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' }
      });
    }
    return passthrough(upstream);               // 不是清单: 原样给播放器
  }
  return passthrough(upstream);
}

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'adstats') {
    self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage({ type: 'adstats', dropped: e.data.dropped, note: e.data.note })));
  }
});
