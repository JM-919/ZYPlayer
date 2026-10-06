/*!
 * ZY影视 网页版 —— JS 桥(vod/collect/core 的浏览器实现)
 *
 * 为什么要这一层: App 里的界面(assets/app.js)只跟 `window.PK` / `window.VOD` 说话,
 * 真实逻辑在 Java 侧。放到 GitHub Pages 上以后没有 Java 了, 所以这里用 JS 把同一套 API 实现出来。
 *
 * 浏览器与 App 的**三个硬差别**(决定了网页版能做到什么程度):
 *  ① 跨域: App 是原生 HTTP 客户端, 没有 CORS 概念; 浏览器里采集站的接口大多**不带 CORS 头**,
 *     所以所有请求都走 `ZYPROXY`(自建的 CORS 代理, 见 proxy/worker.js)。
 *     没有配置代理时, 只有本来就允许跨域的接口能用。
 *  ② Referer / User-Agent: 浏览器里这两个是**禁止修改**的头。需要它们的源只有靠代理服务端代填
 *     (`/p?...` 的分片请求也交给代理), 页面自己是发不出去的。
 *  ③ 嗅探: App 用隐藏 WebView 加载解析页、在网络层截住媒体地址; 浏览器里 <iframe> 是跨域的,
 *     读不到里面发生了什么 —— 所以"解析线路/平台页面嗅探"这条路在网页版**不可用**,
 *     只能走直链、以及本来就让跨域的平台 API。
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ 配置 */
  var CFG = root.ZYWEB || {};
  // 例: 'https://zy-proxy.你的账号.workers.dev'  留空则直连(只有允许跨域的接口能用)
  // 容错: 只写域名(漏了 https://)会自动补全 scheme, 末尾多余的 / 会去掉 —— 免得配置差一个字符就全站 404
  var ZYPROXY = String(CFG.proxy || '').trim().replace(/\/+$/, '');
  if (ZYPROXY && !/^[a-z][a-z0-9+.-]*:\/\//i.test(ZYPROXY)) ZYPROXY = 'https://' + ZYPROXY;
  var PROXY_TOKEN = CFG.token || 'zyweb';      // 与 worker 里配置的一致
  var UA_PLAYER = 'Lavf/58.76.100';
  var UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
  var UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

  function uaFor(url, referer) {
    var l = String(url || '').toLowerCase(), r = String(referer || '').toLowerCase();
    if (l.indexOf('junyu2017.de5.net') >= 0 || r.indexOf('junyu2017.de5.net') >= 0) return UA_PLAYER;
    var desk = ['bilibili', 'douyin', 'ixigua', 'youku', 'iqiyi', 'qq.com', 'youtube', 'kuaishou'];
    for (var i = 0; i < desk.length; i++) if (l.indexOf(desk[i]) >= 0 || r.indexOf(desk[i]) >= 0) return UA_DESKTOP;
    return UA_MOBILE;
  }

  /* ------------------------------------------------------------------ HTTP */
  // 走代理: <proxy>/f?t=<token>&q=<base64url(目标地址)>&r=<referer>&c=<cookie>&ua=<ua>
  // 目标地址用 base64url 放在 `q` 里 —— 不要把 URL 明文塞进 `u`:
  //   ① Cloudflare 的 WAF/托管规则会拦"参数里带 URL"的请求(实测 u=https://… → 403 Forbidden By WAF,
  //      而 q=<base64> 正常放行), 这是本工程踩过的真坑;
  //   ② 参数名/内容都看不出是地址, 顺带少一堆转义问题。`u` 只在极老客户端兜底, 已不主动使用。
  function b64u(s) {
    var bytes = new TextEncoder().encode(String(s == null ? '' : s));   // UTF-8(中文关键词也不会坏)
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function proxied(url, opts) {
    opts = opts || {};
    var q = ZYPROXY + '/f?t=' + encodeURIComponent(PROXY_TOKEN) + '&q=' + b64u(url);
    if (opts.referer) q += '&r=' + encodeURIComponent(opts.referer);
    if (opts.cookie) q += '&c=' + encodeURIComponent(opts.cookie);
    q += '&ua=' + encodeURIComponent(opts.ua || uaFor(url, opts.referer));
    return q;
  }

  function fetchText(url, opts) {
    opts = opts || {};
    var target = ZYPROXY ? proxied(url, opts) : url;
    var init = { method: 'GET', credentials: 'omit', mode: 'cors' };
    if (!ZYPROXY) {                                  // 直连: 能改的头只有这几个
      init.headers = { 'Accept': '*/*' };
      if (opts.referer) init.referrer = opts.referer;
    }
    return fetch(target, init).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  function toJson(txt) {
    try { return JSON.parse(txt); } catch (e) { return null; }
  }
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function norm(u) { return String(u || '').trim().toLowerCase().replace(/\/+$/, ''); }

  /* ------------------------------------------------------------------ 采集源(苹果CMS) */
  // 与 Android 端 Vod.SITES 同一份内置源(逐个真测过才收的)
  var SITES = [
    { key: 'txnp', name: 'TXNQ追剧', api: 'https://cms.txnp.cn' },
    { key: 'lz', name: '量子', api: 'https://cj.lziapi.com' },
    { key: 'ffzy', name: '非凡', api: 'http://cj.ffzyapi.com' },
    { key: 'js', name: '极速', api: 'https://jszyapi.com' },
    { key: 'modu', name: '魔都', api: 'https://caiji.moduapi.cc' },
    { key: 'm360', name: '360', api: 'https://360zy.com' },
    { key: 'gs', name: '光速', api: 'https://api.guangsuapi.com' },
    { key: 'hn', name: '红牛', api: 'https://www.hongniuzy2.com' },
    { key: 'jy', name: '金鹰', api: 'https://jyzyapi.com' },
    { key: 'dytt', name: '电影天堂', api: 'http://caiji.dyttzyapi.com' },
    { key: 'bd', name: '百度', api: 'https://api.apibdzy.com' },
    { key: 'ad', name: '艾旦', api: 'https://lovedan.net' },
    { key: 'bf', name: '暴风', api: 'https://bfzyapi.com' },
    { key: 'xl', name: '新浪', api: 'https://api.xinlangapi.com', path: '/xinlangapi.php/provide//vod' },
    { key: 'jusj', name: '官采(VOX)', api: 'https://cj.jusj.top' },
    { key: 'ja', name: '建安', api: 'http://154.219.117.232:9981', path: '/jacloudapi.php/provide/vod/' },
    { key: 'juli', name: '巨量', api: 'https://api.juliang.live', path: '/api/provide/vod/' },
    { key: 'xg', name: '西瓜', api: 'https://caiji.xgzyapi.com' },
    { key: 'my', name: '猫眼', api: 'https://api.maoyanapi.top', path: '/api.php/provide/vod' },
    { key: 'iqy', name: '爱奇艺', api: 'https://iqiyizyapi.com', burnAd: true },
    { key: 'hhzy', name: '豪华', api: 'https://hhzyapi.com' }
  ];
  var DEF_PATH = '/api.php/provide/vod/';
  function spath(s) { return s.path || DEF_PATH; }
  function userSites() {
    try { return JSON.parse(localStorage.getItem('zy_sites') || '[]') || []; } catch (e) { return []; }
  }
  function saveUserSites(a) { try { localStorage.setItem('zy_sites', JSON.stringify(a)); } catch (e) {} }
  function allSites() {
    var out = SITES.slice(), seen = {};
    SITES.forEach(function (s) { seen[norm(s.api + spath(s))] = 1; });
    userSites().forEach(function (s) {
      if (s.jar) return;                                   // 蜘蛛源网页版跑不了, 不进列表
      var k = norm(s.api + (s.path || DEF_PATH));
      if (seen[k]) return;
      seen[k] = 1; out.push(s);
    });
    return out;
  }
  function siteOf(key) {
    var a = allSites();
    for (var i = 0; i < a.length; i++) if (a[i].key === key) return a[i];
    return a[0];
  }

  function apiUrl(s, qs) {
    var sep = String(s.api + spath(s)).indexOf('?') >= 0 ? '&' : '?';
    return s.api + spath(s) + sep + qs;
  }

  /** 搜一个源: 与 Java 端 Vod.search 同口径(解析 list[].vod_play_url) */
  function search(s, kw, page) {
    var u = apiUrl(s, 'ac=videolist&wd=' + enc(kw) + '&pg=' + (page || 1));
    return fetchText(u, { referer: s.api + '/', cookie: '' }).then(function (txt) {
      var j = toJson(txt);
      if (!j || !j.list) return [];
      return j.list.map(function (v) {
        return { site: s.key, siteName: s.name, id: String(v.vod_id || ''), name: v.vod_name || '',
                 pic: v.vod_pic || '', remarks: v.vod_remarks || '', year: v.vod_year || '',
                 area: v.vod_area || '', type: v.vod_type_name || '', score: v.vod_score || '',
                 content: v.vod_content || '', actor: v.vod_actor || '', director: v.vod_director || '',
                 burnAd: !!s.burnAd, eps: [] };
      });
    });
  }

  /** 详情: 同上, 并把 vod_play_url 拆成分集(多播放源取"分集是直链"的那一组) */
  function detail(s, ids) {
    var u = apiUrl(s, 'ac=videolist&ids=' + enc(ids));
    return fetchText(u, { referer: s.api + '/' }).then(function (txt) {
      var j = toJson(txt);
      var v = (j && j.list && j.list[0]) || null;
      if (!v) return [];
      var groups = String(v.vod_play_url || '').split('$$$');
      var best = 0, bestScore = -1;
      groups.forEach(function (g, gi) {
        var eps = g.split('#').filter(function (x) { return x.indexOf('$') > 0; });
        if (!eps.length) return;
        var direct = 0;
        eps.forEach(function (e) { if (/\.(m3u8|mp4|flv|ts)(\?|$)/i.test(e.split('$').pop())) direct++; });
        var score = direct * 2 + eps.length;
        if (score > bestScore) { bestScore = score; best = gi; }
      });
      var eps = String(groups[best] || '').split('#').filter(function (x) { return x.indexOf('$') > 0; })
        .map(function (x) {
          var i = x.indexOf('$');
          return { name: x.substring(0, i), url: x.substring(i + 1), ready: true, ext: '', mime: '' };
        });
      return [{ site: s.key, siteName: s.name, id: String(v.vod_id || ''), name: v.vod_name || '',
                pic: v.vod_pic || '', remarks: v.vod_remarks || '', year: v.vod_year || '',
                area: v.vod_area || '', type: v.vod_type_name || '', score: v.vod_score || '',
                content: v.vod_content || '', actor: v.vod_actor || '', director: v.vod_director || '',
                burnAd: !!s.burnAd, eps: eps }];
    });
  }

  /** 片名严格判据(与 App 的 sameTitleStrict 同一套) */
  function normTitle(s) {
    return String(s == null ? '' : s)
      .replace(/[\s·:：\-—()（）\[\]【】。.!！?？,，]/g, '')
      .replace(/第[一二三四五六七八九十0-9]+[季部]/g, '')
      .replace(/(全集|完结|国语|粤语|日语|英语|中字|中文字幕|高清|超清|蓝光|4K|HDR)/gi, '');
  }
  function sameTitle(a, b) {
    var x = normTitle(a), y = normTitle(b);
    if (!x || !y) return false;
    if (x === y) return true;
    var lo = x.length >= y.length ? x : y, sh = x.length >= y.length ? y : x;
    var head = lo.indexOf(sh) === 0, tail = lo.lastIndexOf(sh) === lo.length - sh.length;
    if (!head && !tail) return false;
    var rest = head ? lo.slice(sh.length) : lo.slice(0, lo.length - sh.length);
    return /^(\d{2,4}|[一二三四五六七八九十季部上下]{1,3})$/.test(rest);
  }

  /** 相关性别名(粗过滤: 片名出现在结果里 / 结果被片名包含) */
  function relevantTo(items, kw) {
    var k = normTitle(kw);
    if (!k) return items;
    return items.filter(function (it) {
      var n = normTitle(it.name);
      return n.indexOf(k) >= 0 || k.indexOf(n) >= 0;
    });
  }

  /* ------------------------------------------------------------------ 直播表 */
  // 与安卓端 Live.java 的 FEEDS 保持一致(那边有的这里都要有, 否则"网页端频道少一半").
  // ua 是有些源点名要的(否则直接被挡), 走代理时代理会带着它去取.
  var LIVE_FEEDS = [
    { name: 'vbskycn', urls: ['https://raw.githubusercontent.com/vbskycn/iptv/master/tv/iptv4.m3u'] },
    { name: 'jiandantv', urls: ['https://raw.githubusercontent.com/jiandantv/IPTV2026/main/live.m3u'] },
    { name: 'bilibili-live', urls: ['https://sub.ottiptv.cc/bililive.m3u'], ua: 'okHttp/Mod-1.5.0.0' },
    { name: 'huya', urls: ['https://sub.ottiptv.cc/huyayqk.m3u'], ua: 'okHttp/Mod-1.5.0.0' },
    { name: 'douyu', urls: ['https://sub.ottiptv.cc/douyuyqk.m3u'], ua: 'okHttp/Mod-1.5.0.0' },
    { name: 'yy-lunbo', urls: ['https://sub.ottiptv.cc/yylunbo.m3u'], ua: 'okHttp/Mod-1.5.0.0' },
    { name: 'singer', urls: ['https://mgtv.ottiptv.cc/mglist.m3u'], ua: 'okhttp/3.15' },
    { name: 'baohe', urls: ['https://bh.bhkj.de5.net/cs.php'], ua: 'okhttp/5.3.2' },
    { name: 'smt', urls: ['https://bh.bhkj.de5.net/smt2.txt'] },
    { name: 'migu1', urls: ['http://139.224.44.53:1234'] },
    { name: 'migu3', urls: ['http://117.72.81.53:3000'] },
    { name: 'junyu', urls: ['http://cs.junyu2017.de5.net/index.php?token=b078d8a2&type=m3u'] },
    { name: 'iptv-org-cn', urls: ['https://iptv-org.github.io/iptv/countries/cn.m3u'] },
    { name: 'okay-iptv4', urls: ['https://raw.githubusercontent.com/songlees355-wq/okay/main/IPTV4%E6%B5%8B%E8%AF%95.txt'] },
    { name: 'okay-abroad', urls: ['https://raw.githubusercontent.com/songlees355-wq/okay/main/%E5%9B%BD%E5%A4%96%E7%94%B5%E8%A7%86%E5%8F%B02026.txt'] },
    { name: 'zonghe', urls: ['http://193.123.86.190:14888/TV/iptv.php'], ua: 'bingcha/1.1 (mianfeifenxiang)' }
  ];
  function userLive() {
    try { return JSON.parse(localStorage.getItem('zy_live') || '[]') || []; } catch (e) { return []; }
  }
  function saveUserLive(a) { try { localStorage.setItem('zy_live', JSON.stringify(a)); } catch (e) {} }

  function parseM3u(text) {
    var out = [], lines = String(text).split(/\r?\n/), name = '', group = '', logo = '';
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) continue;
      if (t.indexOf('#EXTINF') === 0) {
        var c = t.indexOf(',');
        name = c > 0 ? t.substring(c + 1).trim() : '';
        var g = /group-title="([^"]*)"/i.exec(t);
        group = g ? g[1] : '';
        var l = /tvg-logo="([^"]*)"/i.exec(t);
        logo = l ? l[1] : '';
      } else if (t.charAt(0) !== '#') {
        if (name && /^https?:\/\//i.test(t)) out.push({ n: name, g: group || '未分组', logo: logo, u: [t] });
        name = ''; group = ''; logo = '';
      }
    }
    return out;
  }
  function parseTxt(text) {
    var out = [], group = '未分组';
    String(text).split(/\r?\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var gm = /^(.+?)\s*,#genre#\s*$/.exec(t);
      if (gm) { group = gm[1]; return; }
      var i = t.indexOf(',');
      if (i <= 0) return;
      var name = t.substring(0, i).trim(), url = t.substring(i + 1).trim();
      if (name && /^https?:\/\//i.test(url)) out.push({ n: name, g: group, logo: '', u: [url] });
    });
    return out;
  }
  function mergeChannels(map, ch) {
    var k = ch.g + '|' + ch.n;
    if (!map[k]) { map[k] = { n: ch.n, g: ch.g, logo: ch.logo, u: [] }; }
    var m = map[k];
    ch.u.forEach(function (u) { if (m.u.indexOf(u) < 0 && m.u.length < 12) m.u.push(u); });
    return m;
  }

  var liveAll = null;
  function liveRefresh(done) {
    var feeds = LIVE_FEEDS.concat(userLive().map(function (x) { return { name: x.name, urls: [x.url] }; }));
    var map = {}, got = 0, failed = 0;
    var jobs = feeds.map(function (f) {
      return fetchText(f.urls[0], { referer: '', ua: f.ua || '' }).then(function (txt) {
        if (!txt || txt.length < 20) throw new Error('empty');
        var list = txt.indexOf('#EXTM3U') >= 0 ? parseM3u(txt) : parseTxt(txt);
        list.forEach(function (c) { mergeChannels(map, c); });
        got++;
      }).catch(function () { failed++; });
    });
    return Promise.all(jobs).then(function () {
      var list = Object.keys(map).map(function (k) { return map[k]; });
      if (!list.length) throw new Error('一个频道都没拉到(表都不可用?)');
      liveAll = list;
      try { localStorage.setItem('zy_live_cache', JSON.stringify(list)); } catch (e) {}
      if (done) done({ count: list.length, tags: got + '/' + feeds.length });
      return list;
    });
  }
  function liveList() {
    if (liveAll) return liveAll;
    try { liveAll = JSON.parse(localStorage.getItem('zy_live_cache') || '[]') || []; } catch (e) { liveAll = []; }
    return liveAll;
  }

  /* ------------------------------------------------------------------ 豆瓣评分 */
  function doubanOne(name) {
    var key = String(name || '').replace(/\[[^\]]*\]/g, '').replace(/[（(][^）)]*[）)]/g, '').trim();
    if (key.length < 2) return Promise.resolve(null);
    return fetchText('https://movie.douban.com/j/subject_suggest?q=' + enc(key), { referer: 'https://movie.douban.com/' })
      .then(function (txt) {
        var arr = toJson(txt);
        if (!arr || !arr.length || !arr[0].id) return null;
        var o = arr[0];
        return fetchText('https://m.douban.com/rexxar/api/v2/movie/' + o.id + '?for_mobile=1',
          { referer: 'https://m.douban.com/movie/subject/' + o.id + '/' })
          .then(function (t2) {
            var j = toJson(t2) || {}, r = j.rating || {};
            return { name: name, id: o.id, title: o.title || '', year: o.year || '', img: o.img || '',
                     rating: r.value || '', intro: j.intro || '',
                     genres: (j.genres || []).slice(0, 3).join('/') };
          });
      })
      .catch(function () { return null; });
  }

  /* ------------------------------------------------------------------ TVBox 配置解密 */
  function hexToBytes(hex) {
    var t = String(hex).replace(/\s+/g, '');
    if (t.length % 2) t = t.slice(0, -1);
    var out = new Uint8Array(t.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
    return out;
  }
  function aesDecrypt(pw, iv, bytes) {
    var key = new TextEncoder().encode((pw + '0000000000000000').slice(0, 16));
    var ivb = new TextEncoder().encode((iv + '0000000000000000').slice(0, 16));
    if (!root.crypto || !root.crypto.subtle) return Promise.reject(new Error('这个浏览器没有 WebCrypto(需要 https 或 localhost)'));
    return root.crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt'])
      .then(function (k) { return root.crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivb }, k, bytes.slice(0, bytes.length - (bytes.length % 16))); })
      .then(function (buf) { return new TextDecoder().decode(buf); });
  }
  /** 解一段配置文本: 明文 JSON / base64 包装 / hex($#口令#$ + AES + IV) */
  function analyze(text, url, chars, ms) {
    var out = { ok: false, url: url || '', chars: chars || (text ? text.length : 0), ms: ms || 0 };
    var t = String(text || '').trim().replace(/^\uFEFF/, '');
    function parsePlain(txt) {
      var keep = txt.split('\n').filter(function (ln) { return ln.trim().indexOf('//') !== 0; }).join('\n');
      var j = null;
      try { j = JSON.parse(txt); } catch (e) { try { j = JSON.parse(keep); } catch (e2) { return false; } }
      fill(j, txt);
      return true;
    }
    function fill(j, txt) {
      out.ok = true;
      out.shape = '明文 JSON';
      var sites = (j.sites || []), lives = (j.lives || []), apis = [], spiders = [];
      sites.forEach(function (s) {
        var api = String(s.api || '');
        if (api.indexOf('csp_') === 0) { spiders.push({ key: api, name: s.name || api, ext: s.ext || '', jar: j.spider || '' }); return; }
        if (/^https?:/.test(api) && /(api\.php\/provide\/vod|\/provide\/vod|ac=(videolist|detail|list)|at=json)/i.test(api)) {
          apis.push({ name: s.name || api, raw: api });
        }
      });
      out.sites = sites.length; out.lives = lives.length; out.subs = (j.urls || []).length;
      out.apis = apis; out.spiders = spiders;
      out.spiderJar = j.spider || '';
      out.livesList = lives.map(function (L) { return { name: L.name || '', url: L.url || '', ua: L.ua || '' }; })
        .filter(function (L) { return /^https?:/.test(L.url); });
      out.json = txt;
      // 采集接口拆成 base/path(与 App 的 splitApi 同口径)
      out.apis.forEach(function (a) {
        var i = a.raw.indexOf('/api.php/'); if (i < 0) i = a.raw.indexOf('/provide/'); if (i < 0) i = a.raw.indexOf('/inc/');
        if (i < 0) { a.base = ''; a.path = ''; return; }
        a.base = a.raw.substring(0, i);
        a.path = a.raw.substring(i).split('?')[0];
        if (a.path.slice(-1) !== '/') a.path += '/';
      });
    }
    if (!t) { out.error = '内容是空的'; return Promise.resolve(out); }
    if (t.charAt(0) === '{' || t.charAt(0) === '/') { if (parsePlain(t)) return Promise.resolve(out); }
    if (/^[0-9a-fA-F\s]+$/.test(t)) {
      var blob = hexToBytes(t);
      var s = '';
      for (var i = 0; i < Math.min(blob.length, 60); i++) s += String.fromCharCode(blob[i]);
      if (s.indexOf('$#') === 0) {
        var j2 = s.indexOf('#$'), pw = s.substring(2, j2);
        var body = blob.slice(j2 + 2);
        // IV 是"结尾那串数字"(生成器一般用 13 位毫秒时间戳)。注意一个真实的坑:
        // 密文的最后一个字节如果恰好也是数字, 贪心取数字就会多取一位 —— 于是这里试几个候选:
        // 贪心串、末 13 位、末 10 位、末 16 位, 谁能解出 JSON 就用谁(与 App 端同一套思路)。
        var greedy = '';
        for (var k = body.length - 1; k >= 0 && /\d/.test(String.fromCharCode(body[k])); k--) greedy = String.fromCharCode(body[k]) + greedy;
        if (greedy.length < 8) { out.error = '结尾没有 IV 数字'; return Promise.resolve(out); }
        var cands = [greedy];
        [13, 10, 16, 15, 14].forEach(function (n) { if (greedy.length > n) cands.push(greedy.slice(greedy.length - n)); });
        var seen = {};
        cands = cands.filter(function (x) { if (seen[x]) return false; seen[x] = 1; return x.length >= 8 && x.length <= 20; });
        out.encrypted = true; out.pw = pw;
        var tryOne = function (idx) {
          if (idx >= cands.length) { out.ok = false; out.error = out.error || 'AES 解密失败(IV 候选都试过了)'; return Promise.resolve(out); }
          var iv = cands[idx];
          var ct = body.slice(0, body.length - iv.length);
          out.iv = iv;
          return aesDecrypt(pw, iv, ct).then(function (plain) {
            if (parsePlain(plain)) { out.shape = 'AES-128-CBC 解密(口令 ' + pw + ', IV ' + iv + ')'; return out; }
            out.error = '解密出来的不是 JSON';
            return tryOne(idx + 1);
          }).catch(function () { return tryOne(idx + 1); });
        };
        return tryOne(0);
      }
      out.error = 'hex 文本里没有 $#口令#$ 前缀, 不是这套加密';
      return Promise.resolve(out);
    }
    try {
      var dec = decodeURIComponent(escape(atob(t.replace(/\s+/g, ''))));
      if (parsePlain(dec)) { out.shape = 'base64 包装'; return Promise.resolve(out); }
    } catch (e) {}
    try { if (parsePlain(t)) { out.shape = '明文 JSON(容错)'; return Promise.resolve(out); } } catch (e) {}
    out.error = '认不出这个形态(不是明文/base64/$#口令#$ 的 hex)';
    out.head = t.substring(0, 200);
    return Promise.resolve(out);
  }

  /* ------------------------------------------------------------------ 本地代理(交给 Service Worker) */
  var SWTOKEN = Math.random().toString(16).slice(2, 10);
  /**
   * 同源出口。站点自己就是那个 Cloudflare Worker, 所以 `https://站点/f|/p` 就能用,
   * 而且: ① 不跨域(浏览器不会因缺 CORS 头黑屏); ② 有没有 Service Worker 都能用
   * (没 SW 时请求直接到 Worker, 它会就地改写清单; 有 SW 时 SW 拦 /p 做广告过滤)。
   * 这是直播/VOD 最稳的一条出口 —— 之前用跨域的 zyapi 域名, 一旦那边解析/被挡, 直播就整个黑屏。
   */
  function sameOriginProxy(url, referer, cookie) {
    if (!url) return '';
    var base = '';
    try { base = location.origin + location.pathname.replace(/[^/]*$/, ''); } catch (e) { return ''; }
    var s0 = String(url);
    var looksPl = /\.m3u8(\?|$)/i.test(s0) || !/\.[a-z0-9]{2,4}(\?|$)/i.test(s0);
    return base + (looksPl ? 'f' : 'p') + '?t=' + encodeURIComponent(PROXY_TOKEN) + '&q=' + b64u(url)
      + (referer ? '&r=' + encodeURIComponent(referer) : '')
      + (cookie ? '&c=' + encodeURIComponent(cookie) : '');
  }
  /** 站点和代理是不是同一台(线上就是) —— 是的话优先走同源, 少一层跨域风险 */
  function sameHostProxy() {
    try { return !!ZYPROXY && (new URL(ZYPROXY)).host === location.host; } catch (e) { return false; }
  }

  /**
   * 直播专用出口: 直接给 Worker 地址(不经过页面的 Service Worker)。
   * 为什么单开一个: 直播一旦卡在"旧 SW 直接跨域取流"上就是黑屏, 而且用户在浏览器里
   * 不一定刷新过 SW。Worker 侧现在会把清单里的每条地址改写成继续走它自己(见 proxy/worker.js),
   * 所以直播彻底不依赖 SW 也能播; App 侧没有这个桥方法, 会照旧走 LocalProxy。
   */
  function proxyLive(url, referer, cookie) {
    if (!url) return '';
    var so0 = sameOriginProxy(url, referer, cookie);
    if (so0) return so0;                       // 线上: 站点就是 Worker —— 同源最稳
    if (!ZYPROXY) return '';
    var s0 = String(url);
    if (s0.indexOf(ZYPROXY + '/f?') === 0 || s0.indexOf(ZYPROXY + '/p?') === 0) return url;
    var looksPl = /\.m3u8(\?|$)/i.test(s0) || !/\.[a-z0-9]{2,4}(\?|$)/i.test(s0);
    return ZYPROXY + (looksPl ? '/f' : '/p') + '?t=' + encodeURIComponent(PROXY_TOKEN) + '&q=' + b64u(url)
      + (referer ? '&r=' + encodeURIComponent(referer) : '')
      + (cookie ? '&c=' + encodeURIComponent(cookie) : '');
  }

  function proxyWrap(url, referer, cookie) {
    if (!url) return url;
    var s0 = String(url);
    var base = '';
    try { base = location.origin + location.pathname.replace(/[^/]*$/, ''); } catch (e) {}
    // ① 已经是"本代理地址"就别再套一层 —— 直播线路在 startLiveChannel 里先包过一次, 再包一层
    //    就变成"代理的代理", 播放器直接播不动。安卓端靠 127.0.0.1 判断躲过了这个问题, 网页端漏了。
    if (base && s0.indexOf(base + 'p?') === 0) return url;
    // ①b 已经是"Worker 代理地址"同理: 再套一层会变成 Worker 去 fetch 它自己
    //     (Cloudflare 会直接报错/递归), 直播就是这么整条链断掉的。
    if (ZYPROXY && (s0.indexOf(ZYPROXY + '/f?') === 0 || s0.indexOf(ZYPROXY + '/p?') === 0)) return url;
    // ② Service Worker 还没接管(首次打开/刚更新)时不能返回裸地址: 浏览器直连上游普遍缺 CORS 头,
    //    直播就是"黑屏"。这时退回直接走 Cloudflare 代理, 至少能拿到字节。
    if (!root.navigator || !root.navigator.serviceWorker || !root.navigator.serviceWorker.controller) {
      var so = sameOriginProxy(url, referer, cookie);
      if (so) return so;                       // 没 SW: 同源出口(Worker 会改写清单)
      if (!ZYPROXY) return url;
      var looksPl = /\.m3u8(\?|$)/i.test(s0) || !/\.[a-z0-9]{2,4}(\?|$)/i.test(s0);
      return ZYPROXY + (looksPl ? '/f' : '/p') + '?t=' + encodeURIComponent(PROXY_TOKEN) + '&q=' + b64u(url)
        + (referer ? '&r=' + encodeURIComponent(referer) : '')
        + (cookie ? '&c=' + encodeURIComponent(cookie) : '');
    }
    var q = 'p?t=' + SWTOKEN + '&q=' + b64u(url);
    if (referer) q += '&r=' + encodeURIComponent(referer);
    if (cookie) q += '&c=' + encodeURIComponent(cookie);
    return base + q;
  }

  /* ------------------------------------------------------------------ 桥 */
  var adFilterOn = true, adDropped = 0, adNote = '';
  function call(name) {
    var fn = root[name];
    if (typeof fn === 'function') { try { fn.apply(root, Array.prototype.slice.call(arguments, 1)); } catch (e) {} }
  }
  function toast(m) { call('PK_toast', String(m)); }
  if (!root.PK_toast) root.PK_toast = function (m) {
    var d = document.createElement('div');
    d.textContent = String(m);
    d.style.cssText = 'position:fixed;left:50%;bottom:12%;transform:translateX(-50%);background:rgba(0,0,0,.82);'
      + 'color:#fff;padding:8px 14px;border-radius:16px;font-size:13px;z-index:99999;max-width:80%;text-align:center';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 2200);
  };

  root.ZYBRIDGE = { search: search, detail: detail, allSites: allSites, sameTitle: sameTitle,
                    fetchText: fetchText, analyze: analyze, liveRefresh: liveRefresh, doubanOne: doubanOne,
                    config: function () { return { proxy: ZYPROXY, token: PROXY_TOKEN, swToken: SWTOKEN }; } };

  var VOD = {
    sites: function () { return JSON.stringify(allSites()); },
    userSites: function () { return JSON.stringify(userSites()); },
    search: function (kw) {
      var all = allSites();
      var acc = [], done = 0;
      all.forEach(function (s) {
        search(s, kw, 1).then(function (items) {
          var rel = relevantTo(items, kw);
          if (rel.length) { acc = acc.concat(rel); call('onVodSearch', acc); }
        }).catch(function () {}).then(function () {
          if (++done === all.length && !acc.length) call('onVodSearch', []);
        });
      });
    },
    home: function (siteKey, typeId, page, seq) {
      var s = siteOf(siteKey);
      var u = apiUrl(s, 'ac=videolist' + (typeId ? ('&t=' + enc(typeId)) : '') + '&pg=' + (page || 1));
      fetchText(u, { referer: s.api + '/' }).then(function (txt) {
        var j = toJson(txt) || {};
        var items = (j.list || []).map(function (v) {
          return { site: s.key, siteName: s.name, id: String(v.vod_id || ''), name: v.vod_name || '',
                   pic: v.vod_pic || '', remarks: v.vod_remarks || '', year: v.vod_year || '', eps: [] };
        });
        call('onVodHome', seq, items);
      }).catch(function () { call('onVodHome', seq, []); });
    },
    classes: function (siteKey) {
      var s = siteOf(siteKey);
      fetchText(apiUrl(s, 'ac=list'), { referer: s.api + '/' }).then(function (txt) {
        var j = toJson(txt) || {};
        var out = (j.class || []).map(function (c) {
          return { id: String(c.type_id || ''), name: c.type_name || '', pid: String(c.type_pid || '') };
        });
        call('onVodClasses', out);
      }).catch(function () { call('onVodClasses', []); });
    },
    detail: function (siteKey, id, name) {
      var s = siteOf(siteKey);
      detail(s, id).then(function (items) {
        if (items.length) call('onVodDetail', items);
        else call('onVodError', '这条源没给出可播放地址');
      }).catch(function (e) { call('onVodError', '详情取不到: ' + e.message); });
    },
    detailPeers: function (siteKey, id, name, peersJson) {
      var peers = [];
      try { peers = JSON.parse(peersJson) || []; } catch (e) {}
      var out = [];
      var jobs = peers.map(function (p) {
        var s = siteOf(p.s);
        if (!s) return Promise.resolve();
        return detail(s, p.i).then(function (items) {
          items.forEach(function (it) {
            if (it.eps.length && (String(it.name) === String(name) || sameTitle(it.name, name))) out.push(it);
          });
        }).catch(function () {});
      });
      return Promise.all(jobs).then(function () {
        if (!out.length) return VOD.detail(siteKey, id, name);
        call('onVodDetail', out);
      });
    },
    moreSources: function (name, excludeSite) {
      var all = allSites(), found = [], done = 0;
      var jobs = all.filter(function (s) { return s.key !== excludeSite; }).slice(0, 10).map(function (s) {
        return search(s, name, 1).then(function (items) {
          var hit = items.filter(function (it) { return sameTitle(it.name, name); })[0];
          if (!hit) return;
          return detail(s, hit.id).then(function (ds) {
            var it = ds[0];
            if (it && it.eps.length) found.push({ site: s.key, siteName: s.name, id: it.id, name: it.name,
              pic: it.pic, remarks: it.remarks, burnAd: !!s.burnAd, eps: it.eps });
          });
        }).catch(function () {});
      });
      return Promise.all(jobs).then(function () { call('onMoreSources', name, found); });
    },
    addSite: function (key, name, base, path) {
      var p = path || DEF_PATH;
      var probe = apiUrl({ api: base, path: p }, 'ac=videolist&wd=' + enc('庆余年'));
      return fetchText(probe, { referer: base + '/' }).then(function (txt) {
        var j = toJson(txt) || {}, n = (j.list || []).length;
        if (!n) { call('onAddSite', name, JSON.stringify({ ok: false, msg: '真测没过(没返回片单), 不加' })); return; }
        var u = userSites();
        u.push({ key: key, name: name, api: base, path: p });
        saveUserSites(u);
        call('onAddSite', name, JSON.stringify({ ok: true, msg: '已加入(真测 ' + n + ' 条)' }));
      }).catch(function (e) {
        call('onAddSite', name, JSON.stringify({ ok: false, msg: '真测失败: ' + e.message }));
      });
    },
    delSite: function (key) {
      var u = userSites().filter(function (s) { return s.key !== key; });
      saveUserSites(u);
      call('onAddSite', '', JSON.stringify({ ok: true, msg: '已删除' }));
    },
    decryptText: function (text) {
      analyze(text, '', text.length, 0).then(function (o) { call('onDecrypt', JSON.stringify(o)); });
    },
    decryptUrl: function (url) {
      var t0 = Date.now();
      fetchText(url, { referer: url }).then(function (txt) {
        return analyze(txt, url, txt.length, Date.now() - t0);
      }).then(function (o) { call('onDecrypt', JSON.stringify(o)); })
        .catch(function (e) { call('onDecrypt', JSON.stringify({ ok: false, url: url, error: '取不到: ' + e.message })); });
    },
    probeSiteUrl: function (pageUrl) {
      var m = /^(https?:\/\/[^\/]+)/.exec(pageUrl);
      var base = m ? m[1] : '';
      var paths = [DEF_PATH, '/api.php/provide/vod/at/json/', '/index.php/api/vod/', '/api.php/provide/vod/from/vod/'];
      var i = 0, trace = [];
      function step() {
        if (i >= paths.length) { call('onProbeSite', JSON.stringify({ ok: false, base: base, trace: trace.join(' '), msg: '没探到可用的采集接口' })); return; }
        var p = paths[i++], u = base + p + '?ac=videolist&wd=' + enc('庆余年');
        fetchText(u, { referer: base + '/' }).then(function (txt) {
          var j = toJson(txt) || {}, list = j.list || [];
          if (list.length) {
            trace.push(p + '✓');
            call('onProbeSite', JSON.stringify({ ok: true, base: base, path: p, key: base.replace(/[^a-z0-9]/gi, '').slice(0, 10),
              name: base, n: list.length, sample: (list[0].vod_name || ''), ms: 0, trace: trace.join(' ') }));
          } else { trace.push(p + '✗'); step(); }
        }).catch(function () { trace.push(p + '✗'); step(); });
      }
      step();
    },
    // 蜘蛛(jar)在浏览器里跑不了: 如实说明, 不装样子
    addSpiderSite: function (key, name) { call('onAddSite', name, JSON.stringify({ ok: false, msg: '网页版跑不了蜘蛛 jar(需要 DexClassLoader)' })); },
    spiderTest: function () { call('onSpiderTest', JSON.stringify({ loaded: false, error: '网页版不支持蜘蛛 jar' })); },
    spiderPlay: function () { call('onSpiderPlay', '', JSON.stringify({ ok: false, error: '网页版不支持蜘蛛 jar' })); },
    clipText: function () { return ''; },
    copyText: function (s) { try { root.navigator.clipboard.writeText(String(s || '')); toast('已复制'); } catch (e) { toast('复制失败'); } }
  };

  /* --------------------------------------------------- 网页版专属: 画面亮度 / 媒体音量 */
  var webBright = 1;                                   // 1 = 原样(和 App 的"系统亮度百分比"不同, 这里只调画面)
  function videoEl() { try { return root.document.getElementById('video'); } catch (e) { return null; } }
  function playerEl() { try { return root.document.getElementById('player'); } catch (e) { return null; } }
  function setWebBright(v) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) v = 1;
    webBright = Math.max(0.2, Math.min(1.6, v));
    var el = videoEl();
    if (el) el.style.filter = Math.abs(webBright - 1) < 0.01 ? '' : 'brightness(' + webBright.toFixed(2) + ')';
  }

  var PK = {
    // ★ 网页版标记: app.js 与 index.html 是 App / 网页共用的同一份界面,
    //   凡是"只有原生做得到"的东西(投屏 / 解析线路 / 调起外部播放器 / 应用内更新 / 蜘蛛 jar / 下载),
    //   靠这个标记在网页端**连按钮带入口一起去掉**; App 侧没有 PK.web, 行为一个字节不变。
    web: true,
    toast: function (m) { root.PK_toast(m); },
    appVersion: function () { return 'web-' + (CFG.version || 'dev'); },
    isLandscape: function () {
      try { if (root.screen && screen.orientation && screen.orientation.type) return /landscape/.test(screen.orientation.type); } catch (e) {}
      return root.innerWidth > root.innerHeight;
    },
    /**
     * 横屏/竖屏。浏览器里 `screen.orientation.lock()` **只有全屏之后才让调**, 桌面端更是根本不支持,
     * 所以: 先全屏 -> 再锁方向; 关的时候先解锁 -> 再退全屏。(以前这里只裸调 lock, 没进全屏,
     * 于是"横屏按钮点了没反应" —— 用户反馈的就是这个。)
     */
    landscape: function (on) {
      var el = playerEl() || root.document.documentElement;
      try {
        if (on) {
          if (el.requestFullscreen && !root.document.fullscreenElement) {
            var pr = el.requestFullscreen(); if (pr && pr.catch) pr.catch(function () {});
          }
          if (root.screen && screen.orientation && screen.orientation.lock) {
            setTimeout(function () {
              try { var q = screen.orientation.lock('landscape'); if (q && q.catch) q.catch(function () {}); } catch (e) {}
            }, 150);
          }
        } else {
          try { if (root.screen && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
          if (root.document.fullscreenElement && root.document.exitFullscreen) {
            var pr2 = root.document.exitFullscreen(); if (pr2 && pr2.catch) pr2.catch(function () {});
          }
        }
      } catch (e) {}
    },
    /** 能不能真的锁方向(手机浏览器全屏后可以, 桌面端不行) —— app.js 用它决定"横屏"按钮留不留 */
    canLockOrientation: function () {
      try { return !!(root.screen && screen.orientation && screen.orientation.lock && ('ontouchstart' in root)); } catch (e) { return false; }
    },
    lockOrientation: function (locked) {
      try {
        if (root.screen && screen.orientation && screen.orientation.lock && locked) {
          var q = screen.orientation.lock(screen.orientation.type || 'portrait'); if (q && q.catch) q.catch(function () {});
        } else if (root.screen && screen.orientation && screen.orientation.unlock) {
          screen.orientation.unlock();
        }
      } catch (e) {}
    },
    playerOpen: function () {},
    exit: function () { try { history.back(); } catch (e) {} },
    compat: function () { return ''; }, legacy: function () { return false; }, bootOk: function () {},
    poll: function () { return ''; },
    // 亮度: 浏览器碰不到系统亮度, 就把手势映射成画面的 CSS 滤镜(有反馈, 不是死键)
    brightnessLevel: function () { return Math.round(webBright * 100); },
    brightness: function (v) { setWebBright(v); return Math.round(webBright * 100); },
    // 音量: App 调的是系统音量; 网页版只能调 <video>.volume —— 顺带把 muted 摘掉,
    // 否则"浏览器自动播放策略"留下的 muted=true 会一直静音, 而界面上没有任何地方能改(PC 上没手势)
    volumeLevel: function () { var v = videoEl(); return Math.round((v ? (v.muted ? 0 : v.volume) : 1) * 100); },
    volume: function (v) {
      var el = videoEl(); if (!el) return -1;
      try {
        el.muted = false;
        el.volume = Math.max(0, Math.min(1, Number(v)));
      } catch (e) {}
      return Math.round(el.volume * 100);
    },
    /** 解除自动播放策略留下的静音(网页版在第一次用户手势后调一次) */
    unmute: function () {
      var el = videoEl(); if (!el) return -1;
      try { el.muted = false; if (!(el.volume > 0)) el.volume = 1; } catch (e) {}
      return Math.round(el.volume * 100);
    },
    // 广告过滤: 由 Service Worker 在改写 m3u8 时调用同一份 adfilter.js
    adFilter: function (on) { adFilterOn = !!on; },
    adStats: function () { return JSON.stringify({ on: adFilterOn, dropped: adDropped, note: adNote }); },
    proxyWrap: function (u, r, c) { return proxyWrap(u, r, c); },
    proxyLive: function (u, r, c) { return proxyLive(u, r, c); },
    douban: function (namesJson, limit) {
      var names = [];
      try { names = JSON.parse(namesJson) || []; } catch (e) {}
      names = names.slice(0, Math.max(1, limit || 12));
      var out = [], done = 0;
      names.forEach(function (n) {
        doubanOne(n).then(function (d) { if (d) out.push(d); }).catch(function () {}).then(function () {
          if (++done === names.length) call('onDouban', out);
        });
      });
      if (!names.length) call('onDouban', []);
    },
    liveMeta: function () {
      var l = liveList(), g = {}, order = [];
      l.forEach(function (c) { if (!g[c.g]) { g[c.g] = 0; order.push(c.g); } g[c.g]++; });
      return JSON.stringify({ ok: true, count: l.length, ts: Date.now(), tags: 'web', mirror: '', stale: false,
        groups: order.map(function (n) { return { name: n, n: g[n] }; }) });
    },
    liveChannels: function (group) {
      var l = liveList();
      return JSON.stringify(l.filter(function (c) { return !group || c.g === group; }));
    },
    liveRefresh: function () {
      liveRefresh().then(function (l) { call('onLive', '频道表已更新: ' + l.length + ' 个频道'); })
        .catch(function (e) { call('onLive', '更新失败: ' + e.message); });
    },
    liveAuto: function () { if (!liveList().length) PK.liveRefresh(); },
    liveSweep: function () { call('onLiveSweep', '网页版不做线路测速'); },
    /**
     * 线路探活。两个坑都在这里踩过, 所以现在只保留"最稳"的实现:
     *   ① 以前回调 id 传的是**空串**, 而 playLive() 在 liveWait 里登记的是 'lv1'/'lv2'… ——
     *      onLiveProbe 查不到记录直接 return, 表现就是「点了直播, 播放器永远出不来」;
     *   ② 后来改成真去拉清单+超时深探, 逻辑是清楚了, 但网页端这一层没有原生那套探测能力,
     *      多一层异步就多一个"卡住不回调"的机会。现在**同步回调**, 保证播放器一定起来:
     *      全部线路按 HLS 候选回报, 播不动时 App 自己的自动换线会接着试下一条。
     */
    liveProbe: function (id, urlsJson) {
      var urls = [];
      try { urls = JSON.parse(urlsJson) || []; } catch (e) {}
      var out = [];
      for (var i = 0; i < urls.length && i < 8; i++) {
        if (!/^https?:\/\//i.test(String(urls[i] || ''))) continue;
        out.push({ u: String(urls[i]), ok: true, k: 'm3u8', c: 200, ms: 0 });
      }
      call('onLiveProbe', id, JSON.stringify(out));
    },
    liveAddSource: function (name, url) {
      var u = userLive(); u.push({ name: name || '自加', url: url }); saveUserLive(u);
      call('onLiveAddSource', name, JSON.stringify({ ok: true, msg: '已加入' }));
    },
    liveDelSource: function (name) { saveUserLive(userLive().filter(function (x) { return x.name !== name; })); },
    liveUserSources: function () { return JSON.stringify(userLive()); },
    liveForget: function () { try { localStorage.removeItem('zy_live_play'); } catch (e) {} },
    livePlay: function () { return ''; },
    // 网页版做不了的三件事: 如实返回失败, 让界面走兜底
    castSearch: function () { call('onCastList', []); toast('网页版不支持投屏(DLNA 需要原生 socket)'); },
    castTo: function () { call('onCastResult', false, '网页版不支持投屏'); },
    castSeek: function () {},
    checkUpdate: function () { call('onUpdateInfo', JSON.stringify({ hasUpdate: false, versionName: PK.appVersion() })); },
    installUpdate: function () { call('onUpdateResult', false, '网页版用浏览器刷新即可, 不需要装包'); },
    openInstallPerm: function () {}, openExternal: function (u) { try { root.open(u, '_blank'); } catch (e) {} },
    openFile: function () { toast('网页版不能打开本地文件播放'); },
    // 解析线路: 网页版没有隐藏 WebView, 抓不到页面里的流 —— 如实报错
    vipLines: function () { return JSON.stringify([{ i: 0, name: '网页版不支持', mark: '', note: '需要原生 WebView 嗅探', gate: false }]); },
    vipSniff: function () { toast('网页版抓不到网页里的流(需要 App 的隐藏 WebView)'); },
    platResolve: function (pageUrl) {
      // 只做"平台 API 本身就允许跨域"的那种(如 B 站), 其余如实返回空
      var out = [];
      var fail = function () { call('onPlatResolved', pageUrl, JSON.stringify([])); };
      if (/bilibili\.com|b23\.tv/.test(pageUrl)) {
        var m = /\/video\/(BV[0-9A-Za-z]+)/.exec(pageUrl);
        if (!m) return fail();
        fetchText('https://api.bilibili.com/x/web-interface/view?bvid=' + m[1], { referer: 'https://www.bilibili.com/' })
          .then(function (t) { var j = toJson(t) || {}; var cid = j.data && j.data.cid; var bvid = m[1];
            return fetchText('https://api.bilibili.com/x/player/playurl?bvid=' + bvid + '&cid=' + cid + '&fnval=1&qn=80',
              { referer: 'https://www.bilibili.com/' }); })
          .then(function (t2) { var j2 = toJson(t2) || {}; var durl = (j2.data && j2.data.durl) || [];
            durl.forEach(function (d) { out.push({ url: d.url, ext: 'mp4', quality: 'B站', source: 'bilibili-web' }); });
            call('onPlatResolved', pageUrl, JSON.stringify(out)); })
          .catch(fail);
        return;
      }
      fail();
    },
    rescueResolve: function (name, epIndex, epName) { call('onRescueResolved', false, '网页版不支持按片名救场解析'); },
    openExternal: function (u) { try { root.open(u, '_blank'); } catch (e) {} }
  };

  /* 把"上游出口"告诉 Service Worker: 直播源和很多片源没有 CORS 头,
     由 SW 直接 fetch 只能拿到不透明响应(读不到字节 = 黑屏), 交给 Worker 去取就正常了。
     页面这里送过去的配置能带上运行时改过的值(localStorage), SW 拿不到时会自己读 /webconfig.js 兜底。 */
  function pushSwCfg() {
    try {
      var sw = root.navigator && root.navigator.serviceWorker;
      if (!sw || !sw.controller) return;
      sw.controller.postMessage({ type: 'proxycfg', proxy: ZYPROXY, token: PROXY_TOKEN });
    } catch (e) {}
  }
  try {
    pushSwCfg();
    if (root.navigator && root.navigator.serviceWorker) {
      root.navigator.serviceWorker.addEventListener('controllerchange', function () { setTimeout(pushSwCfg, 300); });
    }
    root.setInterval(pushSwCfg, 5000);      // SW 会被浏览器回收, 配置隔一会儿补一次
  } catch (e) {}

  /* ---------------------------------------------------------------- 版本自检 / 缓存自救
     背景: 改完代码"界面一点没变"这件事, 前后被浏览器缓存、Cloudflare 边缘缓存坑过好几轮。
     现在构建产物带指纹(__ZYBUILD + 静态资源 ?v= + /version.json), 页面自己会发现新旧不一致,
     并且给一个明确可点的"刷新到新版"入口 —— 用户不用记得按 Ctrl+Shift+R。 */
  function buildStamp() { try { return String(root.__ZYBUILD || ''); } catch (e) { return ''; } }
  function showVersionTag() {
    try {
      var doc = root.document;
      if (!doc || doc.getElementById('zyver')) return;
      var h1 = doc.querySelector('header h1');
      if (!h1) return;
      var d = doc.createElement('span');
      d.id = 'zyver';
      d.className = 'dim';
      d.style.cssText = 'font-size:10px;opacity:.65;margin-left:7px;vertical-align:middle';
      d.textContent = 'v' + (buildStamp().slice(-6) || 'dev');
      h1.parentNode.insertBefore(d, h1.nextSibling);
    } catch (e) {}
  }
  function showUpdateHint(remote) {
    try {
      var doc = root.document;
      if (!doc || doc.getElementById('zynewver')) return;
      var d = doc.createElement('div');
      d.id = 'zynewver';
      d.textContent = '🔄 网页版有新版本，点这里刷新';
      d.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99;'
        + 'background:linear-gradient(180deg,#6f5bff,#4a36d6);color:#fff;font-size:13px;font-weight:600;'
        + 'padding:10px 16px;border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.45);cursor:pointer';
      d.onclick = function () { try { root.location.reload(); } catch (e) {} };
      doc.body.appendChild(d);
    } catch (e) {}
  }
  function checkBuild() {
    var cur = buildStamp();
    if (!cur) return;
    fetch('/version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.v || j.v === cur) return;
        var pl = root.document && root.document.getElementById('player');
        var playing = pl && ('' + pl.className).indexOf('on') >= 0;
        // 没在看片就直接换新版(不留旧版); 看片中只提示, 不打断
        if (!playing) { try { root.location.reload(); } catch (e) {} return; }
        showUpdateHint(j.v);
      }).catch(function () {});
  }
  try {
    showVersionTag();
    setTimeout(checkBuild, 3000);
    setInterval(checkBuild, 5 * 60 * 1000);
    if (root.document) root.document.addEventListener('visibilitychange', function () {
      if (!root.document.hidden) checkBuild();
    });
  } catch (e) {}

  /* 详情页"封面做背景虚化": 皮肤里有 html.web body::after 用 --z-poster 做一层模糊背景。
     封面地址只有 DOM 里才知道, 所以这里盯一下 #v-detail, 一出现封面就写进 CSS 变量(纯网页端装饰)。 */
  function watchPoster() {
    try {
      var doc = root.document;
      var v = doc && doc.getElementById('v-detail');
      if (!v || !root.MutationObserver) return;
      var upd = function () {
        var img = v.querySelector('img');
        var src = img && (img.getAttribute('src') || '');
        if (src && src.indexOf('data:') !== 0) doc.body.style.setProperty('--z-poster', 'url("' + src + '")');
      };
      new root.MutationObserver(upd).observe(v, { childList: true, subtree: true });
      upd();
    } catch (e) {}
  }
  try { setTimeout(watchPoster, 800); } catch (e) {}

  root.VOD = VOD; root.PK = PK;
  root.ZY_onAdStats = function (s) { adDropped = s.dropped || adDropped; adNote = s.note || adNote; };
  console.log('[ZY影视 网页版] 桥已就绪; CORS 代理 = ' + (ZYPROXY || '(未配置, 只有允许跨域的接口能用)'));
})(typeof self !== 'undefined' ? self : this);
