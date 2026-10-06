/*!
 * ZY影视 网页版 —— CORS 代理(Cloudflare Worker / Deno Deploy 都行)
 *
 * 为什么必须有: GitHub Pages 只托管静态文件, 浏览器不给跨域; 而采集站/豆瓣/直播表这些接口
 * **不带 CORS 头**, 页面直接 fetch 会被浏览器拦掉。这个小代理只做一件事: 服务端去取, 加上
 * `Access-Control-Allow-Origin: *` 回来 —— 顺便代填 Referer/User-Agent(浏览器里改不了这两个头)。
 *
 * 路由:
 *   /f?t=<令牌>&u=<地址>&r=<Referer>&c=<Cookie>&ua=<UA>   取文本(JSON/HTML/清单)
 *   /p?t=<令牌>&u=<地址>&r=&c=&ua=                        取字节(透传 Range/206, 播放器直接用)
 *
 * 部署(免费):
 *   1. https://workers.cloudflare.com → 新建 Worker → 把本文件内容粘进去 → 改 TOKEN;
 *      **ALLOW_HOSTS 保持 [] 不要动**(它是"允许代理去取的上游站点"白名单, 不是本站域名!)
 *   2. 保存后拿到 https://<名字>.<账号>.workers.dev;
 *   3. 把地址填进 web/dist/webconfig.js 的 `proxy`(站点里的「设置→网页版代理」也能改, 存 localStorage)。
 */
const TOKEN = 'a7ebc133-bf1b-4605-a914-cedeeb9b1e7f';                     // 与 webconfig.js 里的 token 一致
// ── 两个"白名单"别搞混: 一个管"代理去取谁", 一个管"谁在用代理" ──────────────
//
// ① ALLOW_HOSTS = 代理被允许去抓的上游站点(采集接口 / 视频源域名)。**必须留空**:
//    采集源有 20+ 个域名且经常换, 写死白名单 = 搜索永远空、直播空、播放 403。
//    想"只让我自己的站点用", 请去下面的 ②, 不要写这里。
const ALLOW_HOSTS = [];
//
// ② ALLOW_ORIGINS = 允许调用本代理的**网页站点**(按请求头的 Origin / Referer 域名判)。
//    留空 [] = 不限制; 想只让自己的站点用, 就写(注意是"网页的域名", 不是采集源的域名):
//        const ALLOW_ORIGINS = ['zyplayer.hof12.ccwu.cc', 'jm-919.github.io'];
//    ⚠️ 填了之后浏览器直接打开 /f?t=… 会因为没有 Origin/Referer 而 403;
//       命令行测试请加 -H 'Referer: https://zyplayer.hof12.ccwu.cc/' 才通得过。
const ALLOW_ORIGINS = [];
const BLOCK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254'];   // 防 SSRF 打内网

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type'
};

function bad(msg, code) { return new Response(msg, { status: code || 400, headers: CORS }); }

// 目标地址用 base64url 放在 `q` 里(`u=<URL>` 仍认, 作为老客户端兜底)。
// 为什么换掉明文的 `u=<URL>`: 参数里塞一整个 URL 要层层转义, 也容易被各种边缘规则当成
// "疑似 SSRF"处理。但要诚实说明: 这一轮排查里那些 `403 Forbidden By WAF` **不是**它造成的,
// 而是"请求没带 User-Agent"被上游挡掉后原样透传的(见下面 headers 处注释)。base64 少一层坑,
// 真正必须带的是 User-Agent。
// 编码目标地址用(和页面的 b64u 一致: UTF-8 → base64url, 去掉 = 填充)
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

/**
 * 把 m3u8 里的地址改写成"继续走本 Worker"的绝对地址。
 *
 * 为什么要在 Worker 里也做一遍: 浏览器里的 Service Worker 是**可能过期/被回收**的
 * (用户不刷新就一直跑旧版), 那时直播就是黑屏。这里改写好之后, 播放器拿到的清单里
 * 每条地址都指向本 Worker —— 不依赖页面里那个 SW, 直播/VOD 都能起来。
 *   · 清单(.m3u8 / 没后缀) → /f(取文本)
 *   · 分片(其它)          → /p(取字节, 透传 Range)
 * r/c(Referer/Cookie) 一起带下去: 防盗链的源全靠它。
 */
