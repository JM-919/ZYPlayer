#!/usr/bin/env node
/**
 * 网页版播放链路的自测(纯 Node, 不需要浏览器/网络)。
 *
 *   node web/selftest.mjs        # 全绿退出 0, 有问题退出 1
 *
 * 为什么要有它: 播放链路(桥抽出的代理地址 → Service Worker 改写 → Worker 兜底)
 * 被改坏过好几轮, 每次都是"上线后用户发现播不了"才知道。这里把最容易改坏的几条
 * **不变量**钉死:
 *   ① 已经是代理地址(同源 /f|/p、或跨域 Worker)的 URL 不许再被包一层 —— 否则 Worker
 *      会去 fetch 自己, Cloudflare 直接 522(踩过);
 *   ② 直播地址(looks like m3u8)走 /f, 分片走 /p;
 *   ③ Service Worker 改写清单时, 已经是 Worker 地址的行必须原样保留;
 *   ④ 网页端直播列表只保留"有 https 线路"的频道。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  [OK]   ' + name); return; }
  fails++;
  console.log('  [FAIL] ' + name + (extra ? ('  → ' + extra) : ''));
}
function el() {
  return { style: { cssText: '' }, textContent: '', className: '', id: '', children: [],
    appendChild() {}, removeChild() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    insertBefore() {}, closest() { return null; } };
}

/* ---------------------------------------------------------------- 桥: 代理地址不变量 */
function makeBridge(feeds) {
  const store = {};
  const win = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    document: { documentElement: { className: '' }, body: el(), getElementById() { return null; },
      createElement() { return el(); }, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      fullscreenElement: null, exitFullscreen() { return Promise.resolve(); } },
    location: { pathname: '/', origin: 'https://site.example', href: 'https://site.example/', host: 'site.example' },
    navigator: { userAgent: 'node', serviceWorker: null },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    screen: {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: (u) => {
      const s = String(u);
      if (feeds && feeds.__ALL__) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(feeds.__ALL__) });
      for (const k of Object.keys(feeds || {})) if (s.indexOf(k) >= 0) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(feeds[k]) });
      return Promise.reject(new Error('no stub for ' + s.slice(0, 60)));
    },
    addEventListener() {}, removeEventListener() {}, open() {}, innerWidth: 390, innerHeight: 844, __ZYBUILD: 'selftest',
    URL, TextEncoder, TextDecoder, btoa: x => Buffer.from(x, 'binary').toString('base64'), atob: x => Buffer.from(x, 'base64').toString('binary'),
    MutationObserver: function () { this.observe = () => {}; }
  };
  win.window = win; win.self = win; win.globalThis = win; win.PK_toast = () => {};
  vm.runInContext(readFileSync(join(here, 'bridge.js'), 'utf8'), vm.createContext(win), { filename: 'bridge.js' });
  return win;
}

console.log('\n[1] 桥: 代理地址构建与"不重复包裹"不变量');
{
  const w = makeBridge();
  const live = 'https://cdn.example/live/cctv5.m3u8';
  const seg = 'https://cdn.example/live/seg-001.ts';
  const a = w.PK.proxyLive(live, 'https://cdn.example/');
  const b = w.PK.proxyLive(seg, '');
  ok('直播清单走同源 /f', a.indexOf('https://site.example/f?') === 0, a.slice(0, 60));
  ok('分片走同源 /p', b.indexOf('https://site.example/p?') === 0, b.slice(0, 60));
  ok('已是同源 /f 地址: 再包不变', w.PK.proxyWrap(a, '', '') === a);
  ok('已是同源 /p 地址: 再包不变', w.PK.proxyWrap(b, '', '') === b);
  const wprox = 'https://site.example/p?t=x&q=abc';
  ok('已是代理地址(同源 /p): 再包不变', w.PK.proxyWrap(wprox, '', '') === wprox);
  const wprox2 = 'https://site.example/f?t=x&q=abc';
  ok('已是代理地址(同源 /f): 再包不变', w.PK.proxyWrap(wprox2, '', '') === wprox2);
  ok('普通地址: 会被包成同源出口', w.PK.proxyWrap('https://cdn.example/x.m3u8', '', '').indexOf('https://site.example/f?') === 0);
}

