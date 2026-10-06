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
  // 清单里可能已经是"Worker 改写过的绝对地址"(/f? 或 /p?) —— 那层代理已经很好了, 别再套一层
  var _pb = proxyBase();
  if (_pb && (String(u).indexOf(_pb + '/f?') === 0 || String(u).indexOf(_pb + '/p?') === 0)) return u;
  if (PROXY && (String(u).indexOf(PROXY + '/f?') === 0 || String(u).indexOf(PROXY + '/p?') === 0)) return u;
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
  const { u, r, c } = q(url.toString());
  if (!u) return new Response('bad request', { status: 400 });
  await loadCfgFile();
  const headers = {};
  if (r) headers['Referer'] = r;
  if (c) headers['Cookie'] = c;
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  // 看起来像清单吗? 带 .m3u8 后缀 -> 是; 完全没有后缀(很多直播地址长这样) -> 也按清单试一次
  const looksPlaylist = /\.m3u8(\?|$)/i.test(u) || !/\.[a-z0-9]{2,4}(\?|$)/i.test(u);
  const useF = !!PROXY && looksPlaylist;                 // /f = 取文本(清单)
  const useP = !!PROXY && !looksPlaylist;                // /p = 取字节(分片, 透传 Range)

  let upstream = null;
  async function tryFetch(target, hdrs) {
    return await fetch(target, { headers: hdrs || {}, redirect: 'follow', mode: 'cors' });
  }
  try {
    if (useF) upstream = await tryFetch(proxyUrl(u, '/f', r, c), {});
    else if (useP) upstream = await tryFetch(proxyUrl(u, '/p', r, c), range ? { Range: range } : {});
  } catch (e) { upstream = null; }
  if (!upstream || !upstream.ok) {
    try { upstream = await fetch(u, { headers, redirect: 'follow' }); } catch (e) {
      return new Response('upstream failed: ' + e.message, { status: 502 });
    }
  }

  const ctype = upstream.headers.get('Content-Type') || '';
  if (isM3u8(u, ctype) || looksPlaylist) {
    const text = await upstream.text();
    if (text.indexOf('#EXTM3U') >= 0) {
      const res = rewrite(text, u, r, c);
      return new Response(res.text, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' }
      });
    }
    // 不是清单(有些直播是 flv/ts): 原样回给播放器, 别把字节丢掉
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': ctype || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' } });
  }
  // 普通文件: 透传字节(保留状态码与关键头)
  const h = new Headers();
  ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Cache-Control'].forEach(k => {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  });
  h.set('Access-Control-Allow-Origin', '*');
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'adstats') {
    self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage({ type: 'adstats', dropped: e.data.dropped, note: e.data.note })));
  }
});
