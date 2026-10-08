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
  // 用户在页面里显式配过的代理(localStorage 'zyweb_cfg')—— 优先级最高, 用来指向自己的代理(比如自建的中转)
  var USER_PROXY = '';
  try {
    var _saved = JSON.parse(root.localStorage.getItem('zyweb_cfg') || '{}') || {};
    if (_saved.proxy) {
      var _p = String(_saved.proxy).trim().replace(/\/+$/, '');
      if (_p && !/^[a-z][a-z0-9+.-]*:\/\//i.test(_p)) _p = 'https://' + _p;
      USER_PROXY = _p;
    }
  } catch (e) {}
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
  /**
   * 取接口/清单该走哪个出口:
   *   ① 配置里的代理(webconfig.proxy / 用户在设置里填的) —— 只有"站点自身当不了代理"时才需要;
   *   ② 否则**站点自身**(线上 https://zyplayer.hof12.ccwu.cc 自己就是那个 Worker, 同源 /f 直接能用)。
   * ★ 这里以前写的是 `ZYPROXY ? 走代理 : 直连` —— 一旦 proxy 没配(或被清空), 所有接口/豆瓣榜单
   *   就变成浏览器直连, 跨域被挡 → 首页"暂无数据 一共 0 部"。所以出口不能用"配置有没有填"来决定。
   */
  function apiBase() { return (ZYPROXY || pageProxyBase()).replace(/\/+$/, ''); }

  function proxied(url, opts) {
    opts = opts || {};
    var q = apiBase() + '/f?t=' + encodeURIComponent(PROXY_TOKEN) + '&q=' + b64u(url);
    if (opts.referer) q += '&r=' + encodeURIComponent(opts.referer);
    if (opts.cookie) q += '&c=' + encodeURIComponent(opts.cookie);
    q += '&ua=' + encodeURIComponent(opts.ua || uaFor(url, opts.referer));
    return q;
  }

  function fetchText(url, opts) {
    opts = opts || {};
    var base = apiBase();
    var target = base ? proxied(url, opts) : url;
    var init = { method: 'GET', credentials: 'omit', mode: 'cors' };
    if (!base) {                                     // 连出口都没有(纯静态托管且没配代理): 只能直连
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
  /**
   * 图片也走代理。豆瓣图床对 Referer 有要求: 不带 Referer 回 418、带本站 Referer 回 403、
   * 带豆瓣自己的 Referer 才 200 —— `<img>` 标签改不了 Referer, 所以只能让 Worker 去取。
   * (SW 在的时候会先直连, 拿不到(=418)自动回落到 Worker, 那条路上 Referer 是服务端加的。)
   */
  function imgVia(u, referer) {
    if (!u) return '';
    var base = pageProxyBase();
    if (!base) return u;
    return base + 'p?t=' + encodeURIComponent(PROXY_TOKEN) + '&q=' + b64u(u)
      + '&r=' + encodeURIComponent(referer || 'https://m.douban.com/');
  }

  /** 页面侧该用哪个出口: 用户显式配置的代理 > 站点自身(线上站点就是 Worker) > webconfig 里的代理 */
  // 站点自身出口(线上就是这个): 同源, 不跨域
  function selfBase() { try { return location.origin + location.pathname.replace(/[^/]*$/, ''); } catch (e) { return ''; } }
  var _baseOverride = '';        // 只有"站点自身不是代理"时(比如网页托管在别处)才会被探测改成别处
  /**
   * 页面侧该用哪个出口: **站点自身优先**。线上 https://zyplayer.hof12.ccwu.cc 这个站点**本身就是那个 Worker**,
   * 同源 /f|/p 直接可用 —— 不需要、也不该再绕第二个域名。
   * 历史坑(用户为此刻过我): 这里的第一顺位曾经是 webconfig 里的 proxy(=zyapi 那个**另一个域名**),
   * 于是 20 张海报全变成跨域 <img> 请求, 浏览器一失败就是整批"海报 0/20"。
   * 只有"站点自身当不了代理"(例如网页被托管到 GitHub Pages)时, 才由 probeProxyBase()
   * 把 _baseOverride 设成配置里的代理 —— 那是唯一的跨域场景。
   */
  function pageProxyBase() { return _baseOverride || selfBase(); }
  /**
   * 一次探测: 站点自身能不能当代理用(线上能)。不能(例如网页托管在 GitHub Pages)才切到配置里的代理。
   * 探测本身很小(取站点自己的 version.json), 结果只在内存里记一次。
   */
  function probeProxyBase() {
    var sb = selfBase(), zb = (USER_PROXY || ZYPROXY) ? String(USER_PROXY || ZYPROXY).replace(/\/+$/, '') : '';
    if (!sb || !zb || sb === zb) return;
    var probe = sb + 'p?t=' + encodeURIComponent(PROXY_TOKEN) + '&q=' + b64u(sb + 'version.json');
    try {
      fetch(probe, { cache: 'no-store' }).then(function (r) {
        if (!r || !r.ok) _baseOverride = zb;      // 站点自身不是代理 -> 用配置里的
      }).catch(function () { _baseOverride = zb; });
    } catch (e) {}
  }

  function sameOriginProxy(url, referer, cookie) {
    if (!url) return '';
    var base = pageProxyBase();
    if (!base) return '';
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

  function proxyWrap(url, referer, cookie) {
    if (!url) return url;
    var s0 = String(url);
    var base = '';
    try { base = location.origin + location.pathname.replace(/[^/]*$/, ''); } catch (e) {}
    // ① 已经是"本代理地址"就别再套一层。必须 /f 和 /p 都认:
    //    直播地址现在是指向同源 /f 的(Worker 改写过的清单), 只认 /p 的话它会再被包一层,
    //    于是 Worker 收到"目标是自己"的请求 → 自引用 → Cloudflare 直接丢 522(用户截图里那个)。
    var _pb = pageProxyBase();
    if (_pb && (s0.indexOf(_pb + '/f?') === 0 || s0.indexOf(_pb + '/p?') === 0)) return url;
    if (_pb && (s0.indexOf(_pb + 'f?') === 0 || s0.indexOf(_pb + 'p?') === 0)) return url;
    // ①b 跨域的 Worker 地址同理
    if (ZYPROXY && (s0.indexOf(ZYPROXY + '/f?') === 0 || s0.indexOf(ZYPROXY + '/p?') === 0)) return url;
    // ② Service Worker 还没接管(首次打开/刚更新)时不能返回裸地址: 浏览器直连上游普遍缺 CORS 头,
    //    直播就是"黑屏"。这时退回直接走 Cloudflare 代理, 至少能拿到字节。
    // 没有 Service Worker 就交回原始地址(浏览器直连)。**不要**在这里塞 Worker 地址:
    // 那样分片会被拉到海外出口, 国内 CDN 直接 403 —— 点播就是这么被我改坏的。
    if (!root.navigator || !root.navigator.serviceWorker || !root.navigator.serviceWorker.controller) return url;
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
                    fetchText: fetchText, analyze: analyze, doubanOne: doubanOne,
                    config: function () { return { proxy: ZYPROXY, token: PROXY_TOKEN, swToken: SWTOKEN }; } };

  /**
   * 豆瓣榜单总表 —— **每一项都在线上真发过请求验证非空**(2026-10-07 实测, 括号里是当时首条):
   *   电影: 正在上映 / 热门 / Top250 / 一周口碑榜(10 条) / 经典老片
   *   剧集: 热门 / 国产 / 欧美 / 韩 / 日 / 华语口碑剧集榜(10 条)
   *   综艺: 综艺;  动漫: 动漫;  纪录: 纪录片
   * 之前失败过的(写在这里免得以后又有人去试): movie_coming_soon / movie_new / movie_domestic /
   *   movie_american / tv_anime / tv_cartoon / anime / movie_documentary / tv_talk_show / tv_show_hot。
   */
  var CHARTS = [
    { id: 'movie_showing',          name: '正在上映',   group: '电影' },
    { id: 'movie_hot',              name: '热门电影',   group: '电影' },
    { id: 'movie_top250',           name: '豆瓣 Top250', group: '电影' },
    { id: 'movie_weekly_best',      name: '一周口碑榜', group: '电影' },
    { id: 'movie_classic',          name: '经典老片',   group: '电影' },
    { id: 'tv_hot',                 name: '热门剧集',   group: '剧集' },
    { id: 'tv_domestic',            name: '国产剧',     group: '剧集' },
    { id: 'tv_american',            name: '欧美剧',     group: '剧集' },
    { id: 'tv_korean',              name: '韩剧',       group: '剧集' },
    { id: 'tv_japanese',            name: '日剧',       group: '剧集' },
    { id: 'tv_chinese_best_weekly', name: '华语口碑剧集榜', group: '剧集' },
    { id: 'tv_variety_show',        name: '综艺',       group: '综艺' },
    { id: 'tv_animation',           name: '动漫',       group: '动漫' },
    { id: 'tv_documentary',         name: '纪录片',     group: '纪录' }
  ];
  var LEGACY = { '': 'movie_showing', '1': 'movie_hot', '2': 'tv_hot', '3': 'tv_variety_show', '4': 'tv_animation' };

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
    /**
     * 首页 = **豆瓣榜单**(用户要求):
     *   · 好处: 首页不再依赖任何采集源(源全挂首页也还在), 刷新就是重新拉一次榜单;
     *   · 榜单项只有片名/海报/评分(没有源与 id), 点进去由 app.js 按片名去聚合搜索再进详情;
     *   · 翻页用豆瓣的 start/count(「加载更多」照旧可用)。
     */
    /** 网页端可用榜单(每一个都在线上真测过: 非空才写进来), app.js 用它填「榜单」下拉 */
    doubanCharts: function () { return JSON.stringify(CHARTS); },
    home: function (siteKey, typeId, page, seq) {
      var t = String(typeId == null ? '' : typeId);
      // ① 新版: 下拉里给的就是榜单 id(movie_showing / tv_korean …), 直接当 collection 用
      var cid = '';
      for (var ci = 0; ci < CHARTS.length; ci++) if (CHARTS[ci].id === t) { cid = t; break; }
      // ② 兼容老参数(安卓那套 '1'/'2'/'3'/'4' 与空值), 免得别处调用拿到空数据
      if (!cid) cid = LEGACY[t] || 'movie_showing';
      var pg = Math.max(1, parseInt(page || 1, 10) || 1);
      var u = 'https://m.douban.com/rexxar/api/v2/subject_collection/' + cid
        + '/items?start=' + ((pg - 1) * 20) + '&count=20&for_mobile=1';
      fetchText(u, { referer: 'https://m.douban.com/' }).then(function (txt) {
        var j = toJson(txt) || {};
        var list = j.subject_collection_items || j.items || [];
        var items = list.map(function (v) {
          // 注意: 豆瓣这个接口给的是 `cover.url`(**没有** pic 字段) —— 之前映射 pic 才导致海报全空
          var raw = (v.cover && (v.cover.url || v.cover)) || (v.pic && (v.pic.normal || v.pic.large || v.pic)) || v.cover_url || '';
          if (raw && typeof raw === 'object') raw = raw.url || '';
          var score = (v.rating && v.rating.value) ? String(v.rating.value) : '';
          return { name: v.title || '', pic: imgVia(raw), score: score,
                   remarks: String(v.year || ''), year: String(v.year || ''),
                   douban: 1, url: v.url || '', site: '', id: '', eps: [] };
        }).filter(function (x) { return x.name; });
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

  /* ---------------------------------------------------------------- 短剧页(4)
     源来自 zhoufuweigg/guoapp「红果鉴」的 Go 核心实现, 按本工程的写法重写。
     已接入: 红果官网(HTML) / 鬼片(RSS) / 韩小圈(模板站); 其余源在列表里标注未接入原因。
     条目只有 片名/海报/备注(site 与 id 为空) —— 界面点开时复用"按片名聚合搜索"那条既有链路。 */
  var SUANJU_SRC = [
    { key: 'hongguo',     name: '红果',     status: '官网 HTML(红果短剧)', on: true },
    { key: 'guipian',     name: '鬼片',     status: 'RSS 最新 + 站点',      on: true },
    { key: 'hanxiaoquan', name: '韩小圈',   status: '模板站 /hxq 分类',     on: true },
    { key: 'qingkong',    name: '青空',     status: '接口 401, 需要鉴权',   on: false },
    { key: 'huangdou',    name: '黄豆',     status: '需要 AES+HMAC 平台密钥', on: false },
    { key: 'juguo',       name: '剧果',     status: '需要签名 Cookie',      on: false },
    { key: 'yeguo',       name: '野果',     status: '需要签名客户端',       on: false },
    { key: 'diguo',       name: '帝果',     status: '需要 vplayer 签名解析', on: false },
    { key: 'huangguo',    name: '黄果视频', status: '需要登录会话',         on: false },
    { key: 'huangguoai',  name: '黄果AI',   status: '需要登录会话',         on: false },
    { key: 'huangguoold', name: '黄果旧版', status: '需要登录会话',         on: false }
  ];
  /** 剧名可用吗: 页面里有 SEO/占位文案混在标题位(实测 "XX短剧海报"/"红果短剧logo"), 都剔掉 */
  function usableDramaName(name) {
    var t = String(name == null ? '' : name).trim();
    if (t.length < 2 || t.length > 40) return false;
    if (/(短剧海报|海报)$/.test(t)) return false;
    if (t.indexOf('红果短剧') >= 0 || t.toLowerCase().indexOf('logo') >= 0) return false;
    if (t === '首页' || t === '分类' || t === '榜单' || t === '下载') return false;
    return true;
  }
  function suanjuSources() { return JSON.stringify(SUANJU_SRC); }
  function suanjuSupported(key) {
    for (var i = 0; i < SUANJU_SRC.length; i++) if (SUANJU_SRC[i].key === key) return SUANJU_SRC[i].on;
    return false;
  }
  function suanjuText(url, referer) {
    // 站点 HTML/RSS 都不带 CORS 头 -> 只能经站点自身的代理(/f)取
    return fetch(proxied(url, { referer: referer }), { credentials: 'omit', mode: 'cors' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
  }
  function suanjuItem(name, pic, referer, remarks, siteName, id) {
    return { name: name, pic: pic ? imgVia(pic, referer) : '', remarks: remarks || '', score: '',
             siteName: siteName, site: '', id: '', eps: [] };
  }
  /** 短剧搜索: 红果 /search/<关键字> · 鬼片 RSS 按片名匹配 · 韩小圈 /search.php(站点有拦截) */
  function suanjuSearchAll(kw, seq) {
    var q = String(kw == null ? '' : kw).trim();
    if (!q) { call('onSuanjuSearch', seq, []); return; }
    var jobs = SUANJU_SRC.filter(function (x) { return x.on; }).map(function (src) {
      var p;
      if (src.key === 'hongguo') {
        var base = 'https://hongguoduanju.com';
        p = suanjuText(base + '/search/' + encodeURIComponent(q), base + '/').then(function (html) { return parseHongguoHtml(html); });
      } else if (src.key === 'guipian') {
        var gb = 'https://guipianwu.com';
        p = suanjuText(gb + '/xml/rss.xml', gb + '/').then(function (xml) {
          var items = xml.match(/<item>[\s\S]*?<\/item>/g) || [], low = q.toLowerCase(), out = [];
          for (var i = 0; i < items.length && out.length < 30; i++) {
            var t = /<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/.exec(items[i]);
            if (!t) continue;
            var nm = t[1].trim();
            if (nm.toLowerCase().indexOf(low) < 0) continue;
            out.push(suanjuItem(nm, '', gb + '/', '', '鬼片', ''));
          }
          return out;
        });
      } else if (src.key === 'hanxiaoquan') {
        var hb = 'https://www.jennyhow.com';
        p = suanjuText(hb + '/search.php?searchword=' + encodeURIComponent(q), hb + '/').then(function (html) {
          var out = [], re = /<a href="\/hanxiaoquan\/(\d+)\.html"[^>]*title="([^"]*)"/g, m;
          while ((m = re.exec(html)) && out.length < 30) {
            var tail = html.substr(m.index + m[0].length, 1200);
            var img = /<img[^>]*data-src="([^"]+)"/.exec(tail);
            if (out.length === 0 && !/hanxiaoquan/.test(html)) break;
            out.push(suanjuItem(m[2].trim(), img ? img[1] : '', hb + '/', '', '韩小圈', m[1]));
          }
          return out;
        });
      } else { p = Promise.resolve([]); }
      return p.catch(function () { return []; });
    });
    Promise.all(jobs).then(function (groups) {
      var out = [];
      for (var i = 0; i < groups.length; i++) for (var j = 0; j < groups[i].length; j++) { groups[i][j].su = 1; out.push(groups[i][j]); }
      call('onSuanjuSearch', seq, out);
    }).catch(function () { call('onSuanjuSearch', seq, []); });
  }
  function suanjuHome(key, page, seq) {
    var pg = Math.max(1, page || 1), jobs;
    if (key === 'hongguo') {
      var base = 'https://hongguoduanju.com';
      jobs = suanjuText(base + '/', base + '/').then(function (html) {
        var out = [], seen = {}, re = /href="\/detail\?series_id=(\d+)"([\s\S]{0,2600}?)(?:<\/a>|href="\/detail\?series_id=)/g, m, guard = 0;
        while ((m = re.exec(html)) && out.length < 30 && guard++ < 300) {
          var block = m[2];
          var t = /class="pc-scatter-card-title[^"]*"[^>]*>([^<]+)</.exec(block);
          if (!t) t = /<img[^>]*alt="([^"]{2,})"/.exec(block);      // 列表卡: 剧名只在 alt 里
          if (!t) continue;
          var name = String(t[1]).replace(/\s+/g, ' ').trim();
          if (!usableDramaName(name) || seen[name]) continue;       // 剔掉 SEO/占位文案与重复
          seen[name] = 1;
          var img = /<img[^>]*class="image-[^"]*"[^>]*src="([^"]+)"/.exec(block);
          var ep = /class="pc-scatter-episode-[^"]*"[^>]*>([^<]*)</.exec(block);
          out.push(suanjuItem(name, img ? img[1] : '', base + '/', ep ? ep[1].trim() : '', '红果', m[1]));
        }
        return out;
      });
    } else if (key === 'guipian') {
      var gb = 'https://guipianwu.com';
      jobs = suanjuText(gb + '/xml/rss.xml', gb + '/').then(function (xml) {
        var items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        var skip = (pg - 1) * 30, out = [];
        for (var i = skip; i < items.length && out.length < 30; i++) {
          var b = items[i];
          var t = /<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/.exec(b);
          var l = /<link>\s*(?:<!\[CDATA\[)?(https?:\/\/[^<\]]+)/.exec(b);
          if (!t || !t[1]) continue;
          out.push(suanjuItem(t[1].trim(), '', gb + '/', '', '鬼片', l ? l[1] : ''));
        }
        return out;
      });
    } else if (key === 'hanxiaoquan') {
      var hb = 'https://www.jennyhow.com';
      jobs = suanjuText(hb + '/hxq/1' + (pg > 1 ? ('-' + pg) : '') + '.html', hb + '/').then(function (html) {
        var out = [], re = /<a href="\/hanxiaoquan\/(\d+)\.html"[^>]*title="([^"]*)"/g, m;
        while ((m = re.exec(html)) && out.length < 30) {
          var tail = html.substr(m.index + m[0].length, 1200);
          var img = /<img[^>]*data-src="([^"]+)"/.exec(tail);
          var note = /class="module-item-text"[^>]*>([^<]*)</.exec(tail);
          out.push(suanjuItem(m[2].trim(), img ? img[1] : '', hb + '/', note ? note[1].trim() : '', '韩小圈', m[1]));
        }
        return out;
      });
    } else {
      jobs = Promise.resolve([]);
    }
    jobs.then(function (items) { call('onSuanju', seq, items); })
        .catch(function () { call('onSuanju', seq, []); });
  }

  var PK = {
    suanjuSources: suanjuSources,
    suanju: suanjuHome,
    suanjuSearch: suanjuSearchAll,
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
    // 图片走代理(豆瓣图床要 Referer, img 标签改不了): 详情页/首页海报用得到
    imgVia: function (u) { return imgVia(u, 'https://m.douban.com/'); },
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

  try { probeProxyBase(); } catch (e) {}

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
     没在看片时直接换成新版; 正在看片就不打扰(只在控制台说一句)。 */
  function buildStamp() { try { return String(root.__ZYBUILD || ''); } catch (e) { return ''; } }
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
        console.log('[ZY影视 网页版] 有新版本(' + j.v + ')，刷新即更新');
      }).catch(function () {});
  }
  try {
    setTimeout(checkBuild, 3000);
    setInterval(checkBuild, 5 * 60 * 1000);
    if (root.document) root.document.addEventListener('visibilitychange', function () {
      if (!root.document.hidden) checkBuild();
    });
    // ★ 关键补漏: 从"后退/前进缓存(BFCache)"恢复的页面**既不走网络、也不触发 visibilitychange** ——
    //   用户切回标签页看到的就是改动前的旧界面。这正是"我明明改了, 网页端却没生效"的最常见成因:
    //   服务端已经是新版(md5 一致), 用户屏幕上还是旧副本。pageshow.persisted 就是"从缓存恢复"的信号。
    root.addEventListener('pageshow', function (e) {
      if (e && e.persisted) checkBuild();
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