/* ---------------------------------------------------------------- SW: 清单改写不变量 */
console.log('\n[2] Service Worker: 改写清单时不动"已经是代理地址"的行');
{
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    importScripts() {}, addEventListener() {},
    self: null, location: { origin: 'https://site.example', pathname: '/sw.js' },
    Response, Headers, Request, URL, AbortController, TextEncoder, TextDecoder,
    fetch: (u) => (String(u).indexOf('webconfig.js') >= 0
      ? Promise.resolve({ ok: true, text: () => Promise.resolve("proxy: saved.proxy || 'https://site.example'\ntoken: saved.token || 'a7'\n") })
      : Promise.reject(new Error('no net'))),
    btoa: x => Buffer.from(x, 'binary').toString('base64'), atob: x => Buffer.from(x, 'base64').toString('binary'),
    caches: { open: () => Promise.resolve({ match: () => Promise.resolve(null), put: () => Promise.resolve() }) }
  };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext('var AdFilterJS = { filter: function (t) { return { text: t, dropped: 0, note: "" }; } };', ctx);
  vm.runInContext(readFileSync(join(here, 'sw.js'), 'utf8'), ctx, { filename: 'sw.js' });
  await vm.runInContext('loadCfgFile()', ctx);          // 让它读到代理配置(线上是页面推给它/自己读 webconfig)
  const playlist = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    'https://site.example/p?t=a7&q=AAA',
    'https://site.example/f?t=a7&q=BBB',
    'seg-2.ts',
    'https://cdn.example/seg-3.ts'
  ].join('\n');
  const res = vm.runInContext('rewrite(' + JSON.stringify(playlist) + ', "https://cdn.example/live/a.m3u8", "", "")', ctx);
  const out = String(res.text);
  ok('同源 /p 行原样保留', out.indexOf('https://site.example/p?t=a7&q=AAA') >= 0);
  ok('已是代理的 /f 行原样保留', out.indexOf('https://site.example/f?t=a7&q=BBB') >= 0);
  ok('相对分片被改写成走本 SW', out.indexOf('seg-2.ts') < 0 && out.indexOf('p?t=zyweb&q=') > 0);
  ok('绝对分片被改写成走本 SW', out.indexOf('https://cdn.example/seg-3.ts') < 0);
  ok('URI="…" 也被改写成走本 SW', out.indexOf('URI="key.bin"') < 0);
}

/* ---------------------------------------------------------------- 直播列表: 只留 https 频道 */
console.log('\n[3] 网页端直播列表: 只保留"有 https 线路"的频道');
{
  const feedHttps = '#EXTM3U\n#EXTINF:-1,CCTV1\nhttps://a.example/cctv1.m3u8\n#EXTINF:-1,CCTV2\nhttps://b.example/cctv2.m3u8\n';
  const feedHttp = '#EXTM3U\n#EXTINF:-1,某地卫视\nhttp://1.2.3.4:8181/tv.m3u8\n';
  // 所有内置源都返回这两张假表(不联网), 于是每个源都会带进 https 与 http 两种频道
  const w = makeBridge({ __ALL__: feedHttps + feedHttp });
  const all = await w.ZYBRIDGE.liveRefresh();
  const list = JSON.parse(w.PK.liveChannels(''));
  const meta = JSON.parse(w.PK.liveMeta());
  ok('能解析出频道(含 http 的那条)', all.some(c => (c.u || []).some(u => /^http:/i.test(u))));
  ok('列表里每条线路都是 https', list.every(c => (c.u || []).every(u => /^https:/i.test(u))), JSON.stringify((list[0] || {}).u || []).slice(0, 60));
  ok('meta.count 与列表一致', meta.count === list.length);
}

console.log('\n' + (fails ? ('✗ ' + fails + ' 项不通过') : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
