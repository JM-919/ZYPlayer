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
    addSite: function (key, name, base, path, word) {
      var p = path || DEF_PATH;
      // 测试片名由用户填(解密页的"测试片名"); 留空就**不带 wd** —— 短剧/分类站这样才验得活。
      // (以前写死 wd=庆余年, 于是那些站一律"真测没过")
      var w = String(word == null ? '' : word).trim();
      var qs = 'ac=videolist' + (w ? ('&wd=' + enc(w)) : '');
      var probe = apiUrl({ api: base, path: p }, qs);
      return fetchText(probe, { referer: base + '/' }).then(function (txt) {
        var j = toJson(txt) || {}, n = (j.list || []).length;
        if (!n && w) return fetchText(apiUrl({ api: base, path: p }, 'ac=videolist'), { referer: base + '/' })
          .then(function (t2) { return t2; });
        return txt;
      }).then(function (txt) {
        var j = toJson(txt) || {}, n = (j.list || []).length;
        if (!n) { call('onAddSite', name, JSON.stringify({ ok: false, msg: '真测没过(没返回片单), 不加' })); return; }
        var u = userSites();
        u.push({ key: key, name: name, api: base, path: p });
        saveUserSites(u);
        call('onAddSite', name, JSON.stringify({ ok: true, msg: '已加入(真测 ' + n + ' 条' + (w ? '' : ' · 按首页片单验活') + ')' }));
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
    probeSiteUrl: function (pageUrl, word) {
      var m = /^(https?:\/\/[^\/]+)/.exec(pageUrl);
      var base = m ? m[1] : '';
      var paths = [DEF_PATH, '/api.php/provide/vod/at/json/', '/index.php/api/vod/', '/api.php/provide/vod/from/vod/'];
      var w = String(word == null ? '' : word).trim();
      // 用户填了测试词: 先用词探一遍, 没探到再**不带词**重探(短剧/分类站搜索里没有那个词, 首页片单是有的)
      var rounds = w ? [w, ''] : [''];
      var r = 0, i = 0, trace = [];
      function step() {
        if (r >= rounds.length) { call('onProbeSite', JSON.stringify({ ok: false, base: base, trace: trace.join(' '), msg: '没探到可用的采集接口' })); return; }
        if (i >= paths.length) { r++; i = 0; return step(); }
        var kw = rounds[r], p = paths[i++];
        var u = base + p + '?ac=videolist' + (kw ? ('&wd=' + enc(kw)) : '');
        fetchText(u, { referer: base + '/' }).then(function (txt) {
          var j = toJson(txt) || {}, list = j.list || [];
          if (list.length) {
            trace.push(p + '✓');
            call('onProbeSite', JSON.stringify({ ok: true, base: base, path: p, key: base.replace(/[^a-z0-9]/gi, '').slice(0, 10),
              name: base, n: list.length, sample: (list[0].vod_name || ''), ms: 0, trace: trace.join(' '),
              msg: '探到采集接口: ' + p + '（真测 ' + list.length + ' 条' + (kw ? '' : ' · 按首页片单验活') + '）' }));
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

  /* ================= 全屏 / 横屏 / 竖屏: 网页端的"退路"都在这几个函数里 =================
     实测背景(2026-10-09, 用户手机上默认浏览器 Via / 各家 WebView 内核):
       · requestFullscreen 能用(要真手势, 键盘/触摸合成的事件会 "Permissions check failed");
       · screen.orientation.lock **函数存在, 但一调就 reject**:
           NotSupportedError: screen.orientation.lock() is not available on this device.
     老代码三处踩坑, 表现就是用户说的"横屏竖屏全屏都坏了":
       ① canLockOrientation 只看"函数在不在" -> 按钮留在那, 点了只会进全屏, 画面永远不横过来;
       ② landscape(true) 先全屏再锁方向, 锁失败被 catch 吞掉 -> 静默失败, 用户看不到任何反馈;
       ③ 全屏里按"返回"关掉播放器时没退全屏 -> 整屏黑, 只能按系统返回救回来。
     现在改成两段式:
       ① 方向锁真锁上了 -> 走系统真横屏(最舒服);
       ② 锁不了 / 锁了没动 -> 自己上"伪横屏": 播放器内容整体包一层 #pklayer 转 90°, 尺寸换成
          innerHeight × innerWidth(转完正好铺满视口), 用户把手机横过来就是满屏正的画面。
          反过来按"竖屏"而手机物理上还横着(锁不了方向, 谁也拧不过传感器) -> 同一层反着转 -90°,
          画面看起来仍是竖的。手机真转了/真竖回来了 -> 自动撤掉这一层, 绝不跟浏览器打架。
     只动播放器内部一层, 页面/详情/搜索统统不碰; App 端根本不加载 bridge.js, 一个字节都不变。*/
  function fsEl() {
    var d = root.document;
    return d.fullscreenElement || d.webkitFullscreenElement || d.msFullscreenElement || d.webkitCurrentFullScreenElement || null;
  }
  function videoFsOn() { var v = videoEl(); try { return !!(v && v.webkitDisplayingFullscreen); } catch (e) { return false; } }
  function fsOn() { return !!fsEl() || videoFsOn(); }
  function reqFs(el) {
    try {
      el = el || playerEl() || root.document.documentElement;
      var f = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen || el.msRequestFullscreen;
      if (f) { var p = f.call(el); if (p && p.catch) p.catch(function () {}); return true; }
      var v = videoEl();                       // iOS Safari: 元素全屏压根没有, 只有 <video> 能全屏
      if (v && v.webkitEnterFullscreen) { v.webkitEnterFullscreen(); return true; }
    } catch (e) {}
    return false;
  }
  function exitFs() {
    try {
      var v = videoEl();
      if (videoFsOn() && v.webkitExitFullscreen) { v.webkitExitFullscreen(); return; }
      var d = root.document;
      var f = d.exitFullscreen || d.webkitExitFullscreen || d.msExitFullscreen || d.webkitCancelFullScreen;
      if (f) { var p = f.call(d); if (p && p.catch) p.catch(function () {}); }
    } catch (e) {}
  }
  function realLand() {
    try { var so = root.screen && screen.orientation; if (so && so.type) return /landscape/.test(so.type); } catch (e) {}
    return (root.innerWidth || 0) > (root.innerHeight || 0);
  }
  // 只在触摸设备上做伪横屏/伪竖屏: 桌面窗口天生"宽>高", 不做这个判断的话在电脑上点竖屏会把播放器转歪
  var touchDev = (function () { try { return ('ontouchstart' in root) || (root.navigator && root.navigator.maxTouchPoints > 0); } catch (e) { return false; } })();
  // landMode = 用户要的模式(1=伪横屏, −1=伪竖屏); landDone = 已经真转上去的模式(pseudoLand 报的是它)。
  // 两者分开: 转的动作要延后 350ms 做(见 landApply), 那 350ms 里手势换算还不能换轴。
  var landMode = 0, landDone = 0, landWant = false, landWatchOn = false, landTimer = 0;
  /** 把 #player 的子节点整体搬进 #pklayer(同一任务里搬完, <video> 不会重载 —— 规范规定移除后
      到稳定状态时"还在文档里"就不暂停, 重新插入时 networkState 非空也不会重跑选源) */
  function landLayer() {
    var pl = playerEl(); if (!pl) return null;
    var ly = root.document.getElementById('pklayer');
    if (!ly) {
      ly = root.document.createElement('div'); ly.id = 'pklayer';
      while (pl.firstChild) ly.appendChild(pl.firstChild);
      pl.appendChild(ly);
    }
    return ly;
  }
  function landUnlayer() {
    landDone = 0;
    var pl = playerEl(); if (!pl) return;
    var ly = root.document.getElementById('pklayer'); if (!ly) return;
    while (ly.firstChild) pl.insertBefore(ly.firstChild, ly);   // 原顺序放回去
    try { pl.removeChild(ly); } catch (e) {}
  }
  function landFit() {
    if (!landMode) return;
    var w = root.innerWidth || 0, h = root.innerHeight || 0;
    if (!w || !h) return;
    // 手机/浏览器自己转到位了 -> 立刻撤掉我们这一层(伪横屏等真横, 伪竖屏等真竖)
    if (landMode > 0 ? (w > h) : (h > w)) { landApply(0); return; }
    var ly = landLayer(); if (!ly) return;
    landDone = landMode;
    var s = ly.style;
    s.position = 'absolute'; s.left = '50%'; s.top = '50%'; s.right = 'auto'; s.bottom = 'auto';
    s.width = h + 'px'; s.height = w + 'px'; s.margin = '0'; s.maxWidth = 'none'; s.maxHeight = 'none';
    s.transform = s.webkitTransform = 'translate(-50%,-50%) rotate(' + (landMode > 0 ? 90 : -90) + 'deg)';
    s.transformOrigin = s.webkitTransformOrigin = '50% 50%';
  }
  function landWatch() {
    if (landWatchOn) return; landWatchOn = true;
    var h = function () { if (landMode) setTimeout(landFit, 60); };   // 等浏览器把新尺寸结算完再算
    try { root.addEventListener('resize', h); root.addEventListener('orientationchange', h); } catch (e) {}
    try { var so = root.screen && screen.orientation; if (so && so.addEventListener) so.addEventListener('change', h); } catch (e) {}
  }
  function landApply(mode) {
    landMode = touchDev ? (Number(mode) || 0) : 0;
    if (landTimer) { try { clearTimeout(landTimer); } catch (e) {} landTimer = 0; }
    if (!landMode) { landUnlayer(); return; }
    landWatch();
    // ★ 转的动作要**错开一拍**(350ms)再做: 一次点按在 touchend 之后浏览器还会补一个 click,
    //   布局若在手底下瞬间转过去, 那一下会砸在"转完正好落在同一坐标的按钮"上 ——
    //   真机实测点「横屏」顺手点到「返回」, 播放器当场被关掉(用户说的"横屏坏了"里就有这一条)。
    landTimer = setTimeout(function () { landTimer = 0; if (landMode === mode) landFit(); }, 350);
  }
  function setWebBright(v) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) v = 1;
    webBright = Math.max(0.2, Math.min(1.6, v));
    var el = videoEl();
    if (el) el.style.filter = Math.abs(webBright - 1) < 0.01 ? '' : 'brightness(' + webBright.toFixed(2) + ')';
  }

  /* ---------------- 解析线路表(与安卓端 VipParse.LINES 同一份) + 网页端战绩 ---------------- */
  var VIP_LINES = [
    { name: 'TXNQ',  api: 'https://bfq.txnp.cn/player?url=',            note: '' },
    { name: '酥皮',  api: 'https://art.txnp.cn/?url=',                   note: '' },
    { name: '麒麟1', api: 'https://free.maccms.xyz/?url=',               note: '' },
    { name: '七哥',  api: 'https://jx.202617.xyz/tv.php?url=',           note: '首次进入会跳一次带签名的地址，等它跳完' },
    { name: 'M1907', api: 'https://im1907.top/?jx=',                     note: '播放器在 iframe 里，稍慢' },
    { name: 'Node',  api: 'https://jx.nodenode.dpdns.org/?url=',          note: '' },
    { name: '邦宁',  api: 'https://video.isyour.love/player/getplayer?url=', note: '有时先给一页「更多线路」' },
    { name: '66网2', api: 'https://www.66dpw.vip/88888888/jiexi.html?url=', note: '内部会再嵌 66网3' },
    { name: '66网3', api: 'https://svip.qlplayer.cyou/?url=',            note: '直连会被「域名未授权」挡住' },
    { name: '66网1', api: 'https://www.66dpw.vip/?url=',                 note: '授权宿主页，网页端不一定成功' }
  ];
  function sameNameish(a, b) {
    var f = function (x) { return String(x == null ? '' : x).replace(/[\s·:：\-—()（）\[\]【】。.!！?？,，]/g, '').replace(/第[一二三四五六七八九十0-9]+[季部集]/g, ''); };
    var x = f(a), y = f(b);
    if (!x || !y) return false;
    return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
  }
  var VIP_KEY = 'zy_vipline';
  function vipStat() { try { return JSON.parse(localStorage.getItem(VIP_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function vipSave(o) { try { localStorage.setItem(VIP_KEY, JSON.stringify(o)); } catch (e) {} }
  function vipTable() {
    var st = vipStat(), out = [];
    for (var i = 0; i < VIP_LINES.length; i++) {
      var s = st[VIP_LINES[i].name] || {};
      out.push({ i: i, name: VIP_LINES[i].name, note: VIP_LINES[i].note, gate: false,
                 mark: 'web', ok: s.ok || 0, fail: s.fail || 0, ms: 0 });
    }
    return out;
  }
  function vipOrder() {
    var st = vipStat(), idx = [];
    for (var i = 0; i < VIP_LINES.length; i++) idx.push(i);
    idx.sort(function (a, b) {
      var sa = st[VIP_LINES[a].name] || {}, sb = st[VIP_LINES[b].name] || {};
      var ka = (sa.ok || 0) + (sa.fail || 0), kb = (sb.ok || 0) + (sb.fail || 0);
      var va = ka ? ((sa.ok || 0) * 2 - (sa.fail || 0)) : 0;
      var vb = kb ? ((sb.ok || 0) * 2 - (sb.fail || 0)) : 0;
      return vb !== va ? vb - va : a - b;
    });
    return idx;
  }
  function vipBuild(i, pageUrl) {
    if (i < 0 || i >= VIP_LINES.length || !pageUrl) return '';
    return VIP_LINES[i].api + encodeURIComponent(pageUrl);
  }
  function vipRecord(i, ok) {
    if (i < 0 || i >= VIP_LINES.length) return;
    var st = vipStat(), nm = VIP_LINES[i].name, s = st[nm] || { ok: 0, fail: 0 };
    if (ok) s.ok = (s.ok || 0) + 1; else s.fail = (s.fail || 0) + 1;
    s.ts = Date.now(); st[nm] = s; vipSave(st);
  }

  var PK = {
    // ★ 网页版标记: app.js 与 index.html 是 App / 网页共用的同一份界面,
    //   凡是"只有原生做得到"的东西(投屏 / 解析线路 / 调起外部播放器 / 应用内更新 / 蜘蛛 jar / 下载),
    //   靠这个标记在网页端**连按钮带入口一起去掉**; App 侧没有 PK.web, 行为一个字节不变。
    web: true,
    /** 系统主题(网页端用 matchMedia) —— 主题选"随系统"时由它判定 */
    systemTheme: function () {
      try { return (root.matchMedia && root.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark'; }
      catch (e) { return 'dark'; }
    },
    setBarTheme: function (theme) {     // 网页端: 同步浏览器地址栏/系统栏配色(支持的浏览器才生效)
      try {
        var m = document.querySelector('meta[name="theme-color"]');
        if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
        m.content = (theme === 'light') ? '#f4f6fa' : '#07090e';
      } catch (e) {}
    },
    toast: function (m) { root.PK_toast(m); },
    appVersion: function () { return 'web-' + (CFG.version || 'dev'); },
    isLandscape: function () { return landMode > 0 || (landMode === 0 && realLand()); },
    /** 伪横屏/伪竖屏的层开着没有: 1=伪横屏, −1=伪竖屏, 0=没有 —— app.js 的手势换算要看它 */
    pseudoLand: function () { return landDone; },
    /**
     * 横屏/竖屏。先试系统方向锁(全屏后才让调), 锁不了就自己上"伪横屏"(见上面那段注释);
     * 关的时候反过来: 撤伪横屏 -> unlock -> 退全屏。
     */
    landscape: function (on) {
      var pl = playerEl() || root.document.documentElement;
      if (on) {
        landWant = true;
        if (!fsOn()) reqFs(pl);                     // 浏览器只允许"全屏之后"锁方向
        landWatch();
        var locking = false;
        try {
          var so = root.screen && screen.orientation;
          if (so && so.lock) {
            locking = true;                         // 有 API 就等它, 失败/没动都还有兜底
            var q = so.lock('landscape');
            if (q && q.catch) q.catch(function () { if (landWant && !realLand()) landApply(1); });
          }
        } catch (e) {}
        // 没这 API: 立刻伪横屏; 有 API 但 900ms 后画面还是竖的(锁"成功"却没转) -> 也兜上
        if (!locking) { if (!realLand()) landApply(1); }
        else setTimeout(function () { if (landWant && !landMode && !realLand()) landApply(1); }, 900);
      } else {
        landWant = false;
        try { if (root.screen && screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
        // 手机物理上还横着、方向又锁不住(谁也拧不过传感器) -> 反着转一层, 画面看起来仍是竖的
        landApply(realLand() ? -1 : 0);
        if (fsOn()) exitFs();
      }
    },
    /**
     * 方向锁"能用"吗 —— app.js 用它决定播放器里的「横屏」按钮留不留。
     * 判据**不能**是"look 有没有 lock 这个函数": Via / 微信/QQ 内置 / 各家 WebView 里
     * 它存在却永远 reject(NotSupportedError), 于是按钮在、点了不动(用户报的就是这个)。
     * 现在没有方向锁也能靠伪横屏横过来, 所以网页端永远保留这个按钮。
     */
    canLockOrientation: function () { return true; },
    lockOrientation: function (locked) {
      try {
        var so = root.screen && screen.orientation;
        if (!so || !so.lock) return;
        if (locked) { var q = so.lock(so.type || 'portrait'); if (q && q.catch) q.catch(function () {}); }
        else if (so.unlock) so.unlock();
      } catch (e) {}
    },
    /** 全屏三件套: app.js 的点按钮/键盘 F/双击画面都走这里(前缀 + iOS 视频兜底都在桥里) */
    fsOn: fsOn,
    fsExit: exitFs,
    toggleFullscreen: function () {
      if (fsOn()) { exitFs(); return true; }
      return reqFs(playerEl() || root.document.documentElement);
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
    /* ---------------- 解析线路(网页版的"退路") ----------------
     * 浏览器抓不到第三方解析页里的流(跨域 iframe 内的请求读不到), 但实测这些解析页**都允许被 iframe 内嵌**
     * (没有 X-Frame-Options / frame-ancestors) —— 所以网页版的做法是:
     *   ① 把「解析接口 + 页面地址」放进**页内 iframe** 让第三方播放器自己播(退路一);
     *   ② 不行就「新标签打开」直接看(退路二);
     *   ③ 另一条独立退路: 拿片名去别的源找**同一集的直链**(见 rescueResolve);
     *   ④ 哪条线能用由用户点「这条能看/不行」记进 localStorage, 下次自动排前面 —— 与安卓端战绩同一个思路。
     */
    vipLines: function () { return JSON.stringify(vipTable()); },
    vipOrder: function () { return JSON.stringify(vipOrder()); },
    vipBuild: function (i, pageUrl) { return vipBuild(i, pageUrl); },
    vipRecord: function (i, ok) { vipRecord(i, !!ok); },
    vipSniff: function () { toast('网页版请用「页内播放」或「新标签打开」(浏览器抓不到第三方解析页里的流)'); },
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
    /**
     * 网页版的"按片名救场": 当前集是平台页面(爱奇艺/腾讯页)或直链失效时, 拿片名去别的源找同一集的**直链**。
     * 这是网页版最实用的一条退路 —— 采集源里同一部剧往往有能直连的 m3u8, 找到就切过去。
     */
    rescueResolve: function (name, epIndex, epName, cookie) {
      var kw = String(name || '').trim();
      if (!kw) { call('onRescueResolved', false, '没有片名'); return; }
      var want = String(epName || '').trim();
      var jobs = allSites().slice(0, 14).map(function (s) {
        return search(s, kw, 1).then(function (hits) {
          for (var i = 0; i < hits.length; i++) {
            if (!sameNameish(hits[i].name, kw)) continue;
            return detail(s, hits[i].id).then(function (ds) {
              var it = ds[0]; if (!it || !it.eps || !it.eps.length) return [];
              var out = [];
              for (var k = 0; k < it.eps.length; k++) {
                var e = it.eps[k];
                if (want && e.name && !sameNameish(e.name, want) && k !== (epIndex || 0)) continue;
                if (/^https?:\/\/[^\s]+\.(m3u8|mp4|flv|ts)(\?|$)/i.test(e.url)) out.push(e);
              }
              if (!out.length && it.eps[0] && /^https?:\/\/[^\s]+\.(m3u8|mp4|flv|ts)(\?|$)/i.test(it.eps[0].url)) out.push(it.eps[0]);
              return out.slice(0, 2);
            });
          }
          return [];
        }).catch(function () { return []; });
      });
      Promise.all(jobs).then(function (groups) {
        var flat = [];
        groups.forEach(function (g) { g.forEach(function (e) { flat.push(e); }); });
        if (flat.length) call('onRescueResolved', kw + ' · ' + (want || '第1集'), (flat[0].name || kw), flat[0].url, JSON.stringify(flat.slice(0, 3).map(function (e) {
          return { url: e.url, ext: 'm3u8', quality: '', source: '别的源' };
        })));
        else call('onRescueResolved', false, '别的源也没找到这一集的直链');
      });
    },
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
