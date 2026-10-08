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
import { readFileSync, existsSync } from 'node:fs';
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
function makeBridge(feeds, cfg, extra) {
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
  if (extra) for (const k of Object.keys(extra)) win[k] = extra[k];
  // 线上默认: webconfig 里 proxy 留空(代理就是站点自身), token 是那串随机值
  win.ZYWEB = cfg || { proxy: '', token: 'a7', version: 'selftest' };
  vm.runInContext(readFileSync(join(here, 'bridge.js'), 'utf8'), vm.createContext(win), { filename: 'bridge.js' });
  return win;
}

console.log('\n[1] 桥: 代理地址构建与不重复包裹的不变量');
{
  // ① 没有 Service Worker 接管时: 交回原始地址, **绝不能塞 Worker 地址**
  //    (塞了就把分片拖到海外出口 -> 国内 CDN 403, 点播就是这么被改坏过)
  const w0 = makeBridge();
  const raw = 'https://cdn.example/live/a.m3u8';
  ok('没 SW 时返回原始地址', w0.PK.proxyWrap(raw, '', '') === raw, w0.PK.proxyWrap(raw, '', ''));

  // ② 有 SW 接管时: 走同源 SW 地址(/p?q=...), 让 SW 在用户本机直连取流
  const w = makeBridge();
  w.navigator.serviceWorker = { controller: {} };
  const live = 'https://cdn.example/live/cctv5.m3u8';
  const seg = 'https://cdn.example/live/seg-001.ts';
  const a = w.PK.proxyWrap(live, 'https://cdn.example/');
  const b = w.PK.proxyWrap(seg, '');
  ok('有 SW: 走同源 SW 代理地址', a.indexOf('https://site.example/p?') === 0, a.slice(0, 60));
  ok('分片同样走 SW', b.indexOf('https://site.example/p?') === 0, b.slice(0, 60));
  ok('已是 SW 地址: 再包不变', w.PK.proxyWrap(a, '', '') === a);
  ok('已是同源 /f 地址: 再包不变', w.PK.proxyWrap('https://site.example/f?t=x&q=abc', '', '') === 'https://site.example/f?t=x&q=abc');
  ok('已是同源 /p 地址: 再包不变', w.PK.proxyWrap('https://site.example/p?t=x&q=abc', '', '') === 'https://site.example/p?t=x&q=abc');
}

/* ------------------------------------ 桥: 没配 proxy 时接口也必须走"站点自身"(回归: 首页 0 部) */
console.log('\n[1b] 桥: webconfig 里 proxy 没填时, 接口/豆瓣榜单仍然走站点自身(不是直连)');
{
  const w = makeBridge();
  const seen = [];
  w.fetch = (u) => { seen.push(String(u)); return Promise.resolve({ ok: true, status: 200,
    text: () => Promise.resolve('{"subject_collection_items":[]}') }); };
  w.onVodHome = () => {}; w.onVodSearch = () => {}; w.onVodDetail = () => {}; w.onVodClasses = () => {};
  try { w.VOD.home('', '', 1, 1); } catch (e) {}
  await new Promise(r => setTimeout(r, 30));
  const u0 = seen[0] || '';
  ok('接口走的是站点自身的 /f 出口', u0.indexOf('https://site.example/f?') === 0, u0.slice(0, 80));
  ok('接口没有被"直连"(没绕过出口)', seen.length > 0 && u0.indexOf('m.douban.com/rexxar') < 0, u0.slice(0, 80));
  ok('出口里带的是配置里的令牌(不是写死的 zyweb)', u0.indexOf('t=a7') > 0, u0.slice(0, 90));
}