function proxify(uri, base, origin, token, r, c) {
  let abs;
  try { abs = /^https?:/i.test(uri) ? uri : new URL(uri, base).toString(); } catch (e) { return uri; }
  const looksPl = /\.m3u8(\?|$)/i.test(abs) || !/\.[a-z0-9]{2,4}(\?|$)/i.test(abs);
  return origin + (looksPl ? '/f' : '/p') + '?t=' + encodeURIComponent(token) + '&q=' + b64u(abs)
    + (r ? '&r=' + encodeURIComponent(r) : '') + (c ? '&c=' + encodeURIComponent(c) : '');
}
function rewritePlaylist(text, base, origin, token, r, c) {
  const out = String(text).split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.charAt(0) === '#') {
      const m = /URI="([^"]+)"/.exec(t);
      return m ? line.replace(m[1], proxify(m[1], base, origin, token, r, c)) : line;
    }
    return proxify(t, base, origin, token, r, c);
  });
  return out.join('\n');
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname !== '/f' && url.pathname !== '/p') return bad('not found', 404);
    if (url.searchParams.get('t') !== TOKEN) return bad('bad token: 与 worker 里的 TOKEN 不一致(改 webconfig.js 或 worker 任一处即可)', 403);

    // ② 调用方站点白名单(留空 = 不限制)。用 Origin 优先、Referer 兜底
    if (ALLOW_ORIGINS.length) {
      let oh = '';
      const src = req.headers.get('Origin') || req.headers.get('Referer') || '';
      try { oh = new URL(src).hostname; } catch (e) { oh = ''; }
      if (!ALLOW_ORIGINS.some(h => oh === h || oh.endsWith('.' + h))) {
        return bad('origin not allowed: 调用方 ' + (oh || '(无 Origin/Referer)') +
                   ' 不在 ALLOW_ORIGINS 里; 想放开就把它清空成 []', 403);
      }
    }

    const enc = url.searchParams.get('q');
    if (enc && !unb64u(enc)) return bad('bad q: 不是合法的 base64url 目标地址');
    const target = enc ? unb64u(enc) : url.searchParams.get('u');
    if (!target) return bad('missing q(或 u)');
    let t;
    try { t = new URL(target); } catch (e) { return bad('bad q/u: 目标地址不是合法 URL'); }
    if (t.protocol !== 'http:' && t.protocol !== 'https:') return bad('bad scheme');
    if (BLOCK_HOSTS.indexOf(t.hostname) >= 0) return bad('blocked host', 403);
    if (ALLOW_HOSTS.length && !ALLOW_HOSTS.some(h => t.hostname === h || t.hostname.endsWith('.' + h))) {
      return bad('host not allowed: 代理的 ALLOW_HOSTS 白名单挡下了 ' + t.hostname +
                 '; 把 worker 里的 ALLOW_HOSTS 改成 [] (留空=不限制) 后重新部署', 403);
    }

    const headers = { 'Accept': '*/*' };
    const r = url.searchParams.get('r'); if (r) headers['Referer'] = r;
    const c = url.searchParams.get('c'); if (c) headers['Cookie'] = c;
    // User-Agent: 客户端给了就用客户端的; **没给也绝不能空着** ——
    //   实测采集站的 WAF 直接拒绝"没有 User-Agent"的请求(返回一张 `403 Forbidden By WAF` 的 HTML),
    //   而这张 HTML 会被本代理原样透传, 看起来就像"代理坏了/被墙了", 其实是上游把无 UA 的请求挡了。
    const ua = url.searchParams.get('ua');
    headers['User-Agent'] = ua || 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
    const range = req.headers.get('Range'); if (range) headers['Range'] = range;

    let up;
    try {
      up = await fetch(t.toString(), { headers, redirect: 'follow' });
    } catch (e) {
      return new Response('upstream failed: ' + e.message, { status: 502, headers: CORS });
    }
    const ct = up.headers.get('Content-Type') || '';
    // 清单: 就地改写成继续走本 Worker(页面那边的 Service Worker 过期也不影响播放)
    if (url.pathname === '/f' && (up.status === 200) && (/mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(t.pathname) || !/\.[a-z0-9]{2,4}(\?|$)/i.test(t.pathname))) {
      const text = await up.text();
      if (text.indexOf('#EXTM3U') >= 0) {
        const body = rewritePlaylist(text, t.toString(), new URL(req.url).origin, TOKEN, r, c);
        return new Response(body, {
          status: 200,
          headers: Object.assign({}, CORS, { 'Content-Type': 'application/vnd.apple.mpegurl' })
        });
      }
      return new Response(text, { status: up.status, headers: Object.assign({}, CORS, { 'Content-Type': ct || 'text/plain' }) });
    }
    const out = new Headers(CORS);
    ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Cache-Control', 'Last-Modified']
      .forEach(k => { const v = up.headers.get(k); if (v) out.set(k, v); });
    return new Response(up.body, { status: up.status, headers: out });
  }
};
