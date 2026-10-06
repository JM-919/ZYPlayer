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
function isM3u8(url, ctype) {
  return /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(ctype || '');
}
function abs(base, rel) {
  try { return new URL(rel, base).toString(); } catch (e) { return rel; }
}
function selfUrl(u, r, c) {
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
  const headers = {};
  if (r) headers['Referer'] = r;
  if (c) headers['Cookie'] = c;
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;
  let upstream;
  try {
    upstream = await fetch(u, { headers, redirect: 'follow' });
  } catch (e) {
    return new Response('upstream failed: ' + e.message, { status: 502 });
  }
  const ctype = upstream.headers.get('Content-Type') || '';
  if (isM3u8(u, ctype) || /#EXTM3U/.test(await Promise.resolve(''))) {
    const text = await upstream.text();
    if (text.indexOf('#EXTM3U') >= 0) {
      const res = rewrite(text, u, r, c);
      return new Response(res.text, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' }
      });
    }
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