/* --------------------- 广告过滤(网页端 JS): 与 Java 同规则的验收 --------------- */
console.log('\n[1g] 广告过滤: 明流插播块 / 棋牌目录 / 不误杀');
{
  const src = readFileSync(join(here, 'adfilter.js'), 'utf8');
  const sandbox = { console, module: undefined, self: null };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'adfilter.js' });
  const F = sandbox.AdFilterJS;
  ok('adfilter.js 暴露 AdFilterJS', !!(F && F.filter));
  const segs = t => t.split('\n').filter(l => l.trim() && l.trim()[0] !== '#').length;
  const cnt = (t, x) => t.split('\n').filter(l => l.indexOf(x) >= 0).length;

  // ① 同目录 + 无 DISCONTINUITY 的明流插播块(异目录规则看不见的形态)
  let p1 = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n';
  for (let i = 0; i < 12; i++) p1 += '#EXTINF:6,\n/c/' + i + '.ts\n';
  p1 += '#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=NONE\n';
  for (let i = 0; i < 4; i++) p1 += '#EXTINF:5,\n/c/ad' + i + '.ts\n';
  p1 += '#EXT-X-KEY:METHOD=AES-128,URI="k"\n';
  for (let i = 0; i < 12; i++) p1 += '#EXTINF:6,\n/c/z' + i + '.ts\n';
  const r1 = F.filter(p1, 'https://x/c/i.m3u8');
  ok('明流插播 4 段被清掉', cnt(r1.text, '/c/ad') === 0, r1.note);
  ok('正片 24 段一段没少', segs(r1.text) === 24, String(segs(r1.text)));
  ok('KEY 标签保留(正片才解得开)', r1.text.indexOf('#EXT-X-KEY') >= 0);

  // ② 棋牌关键词目录
  let p2 = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n';
  for (let i = 0; i < 12; i++) p2 += '#EXTINF:6,\n/c/' + i + '.ts\n';
  p2 += '#EXTINF:5,\n/site/qipai/a1.ts\n#EXTINF:5,\n/site/bocai/a2.ts\n';
  for (let i = 0; i < 12; i++) p2 += '#EXTINF:6,\n/c/x' + i + '.ts\n';
  const r2 = F.filter(p2, 'https://x/c/i.m3u8');
  ok('棋牌目录(qipai/bocai)被清掉', cnt(r2.text, 'qipai') === 0 && cnt(r2.text, 'bocai') === 0, r2.note);

  // ③ 负例: 正常流不许动(整条明流 / 明流占多数 / 变长分片+交替 CDN)
  let p3 = '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n';
  for (let i = 0; i < 30; i++) p3 += '#EXTINF:6,\n/nc/' + i + '.ts\n';
  ok('全明流清单零改动', F.filter(p3, 'https://x/nc/i.m3u8').dropped === 0);
  let p4 = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\n/c/0.ts\n#EXT-X-KEY:METHOD=NONE\n';
  for (let i = 0; i < 20; i++) p4 += '#EXTINF:6,\n/c/' + i + 'b.ts\n';
  ok('明流占多数不动手(防误杀)', F.filter(p4, 'https://x/c/i.m3u8').dropped === 0);
  let p5 = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n';
  const hosts = ['/c/', '/c/', '/c/', '/cdn2/'];
  for (let i = 0; i < 60; i++) p5 += '#EXTINF:' + (i % 3 === 0 ? '1.7' : (i % 3 === 1 ? '3.2' : '6.1')) + ',\n' + hosts[i % 4] + i + '.ts\n';
  ok('变长分片 + 交替多 CDN 正常流零改动', F.filter(p5, 'https://x/c/i.m3u8').dropped === 0);
}

