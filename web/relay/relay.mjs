#!/usr/bin/env node
/**
 * ZY影视 网页版 · 本机中转(零依赖, Node 18+)
 *
 *   node web/relay/relay.mjs            # 默认 http://127.0.0.1:8899
 *   PORT=9000 TOKEN=你的口令 node web/relay/relay.mjs
 *
 * 为什么需要它: 很多国内片源/CDN **只认国内家宽 IP**(Cloudflare 出口会被 403),
 * 而浏览器又不能读没有 CORS 头的跨域响应。把中转跑在**你自己的电脑**上, 就等于
 * 用你的网络 + 无跨域限制去取流 —— 这一类 403 从根上消失。
 *
 * 用法: 打开网页版 → 播放器「设置」里的代理, 或控制台执行:
 *   localStorage.setItem('zyweb_cfg', JSON.stringify({ proxy: 'http://127.0.0.1:8899', token: 'zyweb' }));
 *   location.reload();
 *
 * 路由(与 Cloudflare 版 worker.js 完全一致, 页面不用改):
 *   GET /f?t=<令牌>&q=<base64url 目标>&r=<Referer>&c=<Cookie>&ua=<UA>   取文本(清单会被改写)
 *   GET /p?t=<令牌>&q=…                                                 取字节(透传 Range/206)
 *   GET /health                                                         自检
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8899);
const TOKEN = process.env.TOKEN || 'zyweb';
const UA_DEF = process.env.UA || 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const BLOCK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254'];
const TIMEOUT = Number(process.env.TIMEOUT || 12000);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type'
};
const b64u = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => { try { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return ''; } };

function proxify(uri, base, r, c) {
  let abs;
  try { abs = /^https?:/i.test(uri) ? uri : new URL(uri, base).toString(); } catch (e) { return uri; }
  const looksPl = /\.m3u8(\?|$)/i.test(abs) || !/\.[a-z0-9]{2,4}(\?|$)/i.test(abs);
  return `http://127.0.0.1:${PORT}${looksPl ? '/f' : '/p'}?t=${encodeURIComponent(TOKEN)}&q=${b64u(abs)}`
    + (r ? `&r=${encodeURIComponent(r)}` : '') + (c ? `&c=${encodeURIComponent(c)}` : '');
}
function rewritePlaylist(text, base, r, c) {
  return String(text).split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.charAt(0) === '#') {
      const m = /URI="([^"]+)"/.exec(t);
      return m ? line.replace(m[1], proxify(m[1], base, r, c)) : line;
    }
    return proxify(t, base, r, c);
  }).join('\n');
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, body, headers) => { res.writeHead(code, Object.assign({}, CORS, headers || {})); res.end(body); };

  if (req.method === 'OPTIONS') return send(204, '');
  if (url.pathname === '/health') return send(200, JSON.stringify({ ok: true, port: PORT, token: TOKEN === 'zyweb' ? 'zyweb(默认, 建议改)' : '(自定义)' }), { 'Content-Type': 'application/json' });
  if (url.pathname !== '/f' && url.pathname !== '/p') return send(404, 'not found');
  if (url.searchParams.get('t') !== TOKEN) return send(403, 'bad token: 与页面里的 token 不一致');

  const q = url.searchParams.get('q');
  const target = q ? unb64u(q) : (url.searchParams.get('u') || '');
  if (!target) return send(400, 'missing q');
  let t;
  try { t = new URL(target); } catch (e) { return send(400, 'bad q: 目标不是合法 URL'); }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') return send(400, 'bad scheme');
  if (BLOCK_HOSTS.indexOf(t.hostname) >= 0) return send(403, 'blocked host');
  const self = new URL(`http://127.0.0.1:${PORT}`);
  if (t.hostname === self.hostname && String(t.port || '') === String(PORT)) return send(400, 'refuse self-proxy: 目标就是中转自己');

  const headers = { 'Accept': '*/*', 'User-Agent': url.searchParams.get('ua') || UA_DEF };
  const r = url.searchParams.get('r'); if (r) headers['Referer'] = r;
  const c = url.searchParams.get('c'); if (c) headers['Cookie'] = c;
  if (req.headers.range) headers['Range'] = req.headers.range;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  let up;
  try { up = await fetch(t.toString(), { headers, redirect: 'follow', signal: ctl.signal }); }
  catch (e) { clearTimeout(timer); return send(504, '上游取不到: ' + (e.name === 'AbortError' ? '超时' : e.message)); }
  clearTimeout(timer);

  const ct = up.headers.get('content-type') || '';
  const looksPl = /\.m3u8(\?|$)/i.test(t.pathname) || !/\.[a-z0-9]{2,4}(\?|$)/i.test(t.pathname);
  if (looksPl || /mpegurl/i.test(ct)) {
    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.slice(0, 7).toString('utf8') === '#EXTM3U') {
      return send(200, rewritePlaylist(buf.toString('utf8'), t.toString(), r, c), { 'Content-Type': 'application/vnd.apple.mpegurl' });
    }
    return send(up.status, buf, ct ? { 'Content-Type': ct } : {});
  }
  const out = {};
  ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified'].forEach((k) => {
    const v = up.headers.get(k); if (v) out[k.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase())] = v;
  });
  const buf = Buffer.from(await up.arrayBuffer());
  send(up.status, buf, out);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[ZY影视 本机中转] http://127.0.0.1:${PORT}  token=${TOKEN}`);
  console.log('页面里这样指过来:');
  console.log(`  localStorage.setItem('zyweb_cfg', JSON.stringify({ proxy: 'http://127.0.0.1:${PORT}', token: '${TOKEN}' })); location.reload();`);
});