/* --------------------- 界面源码: 手势反馈 & 横屏手感(亮度/音量) --------------- */
console.log('\n[1f] 界面: 亮度/音量手势(横屏手感 + 反馈不被静默吞掉)');
{
  const cands = ['../pikachu-dl/android/assets/app.js', 'site/app.js'];
  let src = '';
  for (const c of cands) { const f = join(here, c); if (existsSync(f)) { src = readFileSync(f, 'utf8'); break; } }
  ok('找得到界面脚本 app.js', !!src);
  // ① 直接操作反馈必须永远显示(静默提示只压例行絮叨)
  const mk = /var KEEP = \/([^\/]+)\//.exec(src);
  ok('找得到静默提示的白名单 KEEP', !!mk);
  if (mk) {
    const re = new RegExp(mk[1]);
    for (const t of ['亮度 45%', '音量 45%', '进度 12:34 / 45:00', '已回到 30 秒前', '横屏播放', '倍速 1.5x（只影响影视）']) {
      ok('KEEP 放行「' + t + '」', re.test(t));
    }
    ok('KEEP 仍然压掉例行絮叨「已定位到 10:33」', !re.test('已定位到 10:33'));
  }
  // ② 横屏: 不能按播放器高度(横屏只有 ~450px)折算, 否则一滑就顶满
  ok('亮度按参考高度 refH 折算', /st\.base - dy \/ \(st\.refH/.test(src));
  ok('音量按参考高度 refH 折算', /st\.baseVol - dy \/ \(st\.refH/.test(src));
  ok('左右半屏按"相对播放器左边"判定(不是 viewport clientX)', /st\.lx < st\.w \/ 2/.test(src));
  ok('refH 的定义在 touchstart 里(竖屏=屏高, 横屏≈2 倍高)', /refH: Math\.max\(rc\.height/.test(src));
}

/* --------------------- 界面源码: 每个页面都必须能被 show() 切到(整屏空白的根因) */
console.log('\n[1e] 界面: show() 的页面清单不许漏掉任何一个 section');
{
  const cands = [['../pikachu-dl/android/assets/index.html', '../pikachu-dl/android/assets/app.js'], ['site/index.html', 'site/app.js']];
  let html = '', js = '';
  for (const [h, a] of cands) {
    const hf = join(here, h), af = join(here, a);
    if (existsSync(hf) && existsSync(af)) { html = readFileSync(hf, 'utf8'); js = readFileSync(af, 'utf8'); break; }
  }
  ok('找得到界面源码', !!html && !!js);
  const ids = [...html.matchAll(/<section\s+id="(v-[A-Za-z0-9_-]+)"/g)].map(m => m[1]);
  ok('页面 section ≥ 8 个', ids.length >= 8, '实际 ' + ids.length + ': ' + ids.join(','));
  ok('show() 改成从 DOM 现扫(showList)', /querySelectorAll\('#main section\[id\]'\)/.test(js));
  // 若还有人写死一份白名单, 它必须把 HTML 里所有 section 都包含进去 —— 漏一个 = 点进去整屏空白
  const lists = [...js.matchAll(/\[((?:\s*"v-[A-Za-z0-9_-]+"\s*,?)+)\]/g)].map(m => [...m[1].matchAll(/"(v-[A-Za-z0-9_-]+)"/g)].map(x => x[1]));
  for (const l of lists) {
    const missing = ids.filter(id => l.indexOf(id) < 0);
    ok('写死的页面清单[' + l.length + ' 项]包含全部 section', missing.length === 0, missing.length ? ('漏掉: ' + missing.join(', ')) : '');
  }
}

/* ------------------------------- 界面源码: 静默提示开关(值被纠正后必须重画文案) */
console.log('\n[1d] 界面: 「静默提示」开关的默认值与文案(用户报过: 明明是开, 却显示关)');
{
  const cands = ['../pikachu-dl/android/assets/app.js', 'site/app.js'];
  let src = '';
  for (const c of cands) { const f = join(here, c); if (existsSync(f)) { src = readFileSync(f, 'utf8'); break; } }
  ok('找得到界面脚本 app.js', !!src);
  const at = src.indexOf('function applyWebPsDefaults');
  const body = at >= 0 ? src.slice(at, src.indexOf('\n}', at)) : '';
  ok('默认值里把 silent 设成开', /PS\.silent\s*=\s*1/.test(body));
  // 关键回归: 开关文案是 applyWebMode() 先画的, 而本函数在后面才跑 —— 不重画就永远显示"关"
  ok('值设完之后重画开关文案(syncSilentUI)', /syncSilentUI\(\)/.test(body));
  ok('只有用户自己点过才认"关"(zy_web_silent_set)', /zy_web_silent_set/.test(src));
  const tg = src.indexOf('function webToggleSilent');
  const tbody = tg >= 0 ? src.slice(tg, src.indexOf('\n}', tg)) : '';
  ok('用户点开关时会留下"这是他的选择"的标记', /zy_web_silent_set/.test(tbody));
}

/* ------------------------------------------- 桥: 豆瓣榜单表(网页版首页分类)不变量 */
console.log('\n[1c] 桥: 榜单表与首页取数(网页版「分类榜单」)');
{
  const w = makeBridge();
  const charts = JSON.parse(w.VOD.doubanCharts());
  const ids = charts.map(c => c.id);
  ok('榜单表至少有 12 个', charts.length >= 12, '实际 ' + charts.length);
  for (const need of ['movie_showing', 'movie_hot', 'movie_top250', 'movie_weekly_best', 'movie_classic',
                      'tv_hot', 'tv_domestic', 'tv_american', 'tv_korean', 'tv_japanese',
                      'tv_chinese_best_weekly', 'tv_variety_show', 'tv_animation', 'tv_documentary']) {
    ok('榜单里有 ' + need, ids.indexOf(need) >= 0);
  }
  ok('每个榜单都有中文名和分组', charts.every(c => c.name && c.group));
  ok('表里没有(线上实测为空的)伪榜单', ids.indexOf('movie_coming_soon') < 0 && ids.indexOf('tv_anime') < 0);
  // 首页请求确实带着用户选的榜单
  const seen = [];
  w.fetch = (u) => { seen.push(String(u)); return Promise.resolve({ ok: true, status: 200,
    text: () => Promise.resolve('{"subject_collection_items":[]}') }); };
  w.onVodHome = () => {};
  const dec = (u) => { const m = /[?&]q=([^&]+)/.exec(u); let b = (m ? m[1] : '').replace(/-/g, '+').replace(/_/g, '/');
    if (b.length % 4) b += '='.repeat(4 - b.length % 4);
    try { return Buffer.from(b, 'base64').toString('utf8'); } catch (e) { return ''; } };
  try { w.VOD.home('', 'movie_top250', 1, 1); } catch (e) {}
  await new Promise(r => setTimeout(r, 20));
  ok('选 Top250 -> 请求 movie_top250 榜单', dec(seen[0] || '').indexOf('subject_collection/movie_top250') > 0, dec(seen[0] || ''));
  try { w.VOD.home('', '3', 1, 2); } catch (e) {}
  await new Promise(r => setTimeout(r, 20));
  ok('老参数(3)仍映射到综艺榜单', dec(seen[1] || '').indexOf('subject_collection/tv_variety_show') > 0, dec(seen[1] || ''));
  try { w.VOD.home('', '', 1, 3); } catch (e) {}
  await new Promise(r => setTimeout(r, 20));
  ok('空参数 -> 正在上映', dec(seen[2] || '').indexOf('subject_collection/movie_showing') > 0, dec(seen[2] || ''));
}

/* ---------------------------------------------------------------- SW: 清单改写不变量 */
console.log('\n[2] Service Worker: 改写清单时不动"已经是代理地址"的行');
{
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    importScripts() {}, addEventListener(t, f) { if (t === 'fetch') sandbox.__fetch = f; },
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
  ok('相对分片被改写成走本 SW', out.indexOf('seg-2.ts') < 0 && out.indexOf('p?t=a7&q=') > 0);
  // ★ 令牌必须用 webconfig 里的那串, 不许写死 'zyweb' —— 写死时 Worker 判 403, 改写过的分片全取不到。
  ok('改写用的是配置里的令牌(不是写死的 zyweb)', out.indexOf('p?t=zyweb&q=') < 0, out.slice(0, 120));
  // ★ <img> 请求不许被 SW 拦: 拦了就会把同源 /p 解开成直连豆瓣图床, 不带 Referer 一律 418 → 海报全空。
  {
    // 桩请求也要带 headers: SW 的 handle() 会异步读 request.headers.get('Range') —— 少了它,
    // 这个"迟到的 TypeError"会在后面某一段 await 里突然冒出来, 把整个自测打断(2026-10 真踩过)。
    const rqHeaders = () => ({ get() { return null; } });
    const pending = [];
    let called = false;
    const ev = { request: { url: 'https://site.example/p?t=a7&q=AAA&r=https%3A%2F%2Fm.douban.com%2F', destination: 'image', headers: rqHeaders() },
                 respondWith(p) { called = true; pending.push(Promise.resolve(p).catch(() => {})); } };
    sandbox.__fetch(ev);
    ok('图片请求(destination=image)不拦, 直接交给站点自己的 Worker', called === false);
    let called2 = false;
    const ev2 = { request: { url: 'https://site.example/p?t=a7&q=AAA', destination: '', headers: rqHeaders() },
                  respondWith(p) { called2 = true; pending.push(Promise.resolve(p).catch(() => {})); } };
    sandbox.__fetch(ev2);
    ok('媒体请求(非 image)仍然被 SW 接管', called2 === true);
    await Promise.all(pending);            // 让它跑完(失败也吞掉), 别留个迟到异常把后面打断
  }
  ok('绝对分片被改写成走本 SW', out.indexOf('https://cdn.example/seg-3.ts') < 0);
  ok('URI="…" 也被改写成走本 SW', out.indexOf('URI="key.bin"') < 0);
}

/* ============ 桥: 全屏 / 横屏 / 竖屏(用户报"网页版横屏竖屏全屏都坏了"的回归闸门) ============
   真机实测(用户手机默认浏览器 Via, 各家 WebView 同理):
     · screen.orientation.lock 这个函数**在**, 但一调就 reject:
         NotSupportedError: screen.orientation.lock() is not available on this device.
     · 所以: 只看"函数在不在"就留按钮 = 按钮在、点了不动; 锁不上必须自己转一层(伪横屏)。
     · 全屏里按"返回"关掉播放器却不退全屏 = 整屏黑(用户说的"全屏坏了")。 */
console.log('\n[1h] 桥: 全屏/横竖屏(方向锁不可用时的伪横屏 + 全屏不装样子)');
{
  const mkNode = (id) => {
    const n = { _id: id || '', style: {}, className: '', children: [], parentNode: null,
      get firstChild() { return this.children[0] || null; },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = n; return c; },
      insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c);
        const i = n.children.indexOf(ref); if (i < 0) n.children.push(c); else n.children.splice(i, 0, c); c.parentNode = n; return c; },
      removeChild(c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); c.parentNode = null; return c; },
      addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; } };
    return n;
  };
  // 一个"有内容的播放器": #player 里两件东西(视频 + 顶栏), 横竖屏那层要能整体包起来再整体拆回去
  const player = mkNode('player'), video = mkNode('video'), ptop = mkNode('ptop');
  player.appendChild(video); player.appendChild(ptop);
  const nodes = { player, video, ptop };
  const mkWin = (lockImpl, w, h, fsApi) => {
    const doc = {
      documentElement: mkNode('html'), body: mkNode('body'),
      // getElementById 要像真 DOM 那样"只找还挂在文档里的节点": 拆掉的 #pklayer 不能再被找到,
      // 否则桥会去复用一个已经脱离文档的层(写这个测试时真踩过, 表现是"竖屏拆不掉")。
      getElementById(id) {
        const n = nodes[id];
        for (let p = n; p; p = p.parentNode) if (p === doc.body || p === doc.documentElement) return n;
        return null;
      },
      createElement() { const n = mkNode(''); Object.defineProperty(n, 'id',
        { get() { return n._id; }, set(v) { n._id = v; if (v) nodes[v] = n; } }); return n; },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      fullscreenElement: null, exited: false, req: false,
      exitFullscreen() { doc.exited = true; doc.fullscreenElement = null; return Promise.resolve(); }
    };
    // 全屏 API 挂在"要全屏的那个元素"上(桥优先用 #player, 其次 <video>, 最后才是 documentElement)
    const put = (n, on) => {
      try {
        if (on) n.requestFullscreen = function () { doc.req = true; doc.fullscreenElement = n; return Promise.resolve(); };
        else delete n.requestFullscreen;
      } catch (e) {}
    };
    [player, video, doc.documentElement].forEach(n => put(n, fsApi));
    if (player.parentNode !== doc.body) doc.body.appendChild(player);
    const so = { type: (w > h ? 'landscape-primary' : 'portrait-primary'), lock: lockImpl, unlock() { so.unlocked = true; } };
    return makeBridge(null, { proxy: '', token: 'a7', version: 'selftest' },
      { document: doc, screen: { orientation: so }, innerWidth: w, innerHeight: h, ontouchstart: null });
  };
  const layerOf = () => { const l = nodes['pklayer']; return (l && player.children.indexOf(l) >= 0) ? l : null; };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ① 方向锁 reject(真机的样子) -> 必须自己转一层: 尺寸换成 innerHeight×innerWidth, 转 90°
  {
    const w = mkWin(() => Promise.reject(new Error('NotSupportedError')), 390, 844, true);
    ok('方向锁在但会失败时, 按钮照样留(canLockOrientation 不再"看函数存不存在")', w.PK.canLockOrientation() === true);
    w.PK.landscape(true);
    ok('横屏: 顺手请求了元素全屏(浏览器只允许全屏后锁方向)', w.document.req === true);
    ok('点下去的一瞬间**不能**就转: 同一次点按还会补一个 click, 立刻转会把那一下砸到别的按钮上', !layerOf());
    await sleep(450);                                              // 等"错开一拍"的 350ms + reject 兜底
    const ly = layerOf();
    ok('锁失败 -> 自动上伪横屏(包了一层 #pklayer)', !!ly);
    if (ly) {
      ok('伪横屏: 宽=视口高, 高=视口宽(转完正好铺满)', ly.style.width === '844px' && ly.style.height === '390px', ly.style.width + '×' + ly.style.height);
      ok('伪横屏: 整层 rotate(90deg)', /rotate\(90deg\)/.test(ly.style.transform), ly.style.transform);
      ok('伪横屏: 播放器内容整体搬进那一层(video 也跟着转)', player.children.length === 1 && player.children[0] === ly && ly.children.length === 2);
    }
    ok('横屏时 isLandscape()=true(手势返回/按钮文案都靠它)', w.PK.isLandscape() === true);
    ok('pseudoLand() 报 1(app.js 的手势要按它换轴)', w.PK.pseudoLand() === 1);
    w.PK.landscape(false);
    ok('竖屏: 那一层被拆掉, 内容原顺序还回 #player', !layerOf() && player.children.length === 2 && player.children[0] === video);
    ok('竖屏: pseudoLand() 归 0 / isLandscape()=false', w.PK.pseudoLand() === 0 && w.PK.isLandscape() === false);
    ok('竖屏: 顺手退掉全屏(不然 #player 一藏就是整屏黑)', w.document.exited === true);
  }

  // ② 方向锁"调用成功"却没真的转过来 -> 到点仍然要兜底转一层
  {
    const w = mkWin(() => Promise.resolve(), 390, 844, true);
    w.PK.landscape(true);
    await sleep(200);
    ok('锁 resolve 但画面纹丝不动: 先不转(给系统一点时间)', !layerOf());
    await sleep(1300);                       // 900ms 兜底判定 + 350ms 错开
    ok('一直没转 -> 兜底上伪横屏', !!layerOf());
    w.PK.landscape(false);
  }

  // ③ 真·系统横屏(锁成功且视口真的横了) -> 绝不能自己再转一层(转了就是倒的)
  {
    const w = mkWin(function (q) { this.type = 'landscape-primary'; return Promise.resolve(); }, 844, 390, true);
    w.PK.landscape(true);
    await sleep(450);
    ok('系统真横屏时不叠伪横屏', !layerOf());
    ok('真横屏 isLandscape()=true', w.PK.isLandscape() === true);
  }

  // ④ 手机物理上还横着, 用户按"竖屏" -> 反着转一层(谁也拧不过传感器)
  {
    const w = mkWin(() => Promise.reject(new Error('NotSupportedError')), 844, 390, false);
    w.PK.landscape(false);
    await sleep(450);
    const ly = layerOf();
    ok('物理横屏时按竖屏: 反着转一层', !!ly && /rotate\(-90deg\)/.test(ly.style.transform), ly && ly.style.transform);
    ok('伪竖屏下 isLandscape()=false(画面看起来是竖的)', w.PK.isLandscape() === false);
    ok('伪竖屏 pseudoLand() 报 −1', w.PK.pseudoLand() === -1);
    w.PK.landscape(false);                   // 撤掉: 视口还是横的, 但用户要的是"不要那一层"
  }

  // ⑤ 全屏: 有 API 才进, 没 API 如实返回 false(不装作成功) + 前缀状态也算数
  {
    const w1 = mkWin(() => Promise.reject(new Error('x')), 390, 844, false);
    ok('没有全屏 API -> toggleFullscreen() 返回 false', w1.PK.toggleFullscreen() === false);
    const w2 = mkWin(() => Promise.reject(new Error('x')), 390, 844, true);
    ok('有全屏 API -> 调用并返回 true', w2.PK.toggleFullscreen() === true && w2.document.req === true);
    w2.document.webkitFullscreenElement = w2.document.getElementById('player');
    ok('带前缀的全屏状态也算"在全屏里"(老内核)', w2.PK.fsOn() === true);
    ok('已经在全屏里再按一次 = 退出', w2.PK.toggleFullscreen() === true && w2.document.exited === true);
  }
}

/* ---------- 界面源码: 关播放器要收全屏 / 手势要按伪横屏换轴(网页端专属的接线) ---------- */
console.log('\n[1i] 界面: 关播放器一起收全屏与伪横屏 + 手势按伪横屏换轴');
{
  const cands = ['../pikachu-dl/android/assets/app.js', 'site/app.js'];
  let src = '';
  for (const c of cands) { const f = join(here, c); if (existsSync(f)) { src = readFileSync(f, 'utf8'); break; } }
  ok('找得到界面脚本 app.js', !!src);
  const cp = src.slice(src.indexOf('function closePlayer'), src.indexOf('function closePlayer') + 2200);
  ok('关播放器要退全屏(否则 #player 一藏就是整屏黑, 用户报的"全屏坏了")', /PK\.fsExit/.test(cp));
  ok('关播放器要撤伪横屏(不然下次进播放器还是歪的)', /PK\.pseudoLand/.test(cp));
  ok('手势按 pseudoLand 换轴(伪横屏下上下滑仍=亮度/音量)', /PK\.pseudoLand/.test(src) && /st\.sg/.test(src));
  ok('全屏按钮/键盘F/双击 都交给桥(前缀与 iOS 兜底在桥里)', /PK\.toggleFullscreen/.test(src));
  ok('网页端不再删「横屏」按钮(方向锁存在却永远失败, 删了就真没了)', !/drop\(\$\('prot'\)\)/.test(src));
}

console.log('\n' + (fails ? ('✗ ' + fails + ' 项不通过') : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
