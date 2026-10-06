var sites = [], curSite = "", curType = "", page = 1, homeLoading = false;
/* App 与网页版共用这一份界面。PK.web 由网页版的 bridge.js 提供:
   网页端"只有原生做得到"的功能(投屏 / 解析线路 / 调起外部播放器 / 应用内更新 / 蜘蛛 jar)
   靠这个标记连按钮带入一起去掉。App 侧没有 PK.web, WEB 恒为 false —— App 行为一个字节不变。 */
var WEB = false; try { WEB = !!(window.PK && PK.web); } catch(e){}
var curItem = null, curEp = 0, hls = null;
/* 首页与搜索各自一份数据源：曾共用 lastItems，导致"搜完再回首页点卡片 = 打开搜索结果" */
var homeItems = [], searchItems = [];
function listOf(which){ return which === "search" ? searchItems : homeItems; }

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
/**
 * 内联 onclick 里安全地嵌一个字符串/对象字面量。
 *
 * 为什么必须专门有这么一个函数: 内联处理器是先被 HTML 解析器**解码**、再交给 JS 引擎的。
 * 以前这里是 `JSON.stringify(x).replace(/"/g,'&quot;')` —— 只要数据里本来就有 `&quot;`
 * (上游 IPTV 频道名、用户粘贴的 TVBox 配置里都可能出现), 解码后它就变回一个真正的引号,
 * 于是字符串被提前闭合、后面的内容被当成代码执行(实测 `&quot;);PK.exit();//` 能跑通)。
 * 这里先把 JSON 字面量整体过一遍 HTML 转义(& 先转), 解码后拿到的才是原样的 JSON 字面量。
 */
function jsa(v){ return esc(JSON.stringify(String(v==null?"":v))); }
function show(v){
  // 播放器是 position:fixed + z-index:50, 切页面时如果不关掉会把整屏盖住
  var pl = $("player");
  if (pl && (pl.className || "").indexOf("on") >= 0 && v !== "v-player") { try { closePlayer(); } catch(e){} }
  ["v-home","v-search","v-detail","v-update","v-live","v-hist","v-crash","v-dec"].forEach(function(x){ $(x).style.display = (x===v?"":"none"); });
  hideKwPrev();          // 换页就把搜索预览收掉, 免得它挂在别的视图上
  $("main").scrollTop = 0;
}
/** 封面加载失败(部分图床防盗链): 换成片名首字占位, 不留空白块。 */
function imgFallback(el){
  try {
    var name = el.getAttribute('data-n') || '影';
    var ch = name.replace(/[\[\]（）()·]/g, '').slice(0, 1) || '影';
    var d = document.createElement('div');
    d.className = 'pic picholder';
    d.textContent = ch;
    el.parentNode.replaceChild(d, el);
  } catch (e) { }
}

function card(it, idx, which){
  var pic = it.pic || "";
  var rm = it.remarks || (it.epCount ? (it.epCount+"集") : "");
  return '<div class="item" data-name="' + esc(it.name) + '" onclick="openDetail(&quot;' + (which || 'home') + '&quot;,' + idx + ')">'
    + (it.score ? ('<div class="sc">' + esc(it.score) + '</div>') : "")
    + '<img class="pic" loading="lazy" referrerpolicy="no-referrer" data-n="' + esc(it.name) + '" onerror="imgFallback(this)" src="' + esc(pic) + '" />'
    + '<div class="rm">' + esc(rm) + '</div>'
    + (it.siteName ? ('<div class="src">' + esc(it.siteName) + '</div>') : '')
    + '<div class="nm">' + esc(it.name) + '</div></div>';
}
function renderGrid(el, items, offset, which){
  var h = "";
  for (var i = 0; i < items.length; i++) h += card(items[i], (offset||0) + i, which);
  el.innerHTML = h || '<div class="empty">暂无数据</div>';
}

/* ---------- 首页 ---------- */
/**
 * 源列表**不再显示**了(首页那一栏已删): 直接用第一个源做首页/分类,
 * 搜索仍然是跨源聚合(Vod.search 会并发问好几个源), 所以用户不用再挑源。
 */
function initSites(){
  try { sites = JSON.parse(VOD.sites()); } catch(e){ sites = []; }
  if (!sites.length) return;
  // 优先用用户设过的「首选源」(pk_site, 在「我的源 → 设为首选」里写入); 它被删了就回落到第一个
  var want = '';
  try { want = localStorage.getItem('pk_site') || ''; } catch(e){}
  var hit = '';
  for (var i = 0; i < sites.length; i++) if (sites[i].key === want) hit = want;
  pickSite(hit || sites[0].key);
}
function pickSite(k){
  curSite = k;
  var sel = $("typeSel");
  if (sel) { sel.innerHTML = ''; }                 // 先把旧源的分类表清掉, 免得拿旧 typeId 去问新源
  pendingPick = true;                              // 切源标志: 分类表回来后再拉首页
  clearTimeout(pickTimer);
  pickTimer = setTimeout(function(){               // 兜底: 分类表迟迟不来(源有问题/断网)也要把首页拉起来
    if (!pendingPick) return;
    pendingPick = false;
    reloadHome();
  }, 2500);
  try { VOD.classes(k); } catch(e){ pendingPick = false; clearTimeout(pickTimer); reloadHome(); }
  try { localStorage.setItem('pk_site', k); } catch(e){}   // 记住"首选源", 下次启动还是它
}
var pendingPick = false, pickTimer = null;
var homeSeq = 0;                             // 首页请求序号(见 onVodHome): 迟到的旧响应直接丢
/**
 * 首页刷新。
 * force=true 是**用户点了「刷新」按钮**: 不吃缓存、直接打服务端, 并且给可见反馈
 * (以前无论手动刷新还是自动加载都走同一条路: 先秒出缓存、回来又一模一样, 用户看到的就是
 * "刷新按钮失效了" —— 其实请求发了, 只是屏幕上没有任何变化)。同时补了超时提示,
 * 网络不通时不再是一片沉默。
 */
var homeTimeout = null, homeDoneSeq = 0, forceSeq = 0;
function reloadHome(force){
  if (!curSite) { try { PK.toast('数据源还没就绪, 等一下再刷'); } catch(e){} return; }
  curType = $("typeSel").value; page = 1;
  var ck = "pk_home_" + curSite + "_" + curType;
  var cached = null;
  if (!force) { try { cached = JSON.parse(localStorage.getItem(ck) || "null"); } catch(e){} }
  if (cached && cached.length) {
    homeItems = cached;
    renderGrid($("homeGrid"), homeItems, 0, "home");
    $("load").textContent = "— 共 " + homeItems.length + " 部(缓存) · 点这里加载更多 —";
  } else {
    homeItems = [];
    $("homeGrid").innerHTML = skeleton(6);
    if (force) $("load").textContent = "刷新中…";
  }
  var seq = ++homeSeq;
  if (force) forceSeq = seq;
  var ok = true;
  try { VOD.home(curSite, curType, page, seq); } catch(e) { ok = false; $("load").textContent = "刷新失败: " + e; }
  clearTimeout(homeTimeout);
  if (ok) homeTimeout = setTimeout(function(){
    if (seq !== homeDoneSeq) $("load").textContent = "刷新超时 —— 检查网络后点「刷新」重试";
  }, 13000);
}
function moreHome(){
  if (homeLoading) return;
  homeLoading = true; page++;
  $("load").textContent = "加载中…";
  // 2026-10 修: homeLoading 只在 onVodHome 复位 —— 请求失败/页面报错/超时都进不来,
  // 于是"加载更多"点一次失败后**永久失效**。这里补超时兜底 + try, 保证一定会复位。
  homeDoneSeq = -1;
  clearTimeout(homeTimeout);
  homeTimeout = setTimeout(function(){ homeLoading = false; }, 13000);
  try { VOD.home(curSite, curType, page, ++homeSeq); }
  catch(e) { homeLoading = false; $("load").textContent = "加载失败: " + e; }
}
// onVodHome 带请求令牌: 切分类/切源时在途的旧响应会被丢弃, 不会覆盖或串进新列表
function onVodHome(seq, items){
  if (seq !== homeSeq) return;
  homeLoading = false;
  homeDoneSeq = seq;
  clearTimeout(homeTimeout);
  if (page === 1) { homeItems = items || []; renderGrid($("homeGrid"), homeItems, 0, "home"); }
  else {
    var start = homeItems.length;
    homeItems = homeItems.concat(items || []);
    var box = $("homeGrid");
    var h = "";
    for (var i = 0; i < (items||[]).length; i++) h += card(items[i], start + i, "home");
    // 2026-10 修: 原来 `box.innerHTML = box.innerHTML + h` 会把已渲染的卡片整块重建 ——
    // 已加载的封面重新请求、_db 豆瓣角标丢失、滚动位置抖动。用 insertAdjacentHTML 只追加新卡片。
    box.insertAdjacentHTML('beforeend', h);
  }
  $("load").textContent = (items && items.length ? "— 点这里加载更多 —" : "— 没有更多了 —");
  $("load").textContent = (items && items.length ? "— 点这里加载更多 —" : "— 没有更多了 —") + "   共 " + homeItems.length + " 部";
  try { localStorage.setItem("pk_home_" + curSite + "_" + curType, JSON.stringify(homeItems.slice(0, 40))); } catch(e){}
  if (seq === forceSeq) { forceSeq = 0; try { PK.toast("已刷新 · " + homeItems.length + " 部"); } catch(e){} }
  fetchDouban(homeItems);
}

/* ---------- 搜索: 入口 ---------- */
/**
 * 进搜索页并聚焦输入框 —— 规范入口。
 * 注意: 顶栏那个「搜索」按钮已按用户要求删掉(2026-10), 现在界面上的入口是
 * ① 主页搜索框回车(searchFromHome) ② 详情页的「搜索」按钮。这个函数保留着(闸门 ④ 也钉着它),
 * 谁要再加"进搜索页"的入口就直接用它(它比 show('v-search') 多一步聚焦, 用户不用再点一下输入框)。
 */
function openSearch(){ show('v-search'); var k = document.getElementById('kw'); if (k) k.focus(); }
/**
 * 输入法回车搜索。
 * 为什么写得这么啰嗦: 不少中文输入法在**组词未上屏**时按回车, keydown 报的是 229(或 isComposing=true),
 * 那一刻 input.value 还是空的 —— 直接读值再 doSearch() 就会"什么都没有"(用户看到的就是"搜索坏了")。
 * 所以: 组词中直接放过; 真正回车时延后一拍读值(keydown+keyup 双保险), 并且 1.2 秒内同一个词不重复搜。
 */
var lastEnterAt = 0, lastEnterWord = '';
function searchEnter(e, which){
  if (!e) return;
  if (e.isComposing || e.keyCode === 229) return;          // IME 组词中: 不抢
  var k = e.keyCode || e.which || 0;
  if (k !== 13) return;                                     // 只认回车
  if (e.preventDefault) e.preventDefault();
  if (e.stopPropagation) e.stopPropagation();
  setTimeout(function(){
    var box = document.getElementById(which === 'home' ? 'kwHome' : 'kw');
    var word = box ? String(box.value || '').trim() : '';
    if (!word) return;                                      // 还是空的: 说明只是上屏, 不搜
    var now = Date.now();
    if (word === lastEnterWord && now - lastEnterAt < 1200) return;   // keydown+keyup 只搜一次
    lastEnterWord = word; lastEnterAt = now;
    if (which === 'home') searchFromHome(); else doSearch();
    try { if (box) box.blur(); } catch(e2){}
  }, 0);
}
/* ---------- 搜索预览(输入即出) ---------- */
/*
 * 为什么只查本地数据: 边打字边搜全网, 对 28 个源就是灾难, 而且用户还没决定搜什么。
 * 所以预览只列"本地已经有名字的": ①当前页已加载的结果(allResults) ②首页那批(homeItems)
 * ③观看记录(pk_hist) —— 名字里包含当前输入的就留下, 最多 8 条; 第一行永远是"直接搜这个词"。
 * 点任意一条 = 填回输入框 + 走原来的搜索链路(doSearch / searchFromHome), 不另开路径。
 */
var kwTimer = null, lastSearchWord = '';
function histTitles(){
  var out = [];
  try {
    var h = JSON.parse(localStorage.getItem('pk_hist') || '[]') || [];
    for (var i = 0; i < h.length; i++) if (h[i] && h[i].name) out.push(h[i].name);
  } catch(e){}
  return out;
}
function previewWords(word){
  var w = String(word || '').trim().toLowerCase();
  if (!w) return [];
  var seen = {}, out = [], i;
  var push = function(t, tag){
    var s = String(t || '').trim();
    if (!s || seen[s] || out.length >= 8) return;
    if (s.toLowerCase().indexOf(w) < 0) return;      // 只要"包含当前输入"的名字
    seen[s] = 1; out.push({ n: s, tag: tag });
  };
  var rs = (typeof allResults !== 'undefined' && allResults) ? allResults : [];
  for (i = 0; i < rs.length; i++) push(rs[i].name, '本页');
  var hs = histTitles();
  for (i = 0; i < hs.length; i++) push(hs[i], '记录');
  var hi = (typeof homeItems !== 'undefined' && homeItems) ? homeItems : [];
  for (i = 0; i < hi.length; i++) push(hi[i].name, '首页');
  return out;
}
function drawPreview(box, word){
  if (!box) return;
  var w = String(word || '').trim();
  if (!w) { box.className = 'kwprev'; box.innerHTML = ''; return; }
  var items = previewWords(w), h = '';
  h += '<div class="it go" onclick="kwPick(&quot;' + esc(w) + '&quot;)">🔍 搜「' + esc(w) + '」</div>';
  for (var i = 0; i < items.length; i++) {
    h += '<div class="it" onclick="kwPick(&quot;' + esc(items[i].n) + '&quot;)">'
       + '<span class="nm">' + esc(items[i].n) + '</span>'
       + '<span class="tag">' + esc(items[i].tag) + '</span></div>';
  }
  box.innerHTML = h;
  box.className = 'kwprev on';
}
function kwPreview(){
  clearTimeout(kwTimer);
  var box = document.getElementById('kwPrev');
  if (!box) return;
  var el = document.getElementById('kw');
  var w = el ? el.value : '';
  kwTimer = setTimeout(function(){ drawPreview(box, w); }, 220);   // 220ms 防抖: 边打边算不心跳
}
function kwHomePreview(){
  clearTimeout(kwTimer);
  var box = document.getElementById('kwHomePrev');
  if (!box) return;
  var el = document.getElementById('kwHome');
  var w = el ? el.value : '';
  kwTimer = setTimeout(function(){ drawPreview(box, w); }, 220);
}
/** 收掉所有预览(切页/开搜/点选后都调它, 免得面板残留在屏幕上) */
function hideKwPrev(){
  var a = document.getElementById('kwPrev'), b = document.getElementById('kwHomePrev');
  if (a) { a.className = 'kwprev'; }
  if (b) { b.className = 'kwprev'; }
}
/** 预览里点一条: 填回输入框 + 走原有链路(搜索页里就地搜; 在首页就先跳到搜索页) */
function kwPick(word){
  var w = String(word || '').trim();
  if (!w) return;
  hideKwPrev();
  var sv = document.getElementById('v-search');
  var onSearch = sv && sv.style.display !== 'none';
  if (!onSearch) {
    var hk = document.getElementById('kwHome');
    if (hk) hk.value = w;
    searchFromHome();
    return;
  }
  var k = document.getElementById('kw');
  if (k) k.value = w;
  doSearch();
}
function doSearch(){
  var k = (document.getElementById('kw').value || '').trim();
  if (!k) { document.getElementById('kw').focus(); return; }
  lastSearchWord = k;
  document.getElementById('kw').value = '';   // 搜完就把输入框清空(用户要求: 别让上次搜的字一直留着)
  hideKwPrev();
  document.getElementById('searchTip').textContent = '正在并发搜索 ' + ((sites && sites.length) || 9) + ' 个源「' + k + '」, 结果边收边显示…';
  document.getElementById('searchGrid').innerHTML = '';
  var sc = document.getElementById('srcChips');
  if (sc) { sc.innerHTML = ''; sc.style.display = 'none'; }
  allResults = []; curSrcFilter = '';          // 新搜索: 源筛选回到"全部"
  VOD.search(k);
}


/* ---------- 搜索结果: 源标签筛选 (替代之前堆叠分组) ---------- */
var allResults = [], curSrcFilter = '';
function onVodSearch(items){
  allResults = items || [];
  // 这里**不能**清 curSrcFilter: Java 是"边收边显示", 一次搜索会回调好几次,
  // 每次清一下就把用户刚点的源筛选抹掉了(新搜索开始时才重置, 见 doSearch)
  var tip = document.getElementById('searchTip');
  if (!allResults.length) {
    tip.textContent = (lastSearchWord ? ('「' + lastSearchWord + '」没搜到, ') : '') + '换个词或换源试试';
    document.getElementById('searchGrid').innerHTML = '';
    document.getElementById('srcChips').innerHTML = '';
    return;
  }
  var count = {}, order = [];
  for (var i = 0; i < allResults.length; i++) {
    var k = allResults[i].siteName || '未知';
    if (count[k] === undefined) { count[k] = 0; order.push(k); }
    count[k]++;
  }
  tip.textContent = (lastSearchWord ? ('「' + lastSearchWord + '」· ') : '') + '找到 ' + allResults.length + ' 个结果 · 来自 ' + order.length + ' 个源';
  buildChips(count, order);
  renderSearch();
}
function buildChips(count, order){
  if (!order) {
    count = {}; order = [];
    for (var i = 0; i < allResults.length; i++) {
      var k = allResults[i].siteName || '未知';
      if (count[k] === undefined) { count[k] = 0; order.push(k); }
      count[k]++;
    }
  }
  var box = document.getElementById('srcChips');
  if (!box) return;
  var ch = '<button class="' + (curSrcFilter === '' ? 'on' : '') + '" onclick="filterSrc(&quot;&quot;)">全部 ' + allResults.length + '</button>';
  for (var j = 0; j < order.length; j++) {
    ch += '<button class="' + (curSrcFilter === order[j] ? 'on' : '') + '" onclick="filterSrc(&quot;' + esc(order[j]) + '&quot;)">' + esc(order[j]) + ' ' + count[order[j]] + '</button>';
  }
  box.innerHTML = ch;
  box.style.display = '';
}
function filterSrc(k){
  curSrcFilter = k || '';
  buildChips();
  renderSearch();
}
function renderSearch(){
  var list = [];
  for (var i = 0; i < allResults.length; i++) {
    if (curSrcFilter && (allResults[i].siteName || '未知') !== curSrcFilter) continue;
    allResults[i]._idx = list.length;
    list.push(allResults[i]);
  }
  searchItems = list;
  renderGrid(document.getElementById('searchGrid'), list, 0, 'search');
  fetchDouban(searchItems);
}

function openDetail(which, i){
  if (typeof which === 'number' || which == null) { i = which; which = 'home'; }   /* 旧调用兼容 */
  var it = listOf(which)[i];
  if (!it) return;
  lastMainView = (which === 'search') ? 'v-search' : 'v-home';
  show('v-detail');
  document.getElementById('v-detail').innerHTML = '<div class="empty">读取详情…(拿不到直链会自动换源)</div>';
  if (!doubanOf(it.name)) { try { PK.douban(JSON.stringify([it.name]), 1); } catch(e){} }
  // 关键: 聚合搜索**刚刚**已经告诉我们"这部片在哪些源有"(同名的其它源条目),
  // 直接把它们的 (源,id) 交给 Java 拉详情 —— 不用再按片名重搜一遍, 也就不会只剩三四个源。
  var peers = [];
  try {
    var pool = (which === 'search') ? ((allResults && allResults.length) ? allResults : searchItems) : homeItems;
    for (var k = 0; pool && k < pool.length; k++) {
      var x = pool[k];
      if (!x || !x.id || x.site === it.site) continue;
      if (!sameTitle(x.name, it.name)) continue;
      var dup = false;
      for (var m = 0; m < peers.length; m++) if (peers[m].s === x.site) dup = true;
      if (!dup) peers.push({ s: x.site, i: x.id, sn: x.siteName });
    }
  } catch(e){}
  if (peers.length && VOD.detailPeers) {
    try { VOD.detailPeers(it.site, it.id, it.name, JSON.stringify(peers)); return; } catch(e){}
  }
  VOD.detail(it.site, it.id, it.name);
}

/* ---------- 详情: 多源换源 ---------- */
var srcList = [], srcIdx = 0, detailSrcCount = 0;
function onVodDetail(items){
  // ⚠ 2026-10 用户报"遇到广告/一开过滤就跳成别的剧、或者回到第 1 集" —— **根因就在这里**:
  //   · 这条回调**在播放中也会来**(后台补的备选源 detailWithPeers 结果、以及手动"再搜一遍其它源");
  //   · 老写法每次都清 failedSrc/stallTried、把 srcIdx 重算成"分集最多的源"、再 renderDetail() ——
  //     而 renderDetail() 里有 `curEp = 0`! 于是播放中收到一次详情回调 = 当前源被换掉 + 集号回到第 1 集,
  //     紧接着播放器的失败/卡顿保护就按新下标去切源 → 用户看到"跳剧 / 回到一开始"。
  // 现在: **正在播放时只合并源列表, 绝不动 srcIdx / curEp / failedSrc**。
  var _pl = document.getElementById('player');
  var playing = !!(_pl && ('' + _pl.className).indexOf('on') >= 0);
  var keepSite = (playing && curItem) ? curItem.site : '';
  var keepEpName = (playing && curItem && curItem.eps && curItem.eps[curEp]) ? curItem.eps[curEp].name : '';
  var keepPos = 0;
  try { var _v = document.getElementById('video'); if (_v && _v.currentTime > 3) keepPos = _v.currentTime; } catch(e){}
  if (!playing) {
    failedSrc = {}; stallTried = {};   // 换剧: 上一部"播不动/卡住"的源索引不能带到这部来
    // 2026-10 修: pendingSeek 以前只在"集号不同"时清 —— 上一部剧的续播定位没被消费掉(加载失败/秒退),
    // 换一部剧播同一个集号时就会跳到旧剧的秒数。换剧时无条件复位。
    pendingSeek = 0; pendSeekEp = -1;
  }
  srcList = items || [];
  if (!srcList.length) { onVodError('所有源都没拿到可播放直链, 换一部试试'); return; }
  detailSrcCount = srcList.length;
  var best = 0;
  for (var i = 1; i < srcList.length; i++) {
    if ((srcList[i].eps || []).length > (srcList[best].eps || []).length) best = i;
  }
  // 2026-10: 有些源把广告**烧进画面**(清单里没有广告分片/字幕轨, 过滤器碰不到) ——
  // 与其让用户看广告, 不如默认换一个"分集数差不多、且没有烧录广告"的源。开关在设置抽屉里。
  if (PS.adAvoid && srcList[best] && srcList[best].burnAd) {
    var need = Math.max(1, Math.floor(((srcList[best].eps || []).length) * 0.9));
    for (var q = 0; q < srcList.length; q++) {
      if (srcList[q].burnAd) continue;
      if ((srcList[q].eps || []).length >= need) {
        try { showGest('「' + (srcList[best].siteName || '?') + '」画面里有烧录广告, 已优先用「' + (srcList[q].siteName || '?') + '」'); } catch(e){}
        best = q;
        break;
      }
    }
  }
  if (playing) {
    // 正在播: 源必须还是刚才那一个(还在列表里就用它), 集号也必须还是刚才那一集
    if (keepSite) {
      var sameSite = -1;
      for (var z = 0; z < srcList.length; z++) if (srcList[z].site === keepSite) { sameSite = z; break; }
      if (sameSite >= 0) best = sameSite;
    }
    srcIdx = best;
    renderDetail();                       // 注意: 这里 renderDetail 会把 curEp 归零, 下面马上补回来
    if (keepEpName) {
      var back = epIndexOf(curItem && curItem.eps, keepEpName);
      if (back >= 0) curEp = back;         // 回到同一集 —— 绝不因为"刷了一次详情"就跳回第 1 集
    }
    if (keepPos > 3) { pendingSeek = keepPos; pendSeekEp = curEp; }   // 进度也别丢
    return;
  }
  srcIdx = best;
  renderDetail();
  applyPendingResume();   // 「继续观看」进来的, 详情一到就跳回那一集
}
function switchSrc(k){                     // 手动换源 = 用户认为这条行: 把它的失败/卡住标记撤掉
  if (failedSrc) delete failedSrc[k];
  if (stallTried) delete stallTried[k];
  srcIdx = k; renderDetail();
}
function renderDetail(){
  // 这里**不能**清 failedSrc: 自动换源就是靠 renderDetail 切到下一个源的, 一清就等于
  // "刚标记失败的源"立刻被忘记 -> 会来回跳、或者误判"没有备用源"。清点挪到真正换剧的地方(见 onVodDetail)
  var it = srcList[srcIdx];
  if (!it) return;
  curItem = it;
  var eps = it.eps || [];
  var tabs = '';
  if (srcList.length > 1) {
    tabs = '<div class="chips">';
    for (var i = 0; i < srcList.length; i++) {
      tabs += '<button class="' + (i === srcIdx ? 'on' : '') + '" onclick="switchSrc(' + i + ')">' + esc(srcList[i].siteName) + '</button>';
    }
    tabs += '</div>';
  }
  var h = '<div class="bar">'
    + '<button class="ghost mini" onclick="goHome()">&lsaquo; 首页</button>'
    + '<div class="grow"></div>'
    + '<button onclick="playEp(0)">&blacktriangleright; 播放</button></div>'
    + tabs
    + '<div class="dhead">'
    + '<img referrerpolicy="no-referrer" src="' + esc(it.pic) + '" />'
    + '<div class="info"><h2>' + esc(it.name) + '</h2>'
    + '<div class="meta">'
    + (it.score ? '<span class="tag">评分 ' + esc(it.score) + '</span>' : '')
    + '<span class="tag">' + esc(it.siteName) + '</span>'
    + (it.type ? '<span class="tag">' + esc(it.type) + '</span>' : '')
    + '<br/>' + esc(it.year) + (it.area ? (' · ' + esc(it.area)) : '')
    + (it.remarks ? (' · ' + esc(it.remarks)) : '')
    + '<br/>共 ' + eps.length + ' 个可播地址' + (detailSrcCount > 1 ? (' · ' + detailSrcCount + ' 个源') : '')
    + (it.director ? ('<br/>导演: ' + esc(it.director)) : '')
    + (it.actor ? ('<br/>主演: ' + esc(it.actor).slice(0,60)) : '')
    + '</div>'
    + (doubanOf(it.name) && doubanOf(it.name).rating
        ? ('<div id="dbrow" class="dbrow">豆瓣 ' + esc(doubanOf(it.name).rating) + (doubanOf(it.name).genres ? (' · ' + esc(doubanOf(it.name).genres)) : '') + '</div>')
        : '<div id="dbrow" class="dbrow"></div>')
    + '</div></div>'
    + (it.content ? ('<div class="desc">' + esc(it.content) + '</div>') : '')
    + '<div class="sec">选集</div><div class="eps" id="epsBox"></div>';
  document.getElementById('v-detail').innerHTML = h;
  var b = '';
  for (var j = 0; j < eps.length; j++) {
    b += '<button id="ep-' + j + '" onclick="playEp(' + j + ')">' + esc(eps[j].name)
      + (isSeen(it.name, eps[j].name) ? ' <span style="color:#8ff0b4">✓</span>' : '') + '</button>';
  }
  var boxE = document.getElementById('epsBox');
  boxE.className = 'eps' + (eps.length > 30 ? ' fold' : '');
  boxE.innerHTML = b || '<div class="empty">没有可用播放地址</div>';
  if (eps.length > 30) {
    var mb = document.createElement('button');
    mb.className = 'ghost morebtn';
    mb.textContent = '展开全部 ' + eps.length + ' 集';
    mb.onclick = function(){ boxE.className = 'eps'; mb.style.display = 'none'; };
    boxE.parentNode.insertBefore(mb, boxE.nextSibling);
  }
  curEp = 0;
  fillPlaylist();
}

/* 播放器侧栏「选集」—— 这一块之前一直是空的 */
function liveZapRow(){
  if (!curItem || !curItem.live) return '';
  return '<div class="skiprow"><button class="pbtn" onclick="liveZapPrev()">‹ 上一台</button>'
    + '<button class="pbtn" onclick="liveZapNext()">下一台 ›</button>'
    + '<span class="dim" style="font-size:12px">' + (PS.cross ? '跨分组' : '仅本分组') + '</span></div>';
}
function fillPlaylist(){
  var zap = document.getElementById('pzap');
  if (zap) zap.innerHTML = liveZapRow();          // 直播: 上一台/下一台(参考 TVBox 的换台)
  var box = document.getElementById('plistBox');
  if (!box) return;
  if (!curItem || !curItem.eps || !curItem.eps.length) { box.innerHTML = '<div class="empty">没有可播地址</div>'; return; }
  var eps = curItem.eps, b = '';
  for (var j = 0; j < eps.length; j++) {
    b += '<button id="pep-' + j + '" class="' + (j === curEp ? 'cur' : '') + '" onclick="playEp(' + j + ')">' + (j + 1) + '. ' + esc(eps[j].name)
      + (isSeen(curItem.name, eps[j].name) ? ' <span style="color:#8ff0b4">✓</span>' : '') + '</button>';
  }
  box.innerHTML = b;
}

/* ---------- 自动连播(下一集) ---------- */
/* 播完自动接下一集: 5 秒倒计时, 可取消/立即播放; 开关状态存 localStorage, 下次打开还记得 */
var autoNext = true, nextTimer = null;
/** 启动时把"播放器/直播设置"读回来并应用(画面比例、OSD 这些要立刻生效) */
function initPlayerSettings(){
  psLoad();
  try { PK.adFilter(!!PS.adf); } catch(e){}      // 广告过滤开关先同步给 Java(默认开)
  try { applyFit(); } catch(e){}
  psRender();
  setInterval(osdUpdate, 1000);
}
function initAutoNext(){
  try { if (localStorage.getItem('pk_autonext') === '0') autoNext = false; } catch(e){}
  syncAutoNext();
}
function syncAutoNext(){
  var b = document.getElementById('pauto');
  if (!b) return;
  b.textContent = autoNext ? '连播·开' : '连播·关';
  b.className = autoNext ? 'pbtn' : 'pbtn off';
}
function toggleAutoNext(){
  autoNext = !autoNext;
  try { localStorage.setItem('pk_autonext', autoNext ? '1' : '0'); } catch(e){}
  syncAutoNext();
  showGest(autoNext ? '自动连播已开' : '自动连播已关');
}
/**
 * 一集播完。
 * force=true 表示我们自己知道"这集确实播到头了"(比如片尾跳过主动调的)。
 *
 * 三个坑都在这里:
 *   ① 直播也会发 ended(清单播到头/被 hls.js 判成结尾), 以前它会去"播下一集" —— 直播的
 *      "下一集"其实是下一条线路, 于是画面就在几条线路之间来回跳, 看着就是换线路死循环;
 *   ② 有些流(尤其 HLS 直播切片)会在中途莫名其妙发一次 ended, 明明还在正常播就弹连播;
 *   ③ 所以直播一律不连播, 只把它当"这条线路到底了"处理。
 */
function onEnded(force){
  var v = document.getElementById('video');
  if (!curItem) return;
  if (curItem.live) { liveEnded(); return; }
  if (!force) {
    // 时长已知却离结尾还远 -> 这是假的 ended, 拉回去接着播, 不动连播
    if (v && isFinite(v.duration) && v.duration > 1 && v.currentTime < v.duration - 2) {
      try { v.play(); } catch(e){}
      return;
    }
    if (v && !isFinite(v.duration) && v.currentTime > 0 && v.readyState < 4 && !v.seeking) {
      try { v.play(); } catch(e){}
      return;
    }
  }
  setBig('play');
  if (!autoNext) { showGest('播放结束'); return; }
  if (!curItem.eps || curEp >= curItem.eps.length - 1) { showGest('已经是最后一集'); return; }
  startAutoNext();
}
/**
 * 直播里收到 ended: 不当成"一集播完"。
 * 先试着跳回直播边缘继续播; 短时间连发三次才认这条线路确实完了, 换下一条。
 */
var liveEndHits = 0, liveEndAt = 0;
function liveEnded(){
  var v = document.getElementById('video');
  var now = Date.now();
  if (now - liveEndAt > 40000) liveEndHits = 0;
  liveEndAt = now;
  liveEndHits++;
  if (liveEndHits <= 2) {
    try {
      if (hls && hls.startLoad) hls.startLoad(-1);          // 回到直播边缘
      if (v && v.seekable && v.seekable.length) v.currentTime = v.seekable.end(v.seekable.length - 1);
      if (v) v.play();
    } catch(e){}
    showGest('已回到直播');
    return;
  }
  liveEndHits = 0;
  liveNextLine('源反复结束');
}
function startAutoNext(){
  cancelAutoNext(true);
  if (!curItem || !curItem.eps) return;
  var nx = curItem.eps[curEp + 1];
  if (!nx) return;
  // 用户要求: **静默 3 秒**直接接下一集 —— 不弹倒计时面板、不弹提示。
  // (以前是 5 秒倒计时面板; 现在用户一拖进度/一动播放, 就由 cancelAutoNext 取消, 不必点"取消"。)
  nextTimer = setTimeout(function(){ nextTimer = null; playNextNow(); }, 3000);
}
function cancelAutoNext(silent){
  if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; }
  var el = document.getElementById('pnext');
  if (el) el.className = '';
  if (!silent) showGest('已取消连播');
}
function playNextNow(){
  cancelAutoNext(true);
  if (curItem && curItem.eps && curEp < curItem.eps.length - 1) playEp(curEp + 1);
  else showGest('已经是最后一集');
}

/* ---------- 观看记录（继续观看） ---------- */
var HIST_MAX = 40, histTimer = 0, histSel = {};
function histKeepMax(){
  try { var v = parseInt(localStorage.getItem('pk_hist_keep'), 10); return isNaN(v) ? 40 : v; } catch(e){ return 40; }
}
function histSetKeep(v){
  var n = parseInt(v, 10) || 0;
  try { localStorage.setItem('pk_hist_keep', String(n)); } catch(e){}
  if (n > 0) {
    var a = histArr();
    if (a.length > n) { histStore(a.slice(0, n)); histSel = {}; PK.toast('已按设置清理到 ' + n + ' 条'); }
  }
  renderHistory(); renderHistoryFull();
}
function ago(ts){
  if (!ts) return '';
  var d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d/60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d/3600000) + ' 小时前';
  if (d < 86400000*7) return Math.floor(d/86400000) + ' 天前';
  var t = new Date(ts);
  return (t.getMonth()+1) + '月' + t.getDate() + '日';
}
var HIST_MIN_SEC = 20;          // 新记录至少"真看了 20 秒"才建(见 histPut)
function histArr(){
  try {
    var a = JSON.parse(localStorage.getItem('pk_hist') || '[]') || [];
    // 2026-10 一次性清理: 以前"自动换源切到别的剧/第 1 集"会在几秒内留下记录, 于是
    // 观看记录里出现「权力交锋 00:08」「权利交锋 00:03」这种用户根本没看过的剧。
    // 判据: 播放位置 < 20 秒 且 没有任何"看完"的集 -> 当成播放残渣丢掉(顺手写回去)。
    if (a.length) {
      var keep = [];
      for (var i = 0; i < a.length; i++) {
        var r = a[i];
        var junk = (r && (r.pos || 0) < HIST_MIN_SEC && !(r.seen && r.seen.length));
        if (!junk) keep.push(r);
      }
      if (keep.length !== a.length) {
        try { localStorage.setItem('pk_hist', JSON.stringify(keep)); } catch(e){}
        a = keep;
      }
    }
    return a;
  } catch(e){ return []; }
}
function histStore(a){
  var n = histKeepMax();
  var list = (n > 0) ? a.slice(0, n) : a;      // 按「只保留最近 N 条」自动清理
  try { localStorage.setItem('pk_hist', JSON.stringify(list)); } catch(e){}
}
function titleKey(n){ return String(n == null ? '' : n).replace(/[《》\s·:：\-—]/g, '').slice(0, 40); }
function histOf(name){
  var k = titleKey(name), a = histArr();
  for (var i = 0; i < a.length; i++) if (a[i].k === k) return a[i];
  return null;
}
function histPut(patch){
  if (!curItem) return;
  if (curItem.live) return;                 // 直播不进"观看记录", 免得记录页被频道刷满
  var k = titleKey(curItem.name);
  var a = histArr(), rec = null;
  for (var i = 0; i < a.length; i++) if (a[i].k === k) { rec = a.splice(i, 1)[0]; break; }
  // 2026-10: 新剧必须"真看过一会儿"才建记录 —— 否则自动换源那几秒的"跳剧"会凭空多出一条记录,
  // 用户翻观看记录时看到一堆自己没看过的剧(实测「权力交锋 00:08」「权利交锋 00:03」)。
  if (!rec) {
    var pos0 = (patch && patch.pos) ? patch.pos : 0;
    var seen0 = (patch && patch.seen && patch.seen.length) ? patch.seen : null;
    if (pos0 < HIST_MIN_SEC && !seen0) return;
    rec = { k: k, name: curItem.name, site: curItem.site || '', id: curItem.id || '',
            siteName: curItem.siteName || '', url: curItem.url || '', seen: [] };
  }
  if (curItem.site) rec.site = curItem.site;
  if (curItem.id) rec.id = curItem.id;
  if (curItem.siteName) rec.siteName = curItem.siteName;
  if (curItem.url) rec.url = curItem.url;
  if (patch) for (var p in patch) rec[p] = patch[p];
  rec.ts = Date.now();
  a.unshift(rec);
  histStore(a);
}
/** 播放中每 5 秒记一次进度；一集看了 90% 以上算看完 */
function histTick(){
  var v = document.getElementById('video');
  if (!v || !curItem || !curItem.eps || !curItem.eps[curEp]) return;
  var ep = curItem.eps[curEp];
  var rec = histOf(curItem.name);
  var seen = (rec && rec.seen) ? rec.seen.slice() : [];
  var dur = v.duration || 0, pos = v.currentTime || 0;
  if (dur > 0 && pos / dur >= 0.9 && seen.indexOf(ep.name) < 0) seen.push(ep.name);
  histPut({ epIdx: curEp, epName: ep.name, pos: Math.floor(pos), dur: Math.floor(dur), seen: seen });
}
function isSeen(name, epName){
  var r = histOf(name);
  return !!(r && r.seen && r.seen.indexOf(epName) >= 0);
}
function clearHistory(){
  var n = histArr().length;
  if (n > 1 && !confirm('确定清空全部 ' + n + ' 条观看记录？')) return;
  try { localStorage.removeItem('pk_hist'); } catch(e){}
  histSel = {};
  renderHistory(); renderHistoryFull();
  PK.toast('已清空 ' + n + ' 条观看记录');
}
/* ---------- 观看记录管理页 ---------- */
function openHistory(){
  show('v-hist');
  histSel = {};
  var k = document.getElementById('histKeep');
  if (k) k.value = String(histKeepMax());
  renderHistoryFull();
}
function histToggleSel(i){
  if (histSel[i]) delete histSel[i]; else histSel[i] = 1;
  renderHistoryFull();
}
function histToggleAll(){
  var a = histArr();
  var all = Object.keys(histSel).length >= a.length && a.length > 0;
  histSel = {};
  if (!all) for (var i = 0; i < a.length; i++) histSel[i] = 1;
  renderHistoryFull();
}
function histDeleteOne(i){
  var a = histArr();
  if (!a[i]) return;
  var name = a[i].name;
  a.splice(i, 1);
  histStoreRaw(a);
  histSel = {};
  renderHistory(); renderHistoryFull();
  PK.toast('已删除: ' + name);
}
function histDeleteSelected(){
  var a = histArr(), idx = Object.keys(histSel).map(Number).sort(function(x,y){ return y - x; });
  if (!idx.length) { PK.toast('先勾选要删除的记录'); return; }
  for (var i = 0; i < idx.length; i++) a.splice(idx[i], 1);
  histStoreRaw(a);
  histSel = {};
  renderHistory(); renderHistoryFull();
  PK.toast('已删除 ' + idx.length + ' 条');
}
/** 不走「保留 N 条」的收尾, 删除是精确操作 */
function histStoreRaw(a){ try { localStorage.setItem('pk_hist', JSON.stringify(a)); } catch(e){} }
function renderHistoryFull(){
  var box = document.getElementById('histFull');
  if (!box) return;
  var a = histArr();
  var c = document.getElementById('histCount');
  if (c) c.textContent = a.length + ' 条';
  var sel = Object.keys(histSel).length;
  var allBtn = document.getElementById('histAllBtn');
  if (allBtn) allBtn.textContent = (sel >= a.length && a.length > 0) ? '取消全选' : '全选';
  var delBtn = document.getElementById('histDelBtn');
  if (delBtn) delBtn.textContent = sel > 0 ? ('删除选中 ' + sel) : '删除选中';
  if (!a.length) {
    box.innerHTML = '<div class="empty">还没有观看记录<br/>看过之后这里会自动记下来，方便接着看</div>';
    return;
  }
  var h = '';
  for (var i = 0; i < a.length; i++) {
    var r = a[i];
    var pct = (r.dur > 0) ? Math.min(100, Math.round((r.pos || 0) * 100 / r.dur)) : 0;
    h += '<div class="hrow' + (histSel[i] ? ' sel' : '') + '">'
      + '<div class="chk" onclick="histToggleSel(' + i + ')">✓</div>'
      + '<div class="bd" onclick="resumeWatch(' + i + ')">'
      + '<div class="t1">' + esc(r.name) + '</div>'
      + '<div class="t2">' + esc(r.epName || ('第 ' + ((r.epIdx || 0) + 1) + ' 集'))
      + ' · ' + fmt(r.pos || 0) + (r.dur ? (' / ' + fmt(r.dur)) : '')
      + ' · ' + esc(r.siteName || '来源')
      + ' · ' + ago(r.ts) + '</div>'
      + '<div class="bar2"><i style="width:' + pct + '%"></i></div></div>'
      + '<button class="del" onclick="histDeleteOne(' + i + ')">删除</button>'
      + '</div>';
  }
  box.innerHTML = h;
}
function renderHistory(){
  var wrap = document.getElementById('histWrap'), box = document.getElementById('histList');
  if (!wrap || !box) return;
  var a = histArr();
  if (!a.length) { wrap.style.display = 'none'; box.innerHTML = ''; return; }
  wrap.style.display = 'block';
  var h = '';
  for (var i = 0; i < a.length && i < 12; i++) {
    var r = a[i];
    var pct = (r.dur > 0) ? Math.min(100, Math.round((r.pos || 0) * 100 / r.dur)) : 0;
    h += '<div class="hcard" onclick="resumeWatch(' + i + ')">'
      + '<div class="hn">' + esc(r.name) + '</div>'
      + '<div class="he">' + esc(r.epName || ('第 ' + ((r.epIdx || 0) + 1) + ' 集')) + '</div>'
      + '<div class="hp">' + fmt(r.pos || 0) + (r.dur ? (' / ' + fmt(r.dur)) : '') + ' · ' + esc(r.siteName || '') + '</div>'
      + '<div class="hb"><i style="width:' + pct + '%"></i></div></div>';
  }
  box.innerHTML = h;
}
var pendingResume = null, pendingSeek = 0, pendSeekEp = -1;
function resumeEpIdx(rec, it){
  var eps = (it && it.eps) || [];
  for (var i = 0; i < eps.length; i++) if (eps[i].name === rec.epName) return i;
  var j = rec.epIdx || 0;
  return Math.max(0, Math.min(j, eps.length - 1));
}
function resumeWatch(i){
  var rec = histArr()[i];
  if (!rec) return;
  if (curItem && titleKey(curItem.name) === rec.k) {
    // 已经在这部剧里(典型: 从记录点进去看过一次, 又回记录再点一次)。
    // 以前这里只设了两个变量就 return —— 界面什么都不动, 表现就是"同一部片第二次点没反应"。
    pendingSeek = rec.pos || 0;
    pendSeekEp = resumeEpIdx(rec, curItem);
    var pl = document.getElementById('player');
    if (pl && String(pl.className).indexOf('on') >= 0) {     // 播放器开着: 直接定位续播
      var idx = pendSeekEp;
      if (idx >= 0 && idx !== curEp) { playEp(idx); }
      else {
        try {
          var v = document.getElementById('video');
          if (pendingSeek > 1 && v) { v.currentTime = pendingSeek; pendingSeek = 0; showGest('已定位到 ' + fmt(rec.pos || 0)); }
        } catch(e){}
      }
      return;
    }
    // 播放器没开(在记录页/首页): 重新进详情再续播 —— 走下面同一条路
  }
  if (rec.site === 'direct' && rec.url) {          // 旧版"直链"功能留下的记录(该功能已删)
    PK.toast('这条是旧版直链记录，已不再支持：用「搜索」按片名找，或在播放页点「解析」');
    return;
  }
  if (!rec.site || !rec.id) { PK.toast('这条记录缺站点信息, 重新搜一次吧'); return; }
  pendingResume = rec;
  lastMainView = 'v-home';
  show('v-detail');
  document.getElementById('v-detail').innerHTML = '<div class="empty">继续观看：' + esc(rec.name) + ' 读取中…</div>';
  try { VOD.detail(rec.site, rec.id, rec.name); } catch(e){ onVodError('恢复失败: ' + e); }
}
/** 详情拉回来后, 如果这条是「继续观看」进来的, 自动跳到那一集并定位 */
function applyPendingResume(){
  if (!pendingResume || !curItem) return;
  if (titleKey(curItem.name) !== pendingResume.k) { pendingResume = null; return; }
  var rec = pendingResume; pendingResume = null;
  pendingSeek = rec.pos || 0;
  pendSeekEp = resumeEpIdx(rec, curItem);
  showGest('继续观看 ' + (rec.epName || '') + ' ' + fmt(rec.pos || 0));
  playEp(resumeEpIdx(rec, curItem));
}

/* ---------- 跳过片头 / 片尾 ---------- */
var skipCur = { on: true, intro: 0, outro: 0 }, introDone = false, outroDone = false;
function skipAll(){
  try {
    var o = JSON.parse(localStorage.getItem('pk_skip') || '{}') || {};
    return { on: o.on !== false, intro: o.intro || 0, outro: o.outro || 0, per: o.per || {} };
  } catch(e) { return { on: true, intro: 0, outro: 0, per: {} }; }
}
function skipStore(o){ try { localStorage.setItem('pk_skip', JSON.stringify(o)); } catch(e){} }
/** 优先用「本剧」的设置, 没有就用全局默认 */
function skipOf(name){
  var o = skipAll(), p = o.per[titleKey(name)];
  if (p) return { on: o.on, intro: p.intro || 0, outro: p.outro || 0 };
  return { on: o.on, intro: o.intro || 0, outro: o.outro || 0 };
}
function syncSkipBtn(){
  var b = document.getElementById('pskipbtn');
  if (!b) return;
  var s = null;
  try { s = skipOf(curItem ? curItem.name : ''); } catch(e){}
  if (!s) s = skipCur || { on: false, intro: 0, outro: 0 };
  var on = !!s.on;
  b.textContent = on ? '跳过·开' : '跳过·关';
  b.className = (on && (s.intro > 0 || s.outro > 0)) ? 'pbtn on' : 'pbtn';
}
function toggleSkip(){
  var p = document.getElementById('pskip');
  if (!p) return;
  var open = (p.className || '').indexOf('on') >= 0;
  if (open) { p.className = ''; return; }
  skipCur = skipOf(curItem ? curItem.name : '');
  openSheet('pskip');
  document.getElementById('pskIntro').value = skipCur.intro;
  document.getElementById('pskOutro').value = skipCur.outro;
  document.getElementById('pskont').textContent = skipCur.on ? '开' : '关';
  p.className = 'on';
}
function toggleSkipOn(){
  skipCur.on = !skipCur.on;
  document.getElementById('pskont').textContent = skipCur.on ? '开' : '关';
}
function setSkipNow(which){
  var v = document.getElementById('video');
  if (!v) return;
  if (which === 'intro') document.getElementById('pskIntro').value = Math.max(0, Math.floor(v.currentTime || 0));
  else {
    var dur = v.duration || 0;
    if (!dur) { PK.toast('还不知道总时长'); return; }
    document.getElementById('pskOutro').value = Math.max(0, Math.floor(dur - (v.currentTime || 0)));
  }
}
function readSkipForm(){
  return {
    on: skipCur.on,
    intro: Math.max(0, Math.min(600, parseInt(document.getElementById('pskIntro').value, 10) || 0)),
    outro: Math.max(0, Math.min(600, parseInt(document.getElementById('pskOutro').value, 10) || 0))
  };
}
function saveSkip(){                       // 只对当前这部剧生效
  var f = readSkipForm(), o = skipAll();
  if (curItem) o.per[titleKey(curItem.name)] = { intro: f.intro, outro: f.outro };
  o.on = f.on; skipStore(o);
  skipCur = { on: f.on, intro: f.intro, outro: f.outro };
  introDone = false; outroDone = false; syncSkipBtn();
  showGest('已保存 片头' + f.intro + 's / 片尾' + f.outro + 's(本剧)');
}
function saveSkipGlobal(){
  var f = readSkipForm(), o = skipAll();
  o.on = f.on; o.intro = f.intro; o.outro = f.outro; skipStore(o);
  skipCur = { on: f.on, intro: f.intro, outro: f.outro };
  introDone = false; outroDone = false; syncSkipBtn();
  showGest('已设为默认 片头' + f.intro + 's / 片尾' + f.outro + 's');
}
/** 播放进度里顺手做两件事: 跳片头 / 到片尾就当播完 */
function applySkip(){
  var v = document.getElementById('video');
  if (!v || !skipCur.on) return;
  if (curItem && curItem.live) return;      // 直播没有片头片尾, 别去动它(以前会误触发连播)
  var dur = v.duration || 0, t = v.currentTime || 0;
  if (skipCur.intro > 0) {
    if (!introDone && t > 0.3 && t < skipCur.intro - 1.5) {
      introDone = true;
      try { v.currentTime = skipCur.intro; } catch(e){}
      showGest('已跳过片头 ' + skipCur.intro + ' 秒');
      return;
    }
    if (t >= skipCur.intro - 1.5) introDone = true;
  }
  // 2026-10 修: 短视频/预告片(总时长<=片尾秒数)时 (dur-t)<=outro 从第 0 秒就成立 —— 开播瞬间就算"片尾到了",
  // 配上自动连播会一路连跳好几集。要求"总时长明显大于片尾设置"且真的播过一会儿。
  if (skipCur.outro > 0 && dur > skipCur.outro + 5 && t > 1 && !outroDone && (dur - t) <= skipCur.outro) {
    outroDone = true;
    showGest('片尾已跳过');
    onEnded(true);            // 这个是我们自己判的"到头了", 允许连播
  }
}
function initSkipAndHistory(){
  renderHistory();
}

/* ---------- 屏幕锁定 ---------- */
/* 锁定 = 关掉播放器上所有手势/点击, 只留右边那把锁。
   放在 right:10px / top:50%, 横屏时正好是右手拇指的自然位置。 */
var locked = false, lockHinted = false, lockHideTimer = null, lockTap = null;
/** 把锁浮出来 ms 毫秒, 到点自动隐回去(点屏幕才会调到这里) */
function lockReveal(ms){
  var b = document.getElementById('plock');
  if (!b || !locked) return;
  b.className = 'locked show';
  if (!lockHinted) { lockHinted = true; showGest('点右边那把锁解锁'); }
  clearTimeout(lockHideTimer);
  lockHideTimer = setTimeout(function(){
    if (!locked) return;
    var x = document.getElementById('plock');
    if (x) x.className = 'locked';          // 收起来, 画面干净
  }, ms || 3000);
}
function toggleLock(){
  locked = !locked;
  var pl = document.getElementById('player');
  pl.className = (pl.className || '').replace(/\s*locked/, '') + (locked ? ' locked' : '');
  var b = document.getElementById('plock');
  clearTimeout(lockHideTimer);
  if (b) b.className = locked ? 'locked show' : 'show';  // 锁: 先亮一下; 解锁: 交给 showUI 的节奏
  try { PK.lockOrientation(locked); } catch(e){}     // ★ 锁屏必须连方向一起冻住, 否则一转身画面照样转
  if (locked) {
    hideUI();
    lockHinted = false;
    lockTap = null;
    clearTimeout(lockHideTimer);
    lockHideTimer = setTimeout(function(){               // 亮 1.5 秒就收, 之后靠点屏幕唤出
      if (!locked) return;
      var x = document.getElementById('plock');
      if (x) x.className = 'locked';
    }, 1500);
  } else {
    showUI();
    showGest('已解锁');
  }
}

/* ---------- 投屏 (DLNA) ---------- */
var castDevs = [], castBusy = false;
function toggleCast(){
  if (WEB) return;                       // 网页版: 投屏(DLNA)要原生 socket, 入口已移除
  var p = document.getElementById('pcast');
  var open = (p.className || '').indexOf('on') >= 0;
  if (open) { p.className = ''; return; }
  openSheet('pcast');
  renderCast();
  if (!castDevs.length) castSearch();
}
function castSearch(){
  if (castBusy) return;
  castBusy = true;
  document.getElementById('castList').innerHTML = '<div class="empty">正在搜索局域网设备…</div>';
  try { PK.castSearch(); } catch(e){}
  setTimeout(function(){ castBusy = false; }, 6000);
}
function onCastList(list){
  castBusy = false;
  castDevs = list || [];
  renderCast();
}
function renderCast(){
  var box = document.getElementById('castList');
  if (!box) return;
  if (!castDevs.length) {
    box.innerHTML = '<div class="empty">还没有搜到设备<br/>确认电视和手机在同一个 WiFi，<br/>或者下面手动填电视 IP</div>';
    return;
  }
  var h = '';
  for (var i = 0; i < castDevs.length; i++) {
    var d = castDevs[i];
    h += '<div class="castdev" onclick="castTo(' + i + ')">'
      + '<div class="ic">📺</div><div style="flex:1;min-width:0">'
      + '<div class="nm">' + esc(d.name || '未命名设备') + '</div>'
      + '<div class="ho">' + esc(d.host || '') + '</div></div>'
      + '<span style="color:#7cc4ff;font-size:13px">投屏 ›</span></div>';
  }
  box.innerHTML = h;
}
function castAddHost(){
  var el = document.getElementById('castHost');
  var v = (el && el.value || '').trim();
  if (!v) { PK.toast('填一下电视 IP'); return; }
  PK.toast('正在连接 ' + v + ' …');
  try { PK.castAdd(v); } catch(e){}
}
function castTo(i){
  var d = castDevs[i];
  if (!d) return;
  if (!curItem || !curItem.eps || !curItem.eps[curEp]) { PK.toast('先播一集再投'); return; }
  var ep = curItem.eps[curEp];
  // 本地自建播放列表(爱奇艺/腾讯)只有 127.0.0.1 能访问, 电视拉不到
  if (ep.url.indexOf('http://127.0.0.1') === 0) {
    PK.toast('这个源是本地转的，电视拉不到，换个源再投');
    return;
  }
  var mime = /mpegurl|\.m3u8/i.test(ep.url) ? 'application/vnd.apple.mpegurl' : 'video/mp4';
  PK.toast('正在投到 ' + (d.name || '') + ' …');
  try { PK.castTo(i, ep.url, (curItem.name + ' ' + ep.name), mime); } catch(e){}
}
function onCastResult(msg){
  var ok = String(msg).indexOf('ERR') !== 0;
  PK.toast(msg);
  if (ok) {
    try { var v = document.getElementById('video'); v.pause(); } catch(e){}
    var p = document.getElementById('pcast');
    if (p) p.className = '';
    showGest('已投屏到电视，手机上已暂停播放');
  }
}
function castStop(){
  try { PK.castCtl('stop'); } catch(e){}
}
function onCastStopped(){
  var p = document.getElementById('pcast');
  if (p) p.className = '';
  showGest('已停止投屏');
}

/* ---------- 进度条(自绘) + 缓存进度 ---------- */
/** 取「已缓存到哪」——优先当前播放位置所在的那一段, 否则取最后一段 */
function bufEnd(v){
  try {
    var b = v.buffered;
    if (!b || !b.length) return 0;
    for (var i = 0; i < b.length; i++) {
      if (v.currentTime >= b.start(i) - 0.5 && v.currentTime <= b.end(i) + 0.5) return b.end(i);
    }
    return b.end(b.length - 1);
  } catch(e) { return 0; }
}
/** 把 播放进度 / 缓存进度 画到自绘进度条上 */
function syncBar(v){
  if (!v || !v.duration) return;
  var d = v.duration;
  var pct  = Math.max(0, Math.min(100, v.currentTime / d * 100));
  var bpct = Math.max(0, Math.min(100, bufEnd(v) / d * 100));
  var f = document.getElementById('pfill'), b = document.getElementById('pbuf'), t = document.getElementById('pthumb');
  if (f) f.style.width = pct + '%';
  if (b) b.style.width = Math.max(bpct, pct) + '%';   // 缓存条至少不比播放条短
  if (t) t.style.left = pct + '%';
  var r = document.getElementById('prange');
  if (r) r.value = Math.round(pct * 10);
  var n = document.getElementById('pnow');  if (n) n.textContent = fmt(v.currentTime);
  var o = document.getElementById('ptotal'); if (o) o.textContent = fmt(d);
  // 加载层顺便显示缓存百分比, 让"正在加载"变成"正在缓存 xx%"
  if (loading) {
    var el = document.getElementById('ploadtxt');
    if (el && bpct > 0.5) el.textContent = '正在缓存 ' + Math.round(bpct) + '%';
  }
}
function bufLoading(on){
  var b = document.getElementById('pbuf');
  if (b) b.className = on ? 'loading' : '';
}

/* 中间大按钮只有几种状态, 统一走 class(里面是 SVG, 不能再写 textContent) */
function setBig(st){
  var b = document.getElementById('pbig');
  if (!b) return;
  if (st === 'hide') { b.style.display = 'none'; return; }
  b.style.display = 'flex';
  b.className = 'big ' + st;
}
/* 底栏播放键: 有 play 类时显示三角形, 没有时显示两条竖线 */
function setPlayIcon(paused){
  var b = document.getElementById('pbtn');
  if (!b) return;
  b.className = paused ? 'pbtn ic play' : 'pbtn ic';
}

/* ---------- 播放器 ---------- */
function playEp(i){
  if (!curItem || !curItem.eps || !curItem.eps[i]) return;
  cancelAutoNext(true);
  curEp = i;
  var ep = curItem.eps[i];
  if (pendSeekEp >= 0 && pendSeekEp !== i) pendingSeek = 0;   // 不是当初那一集, 就丢掉续播位置
  if (curItem.live) {                         // 直播: 手动选了哪条线路, 就接着从这条往下自动试
    curItem.liveTry = i;
    liveSwitchAt = 0; liveSwitchN = 0;        // 手动换的: 重置节流, 让下一次自动换立即生效
    liveEndHits = 0;
  }
  // 分集给的是「平台页面地址」(爱奇艺/腾讯/优酷页) 而不是直链 —— 先让 Java 用平台解析换出真地址。
  // 追剧源(如 TXNQ/天空这类采集自己片库的站)给的就是这种地址; 以前直接把 .html 塞给 <video>,
  // 表现就是"点进去一直黑屏/播不动"。
  // 只有"确实是平台页面"才去解析。注意 ep.ready: 由解析器/嗅探交给我们的地址一律直接播 ——
  // 上一版没有这个标记, 遇到"没有扩展名的直链"(优酷 playlist/m3u8?…、腾讯签名 CDN)会
  // 判成页面 -> 再解析 -> 又拿到同一个地址 -> 无限循环。
  // 蜘蛛站点给的地址是 spider://源|线路|原始id —— 播放时现调 playerContent 换真直链
  if (/^spider:\/\//.test(String(ep.url || ''))) { spiderPlayEp(ep); return; }
  if (!ep.ready && !isMediaUrl(ep.url, ep.mime, ep.ext)) { platStart(ep); return; }
  // 有防盗链的源(B站/抖音等)走本地代理, 否则 WebView 带不了 Referer
  var playUrl = ep.url;
  // 自建播放列表(爱奇艺/腾讯)本来就是 127.0.0.1 的地址, 再包一层代理会导致分片地址被重复编码而拿不到
  var isLocal = ep.url.indexOf('http://127.0.0.1') === 0;
  var isM3u8 = /\.m3u8(\?|$)/i.test(ep.url) || /mpegurl/i.test(ep.mime || '');
  if (!isLocal && PS.adf && isM3u8) {
    // 广告过滤开着: m3u8 一律走本地代理 —— 只有经过代理, 清单才会被清洗
    // (CUE/SCTE-35 广告块、注入字幕组、广告分片; 见 core/AdFilter.java)
    try { var pam = PK.proxyWrap(ep.url, ep.referer || '', ep.cookie || ''); if (pam) playUrl = pam; } catch(e){}
  } else if (!isLocal && (ep.referer || ep.cookie)) {
    try { var pw = PK.proxyWrap(ep.url, ep.referer || '', ep.cookie || ''); if (pw) playUrl = pw; } catch(e){}
  }
  // 跳过片头/片尾: 换集时读一遍本剧的设置并复位
  skipCur = skipOf(curItem.name);
  introDone = false; outroDone = false; syncSkipBtn();
  // 播放记忆: 以前这里无条件写 pos:0 —— 同一集重进(或退出时刚好在这 5 秒缝里)就把进度抹了,
  // 表现就是"看到一半退出去, 再进来又从 0 开始"。现在只有**换集**才归零, 同集沿用记录里的进度。
  var _rec0 = histOf(curItem.name);
  var _sameEp = (_rec0 && _rec0.epIdx === i);
  histPut({ epIdx: i, epName: ep.name, pos: _sameEp ? (_rec0.pos || 0) : 0,
            dur: _sameEp ? (_rec0.dur || 0) : 0 });
  document.getElementById('player').className = 'on';
  document.getElementById('ptitle').textContent = curItem.name + ' · ' + ep.name;
  setBig('wait');
  try { PK.playerOpen(true); } catch(e){}
  showLoad('正在连接…');
  var v = document.getElementById('video');
  adStatAt = 0;                                     // 换集/换源: 让广告过滤提示的节流重新计时
  if (hls) { try { hls.destroy(); } catch(e){} hls = null; }
  v.removeAttribute('src'); v.load();
  // Java 侧若探活出"这是 HLS 清单"(无扩展名直链), 会写成 ext=m3u8 —— 这里也要认,
  // 否则会被当成整段文件交给 <video src>, 结构上必然播不了(模块 2 待定项②)。
  var isHls = /\.m3u8(\?|$)/i.test(playUrl) || /m3u8/i.test(ep.url || '')
              || /mpegurl/i.test(ep.mime || '') || /^m3u8$/i.test(ep.ext || '');
  if (isHls && window.Hls && Hls.isSupported()) {
    // 加大预缓存: 目标缓冲 60 秒、上限 3 分钟、字节上限 80MB, 弱网下明显更少卡顿,
    // 进度条上"已缓存"那段也会肉眼可见地往前爬
    // 参数来自"设置"里的缓冲档位/连接超时(参考 TVBox 的直播缓冲与超时设置)
    hls = new Hls(hlsOpts(!!(curItem && curItem.live)));
    // 回调必须认住"我这个实例": 换线路/换集时旧实例还会抛致命错误, 不拦的话它会在已经播起来的
    // 新一集上乱动界面(以前真出现过标题被旧集名覆盖)
    var myHls = hls;
    hls.loadSource(playUrl);   // OSD 网速用分片统计, 见 FRAG_LOADED
    hls.attachMedia(v);
    applyRate();                            // hls 接管媒体元素后, 倍速要重新施加一次
    hls.on(Hls.Events.MANIFEST_PARSED, function(){ if (myHls !== hls) return; applyRate(); safePlay(v); });
    hls.on(Hls.Events.FRAG_LOADED, function(){ if (myHls !== hls) return; adStatsWhisper(); });
    // 分片真的到了 = 这条线路是活的: 立刻消掉失败看门狗, 别在起画面途中把它换掉
    hls.on(Hls.Events.FRAG_LOADED, function(evt, d){
      if (myHls !== hls) return;
      hideLoad(); bufLoading(false); playedOk = true; clearFailWatch();
      liveReport('ok');                       // 分片真到了 = 这台机器放得动 -> 记成功
      // 注意: 这个 hls.js 版本里 data.stats 是**空对象**, 真正的 loaded/loading.start/end 在 data.frag.stats
      try { osdAddFragment((d && d.frag && d.frag.stats) || (d && d.stats) || null); } catch(e){}
      try { updateOsdBitrate(); } catch(e){}
    });
    // 编码这关: hls.js 拉清单时会带上 CODECS, 先问一句系统到底支不支持 ——
    // 不支持(H.265/AV1/AC-3 这类)不是"源坏了", 而是"本机 WebView 放不了", 单独记一种状态
    hls.on(Hls.Events.LEVEL_LOADED, function(){
      if (myHls !== hls) return;
      if (!codecSupported()) {
        liveReport('codec');
        try { PK.toast('这条线路是 H.265/AC-3 这类编码, 系统 WebView 放不了(换 VLC/MX/EXO 能放)'); } catch(e){}
      }
    });
    hls.on(Hls.Events.ERROR, function(e, d){
      if (myHls !== hls) return;                    // 这条线路早被换掉了
      if (d && d.fatal) {
        autoSwitchSource('HLS:' + (d.details || ''));
        setBig('err');
        document.getElementById('ptitle').textContent = curItem.name + ' · ' + ep.name + (srcList.length > 1 ? ' (这条线路失效, 正在自动换源…)' : ' (加载失败)');
        showGest('这个源播不动, 点顶部换源');
      }
    });
  } else {
    lastSrcUrl = playUrl;                     // 记下当前真正在拉的地址, 给下面的 error 归属判定用
    v.src = playUrl; applyRate(); safePlay(v);
  }
  var all = document.getElementById('epsBox');
  if (all) for (var k = 0; k < all.children.length; k++) all.children[k].className = '';
  var eb = document.getElementById('ep-' + i);
  if (eb) eb.className = 'cur';
  fillPlaylist();
  var pb = document.getElementById('pep-' + i);
  if (pb && pb.scrollIntoView) { try { pb.scrollIntoView({ block: 'center' }); } catch(e){} }
  document.getElementById('plist').className = '';
  playedOk = false;
  bufLoading(false);
  var _f = document.getElementById('pfill'); if (_f) _f.style.width = '0%';
  var _b = document.getElementById('pbuf');  if (_b) _b.style.width = '0%';
  var _t = document.getElementById('pthumb'); if (_t) _t.style.left = '0%';
  watchPlayback();
  startStallWatch();            // 停滞看门狗: 出过画面也会盯(源"冻住"时自动换下一条)
  updateQualityBtn();
  syncRotateBtn();
  syncAutoNext();
  syncSkipBtn();
  if (hls) { var qh = hls; qh.on(Hls.Events.LEVEL_SWITCHED, function(){ if (qh === hls) updateQualityBtn(); }); }
  hideUI();
  setTimeout(showUI, 120);
}
/* ---------- 平台页面地址 -> 直链(追剧源的分集是爱奇艺/腾讯/优酷页面时走这里) ---------- */
function isMediaUrl(u, mime, ext){
  u = String(u || '');
  var m = String(mime || '').toLowerCase();
  var e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (/^https?:\/\/127\.0\.0\.1/.test(u)) return true;                // 本地代理 / 自建播放列表
  if (/^video\//.test(m) || /^audio\//.test(m)) return true;             // 解析器给的 mime 最可信
  if (m.indexOf('mpegurl') >= 0 || m.indexOf('m3u8') >= 0) return true;
  if (/^(m3u8|mp4|ts|flv|mkv|mov|webm|m4s|mpd|m4v|mp3|m4a)$/.test(e)) return true;
  var path = u.split('#')[0];
  if (/\.(m3u8|mp4|ts|flv|mkv|mov|webm|m4s|mpd|m4v)(\?|$)/i.test(path)) return true;
  // 没有扩展名的情况: /playlist/m3u8?vid=… (优酷)、/hls/… 、googlevideo 这类也是直链
  if (/[\/.](m3u8|mp4|flv|mpd)[\/?&#]/i.test(path)) return true;
  if (/videoplayback|\/hls\/|\/dash\/|googlevideo|\/playlist\//i.test(path)) return true;
  return false;
}
var platCache = {};      // 页面地址 -> 解析出来的候选([{url,quality,source,...}])
var platOrder = [];      // 写入顺序(只用于淘汰最旧的几条)
var PLAT_CACHE_MAX = 40; // 上限: 连看几十集也不会无限涨(每项 KB 级)
/** 当前正在播的那一页的 key —— 淘汰时绝不能把它在用的候选清掉 */
function platKeepKey(){
  try {
    var ep = (curItem && curItem.eps) ? curItem.eps[curEp] : null;
    return ep ? (ep.page || ep.url || '') : '';
  } catch(e){ return ''; }
}
function platCachePut(k, v){
  if (!k) return;                          // 边界: 空 key 不写(以前会写出 platCache[''] 这种脏项)
  platCache[k] = v;
  var i = platOrder.indexOf(k);
  if (i >= 0) platOrder.splice(i, 1);
  platOrder.push(k);
  var guard = 0;                           // 边界: 防"全是 keep key"时死循环
  while (platOrder.length > PLAT_CACHE_MAX && guard++ < PLAT_CACHE_MAX * 4) {
    var oldK = platOrder.shift();
    if (!oldK) continue;
    if (oldK === platKeepKey()) { platOrder.push(oldK); continue; }   // 正在用的留着, 淘汰下一条
    delete platCache[oldK];
  }
}
var platKey   = '';      // 正在解析的那个页面地址(目前只做记录)
var platWant  = null;    // {t: 这一集的令牌, page: 页面地址} —— 回调回来时用它判断用户是不是还停在这一集
var rescueWant = '', rescueName = '';   // 救场解析的归属
var sniffWant = null;    // VIP 线路嗅探的归属(见 addFound)
/* 本轮嗅探的收集计数/去重表 —— 2026-10 修复: 这两个变量**原来没声明**,
   addFound() 第一行 `if (foundCount >= 40)` 就抛 ReferenceError,
   于是"嗅探抓到的流一条也接不上"(解析线路看着在跑, 其实全被这一个异常吃了)。
   边界: 每轮嗅探开始时复位(见 vipSniffEp), 否则 40 条上限会跨轮累积、之后永远收不到。 */
var foundCount = 0, foundSeen = {};
/** 当前"这一集"的令牌: 换集/换剧/换线路都会变 */
function epToken(){ return (curItem ? curItem.name : '') + '|' + curEp; }
var platTimer = null;    // 解析超时兜底: 25 秒没回调就收工, 不无限转圈
function platStart(ep){
  document.getElementById('player').className = 'on';
  document.getElementById('ptitle').textContent = curItem.name + ' · ' + ep.name;
  setBig('wait');
  showLoad('正在解析这个平台的页面地址…');
  try { PK.playerOpen(true); } catch(e){}
  var list = platCache[ep.url] || (ep.page ? platCache[ep.page] : null);
  if (list && list.length) { platUse(ep, 0); return; }
  // 同一集最多解析 3 次: 再多就是哪里没对上(以前这里能空转到天荒地老)
  ep.tries = (ep.tries || 0) + 1;
  if (ep.tries > 3) {
    setBig('err');
    hideLoad();
    showGest('这个页面解析了几次都没出直链 —— 点右上「解析」换线路，或点「换源」');
    return;
  }
  // (ep.tries 的自增在上面; 手动点「解析」会先清零, 见 retryParseNow/platStart)
  if (platTimer) { clearTimeout(platTimer); platTimer = null; }
  platTimer = setTimeout(function(){
    platTimer = null;
    if (!platWant || platWant.t !== epToken()) return;   // 解析期间用户已经切走了
    setBig('err');
    hideLoad();
    showGest('解析超时了 —— 点右上「解析」换线路，或点「换源」');
  }, 25000);
  platKey = ep.url;
  platWant = { t: epToken(), page: ep.url };
  // 会员集要靠 Cookie: 分集自身没带就用输入框那个(存在 localStorage 的 pk_sessdata)
  var ck = ep.cookie || '';
  try { ck = ck || localStorage.getItem('pk_sessdata') || ''; } catch(e){}
  ep.cookie = ck;
  try { PK.platResolve(ep.url, ep.referer || '', ck); }
  catch(e){ setBig('err'); showLoad(''); showGest('解析桥不可用: ' + e); }
}
/** Java 解析完回调(平台专用解析: B站/腾讯/爱奇艺/优酷…) */
function onPlatResolved(pageUrl, items){
  if (platTimer) { clearTimeout(platTimer); platTimer = null; }
  platCachePut(pageUrl, items || []);                              // 结果先存下来(即使已经切走了)
  // 归属校验: 解析期间用户可能已经换集/换剧/换了线路, 这时旧结果绝不能抢播当前画面
  if (!platWant || platWant.page !== pageUrl || platWant.t !== epToken()) return;
  if (!items || !items.length) {
    setBig('err');
    hideLoad();
    document.getElementById('ptitle').textContent = curItem.name + ' · ' +
      (curItem.eps[curEp] ? curItem.eps[curEp].name : '') + ' (这个页面没解析出直链)';
    showGest('这个页面没解析出直链 —— 点右上「解析」用解析线路，或点「换源」');
    return;
  }
  var ep = (curItem && curItem.eps) ? curItem.eps[curEp] : null;
  if (!ep) return;
  // 页面地址对不上说明用户已经切走了(结果先留在 platCache 里); ep.page 相同则是"同一页的二次回调",
  // 这时也不能再解析一遍, 直接用缓存播。
  if (ep.url !== pageUrl && ep.page !== pageUrl) return;
  if (!ep.page) ep.page = pageUrl;               // 记下原页面地址: 换线路/重解析要用
  platUse(ep, 0);
}
/** 用第 idx 条候选播放(候选来自平台解析或 VIP 线路) */
function platUse(ep, idx){
  var list = (ep.plat && ep.plat.length) ? ep.plat : platCache[ep.page || ep.url];
  if (!list || !list[idx]) return;
  var c = list[idx];
  ep.plat = list;
  ep.url = c.url;
  ep.mime = c.mime || '';
  ep.ext = c.ext || '';
  // 候选里没带 referer/cookie 时**不要覆盖**成空串: 会员集靠 pk_sessdata, 覆盖了就再也解析不出来
  if (c.referer) ep.referer = c.referer;
  if (c.cookie) ep.cookie = c.cookie;
  ep.ready = true;                  // 这条地址是解析器/嗅探给的, 不要再当"页面"解析一遍(死循环的根)
  if (c.source) ep.name = String(ep.name).replace(/\s*\(.*\)$/, '');
  playEp(curEp);
}
/** 播放器里的「解析」面板: 已解析出的备用线路 + 10 条 VIP 线路 */
function toggleVipPanel(){
  if (WEB) return;                       // 网页版: 解析线路要隐藏 WebView 嗅探, 入口已移除
  var p = document.getElementById('pvip');
  var open = (p.className || '').indexOf('on') >= 0;
  if (open) { closeSheets(); return; }
  renderVipPanel();
  openSheet('pvip');
}
function renderVipPanel(){
  var ep = (curItem && curItem.eps) ? curItem.eps[curEp] : null;
  var box = document.getElementById('pvipBox');
  var tip = document.getElementById('pvipTip');
  if (!box) return;
  if (tip) tip.textContent = ep ? (ep.name || '') : '';
  var arr = [], h = '';
  try { arr = JSON.parse(PK.vipLines()); } catch(e){ arr = []; }
  var list = ep ? (ep.plat || platCache[ep.page || ep.url]) : null;
  if (list && list.length > 1) {
    h += '<span class="pw">本集已解析出 ' + list.length + ' 条线路，点一条切过去：</span>';
    for (var i = 0; i < list.length; i++) {
      h += '<button' + (ep.url === list[i].url ? ' class="cur"' : '') + ' onclick="platUse(curItem.eps[curEp],' + i + ')">'
        + (i + 1) + '. ' + esc(list[i].source || '线路') + ' ' + esc(list[i].quality || '') + '</button>';
    }
  }
  h += '<button onclick="rescueStart()">按片名去追剧源找这一集并解析</button>';
  if (curItem && curItem.live) {
    h += '<button onclick="openExternal()">用其它播放器打开这条线路（本机解不了码时用这个）</button>';
  }
  h += '<span class="pw">没出直链时，用下面的线路解析：</span>';
  h += '<span class="pw">' + esc(ep ? (ep.page || ep.url) : '') + '</span>';
  for (var j = 0; j < arr.length; j++) {
    var L = arr[j];
    // 手机上没有 title 悬浮提示, 所以把"这条线的注意事项"直接写在按钮里
    h += '<button onclick="vipSniffEp(' + L.i + ')">' + esc(L.name)
      + (L.gate ? '（需宿主页）' : '')
      + (L.note ? '<span class="pw">' + esc(L.note) + '</span>' : '') + '</button>';
  }
  box.innerHTML = h;
}
/**
 * 救场: 当前源给的是直链且已失效(手里没有平台页面可解析) —— 让 Java 拿片名去追剧源(TXNQ)
 * 反查同一集的平台页面地址, 再用平台专用解析换直链; 换不出来就把页面地址留下来,
 * 让 10 条解析线路接着啃。
 */
function rescueStart(){
  if (!curItem) return;
  var ep = curItem.eps ? curItem.eps[curEp] : null;
  if (!ep) return;
  rescueWant = epToken(); rescueName = curItem.name;
  var ck = ep.cookie || '';
  try { ck = ck || localStorage.getItem('pk_sessdata') || ''; } catch(e){}
  if (document.getElementById('pvipTip')) document.getElementById('pvipTip').textContent = '按片名找页面…';
  showGest('正在按片名「' + curItem.name + '」找这一集的平台页面…');
  // 把"这一集的集名"一起给 Java: 只按序号索引追剧源的集表会给错集(剧集数不一样时更明显)
  try { PK.rescueResolve(curItem.name, curEp, (ep.name || ''), ck); } catch(e){ PK.toast('桥不可用: ' + e); }
}
/** Java 回调: info = "剧名 · 集名 (页面地址)" */
function onRescueResolved(name, info, pageUrl, items){
  if (name !== rescueName || rescueWant !== epToken()) return;       // 用户已经切走了
  var ep = (curItem && curItem.eps) ? curItem.eps[curEp] : null;
  if (ep && pageUrl) ep.page = pageUrl;
  if (items && items.length) {
    if (ep) {
      if (!ep.plat) ep.plat = [];
      for (var i = 0; i < items.length; i++) ep.plat.push(items[i]);
      platCachePut(pageUrl, ep.plat);
      platUse(ep, ep.plat.length - items.length);
    }
    showGest('救场成功: ' + (info || name));
  } else if (pageUrl) {
    showGest('找到页面了, 但平台解析没直链 —— 点下面任一条解析线路试试');
    if (document.getElementById('pvipTip')) document.getElementById('pvipTip').textContent = '已找到页面';
    renderVipPanel();
  } else {
    showGest('追剧源里没找到「' + name + '」这一集, 换个源吧');
    if (document.getElementById('pvipTip')) document.getElementById('pvipTip').textContent = '没找到页面';
  }
}
/** 用第 i 条 VIP 线路解析"当前这一集背后的平台页面" */
function vipSniffEp(i){
  var ep = (curItem && curItem.eps) ? curItem.eps[curEp] : null;
  if (!ep) return;
  var page = ep.page || (isMediaUrl(ep.url) ? '' : ep.url);
  if (!page) { PK.toast('这一集本身就是直链, 不需要解析线路'); return; }
  var ck = ep.cookie || '';
  try { ck = ck || localStorage.getItem('pk_sessdata') || ''; } catch(e){}
  if (document.getElementById('pvipTip')) document.getElementById('pvipTip').textContent = vipName(i) + ' 解析中…';
  showGest('用「' + vipName(i) + '」解析中, 一般 5~20 秒…');
  sniffWant = { t: epToken(), page: page };
  ep.tries = 0;                            // 手动点解析 = 用户要求再试一次, 清零"最多 3 次"的计数
  foundCount = 0; foundSeen = {};          // 新一轮嗅探: 计数/去重复位
  platWant = { t: epToken(), page: page };
  try { PK.vipSniff(i, page, ck); } catch(e){ PK.toast('桥不可用: ' + e); }
}
function closePlayer(){
  cancelAutoNext(true);
  sniffWant = null; platWant = null;      // 收工: 残留的溪探归属会让"直链页嗅到的流"抢播播放器
  rescueWant = ''; rescueName = '';       // 救场解析的归属也要清: 否则关掉播放器后迟到的回调还会把它弹回来

  if (locked) {
    locked = false;
    clearTimeout(lockHideTimer);
    var _l = document.getElementById('plock'); if (_l) _l.className = '';
    try { PK.lockOrientation(false); } catch(e){}    // 退出播放器时把方向还给系统
  }
  var _pc = document.getElementById('pcast'); if (_pc) _pc.className = '';
  var _pl = document.getElementById('player'); if (_pl) _pl.className = ('' + _pl.className).replace(/\s*locked/, '');
  try { histTick(); } catch(e){}
  renderHistory();
  var v = document.getElementById('video');
  try { v.pause(); } catch(e){}
  if (hls) { try { hls.destroy(); } catch(e){} hls = null; }
  document.getElementById('player').className = '';
  hideLoad();
  clearFailWatch();
  clearStallWatch();
  stallTried = {};
  autoSwitching = false;
  try { PK.playerOpen(false); } catch(e){}
}
function togglePlay(){
  var v = document.getElementById('video');
  if (v.paused) safePlay(v); else v.pause();
}
function nextEp(){
  if (curItem && curItem.live) { liveNextLine('手动切下一条线路'); return; }   // 直播: 下一集=下一条线路
  if (curItem && curItem.eps && curEp < curItem.eps.length - 1) playEp(curEp + 1); else PK.toast('已经是最后一集');
}
function prevEp(){
  if (curItem && curItem.live) {
    if (curEp > 0) { curItem.liveTry = curEp - 1; liveSwitchAt = 0; liveSwitchN = 0; playEp(curEp - 1); }
    else PK.toast('已经是第一条线路');
    return;
  }
  if (curEp > 0) playEp(curEp - 1); else PK.toast('已经是第一集');
}
function toggleList(){
  var p = document.getElementById('plist');
  var open = (p.className || '').indexOf('on') >= 0;
  if (open) { closeSheets(); return; }
  fillPlaylist();
  openSheet('plist');
}
/**
 * 把当前倍速施加到播放器上。**每次换集/换源/重建 hls 都要重新施加** ——
 * 以前只写 v.playbackRate, 换集时内核会把 playbackRate 重置回 1, 于是"上一集调了倍速,
 * 下一集又变回 1×"(用户报的就是这个)。倍速现在是设置项 PS.rate, 存 pk_ps。
 */
/** 当前该用哪个倍速: 直播和影视**各存一份**(用户要求: 在影视里调了倍速, 直播不该继承) */
function curRate(){
  return (curItem && curItem.live) ? (PS.rateLive || 1) : (PS.rate || 1);
}
function applyRate(){
  try {
    var v = document.getElementById('video');
    if (!v) return;
    var r = curRate();
    if (v.playbackRate !== r) v.playbackRate = r;
    var b = document.getElementById('prate');
    if (b) b.textContent = '倍速 ' + r.toFixed(2).replace(/0$/, '') + 'x';
  } catch(e){}
}
function cycleRate(){
  var live = !!(curItem && curItem.live);            // 只在当前这个播放器的倍速上循环
  var cur = live ? (PS.rateLive || 1) : (PS.rate || 1);
  var i = RATES.indexOf(cur); if (i < 0) i = 0;
  var nx = RATES[(i + 1) % RATES.length];
  if (live) PS.rateLive = nx; else PS.rate = nx;
  psSave();
  applyRate();
  showGest('倍速 ' + nx + 'x（只影响' + (live ? '直播' : '影视') + '）');
}
function searchFromHome(){
  var k = (document.getElementById('kwHome').value || '').trim();
  if (!k) { document.getElementById('kwHome').focus(); return; }
  hideKwPrev();
  document.getElementById('kwHome').value = '';   // 同上: 搜完清空首页那个框
  document.getElementById('kw').value = k;
  show('v-search');
  doSearch();
}

/* 回到首页：清掉搜索/详情残留状态，并用首页自己的数据重绘，避免"回首页还是搜索内容" */
function goHome(){
  try { var kw = document.getElementById("kw"); if (kw) kw.value = ""; } catch(e){}
  try { var sg = document.getElementById("searchGrid"); if (sg) sg.innerHTML = ""; } catch(e){}
  try { var sc = document.getElementById("srcChips"); if (sc) { sc.innerHTML = ""; sc.style.display = "none"; } } catch(e){}
  try { document.getElementById("searchTip").textContent = ""; } catch(e){}
  allResults = []; searchItems = []; curSrcFilter = "";
  lastMainView = "v-home";
  show("v-home");
  renderHistory();
  if (homeItems && homeItems.length) renderGrid(document.getElementById("homeGrid"), homeItems, 0, "home");
  else reloadHome();
}
function onVodError(m){
  PK.toast(m);
  homeLoading = false;                     // 首页请求失败也要解锁"加载更多"(否则一次失败就永久失效)
  try {
    var d = document.getElementById('v-detail');
    if (d && d.style.display !== 'none') {
      var box = d.querySelector('.empty');
      if (box && box.textContent.indexOf('读取详情') >= 0) box.textContent = '详情取不到: ' + m;
    }
  } catch(e){}
}

/* ---------- 系统返回键 ---------- */
var lastMainView = 'v-home';
/* ---------- 播放器右侧抽屉: 统一开关 ----------
   以前 back() 只认 跳过/连播/清晰度/选集 四个, 解析线路和投屏是漏的 —— 面板开着按返回
   直接把播放器关了(用户看到的就是"只能退回剧情首页")。现在统一走 closeSheets()。 */
var SHEETS = ['plist', 'qlist', 'pskip', 'pcast', 'pvip', 'pset'];   // 新增抽屉必须加进来, 否则关不掉(踩过)
function sheetOn(id){ var e = document.getElementById(id); return !!(e && (e.className || '').indexOf('on') >= 0); }
function anySheetOpen(){ for (var i = 0; i < SHEETS.length; i++) if (sheetOn(SHEETS[i])) return true; return false; }
function syncMask(){ var m = document.getElementById('pmask'); if (m) m.className = anySheetOpen() ? 'on' : ''; }
function closeSheets(){
  for (var i = 0; i < SHEETS.length; i++) { var e = document.getElementById(SHEETS[i]); if (e) e.className = ''; }
  syncMask();
}
/** 打开某个抽屉(自动关掉其它抽屉, 并亮出遮罩) */
function openSheet(id){
  for (var i = 0; i < SHEETS.length; i++) {
    var e = document.getElementById(SHEETS[i]);
    if (e) e.className = (SHEETS[i] === id ? 'on' : '');
  }
  syncMask();
}
var backPortraitAt = 0;    // 横屏观影时"手势返回先回竖屏"的节流时间戳
function back(){
  if (anySheetOpen()) { closeSheets(); return; }        // 先关抽屉, 再谈退出
  // 横屏观影: 手势返回先切回竖屏(留在播放器里), 再按一次才退出播放器回详情页。
  // 2.5 秒节流: 切回竖屏后马上再按一次就直接退出, 不会卡在"一直切竖屏"。
  try {
    var pl0 = document.getElementById('player');
    if (pl0 && String(pl0.className).indexOf('on') >= 0 && !locked
        && PK.isLandscape() && (Date.now() - backPortraitAt) > 2500) {
      backPortraitAt = Date.now();
      try { PK.landscape(false); } catch(e){}   // Java 侧会一并退出沉浸式全屏
      showGest('已切回竖屏，再按一次返回退出播放');
      setTimeout(syncRotateBtn, 600);
      return;
    }
  } catch(e){}
  var sk = document.getElementById('pskip');
  if (sk && (sk.className || '').indexOf('on') >= 0) { sk.className = ''; return; }
  var nx = document.getElementById('pnext');
  if (nx && (nx.className || '').indexOf('on') >= 0) { cancelAutoNext(true); return; }
  var q = document.getElementById('qlist');
  var pl = document.getElementById('plist');
  if (q && (q.className || '').indexOf('on') >= 0) { q.className = ''; return; }
  if (pl && (pl.className || '').indexOf('on') >= 0) { pl.className = ''; return; }
  var plOn = document.getElementById('player');
  if (plOn && ('' + plOn.className).indexOf('on') >= 0) {
    if (locked) { toggleLock(); return; }     // 锁屏时返回 = 先解锁(以前会一路走到 PK.exit() 把 App 退了)
    closePlayer(); return;
  }
  if (document.getElementById('v-detail').style.display !== 'none') { show(lastMainView); return; }
  if (document.getElementById('v-search').style.display !== 'none') { show('v-home'); return; }
  if (document.getElementById('v-update').style.display !== 'none') { show('v-home'); return; }
  if (document.getElementById('v-dec').style.display !== 'none') { show('v-home'); return; }   // 漏了这一条 -> 在解密页按返回会直接退 App
  if (document.getElementById('v-live').style.display !== 'none') { show('v-home'); return; }
  if (document.getElementById('v-hist').style.display !== 'none') { show('v-home'); return; }
  // 直链页/崩溃页以前不在这个链里 -> 在那两页按返回会一路走到 PK.exit() 把 App 退了
  // (跟刚修过的"锁屏时返回退出 App"是同一类坑, 只是另一条路径)
  if (document.getElementById('v-crash').style.display !== 'none') { show('v-home'); return; }
  PK.exit();
}

/* ---------- 控件显隐 / 手势 ---------- */
var uiTimer = null, gTimer = null, loading = false, lastUIAt = 0;
var touchDown = false;   // 手指是否按在画面上(看门狗要读它, 必须是全局的 —— 以前这里读的是 IIFE 里的 st)
/**
 * addEventListener 第三个参数: 支持 passive 的内核用 `{passive:true}`, 不支持的传布尔 `false`。
 * 为什么必须探测: Chrome 49 以下把对象参数当 capture 布尔量、个别老 WebKit(CoolEagle) 直接**抛错**;
 * 一抛, 下面 bindVideo 整个 IIFE 就断了 —— 手势/进度条/锁屏全废。
 * 探测靠 getter: 内核支持 passive 时*读取* options 会命中 getter, 老内核不读它 -> 恒 false(安全侧)。
 * 只探测一次, 用 window 做探针(此脚本在 <head> 或 body 末尾都能跑, 不依赖具体元素)。
 */
var PASSIVE = false, PASSIVE_BLOCK = false;
(function(){
  try {
    var seen = false;
    var opt = { get passive(){ seen = true; return true; } };
    window.addEventListener('pk_probe', null, opt);
    window.removeEventListener('pk_probe', null, opt);
    PASSIVE = PASSIVE_BLOCK = seen;
  } catch(e) { PASSIVE = PASSIVE_BLOCK = false; }
})();
function showUI(){
  if (locked) return;                        // 锁屏时不显示任何控件
  lastUIAt = Date.now();
  document.getElementById('ptop').className = '';
  document.getElementById('pbot').className = '';
  document.getElementById('pcenter').style.display = 'flex';
  var lk = document.getElementById('plock');
  if (lk) lk.className = 'show';             // 锁按钮跟控制栏一起出现(未锁时不再常亮)
  clearTimeout(uiTimer);
  if (!loading) uiTimer = setTimeout(hideUI, 4500);
}
function hideUI(){
  document.getElementById('ptop').className = 'hide';
  document.getElementById('pbot').className = 'hide';
  document.getElementById('pcenter').style.display = 'none';
  var lk = document.getElementById('plock');
  if (lk && !locked) lk.className = '';      // 控制栏收起来, 锁按钮一起收
}
/* 自动隐藏看门狗: 只认"最后一次交互/最后一次 showUI"的时间戳,
   任何事件(缓冲、切集、切横竖屏)把控件弹出来都不会让它永久留在屏幕上。
   音乐/菜单/拖进度/缓冲中/锁屏 一律豁免。 */
setInterval(function(){
  if (locked || loading) { lastUIAt = Date.now(); return; }
  var pl = document.getElementById('player');
  if (!pl || ('' + pl.className).indexOf('on') < 0) return;
  if (touchDown) { lastUIAt = Date.now(); return; }                // 手指还按在屏幕上
  var trk = document.getElementById('ptrack');
  if (trk && ('' + trk.className).indexOf('on') >= 0) { lastUIAt = Date.now(); return; }
  var li = document.getElementById('plist');
  if (li && ('' + li.className).indexOf('on') >= 0) { lastUIAt = Date.now(); return; }
  var ql = document.getElementById('qlist');
  if (ql && ('' + ql.className).indexOf('on') >= 0) { lastUIAt = Date.now(); return; }
  var nx = document.getElementById('pnext');
  if (nx && ('' + nx.className).indexOf('on') >= 0) { lastUIAt = Date.now(); return; }
  var top = document.getElementById('ptop');
  if (!top || top.className === 'hide') return;                    // 已经收起来了
  if (!lastUIAt) lastUIAt = Date.now();
  if (Date.now() - lastUIAt > 4200) hideUI();
}, 700);

function showGest(txt){
  var g = document.getElementById('pgest');
  if (!g) return;
  g.textContent = txt; g.style.display = 'block';
  clearTimeout(gTimer); gTimer = setTimeout(function(){ g.style.display = 'none'; }, 900);
}
/**
 * 播一下, 但别假设 play() 一定返回 Promise —— 老内核(Android 4.x WebView)返回 undefined,
 * 直接 .catch() 会抛 TypeError; 这个异常出现在 playEp 主干上, 会把后面的
 * playedOk=false / watchPlayback() / fillPlaylist() / hideUI() 全截断(实测踩过这一天)。
 */
function safePlay(v){
  try {
    if (!v) return;
    if (WEB) {
      // 浏览器可能给 <video> 留了 muted(自动播放策略), 不摘掉就是"有画面没声音"
      try {
        v.muted = false;
        var sv = parseInt(localStorage.getItem('pk_vol') || '', 10);
        if (isFinite(sv)) v.volume = Math.max(0, Math.min(1, sv / 100));
        else if (!(v.volume > 0)) v.volume = 1;
      } catch(e){}
    }
    var r = v.play();
    if (r && typeof r.catch === 'function') r.catch(function(){ if (WEB) webNeedGesture(); });
  } catch(e) {}
}
function fmt(s){
  // 直播的 duration 是 Infinity(hls 直播流): 以前 Math.floor(Infinity) 会显示成 "Infinity:NaN"
  if (s == null || !isFinite(s) || s <= 0) return '--:--';
  s = Math.max(0, Math.floor(s));
  var m = Math.floor(s/60), ss = s % 60;
  return (m<10?'0':'') + m + ':' + (ss<10?'0':'') + ss;
}

(function bindVideo(){
  var v = document.getElementById('video');
  var player = document.getElementById('player');
  v.addEventListener('timeupdate', function(){
    if (v.duration) {
      syncBar(v);
      if (!v.paused) { hideLoad(); playedOk = true; clearFailWatch(); }   // 有进展=播起来了, 锁定不再换源
    }
    // 每 5 秒落一次观看记录; 顺便处理片头/片尾
    var now = Date.now();
    if (now - histTimer > 5000) { histTimer = now; histTick(); }
    applySkip();
  });
  // 续播: 元数据一到位就跳到上次的位置(只跳一次)
  v.addEventListener('loadedmetadata', function(){
    applyRate();                                  // 元数据一到就把倍速设回去(换集后必做)
    if (pendingSeek > 1) {
      var p = pendingSeek; pendingSeek = 0;
      try { v.currentTime = p; showGest('已定位到 ' + fmt(p)); } catch(e){}
    }
  });
  v.addEventListener('play',  function(){ hideLoad(); setPlayIcon(false); setBig('hide'); });
  v.addEventListener('pause', function(){ hideLoad(); setPlayIcon(true); setBig('play'); });
  v.addEventListener('waiting', function(){ showLoad('正在缓存…'); bufLoading(true); });
  // 缓存进度会在 progress 事件里持续更新 -> 进度条上"已缓存"那段会一直往前爬
  v.addEventListener('progress', function(){ syncBar(v); });
  v.addEventListener('durationchange', function(){ syncBar(v); });
  v.addEventListener('stalled', function(){ bufLoading(true); });
  // play 只在首次播放触发; 卡顿恢复走 playing, 所以必须监听它
  v.addEventListener('playing', function(){ hideLoad(); bufLoading(false); clearFailWatch(); failedSrc[srcIdx] = false; playedOk = true; applyRate(); syncBar(v);
    if (nextTimer) cancelAutoNext(true);      // 用户又让画面动起来(比如往回拖) -> 别静默跳下一集
  });
  v.addEventListener('canplay', function(){ hideLoad(); bufLoading(false); syncBar(v); });
  v.addEventListener('canplaythrough', function(){ hideLoad(); bufLoading(false); syncBar(v); });
  v.addEventListener('seeked', function(){ hideLoad(); syncBar(v); });
  v.addEventListener('loadeddata', function(){ hideLoad(); syncBar(v); });
  v.addEventListener('ended', function(){ onEnded(false); });
  // 换集/换源时内核有时会把**上一条地址**的 error 迟到地派发过来 —— 不校验就会把刚起来的新线路
  // 当坏源切走(表现就是"明明播上了还自动换源")
  v.addEventListener('error', function(){
    if (lastSrcUrl && v.src && v.src !== lastSrcUrl) return;
    setBig('err'); autoSwitchSource('video error');
  });
  document.getElementById('prange').addEventListener('input', function(){
    if (!v.duration || !isFinite(v.duration)) return;   // 直播(Infinity)不能拖, 否则 currentTime=Infinity 抛异常
    var pct = this.value / 10;
    var f = document.getElementById('pfill'); if (f) f.style.width = pct + '%';
    var t = document.getElementById('pthumb'); if (t) t.style.left = pct + '%';
    var n = document.getElementById('pnow'); if (n) n.textContent = fmt(this.value / 1000 * v.duration);
    v.currentTime = this.value / 1000 * v.duration;
    if (!WEB) { try { PK.castSeek(Math.floor(this.value / 1000 * v.duration)); } catch(e){} }   // 投屏中: 让电视也跟着跳(网页版没有投屏)
  });
  // 手指按住时轨道变粗一点, 松手回细 —— 细条也不难拖
  var trk = document.getElementById('ptrack');
  if (trk) {
    ['touchstart','mousedown','pointerdown'].forEach(function(e){ trk.addEventListener(e, function(){ trk.className = 'on'; }); });
    ['touchend','mouseup','touchcancel','pointerup'].forEach(function(e){ trk.addEventListener(e, function(){ trk.className = ''; }); });
  }
  document.getElementById('pbig').addEventListener('click', function(e){ e.stopPropagation(); if (locked) return; togglePlay(); });
  document.getElementById('pcenter').addEventListener('click', function(e){ e.stopPropagation(); if (locked) return; togglePlay(); });

  var st = null, lastTap = 0, tapTimer = null, moved = false;
  // 手势要"接着上次的值继续滑", 所以基准必须取**当前真实值**。
  // 以前亮度写死 0.5(每次一滑就跳回 50%), 音量每动一下就重新问系统(系统值没变 -> 弹回 40%)。
  var gBright = -1, gVol = -1;
  function readLevels(){
    try { if (PK.brightnessLevel) gBright = PK.brightnessLevel() / 100; } catch(err){}
    try { if (PK.volumeLevel) gVol = PK.volumeLevel() / 100; } catch(err){}
    if (!(gBright >= 0)) gBright = 0.5;
    if (!(gVol >= 0)) gVol = 0.5;
  }
  /**
   * 这一下触摸是不是"别人家的"：抽屉(选集/清晰度/设置/跳过/投屏/解析)、上下控制栏、
   * 进度条、按钮、锁钮 —— 落在这些上面时**绝不能**启动播放器手势。
   * 踩过的坑：设置抽屉是 #player 的子节点，在抽屉里上下滑动会冒泡到播放器手势，
   * 于是"滑设置列表"顺带把亮度/音量也改了（用户直接反馈过"这种逻辑性错误不能再有"）。
   */
  var NOGEST = {'ptop':1,'pbot':1,'pgbar':1,'ptrack':1,'plist':1,'qlist':1,'pskip':1,'pcast':1,
                'pvip':1,'pset':1,'plock':1,'pnext':1,'pmask':1,'pgest':1,'pbig':1,'pcenter':1};
  function touchBlocked(target){
    var el = target;
    var guard = 0;
    while (el && el !== player && guard++ < 24) {
      if (el.id && NOGEST[el.id]) return true;
      var cn = '' + (el.className || '');
      if (cn.indexOf('pbtn') >= 0 || cn.indexOf('pclose') >= 0) return true;   // 按钮上滑也不该调音量
      el = el.parentNode;
    }
    return false;
  }
  player.addEventListener('touchstart', function(e){
    if (locked) {                            // 锁屏后所有播放手势失效, 但轻点要能唤出那把锁
      lockTap = (e.touches.length === 1) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      return;
    }
    // 抽屉开着 / 点在控制栏·进度条·按钮上 -> 不启动手势(让抽屉自己滚)
    if (anySheetOpen() || touchBlocked(e.target)) { st = null; touchDown = false; return; }
    if (e.touches.length !== 1) return;
    var t = e.touches[0];
    touchDown = true;
    readLevels();
    st = { x: t.clientX, y: t.clientY, time: v.currentTime || 0, dur: v.duration || 0,
           w: player.clientWidth || 1, h: player.clientHeight || 1, mode: null,
           base: 0, baseVol: gVol };
    moved = false;
  }, PASSIVE ? { passive: true } : false);
  player.addEventListener('touchmove', function(e){
    if (locked) { lockTap = null; return; }   // 划动不算轻点
    if (!st || e.touches.length !== 1) return;
    var t = e.touches[0];
    var dx = t.clientX - st.x, dy = t.clientY - st.y;
    if (!st.mode) {
      // 防误碰(用户: "快进快退经常误碰"):
      //  · 起手位移 <28px 一律不认(以前是 14px, 手指抖一下就开始拖进度);
      //  · 横向要明显压过纵向(≥1.6 倍)才算快进快退, 斜着划不再被判成 seek;
      //  · 纵向同理(≥1.6 倍)才算亮度/音量, 免得"想调音量"变成拖进度;
      //  · 两个方向都不够就继续等, 不锁定模式。
      var ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax < 28 && ay < 28) return;
      if (ax >= 28 && ax >= ay * 1.6) { st.mode = 'seek'; if (nextTimer) cancelAutoNext(true); }
      else if (ay >= 28 && ay >= ax * 1.6) st.mode = (st.x < st.w / 2 ? 'bright' : 'vol');
      else return;
      st.dead = (st.mode === 'seek') ? 18 : 14;   // 死区: 起手头 18px 不动进度, 避免一碰就跳
    }
    moved = true;
    var eff = dx - (st.dead || 0) * (dx >= 0 ? 1 : -1);     // 扣掉死区(左右对称)
    if (Math.abs(eff) < 1) eff = 0;
    if (st.mode === 'seek' && isFinite(st.dur) && st.dur > 0) {
      var nt = Math.max(0, Math.min(st.dur, st.time + eff / st.w * st.dur));
      v.currentTime = nt;
      showGest('进度 ' + fmt(nt) + ' / ' + fmt(st.dur));
    } else if (st.mode === 'seek') {
      // 直播: v.duration 是 Infinity, 拿它算进度会得到 ±Infinity, 给 currentTime 赋值直接抛错,
      // 手势会中断、进度提示还会显示"Infinity"; 直播只能按"可回看窗口"拖
      try {
        var sk = v.seekable;
        if (sk && sk.length) {
          var hi = sk.end(sk.length - 1);
          var t2 = Math.max(sk.start(sk.length - 1), Math.min(hi - 0.5, (v.currentTime || hi) + eff / st.w * 60));
          v.currentTime = t2;
          showGest('已回到 ' + fmt(hi - t2) + ' 秒前');
        }
      } catch(e) {}
    } else if (st.mode === 'bright') {
      if (st.base <= 0) st.base = gBright;          // 记一次起点, 之后按位移算
      var b = Math.max(0.02, Math.min(1, st.base - dy / st.h));
      gBright = b;
      try { PK.brightness(b); } catch(err){}
      showGest('亮度 ' + Math.round(b * 100) + '%');
    } else if (st.mode === 'vol') {
      if (st.baseVol < 0) st.baseVol = gVol;
      var nv = Math.max(0, Math.min(1, st.baseVol - dy / st.h));
      var real = -1;
      try { real = PK.volume(nv); } catch(err){ real = -1; }
      // 显示用"系统真认了多少"(有些机器音量档位粗, 比如 15 档), 但**基准不能跟着回写** ——
      // 基准是这次手势的起点, 跟着回写就等于把手指位移算了两遍, 会越滑越飞。
      gVol = (real >= 0) ? real / 100 : nv;
      showGest('音量 ' + Math.round(gVol * 100) + '%');
    }
    if (e.cancelable) e.preventDefault();
  }, PASSIVE_BLOCK ? { passive: false } : false);
  player.addEventListener('touchend', function(){
    touchDown = false;
    if (locked) {
      if (lockTap) { lockReveal(3000); lockTap = null; }   // 轻点 -> 浮出锁, 3 秒不动自动隐
      st = null;
      return;
    }
    if (st && !moved) {
      var now = Date.now();
      if (now - lastTap < 300) {
        // 双击 = 播放/暂停: 必须把单击那次的"显隐控制栏"定时器取消掉,
        // 否则双击会顺带把控制栏切一次(以前就是这个毛病: 定时器还在, 到点照样跑)
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
        togglePlay();
        lastTap = 0;
      } else {
        lastTap = now;
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
        tapTimer = setTimeout(function(){
          tapTimer = null;
          if (Date.now() - lastTap >= 290) {
            if (document.getElementById('ptop').className === 'hide') showUI(); else hideUI();
          }
        }, 300);
      }
    }
    st = null;
  }, PASSIVE ? { passive: true } : false);
  player.addEventListener('touchcancel', function(){ touchDown = false; st = null; }, PASSIVE ? { passive: true } : false);
})();

/**
 * 播本地已下载的文件（任务页那个"播放"按钮）。
 * 以前这里调 PK.openFile —— Java 侧压根没有这个方法，调用直接抛异常被吞掉，按钮等于没反应。
 * 现在拿 file:// 地址交给**内置播放器**（主 WebView 已放开 file:// 读权限），不绕系统播放器，
 * 也就没有 Android 7+ 的 FileUriExposedException 那一摊事。
 */

/* ---------- 清晰度切换 (读 hls.js 的 level 列表) ---------- */
function toggleQuality(){
  var q = document.getElementById('qlist');
  if (!q) return;
  var open = (q.className || '').indexOf('on') >= 0;
  if (!open) {
    fillQuality();
  }
  if (open) closeSheets(); else openSheet('qlist');
}
function fillQuality(){
  var box = document.getElementById('qlistBox');
  if (!box) return;
  var h = '';
  var lv = (hls && hls.levels) ? hls.levels : null;
  if (lv && lv.length > 1) {
    h += '<div class="qtitle">清晰度</div>';
    h += '<button class="' + (hls.autoLevelEnabled ? 'cur' : '') + '" onclick="setQuality(-1)">自动</button>';
    for (var i = 0; i < lv.length; i++) {
      var label = lv[i].height ? (lv[i].height + 'P') : (Math.round(lv[i].bitrate / 1000) + 'K');
      h += '<button class="' + (!hls.autoLevelEnabled && i === hls.currentLevel ? 'cur' : '') + '" onclick="setQuality(' + i + ')">' + label + '</button>';
    }
  } else {
    var v = document.getElementById('video');
    var res = (v && v.videoWidth) ? ('  ' + v.videoWidth + 'x' + v.videoHeight) : '';
    h += '<div class="qtitle">当前源（单码率）' + res + '</div>';
  }
  if (srcList.length > 1) {
    h += '<div class="qtitle" style="margin-top:16px">线路切换（换源）</div>';
    for (var j = 0; j < srcList.length; j++) {
      h += '<button class="' + (j === srcIdx ? 'cur' : '') + '" onclick="switchLine(' + j + ')">'
        + esc(srcList[j].siteName) + ' · ' + srcList[j].eps.length + '集'
        // 画面里带烧录广告的源如实标出来 —— 这种广告滤镜碰不到, 只能靠换源避开
        + (srcList[j].burnAd ? ' ⚠ 画面烧录广告' : '') + '</button>';
    }
    h += '<div class="qtitle" style="margin-top:16px">还没找到别的?</div>';
    h += '<button onclick="requestMoreSources()">再搜一遍其它源</button>';
  } else {
    h += '<div class="qtitle" style="margin-top:16px">换源</div>';
    h += '<div class="dim" style="font-size:12px;margin:6px 2px">'
      + (altBusy ? '正在搜索其它源…' : '目前只有这一个源有这部片') + '</div>';
    h += '<button onclick="requestMoreSources()">' + (altBusy ? '搜索中…' : '搜索其它源') + '</button>';
  }
  box.innerHTML = h;
}
function switchLine(j){
  // 2026-10 修: 原来是"记下集序号 -> 换源 -> playEp(同一个序号)"。但不同源的集表顺序/起始集不一样
  // (有的从第 1 集开始、有的带预告/花絮), 同一个序号往往**不是同一集**。改成按集名找(和自动换源一致)。
  var keepName = (curItem && curItem.eps && curItem.eps[curEp]) ? curItem.eps[curEp].name : '';
  switchSrc(j);
  document.getElementById('qlist').className = '';
  if (document.getElementById('player').className.indexOf('on') < 0) return;   // 用户已经关掉播放器: 别抢播
  setTimeout(function(){
    if (document.getElementById('player').className.indexOf('on') < 0) return;
    var target = keepName ? epIndexOf(curItem && curItem.eps, keepName) : 0;
    if (target < 0) target = 0;                 // 手动换线路: 用户自己选的源, 没同名集就从头
    playEp(target);
  }, 300);
}
function setQuality(i){
  if (!hls) { PK.toast('还没开始播放'); return; }
  hls.currentLevel = i;
  var txt = '自动';
  if (i >= 0 && hls.levels && hls.levels[i]) txt = (hls.levels[i].height || '?') + 'P';
  var b = document.getElementById('pqInList');
  if (b) b.textContent = txt;
  document.getElementById('qlist').className = '';
  showGest('清晰度: ' + txt);
}
function updateQualityBtn(){
  var b = document.getElementById('pqInList');
  if (!b) return;   // 清晰度按钮已挪进「选集」面板(真节点是 #pqInList, 以前写 #pq 永远写不进去)
  if (!hls || !hls.levels || hls.levels.length <= 1) { b.textContent = '换源'; b.style.opacity = 1; }   // 只有一档码率时这里就是"换源"入口
  else { b.textContent = hls.autoLevelEnabled ? '自动' : (((hls.levels[hls.currentLevel] || {}).height || '?') + 'P'); b.style.opacity = 1; }
}


/* ---------- 横屏 / 画面比例 ---------- */
var fitNames = ['适应', '铺满', '裁剪', '16:9', '4:3', '原始'];
var fitCss = ['contain', 'fill', 'cover', '169', '43', 'native'];
var fitMode = 0;   // 0=适应
/* ---------- 播放器/直播设置(参考 TVBox 的设置分组: 画面比例/超时/换源/OSD 都可调且记住) ---------- */
var PS = { ratio: 0, buf: 'normal', to: 12, autoSw: 1, osd: 1, cross: 1, desc: 0, rate: 1 };
var PS_DEF = { ratio: 0, buf: 'normal', to: 12, autoSw: 1, osd: 1, cross: 1, desc: 0, rate: 1, rateLive: 1, adf: 1, adAvoid: 1 };  // adBlock=短插播块过滤(默认开)  // adf=广告过滤; adAvoid=优先避开"画面带烧录广告"的源(默认开)
var RATES = [1, 1.25, 1.5, 2, 0.75];
function psLoad(){
  // ① 先铺一遍默认值 —— 以前只做"存过的键覆盖", 于是**新加的设置项默认值永远不生效**:
  //    老用户 localStorage 里的 pk_ps 没有 adf, PS.adf 就是 undefined(假), 界面显示"关"。
  //    (2026-10 实测踩到: 「广告过滤」要求默认开, 装上去却是关的。)
  for (var d in PS_DEF) PS[d] = PS_DEF[d];
  // ② 再用用户存过的值覆盖(用户手动关掉的项必须尊重)
  try {
    var t = localStorage.getItem('pk_ps');
    if (t) {
      var o = JSON.parse(t);
      for (var k in PS_DEF) if (o && typeof o[k] !== 'undefined') PS[k] = o[k];
    }
  } catch(e){}
  if (fitNames[PS.ratio] == null) PS.ratio = 0;
  if (RATES.indexOf(PS.rate) < 0) PS.rate = 1;      // 倍速是设置项(存 pk_ps), 换集/换源/重启都跟着走
  fitMode = PS.ratio;
}
function psSave(){ try { localStorage.setItem('pk_ps', JSON.stringify(PS)); } catch(e){} }
/** 缓冲档位 -> hls.js 参数(参考 TVBox 的"直播缓冲/超时"设置, 这里映射到 hls.js) */
function hlsOpts(live){
  var to = Math.max(6, Math.min(30, PS.to || 12)) * 1000;
  if (live) {
    if (PS.buf === 'low')  return { enableWorker:false, lowLatencyMode:false, liveSyncDurationCount:2, maxBufferLength:10, maxMaxBufferLength:20, backBufferLength:8, manifestLoadingTimeOut:Math.min(to,10000), levelLoadingTimeOut:Math.min(to,10000), fragLoadingTimeOut:to+6000 };
    if (PS.buf === 'high') return { enableWorker:false, lowLatencyMode:false, liveSyncDurationCount:4, maxBufferLength:40, maxMaxBufferLength:90, backBufferLength:20, manifestLoadingTimeOut:to, levelLoadingTimeOut:to, fragLoadingTimeOut:to+15000 };
    return { enableWorker:false, lowLatencyMode:false, liveSyncDurationCount:3, maxBufferLength:20, maxMaxBufferLength:40, backBufferLength:10, manifestLoadingTimeOut:to, levelLoadingTimeOut:to, fragLoadingTimeOut:to+8000 };
  }
  return { maxBufferLength:60, maxMaxBufferLength:180, maxBufferSize:80*1000*1000, backBufferLength:30,
           maxBufferHole:0.5, enableWorker:true, startLevel:-1, manifestLoadingTimeOut:Math.max(to,10000) };
}
function psCycleBuf(){
  PS.buf = PS.buf === 'low' ? 'normal' : (PS.buf === 'normal' ? 'high' : 'low');
  psSave(); psRender();
  var nm = PS.buf === 'low' ? '流畅' : (PS.buf === 'normal' ? '标准' : '更稳');
  showGest('缓冲档位: ' + nm + '（换台/重播生效）');
}
function psCycleTo(){
  var v = [8, 12, 20, 30], i = v.indexOf(PS.to); if (i < 0) i = 1;
  PS.to = v[(i + 1) % v.length];
  psSave(); psRender(); showGest('连接超时: ' + PS.to + ' 秒');
}
function psToggle(k){
  PS[k] = PS[k] ? 0 : 1;
  psSave(); psRender();
  var nm = { autoSw:'自动换线路', osd:'画面 OSD', cross:'跨分组换台', desc:'频道倒序', adf:'广告过滤', adAvoid:'避开烧录广告源' }[k] || k;
  if (k === 'adf') {                       // 过滤在 Java 侧(清单清洗), 这里把开关同步过去
    try { PK.adFilter(!!PS.adf); } catch(e){}
    showGest(PS.adf ? '广告过滤: 开(滤 CUE 广告块/字幕注入/广告分片/异目录插入块/短插播块)' : '广告过滤: 关(清单原样透传)');
    reloadForAdSetting();                  // 2026-10: 正在播的这条清单是"开之前"拉下来的, 必须重载才生效
    return;
  }
  showGest(nm + (PS[k] ? ': 开' : ': 关'));
  if (k === 'osd') osdUpdate();
  if (k === 'adAvoid') showGest(PS.adAvoid ? '以后打开片子会优先用没有烧录广告的源' : '不再自动避开, 按分集数选源');
  if (k === 'desc') renderLiveChannels(liveGroup);
}
var adStatsShown = 0;
/**
 * 广告过滤"念一句": 播起来之后问一次 Java 侧累计滤掉了什么, 有变化就提示一行。
 * 为什么不每片都问: 分片回调很密集, 每片一次 IPC 纯属浪费; 而且这类提示只该出现一次。
 */
var adStatAt = 0;
function adStatsWhisper(){
  if (!PS.adf) return;
  // 节流: FRAG_LOADED 每个分片都会回调(2~6 秒一次), 每次都过一遍 IPC + JSON.parse 纯属浪费。
  // 边界: 新一集开始播时 adStatAt 会被重置成 0(见 playEp), 保证第一片就能及时提示, 不会因为节流漏掉。
  var now = Date.now();
  if (adStatAt && now - adStatAt < 5000) return;
  adStatAt = now;
  try {
    var d = JSON.parse(PK.adStats());
    if (d && d.dropped > adStatsShown) { adStatsShown = d.dropped; if (d.note) showGest(d.note); }
  } catch(e){}
}
var osdBytes = 0, osdTs = 0, osdLastSpeed = '';
var netBps = 0;                  // 真实下载速率(bit/s): 每个分片"字节 ÷ 加载耗时"的滑动平均
/**
 * 记一个分片的下载速率。
 * 2026-10 用户两次报"网速不对": ①老算法是"窗口内字节 ÷ 窗口时长", 而 hls.js 是**提前缓冲**的 ——
 * 一次拉完 2~3 个分片(瞬时几十 Mbps)、随后几秒不下载(0), 数字忽高忽低;
 * ②上一版改用 hls.bandwidthEstimate, 那是 hls.js **估可用带宽**(给码率决策用的, 会往上飘),
 * 也不是"这条流现在的下载速度"。
 * 现在按每个分片自己的 stats(loaded 字节 / loading.end-loading.start 毫秒)算瞬时速率, 再做 EWMA 平滑 ——
 * 这就是"网速"。缓冲满、没在下载时保留上次的值(而不是跳成 0)。
 */
function osdAddFragment(stats){
  try {
    if (!stats) return;
    var bytes = stats.loaded || 0;
    var t0 = stats.loading && stats.loading.start ? stats.loading.start : 0;
    var t1 = stats.loading && stats.loading.end ? stats.loading.end : 0;
    var sec = (t1 - t0) / 1000;
    if (bytes <= 0 || sec <= 0.05) { osdAddBytes(bytes); return; }
    var bps = bytes * 8 / sec;
    if (bps > 500000000) bps = 500000000;                    // 明显离奇的样本(计时异常)丢掉一半权重
    netBps = netBps > 0 ? (netBps * 0.55 + bps * 0.45) : bps;
    osdAddBytes(bytes);
  } catch(e){}
}
function osdAddBytes(n){ if (n > 0) osdBytes += n; }
/** 当前播放档位的**声明码率**(hls.js 的 level.bitrate), 用 M 表示 */
function levelMbps(){
  try {
    if (!hls || !hls.levels || !hls.levels.length) return '';
    var i = hls.currentLevel >= 0 ? hls.currentLevel : (hls.loadLevel >= 0 ? hls.loadLevel : 0);
    var lv = hls.levels[i];
    if (!lv || !lv.bitrate) return '';
    return (lv.bitrate / 1000000).toFixed(1) + 'M';
  } catch(e){ return ''; }
}
function updateOsdBitrate(){ /* 码率是实时读的, 这里只是留个钩子(手动切换清晰度后立刻刷一次) */
  try { osdUpdate(); } catch(e){}
}
function osdSpeed(){
  if (netBps > 0) {
    var mb = netBps / 1000000;
    return mb >= 1 ? (mb.toFixed(1) + 'M') : (Math.round(netBps / 1000) + 'k');
  }
  // 兜底(还没下过任何分片 / 直播刚起流): 用码率量级顶一下, 至少不是空白
  var now = Date.now();
  if (!osdTs) { osdTs = now; return osdLastSpeed; }
  var dt = (now - osdTs) / 1000;
  if (dt < 2) return osdLastSpeed;
  var kbps = Math.round(osdBytes * 8 / dt / 1000);
  osdBytes = 0; osdTs = now;
  if (kbps > 0) osdLastSpeed = kbps >= 1000 ? ((kbps/1000).toFixed(1) + ' Mbps') : (kbps + ' kbps');
  else if (hls && hls.levels && hls.levels[hls.currentLevel] && hls.levels[hls.currentLevel].bitrate) {
    var br = hls.levels[hls.currentLevel].bitrate / 1000000;      // 缓冲满了没在下载: 至少显示码率量级
    osdLastSpeed = br.toFixed(1) + ' Mbps';
  }
  return osdLastSpeed;
}
/** 画面右上角的小字: 分辨率 · 时间 · 网速 */
function osdUpdate(){
  var o = document.getElementById('posd');
  if (!o) return;
  var pl = document.getElementById('player');
  if (!PS.osd || !curItem || !pl || String(pl.className).indexOf('on') < 0) { o.style.display = 'none'; return; }
  var v = document.getElementById('video');
  var d = new Date(), p2 = function(n){ return (n < 10 ? '0' : '') + n; };
  var bits = [];
  if (v && v.videoWidth) bits.push(v.videoWidth + '×' + v.videoHeight);
  bits.push(p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()));
  var sp = osdSpeed(); if (sp) bits.push('网速 ' + sp);
  var br = levelMbps(); if (br) bits.push('码率 ' + br);
  o.textContent = bits.join(' · ');
  o.style.display = 'block';
}
/**
 * 广告相关的开关改了以后, **正在播的那条流必须重载**才会有新效果 ——
 * 因为"要不要走本地代理清洗"是在 playEp() 里决定并拼进地址的, 已经拉下来的清单不会自己变。
 * 2026-10 用户报"开了过滤广告还在"就是这个原因(开关是开了, 但当前这条流还是老的地址)。
 * 重载时把当前进度记进 pendingSeek, 起来之后接着播, 不会跳回开头。
 */
function reloadForAdSetting(){
  try {
    var pl = document.getElementById('player');
    if (!pl || ('' + pl.className).indexOf('on') < 0) return;      // 没在播: 下次播放自然生效
    if (!curItem || !curItem.eps || !curItem.eps.length) return;
    var v = document.getElementById('video');
    var pos = v ? (v.currentTime || 0) : 0;
    if (pos > 3) { pendingSeek = pos; pendSeekEp = curEp; }
    showGest('已重新加载当前集, 让过滤设置生效(进度保留)');
    setTimeout(function(){ try { playEp(curEp); } catch(e){} }, 260);
  } catch(e){}
}
function psRender(){
  var set = function(id, txt){ var e = document.getElementById(id); if (e) e.textContent = txt; };
  set('psRatio', fitNames[fitMode] || '适应');
  set('psBuf', PS.buf === 'low' ? '流畅' : (PS.buf === 'normal' ? '标准' : '更稳'));
  set('psTo', PS.to + ' 秒');
  set('psAuto', PS.autoSw ? '开' : '关');
  set('psOsd', PS.osd ? '开' : '关');
  set('psCross', PS.cross ? '开' : '关');
  set('psDesc', PS.desc ? '开' : '关');
  set('psAdf', PS.adf ? '开' : '关');
  set('psAdAvoid', PS.adAvoid ? '开' : '关');
}
function openPSet(){
  var p = document.getElementById('pset');
  if (p && (p.className || '').indexOf('on') >= 0) { closeSheets(); return; }
  psRender();
  openSheet('pset');
}
/** 自测: 把用户粘的候选源地址交给 Java 真测一次, 结果原样显示(含 UA/HTTP码/字符数/频道数/前 120 字) */

/* ---------- TVBox 数据源配置: 解析(含解密) + 逐个真测 + 通过才加 ---------- */
var scanLives = [], scanSpiders = [];
function onAddSite(name, jsonStr){
  var d = null;
  try { d = JSON.parse(jsonStr); } catch(e){}
  var msg = (d && d.msg) ? d.msg : '完了';
  try { PK.toast((d && d.ok ? '✓ ' : '✗ ') + (name ? name + ': ' : '') + msg); } catch(e){}
  if (d && d.ok) {
    // 源列表没有下拉框(界面里不选源, 聚合搜索会自动带上): 只要刷新内存里的列表,
    // 当前源还在就保持不动, 不在(第一次加源)就用第一个
    try { sites = JSON.parse(VOD.sites()); } catch(e){}
    var has = false;
    for (var i = 0; i < (sites || []).length; i++) if (sites[i].key === curSite) has = true;
    if (!has && sites && sites.length) pickSite(sites[0].key);
    try { PK.toast('已生效：现在搜索会并发搜 ' + (sites || []).length + ' 个源（含你加的）'); } catch(e){}
  }
}
/** 我的源: 列出用户加进来的源, 可删 */
function showUserSites(){
  var cd = document.getElementById('decTools');
  if (!cd) return;
  var list = [];
  try { list = JSON.parse(VOD.userSites()); } catch(e){}
  if (!list.length) {
    cd.innerHTML = '<div class="hint">还没有自己加的源 —— 粘一个 TVBox 配置地址点「解析并加源」，真测通过的才能加进来</div>';
    return;
  }
  // 加进来怎么用, 直接写在面板上(用户问过"添加了怎么使用")
  var h = '<div class="pw">自己加的源（' + list.length + ' 个）已经生效，三种用法都不用手动选源：<br>'
    + '① <b>搜索</b>：点搜索时所有源并发搜（含你加的），结果右上角能按源名筛选；<br>'
    + '② <b>详情/播放</b>：这部片在当前源拿不到直链时，会自动去你加的源里找同名的；<br>'
    + '③ <b>首页</b>：当前源没数据时会优先用它兜底。<br>'
    + '加完不用重启，退出设置就能用。</div>'
    + '<button class="pbtn" onclick="tryUserSourceSearch()">搜一部片试试</button>'
    + '<div style="height:6px"></div>';
  for (var i = 0; i < list.length; i++) {
    var keyQ = jsa(list[i].key);
    var isCur = (list[i].key === curSite);
    h += '<div class="srcrow">'
      + '<div class="sinfo" title="' + esc(list[i].api) + '">' + esc(list[i].name)
      + (isCur ? ' <span class="sbad">当前源</span>' : '')
      + '<br><span class="sapi">' + esc(list[i].api) + esc(list[i].path || '') + '</span></div>'
      + '<button class="pbtn" onclick="useUserSite(' + keyQ + ')">' + (isCur ? '已用' : '设为首选') + '</button>'
      + '<button class="pbtn" onclick="delUserSite(' + keyQ + ')">删除</button></div>';
  }
  cd.innerHTML = h;
}
function useUserSite(key){
  try { pickSite(key); } catch(e){ PK.toast('切换失败: ' + e); return; }
  try { PK.toast('当前源已切到「' + key + '」'); } catch(e){}
  closeSheets();
  show('v-home');
}
function tryUserSourceSearch(){
  closeSheets();
  show('v-search');
  var k = document.getElementById('kw');
  if (k) { k.value = '庆余年'; k.focus(); }
  doSearch();
}
function onSpiderTest(jsonStr){
  var out = document.getElementById('decOut');
  var d = null;
  try { d = JSON.parse(jsonStr); } catch(e){}
  if (!d) { if (out) out.textContent = '结果解析不了'; return; }
  if (out) out.textContent = '🕷 蜘蛛自测\njar: ' + (d.jar || '') + '\n类: ' + (d.cls || '')
    + '   ext: ' + String(d.ext || '').slice(0, 80) + '\n'
    + '加载: ' + (d.loaded ? '成功' : ('失败 ' + (d.loadError || ''))) + '   总用时 ' + (d.totalMs || 0) + 'ms\n'
    + (d.error ? ('异常: ' + d.error + '\n') : '')
    + '\nhomeContent(' + (d.homeMs || 0) + 'ms): ' + (d.home || '(空)')
    + '\n\nsearchContent(' + (d.searchMs || 0) + 'ms): ' + (d.search || '(空)')
    + (d.detailId ? ('\n\ndetailContent(' + (d.detailMs || 0) + 'ms) id=' + String(d.detailId).slice(0, 60)
        + '\n' + (d.detail || '(空)') + '\n\n(原始回包, 只给排查用)') : '');
}
/** 蜘蛛自测: 看爬虫原样返回什么(定位"站点死了"还是"翻译层不对")。蜘蛛行的「自测」按钮调它。 */
function spiderTestNow(i){
  if (WEB) { try { PK.toast('网页版跑不了蜘蛛 jar'); } catch(e){} return; }
  var sp = (i != null && scanSpiders[i]) ? scanSpiders[i] : null;
  var out = document.getElementById('decOut');
  var jar = (sp && sp.jar) || scanJar;
  var cls = (sp && sp.key) ? String(sp.key).replace(/^csp_/, '') : 'XBPQ';
  var ext = (sp && sp.ext) || '';
  if (!jar) { if (out) out.textContent = '还不知道 jar 地址 —— 先点「解析并加源」让它从配置里读出来'; return; }
  if (out) out.textContent = '正在下载 jar → 加载 → 跑 homeContent/searchContent…(' + cls + ')';
  try { VOD.spiderTest(jar, cls, ext, '庆余年'); }
  catch(e){ if (out) out.textContent = '桥不可用: ' + e; }
}
/** 蜘蛛站点: 把 spider://源|线路|id 交给 Java 调 playerContent, 换到直链再播 */
function spiderPlayEp(ep){
  if (WEB) { try { hideLoad(); setBig('err'); PK.toast('网页版跑不了蜘蛛源(需要 DexClassLoader)'); } catch(e){} return; }
  var parts = String(ep.url).replace(/^spider:\/\//, '').split('|');
  var key = parts[0] || '', flag = parts[1] || '', sid = parts.slice(2).join('|');
  spiderWait = { key: key, flag: flag, id: sid, ep: ep, t: epToken() };
  showLoad('正在让爬虫取播放地址…');
  try { VOD.spiderPlay(key, flag, sid); } catch(e){ hideLoad(); setBig('err'); showGest('桥不可用: ' + e); }
}
var spiderWait = null;
function onSpiderPlay(key, jsonStr){
  var d = null;
  try { d = JSON.parse(jsonStr); } catch(e){}
  var w = spiderWait;
  spiderWait = null;
  hideLoad();
  if (!w || w.t !== epToken()) return;              // 用户已经切走了
  if (!d || !d.ok || !d.url) {
    showGest('爬虫没给出播放地址: ' + ((d && d.error) || '未知'));
    autoSwitchSource('spider no url');
    return;
  }
  var ep = w.ep;
  var u = String(d.url || '');
  // ① 蜘蛛说这条要"再解析一次"(parse/jx=1, url 是平台页) —— 以前也强置 ready=true 直接丢给 <video>,
  //    结果是黑屏。这种交给平台解析链路。
  var needParse = (Number(d.parse) === 1 || Number(d.jx) === 1) && !isMediaUrl(u, '', '');
  // ② header 以前只是存进 ep.header, 全文件没人读 —— 带防盗链的爬虫流(要 Referer/Cookie)会 403。
  //    这里把 header 里的 Referer/Cookie 拆出来, 交给本地代理带上(和平台直链同一条通路)。
  var hd = String(d.header || ''), ref = '', ck = '';
  try {
    if (/^\s*\{/.test(hd)) {
      var hj = JSON.parse(hd);
      for (var hk in hj) {
        var hv = String(hj[hk] == null ? '' : hj[hk]);
        if (/^referer$/i.test(hk)) ref = hv;
        else if (/^cookie$/i.test(hk)) ck = hv;
      }
    } else {
      hd.split(/[\r\n]+/).forEach(function(line){
        var m = line.match(/^\s*(Referer|Cookie)\s*:\s*(.+)$/i);
        if (m) { if (/^referer$/i.test(m[1])) ref = m[2].trim(); else ck = m[2].trim(); }
      });
    }
  } catch(e){}
  if (needParse) {
    ep.page = u;
    ep.url = u;
    ep.ready = false;
    ep.cookie = ck || ep.cookie || '';
    playEp(curEp);                                  // 走平台解析(platStart)
    return;
  }
  // 注意: 这里**不能**自己 proxyWrap —— playEp() 才是决定"要不要走本地代理"的唯一地方,
  // 在这里包一层会让 ep.url 变成 127.0.0.1, playEp 就认不出它是 m3u8 了(hls.js 不会被启用)。
  // 正确做法是把 Referer/Cookie 交给 ep, 由 playEp 按同一条规则处理。
  ep.url = u;                                       // 换成真地址(下次直接播)
  ep.referer = ref || ep.referer || '';
  ep.cookie = ck || ep.cookie || '';
  ep.ready = true;
  ep.mime = /\.m3u8/i.test(u) ? 'application/vnd.apple.mpegurl' : (ep.mime || '');
  ep.header = hd;
  playEp(curEp);
}
function onLiveAddSource(name, jsonStr){
  var d = null;
  try { d = JSON.parse(jsonStr); } catch(e){}
  try { PK.toast((d && d.ok ? '✓ ' : '✗ ') + (d && d.msg ? d.msg : '完了')); } catch(e){}
}
/** 我的直播源: 列出用户自己加的直播表, 可删; 加完点「刷新列表」就能看到里面的频道 */
function showUserLiveSources(){
  var cd = document.getElementById('decTools');
  if (!cd) return;
  var list = [];
  try { list = JSON.parse(PK.liveUserSources()); } catch(e){}
  var h = '<div class="pw">自己加的直播源（' + list.length + ' 个）: 加进来就并进频道表，'
        + '点直播页右上角「刷新列表」拉一次即可看到（和内置那几个源一起做探活/记忆）。</div>';
  if (!list.length) h += '<div class="hint">还没有 —— 粘一个 TVBox 配置点「解析并加源」，或直接粘直播表地址用「加入直播源」。</div>';
  for (var i = 0; i < list.length; i++) {
    var uq = jsa(list[i].url);
    h += '<div class="srcrow"><div class="sinfo">📺 ' + esc(list[i].name) + '<br><span class="sapi">'
      + esc(list[i].url) + (list[i].ua ? ('  · UA ' + esc(list[i].ua)) : '') + '</span></div>'
      + '<button class="pbtn" onclick="delUserLive(' + uq + ')">删除</button></div>';
  }
  h += '<div class="skiprow"><button class="pbtn" onclick="refreshLiveList()">刷新直播列表</button>'
     + '<span class="dim" style="font-size:12px">拉一次上游, 把自己的源也并进来</span></div>';
  cd.innerHTML = h;
}
function delUserLive(url){
  try { PK.liveDelSource(url); } catch(e){ PK.toast('桥不可用: ' + e); }
  setTimeout(showUserLiveSources, 400);
}
function refreshLiveList(){
  try { PK.liveRefresh(); PK.toast('正在重新拉频道表…'); } catch(e){ PK.toast('桥不可用: ' + e); }
}
/** 直接粘一个直播表地址加进来(不经 TVBox 配置) */
function delUserSite(key){
  try { VOD.delSite(key); } catch(e){ PK.toast('桥不可用: ' + e); }
  setTimeout(showUserSites, 400);
}
/** 清空"直播线路记忆"(ok/fail/codec 全清) */
function liveForgetPlay(){
  try { PK.liveForget(); PK.toast('已清空直播线路记忆, 下次会重新试'); } catch(e){ PK.toast('桥不可用: ' + e); }
}
function toggleRotate(){
  if (locked) { showGest('已锁定屏幕，先解锁再换方向'); return; }
  var land = false;
  try { land = PK.isLandscape(); } catch(e){}
  try { PK.landscape(!land); } catch(e){}
  var b = document.getElementById('prot');
  if (b) b.textContent = land ? '横屏' : '竖屏';
  showGest(land ? '切回竖屏' : '横屏播放');
  setTimeout(syncRotateBtn, 600);
}
function cycleFit(){
  fitMode = (fitMode + 1) % fitCss.length;
  PS.ratio = fitMode; psSave();
  applyFit();
  psRender();
}
/** 应用画面模式。169/4:3 是按比例算尺寸, native = 按视频原始分辨率居中 */
function applyFit(){
  var v = document.getElementById('video');
  var box = document.getElementById('player');
  var m = fitCss[fitMode] || 'contain';
  v.style.left = ''; v.style.top = ''; v.style.transform = ''; v.style.webkitTransform = '';
  if (m === '169' || m === '43') {
    var ar = m === '169' ? 16/9 : 4/3;
    var bw = (box && box.clientWidth) || 1, bh = (box && box.clientHeight) || 1;
    var w = bw, h = Math.round(bw / ar);
    if (h > bh) { h = bh; w = Math.round(bh * ar); }         // 按比例塞进画面(留黑边)
    v.style.width = w + 'px'; v.style.height = h + 'px';
    v.style.left = Math.max(0, Math.round((bw - w)/2)) + 'px';
    v.style.top = Math.max(0, Math.round((bh - h)/2)) + 'px';
    v.style.right = 'auto'; v.style.bottom = 'auto';
    v.style.objectFit = 'fill';
  } else if (m === 'native') {
    v.style.width = 'auto'; v.style.height = 'auto'; v.style.right = 'auto'; v.style.bottom = 'auto';
    v.style.left = '50%'; v.style.top = '50%';
    v.style.transform = 'translate(-50%,-50%)';
    v.style.webkitTransform = 'translate(-50%,-50%)';
    v.style.objectFit = 'none';
  } else {
    v.style.width = '100%'; v.style.height = '100%';
    v.style.left = '0'; v.style.top = '0'; v.style.right = '0'; v.style.bottom = '0';
    v.style.objectFit = m;
  }
  psRender();                       // 画面比例的显示在「设置」里(#pfit 按钮已经删掉了)
  showGest('画面: ' + fitNames[fitMode]);
}
function syncRotateBtn(){
  var b = document.getElementById('prot');
  if (!b) return;
  try { b.textContent = PK.isLandscape() ? '竖屏' : '横屏'; } catch(e){}
}


/* ---------- 豆瓣评分(选片参考) ---------- */
var lastDoubanAt = 0;
function fetchDouban(list){
  // 豆瓣按 IP 软限流: 列表角标 20 秒内只问一次, 免得翻两页就把整批评分打死。
  // 详情页那次(openDetail)不受这个限制 —— 用户点开哪部片, 那部的评分最重要。
  var now = Date.now();
  if (now - lastDoubanAt < 20000) return;
  lastDoubanAt = now;
  list = list || homeItems.concat(searchItems);
  var names = [], seen = {};
  for (var i = 0; i < list.length && names.length < 12; i++) {   // 12 条: 豆瓣按 IP 软限流, 一次问太多会被整批打死
    var n = list[i].name;
    if (!n || seen[n]) continue;
    seen[n] = 1; names.push(n);
  }
  if (!names.length) return;
  try { PK.douban(JSON.stringify(names), 12); } catch(e){}
}
function onDouban(list){
  if (!list || !list.length) return;
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (!d || !d.rating || d.rating === '0' || d.rating === '0.0') continue;
    var els = document.getElementsByClassName('item');
    for (var j = 0; j < els.length; j++) {
      if (els[j].getAttribute('data-name') !== d.name) continue;
      els[j]._db = d;
      if (!els[j].querySelector('.db')) {
        var sp = document.createElement('div');
        sp.className = 'db';
        sp.textContent = '★ ' + d.rating;
        els[j].appendChild(sp);
      }
    }
  }
  refreshDbRow();
}
function doubanOf(name){
  var els = document.getElementsByClassName('item');
  for (var i = 0; i < els.length; i++) {
    if (els[i].getAttribute('data-name') === name && els[i]._db) return els[i]._db;
  }
  return null;
}
function refreshDbRow(){
  try {
    var box = document.getElementById('dbrow');
    if (!box || !curItem) return;
    var d = doubanOf(curItem.name);
    if (d && d.rating) box.textContent = '豆瓣 ' + d.rating + (d.genres ? (' · ' + d.genres) : '') + (d.intro ? ('  ' + d.intro.slice(0, 46) + '…') : '');
  } catch(e){}
}

/* ---------- 分类表: 用源自己的 class, 之前写死的 1/2/3/4 拿不到内容 ---------- */
function onVodClasses(list){
  var sel = document.getElementById('typeSel');
  if (!sel) return;
  var tops = [], subs = {};
  if (list && list.length) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !c.id) continue;
      if (!c.pid || c.pid === '0') { tops.push(c); }
      else {
        if (!subs[c.pid]) subs[c.pid] = [];
        subs[c.pid].push(c);
      }
    }
  }
  var h = '<option value="">最新更新</option>', n = 0;
  for (var j = 0; j < tops.length; j++) {
    var sub = subs[tops[j].id];
    if (sub && sub.length) {
      h += '<optgroup label="' + esc(tops[j].name) + '">';
      h += '<option value="' + esc(tops[j].id) + '">全部' + esc(tops[j].name) + '</option>';
      for (var k = 0; k < sub.length; k++) h += '<option value="' + esc(sub[k].id) + '">' + esc(sub[k].name) + '</option>';
      h += '</optgroup>';
      n += sub.length + 1;
    } else {
      h += '<option value="' + esc(tops[j].id) + '">' + esc(tops[j].name) + '</option>';
      n++;
    }
  }
  if (n === 0 && list && list.length) {
    for (var m = 0; m < list.length; m++) {
      if (!list[m] || !list[m].id) continue;
      h += '<option value="' + esc(list[m].id) + '">' + esc(list[m].name) + '</option>';
      n++;
    }
  }
  sel.innerHTML = h;
  sel.disabled = (n === 0);
  // 刚"设为首选/切源"过: 分类表已就位, 现在才拉首页 —— 以前 pickSite 里立刻 reloadHome(),
  // 用的是**旧源**的 typeId, 新源当然返回空, 用户看到的就是"设为首选不生效"
  if (pendingPick) {
    pendingPick = false;
    clearTimeout(pickTimer);
    try { $("typeSel").value = ''; } catch(e){}
    reloadHome();
  }
}


/* ---------- 缓冲/骨架 ---------- */
function showLoad(txt){
  var el = document.getElementById('pload');
  if (!el) return;
  var t = document.getElementById('ploadtxt');
  if (t && txt) t.textContent = txt;
  el.className = 'on';
  document.getElementById('pbig').style.display = 'none';
  loading = true;
  showUI();
  clearTimeout(uiTimer);   // 缓冲期间不自动隐藏控件, 保证能点返回
}
function hideLoad(){
  var el = document.getElementById('pload');
  if (el) el.className = '';
  var was = loading;
  loading = false;
  // 缓冲结束 -> 把自动隐藏重新装回去, 不然一次 waiting 就能把控件永久留在屏幕上
  if (was && !locked) { clearTimeout(uiTimer); uiTimer = setTimeout(hideUI, 2500); }
}
function skeleton(n){
  var h = '';
  for (var i = 0; i < n; i++) h += '<div class="item"><div class="pic skel"></div><div class="nm skel2"></div></div>';
  return h;
}

function onOrientation(land){
  var b = document.getElementById('prot');
  if (b) b.textContent = land ? '竖屏' : '横屏';
}

/* ---------- 无感自动换源: 源失效/超时 -> 自动切下一个源并保持当前集 ---------- */
var failedSrc = {}, autoSwitching = false, failWatch = null;
var playedOk = false;   // 当前集是否已经出过画面
/* 停滞看门狗: 光看"有没有出过画面"不够 —— 源可能出个首帧就冻住(黑屏/转圈不再动)。
   这里每 2 秒比一次 currentTime, 只要"没暂停、没在拖、也没解码报错"却长时间不往前走,
   就认定这条源废了, 自动换下一条(直播=换线路)。阈值就用设置里的「连接超时」。 */
var stallTimer = null, stallAt = 0, stallTime = -1, stallTried = {};
function clearStallWatch(){ if (stallTimer) { clearInterval(stallTimer); stallTimer = null; } }
function startStallWatch(){
  clearStallWatch();
  stallAt = Date.now(); stallTime = -1;   // stallTried 不清: 它记的是"这次播放里卡过哪些源", 见 onVodDetail
  stallTimer = setInterval(function(){
    try {
      var v = document.getElementById('video');
      var pl = document.getElementById('player');
      if (!v || !pl) { clearStallWatch(); return; }
      if (('' + pl.className).indexOf('on') < 0) { clearStallWatch(); return; }   // 玩家关了
      if (v.paused || v.seeking || locked || anySheetOpen()) { stallAt = Date.now(); stallTime = v.currentTime; return; }
      if (v.currentTime > stallTime + 0.2) { stallTime = v.currentTime; stallAt = Date.now(); return; }
      var lim = Math.max(8000, (PS.to || 12) * 1000);
      if (Date.now() - stallAt < lim) return;
      stallAt = Date.now();
      stallTried[srcIdx] = 1;                       // 这条源卡过: 本次播放里不再回头选它
      if (curItem && curItem.live) {                // 直播: 换下一条线路
        autoSwitchSource('直播卡住不动', true);
        return;
      }
      var keep0 = (curItem && curItem.eps && curItem.eps[curEp]) ? curItem.eps[curEp].name : '';
      var target = pickSwitchSource(srcIdx, keep0);
      if (target < 0) { showGest('这条源卡住不动, 没有同一集的备用源了'); clearStallWatch(); return; }
      autoSwitchSource('卡住不动', true);
    } catch(e) { clearStallWatch(); }
  }, 2000);
}
function clearFailWatch(){ if (failWatch) { clearTimeout(failWatch); failWatch = null; } }
/** 播放开始后盯 12 秒: 没画面/没进展就认定这条线路失效 */
function watchPlayback(){
  clearFailWatch();
  failWatch = setTimeout(function(){
    var v = document.getElementById('video');
    if (!v) return;
    var ok = (v.readyState >= 2 && v.currentTime > 0.3) || v.videoWidth > 0;
    if (ok || Date.now() - liveSwitchAt < 2000) return;   // 刚换过线路: 给它时间起画面
    autoSwitchSource('超时无画面');
  }, Math.max(8000, (PS.to || 12) * 1000));
}
/**
 * 央视官网页面把流要出来了(Java 在隐藏 WebView 的网络层截到的)。
 * 这条相当于"官网亲自给的线路", 排在最前面直接播。
 */

/**
 * 把"这条直播线路的真实结果"告诉 Java 记住: ok=播出画面了 / fail=播不动 / codec=本机解不了码。
 * 同一条线路每种结果只报一次(不然每 4 秒的分片都来一记)。
 */
function liveReport(kind){
  if (!curItem || !curItem.live) return;
  var u = (curItem.liveOrig || [])[curEp];
  if (!u) return;
  if (!curItem.liveDone) curItem.liveDone = {};
  var key = kind + ':' + curEp;
  if (curItem.liveDone[key]) return;
  curItem.liveDone[key] = 1;
  try { PK.livePlay(u, kind); } catch(e){}
}
/** 当前这条 HLS 的编码, 系统 WebView 支不支持(拿不到信息时按"支持"处理, 别误判) */
function codecSupported(){
  try {
    if (!hls || !hls.levels || !hls.levels.length) return true;
    if (!window.MediaSource || !MediaSource.isTypeSupported) return true;
    var lv = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : 0] || hls.levels[0];
    var vc = (lv && lv.videoCodec) || (lv && lv.attrs && lv.attrs.CODECS) || '';
    if (!vc) return true;
    var parts = String(vc).split(',');
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i].trim();
      if (!c) continue;
      if (c.indexOf('avc1') === 0 || c.indexOf('mp4a') === 0) continue;      // 最常见的两种, 直接放行
      var mime = (c.indexOf('mp4a') === 0) ? 'audio/mp4' : 'video/mp4';
      if (!MediaSource.isTypeSupported(mime + '; codecs="' + c + '"')) return false;
    }
    return true;
  } catch(e) { return true; }
}

/**
 * 直播线路自动切换: 顺着 eps 往下试, 全试完再报错。
 *
 * 必须节流: hls.js 一条线出错时会连着抛好几个致命错误(网络、清单、分片), 以前每个都触发
 * 一次换线路 —— 一秒钟内就能把 12 条线路刷完, 看着就是"死循环不停换"。现在:
 *   · 1.5 秒内只换一次;
 *   · 一分钟内最多换 eps.length+2 次(真的都试过了就停下来报错, 不再空转)。
 */
var liveSwitchAt = 0, liveSwitchN = 0, liveSwitchFrom = 0;
function liveNextLine(reason){
  if (!curItem || !curItem.live || !curItem.eps || !curItem.eps.length) return;
  var now = Date.now();
  if (now - liveSwitchFrom > 60000) { liveSwitchN = 0; liveSwitchFrom = now; }
  if (now - liveSwitchAt < 1500) return;                       // 同一波错误只换一次
  if (liveSwitchN >= curItem.eps.length + 2) {
    setBig('err');
    hideLoad();
    showGest('这个频道的线路都播不动（换个频道试试）');
    return;
  }
  liveSwitchAt = now;
  liveSwitchN++;
  // 用局部变量算"下一条", 再写回 curItem.liveTry(playEp 里也会同步) —— 免得以后有人在这里
  // 又多写一次 ++, 变成 0→1→3→5 跳着试、一半线路没试到就报"都播不动"
  var next = (curItem.liveTry == null ? 0 : curItem.liveTry + 1);
  if (next >= curItem.eps.length) {
    setBig('err');
    hideLoad();
    showGest('这个频道 ' + curItem.eps.length + ' 条线路都放不动 —— 可能不是源的问题, 而是本机 WebView 解不了它的编码(H.265/AC-3 这类): 在「选集」里点「用其它播放器打开」交给 VLC/MX/EXO 试试');
    return;
  }
  liveReport('fail');                      // 这条试过了不通 -> 记下来(连续两次就不再自动试它)
  curItem.liveTry = next;
  showGest('线路 ' + (next + 1) + ' 不通' + (reason ? ('(' + reason + ')') : '') + '，换下一条…');
  playEp(next);
}
/** 自动换源(用户无感): 标记坏源, 找下一个可用源, 保持当前集继续播 */
/**
 * 挑"下一条还能试的源": 跳过已失败的、以及本次播放里已经卡住过的; 都试完返回 -1。
 * 抽成纯函数是为了能在 urlcheck 里真跑(以前这段内联在 autoSwitchSource 里, 只能靠眼睛看)。
 */
/**
 * 挑一个"可以切过去"的备用源: 同一部剧 + 真有当前这一集 + 没失败/没卡过。
 * 找不到返回 -1 —— 调用方必须**留在当前线路**, 不许退而求其次去播别的剧或第 1 集。
 */
function pickSwitchSource(cur, keepName){
  var list = srcList || [];
  var blocked = {};                       // 本轮里"剧名/集号对不上"的源: 临时当失败, 让纯函数跳过它们
  for (var n = 0; n < list.length; n++) {
    var failed2 = {};
    for (var f in failedSrc) failed2[f] = failedSrc[f];
    for (var b in blocked) failed2[b] = true;
    var idx = nextPlayableSrc(cur, list, failed2, stallTried);   // 纯函数: 轮转 + 跳过失败/卡过的
    if (idx < 0) return -1;
    var s = list[idx];
    if (s && sameTitle(s.name, curItem ? curItem.name : '')
        && (!keepName || epIndexOf(s.eps, keepName) >= 0)) return idx;
    blocked[idx] = true;                 // 别的剧 / 没有这一集 -> 绝不切过去
  }
  return -1;
}
function nextPlayableSrc(cur, list, failed, tried){
  list = list || [];
  for (var k = 1; k < list.length; k++) {
    var idx = (cur + k) % list.length;
    if (!(failed && failed[idx]) && !(tried && tried[idx])) return idx;
  }
  return -1;
}
function autoSwitchSource(reason, force){
  // 出过画面就不再自动换源 —— 但"卡住不动"是例外(force): 画面冻在那儿不动, 用户想看下一源
  if (playedOk && !force) { clearFailWatch(); return; }
  if (!PS.autoSw) {                             // 设置里关了自动换线路: 只提示, 不动画面
    clearFailWatch();
    showGest('这条线路播不动（自动换线路已关, 可在设置里打开）');
    return;
  }
  // 直播: 备用线路在 eps 里(就是"选集"那几条), 直接自动换下一条 —— 以前这里会走到
  // "没有备用源"就放弃, 于是"点频道播不动"看着像播放器坏了
  if (curItem && curItem.live) {
    clearFailWatch();
    liveNextLine(reason);
    return;
  }
  if (autoSwitching) return;
  if (!srcList || srcList.length < 2) {
    showGest('这条线路播不动, 且没有备用源');
    return;
  }
  failedSrc[srcIdx] = true;
  var keepName = (curItem && curItem.eps && curItem.eps[curEp]) ? curItem.eps[curEp].name : '';
  // 2026-10 修: 备选源必须是**同一部剧**、而且**真有这一集** —— 用户报的"遇到广告马上跳成其他剧/
  // 回到第 1 集"就是这里: 换源列表里混进了「交锋联盟之机巧一族」「权力交锋」, 一卡就切过去;
  // 找不到同名集时老的写法还会 target=0 直接播第 1 集。
  var next = pickSwitchSource(srcIdx, keepName);
  if (next < 0) {
    clearStallWatch();
    showGest('没有"同一集"的备用源了, 留在当前线路');
    return;
  }
  autoSwitching = true;
  var lockItem = curItem;                       // 600ms 里用户可能已经切到别的剧了
  showGest('线路失效, 自动换源…');
  setTimeout(function(){
    try {
      if (curItem !== lockItem) { autoSwitching = false; return; }   // 换剧了: 别抢播
      var old = srcIdx;
      srcIdx = next;
      renderDetail();                       // 重新渲染详情(会重置 curEp)
      var target = keepName ? epIndexOf(curItem && curItem.eps, keepName) : 0;
      if (target < 0) {                     // 这一源没有同一集: 退回原线路, 绝不跳集/跳剧
        srcIdx = old;
        renderDetail();
        autoSwitching = false;
        showGest('这个备用源没有这一集, 留在当前线路');
        return;
      }
      playEp(target);                       // 接着播同一集
      failedSrc[next] = false;
      stallTried[next] = 1;                 // 这一源是"试过"的, 别再为停滞反复切
    } catch (e) { }
    autoSwitching = false;
  }, 600);
}

/* 后台补来的备选源: 静默追加, 不打断当前播放 */
// Java 是"主源先给界面、备选源几十秒后再补"(detailSmart 之后才找), 期间用户很可能已经换了剧 ——
// 所以它把片名一起回传, 这里必须比对: 否则上一部剧的源会混进这部片的线路表, 失效时还会切到别的剧去
/** 片名宽松比对: "异人旅馆第二季" / "异人旅馆 第二季" / "异人旅馆" 都算同一部。
 *  严格 == 会把半夜才回来的备选源全丢掉(名字里多个空格就没了)。 */
function sameTitle(a, b){
  // 2026-10 修(用户报"遇到广告就跳成其他剧"): 原来是"一方包含另一方就算同一部" —— 于是
  // 「交锋」把「交锋联盟之机巧一族」「权力交锋」全当成了同一部, 它们混进换源列表, 一卡就切过去。
  // 现在只允许**季/部/年份**这类真正的附属差异:
  //   庆余年 ↔ 庆余年第一季 ✓    交锋 ↔ 交锋2026 ✓
  //   交锋 ↔ 交锋联盟之机巧一族 ✗  交锋 ↔ 权力交锋 ✗
  var f = function(x){
    return String(x == null ? '' : x)
      .replace(/[\s·:：\-—()（）\[\]【】。.!！?？,，]/g, '')
      .replace(/第[一二三四五六七八九十0-9]+[季部]/g, '')
      .replace(/(全集|完结|国语|粤语|日语|英语|中字|中文字幕|高清|超清|蓝光|4K|HDR)/gi, '');
  };
  var x = f(a), y = f(b);
  if (!x || !y) return false;
  if (x === y) return true;
  var long = x.length >= y.length ? x : y, short = x.length >= y.length ? y : x;
  var atHead = long.indexOf(short) === 0;
  var atTail = long.lastIndexOf(short) === long.length - short.length;
  if (!atHead && !atTail) return false;
  var rest = atHead ? long.slice(short.length) : long.slice(0, long.length - short.length);
  // 只允许"年份(2~4 位数字)/季/部/上下"这类尾巴
  return /^(\d{2,4}|[一二三四五六七八九十季部上下]{1,3})$/.test(rest);
}
/** 集名归一: "第01集" "第1集" "EP01" "01" 视为同一集(不同源的写法不一样) */
function epKey(n){
  return String(n == null ? '' : n).toLowerCase()
    .replace(/[\s第集话回期]/g, '').replace(/^(ep|e)\.?/,'').replace(/^0+(?=\d)/, '');
}
function epIndexOf(eps, name){
  if (!name) return -1;
  var want = epKey(name);
  for (var i = 0; i < (eps || []).length; i++) if (epKey(eps[i].name) === want) return i;
  return -1;
}
/** 备选源到手: 并进 srcList, 并让已经打开的「换源」面板/详情页源标签立刻反映出来 */
function onMoreSources(name, list){
  altBusy = false; clearTimeout(altTimer);
  if (!curItem || !sameTitle(name, curItem.name)) return;
  if (!list || !list.length) { if (sheetOn('qlist')) fillQuality(); return; }
  var added = 0;
  for (var i = 0; i < list.length; i++) {
    var it = list[i], dup = false;
    for (var j = 0; j < srcList.length; j++) if (srcList[j].site === it.site) dup = true;
    if (!dup) { srcList.push(it); added++; }
  }
  detailSrcCount = srcList.length;
  refreshSrcUi();
  try { PK.toast(added ? ("找到 " + added + " 个其它源, 点「换源」可切") : "没找到其它源"); } catch(e){}
}
/** 源列表变了以后刷新界面(不重置当前集: renderDetail 会把 curEp 归零, 播放中绝不能调) */
function refreshSrcUi(){
  if (sheetOn('qlist')) fillQuality();
  var v = document.getElementById('v-detail');
  if (!v || srcList.length < 2) return;
  var html = '';
  for (var i = 0; i < srcList.length; i++)
    html += '<button class="' + (i === srcIdx ? 'on' : '') + '" onclick="switchSrc(' + i + ')">' + esc(srcList[i].siteName) + '</button>';
  var chips = v.querySelector('.chips');
  if (chips) { chips.innerHTML = html; return; }
  var head = v.querySelector('.dhead');
  if (head && head.parentNode) {
    var d = document.createElement('div');
    d.className = 'chips'; d.innerHTML = html;
    head.parentNode.insertBefore(d, head);
  }
}
var altBusy = false, altTimer = null;
/** 「换源」面板里的手动搜索(后台那次没回来/没搜到时的第二次机会) */
function requestMoreSources(){
  if (!curItem || !curItem.name) { try { PK.toast('还没有正在看的片子'); } catch(e){} return; }
  if (!VOD.moreSources) { try { PK.toast('这个版本不支持搜索其它源'); } catch(e){} return; }
  if (altBusy) { try { PK.toast('正在搜索其它源…'); } catch(e){} return; }
  altBusy = true;
  if (sheetOn('qlist')) fillQuality();
  try { VOD.moreSources(curItem.name, curItem.site); }
  catch(e) { altBusy = false; try { PK.toast('桥不可用: ' + e); } catch(e2){} return; }
  clearTimeout(altTimer);
  altTimer = setTimeout(function(){
    if (!altBusy) return;
    altBusy = false;
    if (sheetOn('qlist')) fillQuality();
    try { PK.toast('没搜到其它源(可能只有这个源有这部)'); } catch(e){}
  }, 15000);
}

/* ---------- 更新页 ---------- */
function showUpdate(){
  if (WEB) return;                       // 网页版: 刷新即最新, 没有"应用内更新"这回事
  show('v-update');
  try {
    var v = document.getElementById('updVer');
    if (v) v.textContent = '版本 ' + PK.appVersion();
  } catch(e){}
  renderUpdAuto();
  // 进来先给一句"现在是什么状态" —— 以前不点「检查更新」时正文是空白的, 看着像"这页没内容"
  var note = document.getElementById('updNote'), body = document.getElementById('updBody');
  if (note && !String(note.textContent || '').trim()) {
    note.textContent = '检查一下有没有新版本（启动时也会静默查一次）';
  }
  if (body && !String(body.innerHTML || '').trim()) {
    body.innerHTML = '<div class="pw">当前版本 <b>' + esc(PK.appVersion()) + '</b>。'
      + '点上面的「检查更新」会去 Gitee releases 读清单（读不到会直连 CDN 兜底），'
      + '有新版本会显示版本号、更新说明和「下载并安装」。</div>';
  }
  if (autoUpdOn()) setTimeout(function(){ checkUpdate(true); }, 200);   // 进来就真查一次(手动模式: 结果一定会显示)
}

/* ---------- 看电视直播(频道表来自 collect/Live.java; 打开软件就自动拉最新的) ---------- */
var liveGroups = [], liveCur = [], liveGroup = '', liveSwapped = false;
var liveFind = '', liveAll = null;          // liveFind: 搜索词; liveAll: 全部分组的频道(给跨分组换台用)
var livePend = '';                          // 正在等探活结果的频道名(归属校验用)
function liveFavs(){
  try { return JSON.parse(localStorage.getItem('pk_live_fav') || '[]') || []; } catch(e){ return []; }
}
function liveFavHas(n){ var f = liveFavs(); for (var i=0;i<f.length;i++) if (f[i] === n) return true; return false; }
function liveFavToggle(n, ev){
  if (ev && ev.stopPropagation) ev.stopPropagation();
  var f = liveFavs(), i = f.indexOf(n);
  if (i >= 0) f.splice(i, 1); else f.unshift(n);
  try { localStorage.setItem('pk_live_fav', JSON.stringify(f.slice(0, 200))); } catch(e){}
  try { PK.toast(i >= 0 ? ('已取消收藏 ' + n) : ('已收藏 ' + n)); } catch(e){}
  // 只重画当前列表就行 —— 以前这里写了 `livePickGroup(liveGroup === '__fav__' ? -1 : -1)`,
  // 两个分支都是 -1, 于是"在某个分组里点个星"会被踢回「全部」(逻辑写错了)
  renderLiveChannels(liveGroup);
}
function liveSearch(v){
  liveFind = String(v || '').trim().toLowerCase();
  renderLiveChannels(liveGroup);
}
function liveLastGet(){ try { return JSON.parse(localStorage.getItem('pk_live_last') || 'null'); } catch(e){ return null; } }
function liveLastSet(name, group){ try { localStorage.setItem('pk_live_last', JSON.stringify({ n: name, g: group || '' })); } catch(e){} }
function renderLiveLastBar(){
  var box = document.getElementById('liveLastBar');
  if (!box) return;
  var last = liveLastGet();
  if (!last || !last.n) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = '<button class="ghost mini" onclick="liveResume()">继续看: ' + esc(last.n) + '</button>';
}
function liveResume(){
  var last = liveLastGet();
  if (!last || !last.n) return;
  if (last.g) { liveGroup = last.g; renderLiveGroupChips(); renderLiveChannels(liveGroup); }
  for (var i = 0; i < liveCur.length; i++) if (liveCur[i].n === last.n) { playLive(i); return; }
  // 当前分组没有: 到全部频道里找
  var all = liveAllChannels();
  // 这里必须传对象而不是下标: all[] 是"全部频道"的顺序, 而 liveCur 已经按分组/搜索/倒序/测速重排过,
  // 拿 all 的下标去点 liveCur 会播到别的台(或者直接越界没反应)。
  for (var k = 0; k < all.length; k++) if (all[k].n === last.n) {
    liveGroup = all[k].g || ''; renderLiveGroupChips(); renderLiveChannels(liveGroup); playLive(-1, all[k]); return;
  }
  try { PK.toast('上次那个频道现在列表里没有了'); } catch(e){}
}
/** 全部分组的频道(跨分组换台/找频道用), 取回来缓存 */
function liveAllChannels(){
  if (liveAll) return liveAll;
  try { liveAll = JSON.parse(PK.liveChannels('')) || []; } catch(e){ liveAll = []; }
  return liveAll;
}
/** 换台: dir=+1 下一台 / -1 上一台; 跨分组(参考 TVBox 的 live_cross_group) */
function liveZap(dir){
  var name = curItem ? curItem.name : '';
  var all = (PS.cross || liveFind) ? liveAllChannels() : null;
  if (!all || !all.length) {
    // 不跨分组: 只在当前列表里前后挪
    var idx = -1;
    for (var i = 0; i < liveCur.length; i++) if (liveCur[i].n === name) idx = i;
    if (idx < 0) { try { PK.toast('先选个频道'); } catch(e){} return; }
    var j = idx + dir;
    if (j < 0 || j >= liveCur.length) { try { PK.toast(dir > 0 ? '已经是最后一个频道' : '已经是第一个频道'); } catch(e){} return; }
    playLive(j); return;
  }
  var at = -1;
  for (var k = 0; k < all.length; k++) if (all[k].n === name) { at = k; break; }
  if (at < 0) { try { PK.toast('先选个频道'); } catch(e){} return; }
  for (var step = 1; step <= all.length; step++) {
    var t = at + dir * step;
    if (t < 0 || t >= all.length) t = (t + all.length) % all.length;      // 循环换台
    if (all[t] && all[t].n !== name) { if (all[t].g) liveGroup = all[t].g; playLive(-1, all[t]); return; }
  }
}
function liveZapNext(){ liveZap(1); }
function liveZapPrev(){ liveZap(-1); }
function showLive(){
  show('v-live');
  renderLiveFromCache();                  // 先把缓存画出来, 页面立刻有东西
  try { PK.liveAuto(); } catch(e){}       // 顺手在后台检查/更新(用户不用点任何东西)
}
function renderLiveFromCache(){
  var meta = null, tag = document.getElementById('liveMeta');
  try { meta = JSON.parse(PK.liveMeta()); } catch(e){}
  var gs = (meta && meta.groups) || [];
  if (typeof gs === 'string') { try { gs = JSON.parse(gs); } catch(e){ gs = []; } }   // 防"分组名显示 undefined"
  liveGroups = gs || [];
  if (tag) {
    if (meta && meta.ok) {
      var d = new Date(meta.ts || 0), p = function(n){ return (n < 10 ? '0' : '') + n; };
      // 源可能有十来个, 顶栏只报"几个源", 名字塞进 title(长按/悬停能看到)
      var arr = String(meta.tags || '').split('+').filter(function(x){ return x; });
      tag.textContent = meta.count + ' 个频道 · ' + (d.getMonth() + 1) + '-' + d.getDate()
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + (arr.length ? (' · ' + arr.length + ' 个源') : '');
      tag.title = arr.join(' / ');
      var hint = document.getElementById('liveHint');
      if (hint && arr.length) hint.textContent = '本次频道表合并了 ' + arr.length + ' 个源: '
        + arr.join(' / ') + '。点频道会先在你本机网络上探活它的线路, 通了的那条直接播。';
    } else {
      tag.textContent = '还没有频道表';
    }
  }
  renderLiveGroupChips();
  renderLiveChannels(liveGroup);
  renderLiveLastBar();
}
function renderLiveGroupChips(){
  var box = document.getElementById('liveGroups');
  if (!box) return;
  var h = '<button class="' + (liveGroup === '__fav__' ? 'on' : '') + '" onclick="livePickFav()">★ 收藏</button>'
    + '<button class="' + (liveGroup === '' ? 'on' : '') + '" onclick="livePickGroup(-1)">全部</button>';
  for (var i = 0; i < liveGroups.length; i++) {
    var g = liveGroups[i];
    h += '<button class="' + (liveGroup === g.name ? 'on' : '') + '" onclick="livePickGroup(' + i + ')">'
      + esc(g.name) + ' ' + g.n + '</button>';
  }
  box.innerHTML = h;
}
function livePickGroup(i){
  liveGroup = (typeof i === 'number' && i >= 0 && liveGroups[i]) ? liveGroups[i].name : '';
  renderLiveGroupChips();
  renderLiveChannels(liveGroup);
}
function livePickFav(){ liveGroup = '__fav__'; renderLiveGroupChips(); renderLiveChannels(liveGroup); }
function renderLiveChannels(group){
  var box = document.getElementById('liveList');
  if (!box) return;
  var arr = [];
  try { arr = JSON.parse(PK.liveChannels(group || '')); } catch(e){ arr = []; }
  liveCur = arr || [];
  // 测过速了就重排一次: 能播的排最前, 没测过的中间, 测过但连不上的垫底(稳定排序, 不打乱同组内原有次序)
  // 搜索: 按频道名过滤(1700 多个频道, 没有搜索等于大海捞针)
  if (liveFind) {
    var hit = [];
    for (var q = 0; q < liveCur.length; q++) {
      var nm = String(liveCur[q].n || '').toLowerCase();
      if (nm.indexOf(liveFind) >= 0) hit.push(liveCur[q]);
    }
    liveCur = hit;
  }
  // 收藏分组: 只留收藏过的
  if (liveGroup === '__fav__') {
    var favs = liveFavs(), keep = [];
    for (var w = 0; w < liveCur.length; w++) if (favs.indexOf(liveCur[w].n) >= 0) keep.push(liveCur[w]);
    liveCur = keep;
  }
  if (PS.desc && liveCur.length > 1) liveCur = liveCur.slice().reverse();
  if (liveSwapped && liveCur.length > 1) {
    var dec = [];
    for (var i = 0; i < liveCur.length; i++) {
      var cc = liveCur[i], s2 = (cc.pr > 0) ? (((cc.dp || 0) > 0 || (cc.ok || 0) > 0) ? 2 : 0) : 1;
      dec.push({ i: i, c: cc, s: s2 });
    }
    dec.sort(function(x, y){ return (y.s - x.s) || (x.i - y.i); });
    var sorted = [];
    for (var k = 0; k < dec.length; k++) sorted.push(dec[k].c);
    liveCur = sorted;
  }
  if (!liveCur.length) {
    if (liveFind) box.innerHTML = '<div class="empty">没搜到「' + esc(liveFind) + '」</div>';
    else if (liveGroup === '__fav__') box.innerHTML = '<div class="empty">还没有收藏频道 —— 点频道右边的 ☆ 收藏</div>';
    else box.innerHTML = '<div class="empty">还没有频道表 —— 点右上角「刷新列表」拉一份，或者直接等 App 自动更新</div>';
    return;
  }
  var h = '', shown = 0, cap = group ? 100000 : 400;   // 「全部」一千多个频道: 老内核一次画几千行会卡, 截前 400 个
  for (var i = 0; i < liveCur.length && shown < cap; i++, shown++) {
    var c = liveCur[i];
    var ch = String(c.n || '?').replace(/[\[\]（）()·]/g, '').slice(0, 1) || '?';
    // 探过的频道直接告诉你"这个网能不能看": 绿=有能播的线, 灰=连不上, 没测过=只报条数
    var pr = c.pr || 0, okN = c.ok || 0, stat;
    if (c.good > 0) {                       // 播放记忆: 上次在这台机器上真播出过画面
      stat = '<span class="srate" style="color:#39d98a">✓ 上次能播' + (c.x > 0 ? (' · 清理 ' + c.x) : '') + '</span>';
    } else if (pr > 0) {
      stat = okN > 0 ? ('<span class="srate" style="color:#39d98a">✓ ' + okN + ' 条可播</span>')
                     : ('<span class="srate" style="color:#8a8f98">本机网络连不上</span>');
    } else {
      stat = '<span class="srate">' + ((c.u && c.u.length) || 0) + ' 线路</span>';
    }
    var isFav = liveFavHas(c.n);
    h += '<div class="srow" onclick="playLive(' + i + ')">'
      + '<span class="smark ok" style="width:22px">' + esc(ch) + '</span>'
      + '<span class="sname">' + esc(c.n) + '</span>'
      + stat
      + '<span class="fav' + (isFav ? ' on' : '') + '" onclick="liveFavToggle(' + jsa(c.n) + ',event)">' + (isFav ? '★' : '☆') + '</span></div>';
  }
  box.innerHTML = h;
  if (shown < liveCur.length) box.innerHTML += '<div class="hint">共 ' + liveCur.length
    + ' 个频道，这里只列前 ' + shown + ' 个 —— 点上面的分组看全部</div>';
}
/** 点频道 = 先探活它那几条线(并发, 很快), 通了的那条直接播; 探完的结果会缓存 6 小时 */
var liveWait = {}, liveSeq = 0;
function playLive(i, obj){
  var c = obj || liveCur[i];
  if (!c || !c.u || !c.u.length) return;
  liveLastSet(c.n, c.g || liveGroup);        // 记"上次看的频道"(参考 TVBox 的 last_live_channel_name)
  renderLiveLastBar();
  var urls = [];
  for (var k = 0; k < c.u.length && urls.length < 8; k++) {
    var u = String(c.u[k] || '');
    if (/^https?:\/\//i.test(u) && urls.indexOf(u) < 0) urls.push(u);
  }
  if (!urls.length) { PK.toast('这个频道没有浏览器能播的地址'); return; }
  // 播放记忆: 上次这台机器上**真播出过画面**的那条, 直接播, 不再一条条探(用户等的就是这一下)
  var best = String(c.best || '');
  if (best && urls.indexOf(best) > 0) { urls.splice(urls.indexOf(best), 1); urls.unshift(best); }
  if (c.good > 0 && best) {
    startLiveChannel(c.n, urls, [{ u: best, ok: true, d: true, k: 'm3u8', c: 200, ms: 0 }], 1, '');
    try { PK.toast('按上次的成功记录直接播' + (c.x > 0 ? ('（已自动清掉 ' + c.x + ' 条无效线路）') : '')); } catch(e){}
    return;
  }
  if (urls.length === 1) {
    // 只有一条也要探一次: 地址可能没有 .m3u8 后缀, 不探就不知道它是 HLS,
    // 交给 <video> 直连必然黑屏(单条探测成本极低)
    var id1 = 'lv' + (++liveSeq);
    livePend = c.n;
    liveWait[id1] = { name: c.n, urls: urls };
    try { PK.liveProbe(id1, JSON.stringify(urls)); } catch(e){ startLiveChannel(c.n, urls, []); }
    return;
  }
  var id = 'lv' + (++liveSeq);
  livePend = c.n;                            // 记下"用户现在等的是这个频道", 探活回来看对得上才播
  liveWait[id] = { name: c.n, urls: urls };
  try { PK.toast('正在探测 ' + urls.length + ' 条线路…'); } catch(e){}
  try { PK.liveProbe(id, JSON.stringify(urls)); }
  catch(e){ onLiveProbe(id, '[]'); }
}
function onLiveProbe(id, json){
  var w = liveWait[id];
  if (!w) return;
  // 归属校验: 探活要 1~4 秒, 期间用户可能已经点了别的频道 —— 那时这份结果不能抢画面
  // (onLiveDeep 一直有这个判断, 这里漏了, 两条回调前后不一致)
  if (livePend !== w.name) { delete liveWait[id]; return; }
  var res = [];
  try { res = JSON.parse(json) || []; } catch(e){ res = []; }
  var byUrl = {}, deep = [], ok = [], bad = [];
  for (var i = 0; i < res.length; i++) {
    if (!res[i] || !res[i].u) continue;
    byUrl[res[i].u] = res[i];
    if (res[i].d) deep.push(res[i]);            // 上一轮深探过、实测能出画面的
    else if (res[i].ok) ok.push(res[i]);
    else bad.push(res[i]);
  }
  for (var k = 0; k < w.urls.length; k++) {
    if (!byUrl[w.urls[k]]) bad.push({ u: w.urls[k], ok: false, k: '', c: 0, ms: 0 });
  }
  // 实测能播的排最前, 其次"清单通"(优先 m3u8), 最后才是连不上的
  ok.sort(function(a, b){ return (a.k === 'm3u8' ? 0 : 1) - (b.k === 'm3u8' ? 0 : 1); });
  var order = deep.concat(ok, bad);
  var n = deep.length + ok.length;
  startLiveChannel(w.name, w.urls, order, n, id);   // 先播起来(不等深探)
}
/**
 * 深探结果回来了: 这时"清单在、分片早没了"的假活线路已经被判掉。
 * 还在等画面就立刻换到实测能播的那条; 已经有画面了就不动它, 只把标记补上。
 */
function onLiveDeep(id, json){
  var w = liveWait[id];
  delete liveWait[id];                        // 无论后面怎么返回都要清掉, 否则这个表会越积越多
  if (!w) return;
  if (!curItem || !curItem.live || curItem.name !== w.name || !curItem.eps) return;
  var res = [];
  try { res = JSON.parse(json) || []; } catch(e){ return; }
  var deep = {}, any = false;
  for (var i = 0; i < res.length; i++) {
    if (res[i] && res[i].u && res[i].d) { deep[res[i].u] = 1; any = true; }
  }
  if (!any) return;
  var orig = curItem.liveOrig || [];
  for (var k = 0; k < curItem.eps.length; k++) {
    if (deep[orig[k]] && curItem.eps[k].name.indexOf('✓✓') < 0) curItem.eps[k].name += ' ✓✓';
  }
  if (playedOk) { fillPlaylist(); return; }        // 已经有画面: 不打扰
  for (var k = 0; k < curItem.eps.length; k++) {
    if (deep[orig[k]]) {
      if (k !== curEp) {
        curItem.liveTry = k;
        liveSwitchAt = 0; liveSwitchN = 0; liveEndHits = 0;
        try { PK.toast('换到实测能播的线路' + (k + 1)); } catch(e){}
        playEp(k);
      }
      return;
    }
  }
  fillPlaylist();
  // 一条都没实测通: 明确告诉用户"这个频道这会儿不通", 别让它一直转圈
  if (curItem.name === w.name) {
    try { PK.toast('这个频道的线路都不通：源那边可能没在播, 或在你的网络/运营商走不通'); } catch(e){}
  }
}
/**
 * 把当前这条线路交给系统里别的播放器(VLC/MX/EXO 壳)打开。
 * 本机 WebView 解不了 H.265/AC-3 这类编码时, 这是唯一能继续看的办法 —— 也能帮用户分清
 * "是源坏了"还是"是本机播放器放不了"。
 */
function openExternal(){
  if (WEB) { try { PK.toast('网页版不支持调起外部播放器'); } catch(e){} return; }
  var u = (curItem && curItem.liveOrig) ? curItem.liveOrig[curEp] : '';
  if (!u && curItem && curItem.eps && curItem.eps[curEp]) u = curItem.eps[curEp].url;
  if (!u) { PK.toast('还没有可交出去的地址'); return; }
  var mime = (curItem && curItem.eps && curItem.eps[curEp] && curItem.eps[curEp].mime) || '';
  try { PK.openExternal(u, mime, (curItem ? curItem.name : '')); }
  catch(e){ PK.toast('桥不可用: ' + e); }
}
function onExternalFail(msg){ try { PK.toast('没打开: ' + msg); } catch(e){} }
/** 用现有播放器播一个直播频道(多条线路进「选集」, 播不动就自动换下一条) */
function startLiveChannel(name, urls, probe, okN, id){
  curItem = { name: name, siteName: '直播', site: 'live', live: true, liveTry: 0, eps: [], liveOrig: [] };
  var info = probe || [];
  var byUrl = {};
  for (var i = 0; i < info.length; i++) if (info[i] && info[i].u) byUrl[info[i].u] = info[i];
  for (var k = 0; k < urls.length; k++) {
    var u = String(urls[k] || '');
    if (!/^https?:\/\//i.test(u)) continue;                       // rtmp/rtsp 之类 WebView 放不动, 不收
    var r = byUrl[u] || null;
    // 线路名后面带状态: ✓ = 探到能连(#EXTM3U), ✗ = 连不上, flv = 浏览器放不了这种格式
    var mark = '';
    if (r) mark = r.d ? ' ✓✓' : (r.ok ? ' ✓' : (r.k === 'flv' ? ' flv(播不了)' : ' ✗'));
    var ref = u.replace(/^(https?:\/\/[^\/]+).*$/, '$1/');
    // 关键: 走本地代理。页面源是 file://, 直连 CDN 会因缺 CORS 头被浏览器挡掉, 表现就是"直播播不了";
    // LocalProxy 用 Java 去取, 回来带 Access-Control-Allow-Origin: *, 并把 m3u8 里的分片也改走代理。
    var play = u;
    try { var pw = PK.proxyWrap(u, ref, ''); if (pw) play = pw; } catch(e){}
    // 探到是 HLS 的, 把 mime 一起带上: 很多直播地址没有 .m3u8 后缀(比如 /live/1234?streamid=x),
    // 只按后缀判就会把 HLS 丢给 <video> 直连, 结果还是黑屏
    var pmime = (r && r.k === 'm3u8') ? 'application/vnd.apple.mpegurl' : '';
    curItem.eps.push({ name: '线路' + (curItem.eps.length + 1) + mark, url: play, mime: pmime, ext: '', ready: true });
    curItem.liveOrig.push(u);
  if (!curItem.liveDone) curItem.liveDone = {};
  }
  if (!curItem.eps.length) { PK.toast('这个频道没有浏览器能播的地址'); return; }
  srcList = []; srcIdx = 0; curEp = 0;
  if (okN === 0 && urls.length > 1) PK.toast(urls.length + ' 条线路都没探通, 挑一条硬试…');
  playEp(0);
}
/** 「测速」: 给当前分组每个频道试前两条线, 结果缓存下来, 列表里直接标绿 */
var liveSweeping = false;
function liveSpeedTest(){
  if (liveSweeping) { try { PK.toast('正在测速, 稍等…'); } catch(e){} return; }   // 连点会并发好几份探测
  liveSweeping = true;
  setTimeout(function(){ liveSweeping = false; }, 120000);      // 兜底复位
  var tag = document.getElementById('liveMeta');
  if (tag) tag.textContent = '正在测速…(可以继续用, 结果出来自动刷新)';
  try { PK.liveSweep(liveGroup || ''); } catch(e){ if (tag) tag.textContent = '桥不可用: ' + e; }
}
function onLiveSweep(msg){
  liveSwapped = true;                      // 测速结果出来了: 列表按"能不能播"重排一次
  liveAll = null;                          // 2026-10: 全部频道缓存要失效, 否则跨分组换台/继续看还在用旧表
  try { PK.toast(msg); } catch(e){}
  renderLiveFromCache();
}
var liveRefreshing = false;
function liveRefresh(){
  if (liveRefreshing) { try { PK.toast('正在更新列表, 稍等…'); } catch(e){} return; }   // 连点会并发好几份抓取
  liveRefreshing = true;
  setTimeout(function(){ liveRefreshing = false; }, 60000);      // 兜底复位(回调没来也不会永远卡住)
  var tag = document.getElementById('liveMeta');
  if (tag) tag.textContent = '正在更新列表…';
  try { PK.liveRefresh(); } catch(e){ if (tag) tag.textContent = '桥不可用: ' + e; }
}
function onLive(msg){
  liveRefreshing = false;
  liveAll = null;                          // 同上: 表刷新了, 缓存必须跟着失效
  try { PK.toast(msg); } catch(e){}
  renderLiveFromCache();
}

/** 平台解析失败时由 Java 回调过来。之前没这个函数, 报错全被吞掉, 看着就像「完全没反应」。 */
/* SESSDATA 只存在本机 localStorage, 下次打开自动填回去 */
/**
 * 嗅探 WebView 每抓到一条媒体流, Java 就推一次 addFound(以前 app.js 里没有这个函数,
 * 嗅探到的地址全被 js() 静默吞掉了 —— 这也是"嗅探没结果"的一个原因)。
 */
var lastFoundAt = 0;
function addFound(m){
  if (!m || !m.url) return;
  if (foundCount >= 40) return;                         // 兜底: 一轮嗅探最多收 40 条
  if (foundSeen[m.url]) return;
  foundSeen[m.url] = 1; foundCount++;
  // 播放器开着时(解析线路救场): 抓到就直接接到当前这一集上播, 不用退出去
  try {
    var pl = document.getElementById('player');
    // 归属校验(2026-10 修): **必须有正在进行的嗅探**, 且是给"当前这一集"抓的。
    // 以前写成 `!sniffWant || …` —— sniffWant 为空时反而算命中, 于是"停止/收工后迟到的抓取"能接上当前这一集。
    var mine = !!sniffWant && sniffWant.t === epToken();
    if (mine && pl && String(pl.className).indexOf('on') >= 0 && curItem && curItem.eps && curItem.eps[curEp]) {
      var ep = curItem.eps[curEp];
      if (!ep.plat) ep.plat = [];
      var dup = false;
      for (var k = 0; k < ep.plat.length; k++) if (ep.plat[k].url === m.url) dup = true;
      if (!dup) ep.plat.push(m);
      if (!ep.page) ep.page = ep.url;
      platCachePut(ep.page, ep.plat);
      platUse(ep, ep.plat.length - 1);
      renderVipPanel();
      PK.toast('解析线路抓到直链, 已切过去');
    }
  } catch(e){}
  var now = Date.now();
  if (now - lastFoundAt > 1200) {
    lastFoundAt = now;
    PK.toast('解析抓到 ' + foundCount + ' 条流');
  }
}

/* ---------- VIP 解析线路(10 条, 清单在 Java: extract/VipParse.java) ---------- */
var vipList = null;
var VIP_MARK = { txnp: '#c9a0f0', qilin: '#3fd9b8', special: '#ff6b4a', other: '#8fa0b8' };
function vipName(i){
  for (var k = 0; vipList && k < vipList.length; k++) if (vipList[k].i === i) return vipList[k].name;
  return ('线路' + i);
}
/** 分享进来的链接由 Java 的 handleIntent 推过来(以前 app.js 没有这个函数, 分享进来等于没反应)。 */
function setUrl(u){
  var s = String(u || '').trim();
  if (!s || !/^https?:\/\//i.test(s)) return;
  // 分享进来的链接: 直接进播放器。媒体地址直接播; 平台页面地址交给「解析」(平台解析 + 解析线路)。
  // (以前这里跳到"直链"页 —— 那个页面已按用户要求整块删除, 解析链本身还在)
  curItem = { name: '分享的链接', siteName: '分享', site: 'share', live: false,
              eps: [{ name: '第01集', url: s, ready: isMediaUrl(s, '', '') }] };
  srcList = [curItem]; srcIdx = 0; failedSrc = {}; stallTried = {}; curEp = 0;
  detailSrcCount = 1;
  playEp(0);
  try { PK.toast('已收到分享链接，正在解析…'); } catch(e){}
}
/* ---------- 解密器(与独立解密器 App 共用同一份 Box.analyze) ---------- */
var decRaw = '', decJson = '';
function showDecrypt(){ show('v-dec'); }
function decClear(){ var t=document.getElementById('decIn'); if(t) t.value=''; document.getElementById('decOut').innerHTML=''; }
function decPaste(){
  try { var c = VOD.clipText ? VOD.clipText() : ''; if (c) { document.getElementById('decIn').value = c; PK.toast('已粘贴'); } else PK.toast('剪贴板空的'); }
  catch(e){ PK.toast('桥不可用: ' + e); }
}
function decGo(){
  var v = (document.getElementById('decIn').value || '').trim();
  if (!v) { PK.toast('先粘地址或配置文本'); return; }
  document.getElementById('decOut').innerHTML = '<div class="pw">正在处理…</div>';
  try {
    if (/^https?:\/\//i.test(v) && v.indexOf('\n') < 0) VOD.decryptUrl(v);
    else VOD.decryptText(v);
  } catch(e){ document.getElementById('decOut').innerHTML = '<div class="pw">桥不可用: ' + esc(e) + '</div>'; }
}
function onDecrypt(jsonStr){
  var box = document.getElementById('decOut');
  var d = null;
  try { d = JSON.parse(jsonStr); } catch(e){}
  if (!d) { box.innerHTML = '<div class="pw">结果解析不了</div>'; return; }
  if (!d.ok) {
    box.innerHTML = '<div class="pw">❌ 没解开</div>'
      + '<div class="pw">形态：' + esc(d.shape || '认不出') + (d.chars ? ('　字符数 ' + d.chars) : '') + '</div>'
      + '<div class="pw">原因：' + esc(d.error || '') + '</div>'
      + (d.head ? ('<pre style="white-space:pre-wrap;font-size:11px">' + esc(d.head) + '</pre>') : '');
    return;
  }
  decRaw = d.json || ''; decJson = jsonStr;
  var h = '<div class="pw">✅ 解开了　形态 <b>' + esc(d.shape || '明文') + '</b>'
    + (d.encrypted ? ('　🔑 口令 <b>' + esc(d.pw) + '</b>　IV <b>' + esc(d.iv) + '</b>') : '')
    + (d.lenient ? '　（配置里有重复键，容错模式，站点数未知）' : '')
    + '<br>站点 ' + (d.lenient ? '?' : d.sites) + ' 个 · 直播 ' + (d.lenient ? '?' : d.lives) + ' 组'
    + ' · 多仓 ' + (d.lenient ? '?' : d.subs) + ' 个'
    + (d.spiderJar ? ('<br>蜘蛛 jar: ' + esc(d.spiderJar)) : '')
    + '<br><button class="pbtn" onclick="decCopy(decJson)">复制完整结果(JSON)</button>'
    + ' <button class="pbtn" onclick="decCopy(decRaw)">复制解密原文</button></div>';
  var apis = d.apis || [], lv = d.livesList || [], sp = d.spiders || [];
  h += '<div class="pw">📡 采集接口（' + apis.length + '）—— 这类才是影视源，可逐条加：</div>';
  for (var i = 0; i < apis.length; i++) {
    var a = apis[i], u = a.base + a.path;
    h += '<div class="srcrow"><div class="sinfo">' + esc(a.name || '源') + '<br><span class="sapi">' + esc(a.raw) + '</span></div>'
      + '<button class="pbtn" onclick="decAddSite(' + jsa(JSON.stringify({k: a.base.replace(/[^a-z0-9]/gi, '').slice(0, 10), n: a.name, b: a.base, p: a.path})) + ')">加入影视源</button>'
      + '<button class="pbtn" onclick="decCopy(' + jsa(u) + ')">复制</button></div>';
  }
  h += '<div class="pw">📺 直播表（' + lv.length + '）—— 加进来会先真拉一次、解析出频道才收：</div>';
  for (var j = 0; j < lv.length; j++) {
    h += '<div class="srcrow wide"><div class="sinfo">' + esc(lv[j].name || '直播') + '<br><span class="sapi">' + esc(lv[j].url)
      + (lv[j].ua ? ('  · UA ' + esc(lv[j].ua)) : '') + '</span></div>'
      + '<button class="pbtn" onclick="decAddLive(' + j + ')">加入直播源</button>'
      + '<button class="pbtn" onclick="decCopy(' + jsa(lv[j].url) + ')">复制</button></div>';
  }
  if (!WEB) {
    h += '<div class="pw">🕷 蜘蛛站点（' + sp.length + '）—— 靠 jar 里的爬虫跑，加入前会先下 jar 真测。<br>'
      + '注意：<b>ext 是"规则"（网址模板/整段规则）的这类，是不可能转成 JSON 接口的</b>（接口探测对它们无效），'
      + '只能跑 jar；ext 是 http 接口的才是能直接当影视源的那种。</div>';
    for (var k = 0; k < sp.length; k++) {
      var isRule = String(sp[k].ext || '').indexOf('{cateId}') >= 0 || String(sp[k].ext || '').indexOf('"') === 0
        || String(sp[k].ext || '').indexOf('请求头') >= 0;
      h += '<div class="srcrow wide"><div class="sinfo">' + esc(sp[k].key) + ' ' + esc(sp[k].name || '')
        + (isRule ? ' <span class="sbad">规则</span>' : '')
        + '<br><span class="sapi">' + esc(sp[k].ext || '(无 ext)') + '</span></div>'
        + '<button class="pbtn" onclick="decAddSpider(' + k + ')">加入(蜘蛛)</button>'
        + '<button class="pbtn" onclick="spiderTestNow(' + k + ')">自测</button>'
        + '<button class="pbtn" onclick="decCopy(' + jsa(sp[k].key + ' ' + (sp[k].ext || '')) + ')">复制</button></div>';
    }
    if (d.spiderJar) {
      h += '<div class="pw">蜘蛛 jar：' + esc(d.spiderJar)
        + (d.spiderJarUsable ? '' : '<br><b class="bad">这个 jar 是别人 App 里打包的(assets:// 之类)，我们下不到，加不了</b>')
        + (d.spiderJarRaw && d.spiderJarRaw !== d.spiderJar ? ('<br>配置里写的是相对路径 ' + esc(d.spiderJarRaw) + '，已按配置地址解析成上面的绝对地址') : '')
        + '</div>';
    }
    scanLives = lv; scanSpiders = sp;
  }
  if (sp.length) { scanJar = sp[0].jar || d.spiderJar || ''; scanCls = String(sp[0].key).replace(/^csp_/, ''); scanExt = sp[0].ext || ''; }
  box.innerHTML = h;
}
/**
 * 把"网页站地址"转成 App 能用的 JSON 采集接口：拿根域名试一组常见路径, 真返回片单才算探到。
 * (用户问的就是"vodshow/id/{cateId}/page{catePg}.html 这种能不能转成 JSON 用" —— 这样转)
 */
function probeSite(){
  var v = (document.getElementById('decIn').value || '').trim();
  if (!/^https?:\/\//i.test(v)) { PK.toast('先把站点地址粘进输入框'); return; }
  document.getElementById('decOut').innerHTML = '<div class="pw">正在探测常见采集接口路径…</div>';
  try { VOD.probeSiteUrl(v); } catch(e){ document.getElementById('decOut').innerHTML = '<div class="pw">桥不可用: ' + esc(e) + '</div>'; }
}
function onProbeSite(jsonStr){
  var box = document.getElementById('decOut');
  var d = null;
  try { d = JSON.parse(jsonStr); } catch(e){}
  if (!d) { box.innerHTML = '<div class="pw">结果解析不了</div>'; return; }
  if (!d.ok) {
    box.innerHTML = '<div class="pw">❌ 没探到采集接口</div>'
      + '<div class="pw">站点根：' + esc(d.base || '') + '</div>'
      + '<div class="pw">试过：' + esc(d.trace || '') + '</div>'
      + '<div class="pw">' + esc(d.msg || '') + '</div>';
    return;
  }
  box.innerHTML = '<div class="pw">✅ 转换成功：这个站的 JSON 采集接口在 <b>' + esc(d.path) + '</b></div>'
    + '<div class="pw">站点根：' + esc(d.base) + '<br>真测：' + d.n + ' 条 「' + esc(d.sample || '') + '」 '
    + (d.eps ? (d.eps + ' 集 ') : '') + d.ms + 'ms<br>试过：' + esc(d.trace || '') + '</div>'
    + '<div class="srcrow"><div class="sinfo">' + esc(d.base) + '<br><span class="sapi">' + esc(d.base + d.path) + '</span></div>'
    + '<button class="pbtn" onclick="decAddSite({k:' + jsa(d.key) + ',n:'
    + jsa(d.base.split('//')[1] || d.base) + ',b:'
    + jsa(d.base) + ',p:' + jsa(d.path) + '})">加入影视源</button>'
    + '<button class="pbtn" onclick="decCopy(' + jsa(d.base + d.path) + ')">复制</button></div>';
}
/** 把输入框里的地址直接当"直播源"加入: 真拉一次、解析出频道才收(原来在设置抽屉里, 现在搬到解密页) */
function decAddLiveByUrl(){
  var box = document.getElementById('decIn');
  var u = box ? String(box.value || '').trim() : '';
  if (!/^https?:\/\//i.test(u)) { PK.toast('先把直播表地址粘进输入框'); return; }
  try { PK.liveAddSource('自加直播源', u, u.indexOf('.nzk') >= 0 ? 'Goiptv/8.8.8' : ''); } catch(e){ PK.toast('桥不可用: ' + e); }
}
function decCopy(s){ try { VOD.copyText(s || ''); } catch(e){ try { PK.toast('复制失败'); } catch(e2){} } }
function decAddSite(o){ try { VOD.addSite(o.k, o.n, o.b, o.p); } catch(e){ PK.toast('桥不可用: ' + e); } }
function decAddLive(i){ var L = scanLives[i]; if (L) try { PK.liveAddSource(L.name, L.url, L.ua || ''); } catch(e){ PK.toast('桥不可用: ' + e); } }
function decAddSpider(i){
  var s = scanSpiders[i];
  if (!s) return;
  try { VOD.addSpiderSite(s.key, s.name, scanJar || s.jar, s.ext); } catch(e){ PK.toast('桥不可用: ' + e); }
}
/** 上次崩溃的堆栈(Java 启动时推过来)。 */
function showCrash(t){
  var el = document.getElementById('crashText');
  if (el) el.textContent = String(t || '');
  show('v-crash');
}

/* ---------- 应用内更新（逻辑在 core/Updater.java；清单地址在 UPDATE_URL） ---------- */
var updInfo = null, updLaunched = false;
function autoUpdOn(){ try { return localStorage.getItem('pk_autoupd') !== '0'; } catch(e){ return true; } }
function renderUpdAuto(){
  var b = document.getElementById('updAuto');
  if (b) b.textContent = '自动更新 ' + (autoUpdOn() ? '开' : '关');
}
function toggleAutoUpd(){
  try { localStorage.setItem('pk_autoupd', autoUpdOn() ? '0' : '1'); } catch(e){}
  renderUpdAuto();
  PK.toast(autoUpdOn() ? '以后发现新版本会自动下载并拉起安装' : '已关掉自动更新，需要手动点「检查更新」');
}
function checkUpdate(manual){
  if (WEB) return;                       // 同上: 网页端不查更新
  var n = document.getElementById('updNote');
  if (n && manual) n.textContent = '正在检查更新…';
  try {
    var v = document.getElementById('updVer');
    if (v && !manual) { try { v.textContent = '版本 ' + PK.appVersion(); } catch(e){} }
    PK.checkUpdate(!!manual);
  } catch(e){ if (n && manual) n.textContent = '更新桥不可用: ' + e; }
}
function onUpdateInfo(jsonStr){
  var d = null;
  try { d = JSON.parse(jsonStr); } catch(e){}
  var note = document.getElementById('updNote'), body = document.getElementById('updBody'), ver = document.getElementById('updVer');
  if (ver) ver.textContent = '版本 ' + ((d && d.current) || '?');
  if (!d || !d.ok) {
    var err = (d && d.error) || '未知错误';
    // 网络不通和"清单坏了/仓库那边出问题"是两回事: 前者重试就行, 后者得改仓库
    var net = /UnknownHost|Failed to connect|Unable to resolve|timeout|timed out|Network is unreachable|Connection ref|Connection reset|SSL/i.test(err);
    if (note) note.textContent = (net ? '网络不通，检查更新失败' : '检查更新失败') + '：' + err;
    // 两条源都试过了(update.json 主站+CDN、目录接口) —— 地址摆出来, 出错时不用猜
    if (body) body.innerHTML = (d && (d.manifest || d.listing))
      ? ('<div class="pw">试过这几条路：<br>' + esc(d.manifest || '') + '<br>' + esc(d.listing || '')
         + '<br>' + (net ? '多半是当前网络到 gitee 不通（或 DNS 解析不到），换网络/稍后再试即可；'
                         : '仓库那边的问题（清单内容或目录接口），稍后再试；')
         + '网络类失败不算崩溃，不会记进诊断页。</div>')
      : '';
    return;
  }
  updInfo = d;
  if (!d.hasUpdate) {
    if (note) note.textContent = '已是最新版本（远端 ' + (d.remoteName || d.remoteCode) + '）';
    if (body) body.innerHTML = '';
    return;
  }
  if (note) note.textContent = '发现新版本 ' + (d.remoteName || '')
    + (d.file && d.file !== d.remoteName ? ('（' + d.file + '）') : '')
    + (d.source ? (' · 来源 ' + (d.source === 'update.json' ? 'releases/update.json' : 'Gitee 目录接口')) : '');
  var h = '';
  if (d.notes) h += '<div class="pw">' + esc(d.notes) + '</div>';
  if (!d.canInstall) h += '<div class="pw">这台设备还没允许本应用"安装未知应用"，先点右边那个按钮打开，再回来装。</div>';
  h += '<div class="grid2" style="margin-top:8px">'
    + (d.canInstall ? '<button class="mini" onclick="doUpdate()">下载并安装</button>'
                   : '<button class="mini" onclick="PK.openInstallPerm()">去开启安装权限</button>')
    + '<button class="ghost mini" onclick="checkUpdate(true)">重新检查</button></div>';
  if (body) body.innerHTML = h;
  PK.toast('有新版本：' + (d.remoteName || d.remoteCode));
  // 更新一体化: 静默检查发现的(用户没点任何按钮)就直接下载并拉起系统安装器,
  // 用户最多只在系统弹窗里点一下"安装"(Android 不允许应用静默装包)。
  if (!d.manual && d.canInstall && autoUpdOn() && !updLaunched) {
    PK.toast('正在自动下载新版本…');
    doUpdate();
  }
}
function doUpdate(){
  if (!updInfo || !updInfo.url) { PK.toast('没有下载地址'); return; }
  if (updLaunched) return;                     // 一轮只拉一次安装器, 免得反复弹
  updLaunched = true;
  var n = document.getElementById('updNote');
  if (n) n.textContent = '开始下载…';
  try { PK.installUpdate(updInfo.url, updInfo.md5 || ''); } catch(e){ PK.toast('桥不可用: ' + e); }
}
function onUpdateProgress(pct, got, total){
  var n = document.getElementById('updNote');
  if (!n) return;
  var mb = function(x){ return (x / 1048576).toFixed(1); };
  n.textContent = (pct >= 0 ? ('下载中 ' + pct + '%') : '下载中…')
    + '（' + mb(got || 0) + 'MB' + (total > 0 ? (' / ' + mb(total) + 'MB') : '') + '）';
}
function onUpdateResult(ok, msg){
  var n = document.getElementById('updNote');
  if (n) n.textContent = (ok ? '✔ ' : '✘ ') + msg;
  PK.toast(msg);
  if (!ok) updLaunched = false;                // 失败就允许下次再试(比如用户取消了安装)
}

/**
 * 启动时把"页面状态"硬归零: 关掉播放器和所有抽屉、清掉当前播放项。
 * 为什么必须做: WebView 在进程被回收后会**恢复 DOM 状态**, 一旦上次退出时播放器是开着的,
 * 下次进来就可能"播放器盖在主页前面"(用户报过; 我测试时也踩到过 —— 只是把状态留在那儿没清)。
 * 显式归零比"相信内核会恢复干净"可靠。
 */
function resetUiState(){
  try {
    var pl = document.getElementById('player');
    if (pl) pl.className = '';
  } catch(e){}
  try { closeSheets(); } catch(e){}
  try { curItem = null; srcList = []; srcIdx = 0; curEp = 0; } catch(e){}
  try { document.body.style.overflow = ''; } catch(e){}
}
resetUiState();

/* ============================================================ 网页版专属(APP 完全不执行)
 * 这些代码只在 PK.web 存在时生效: 用 if (WEB) 或 applyWebMode() 里的空判断守起来,
 * App 侧一个分支都不会进 —— 改网页端不会碰到 App 的行为。
 */
function webV(){ return $('video'); }
function webVol(){ var v = webV(); return v ? (v.muted ? 0 : (v.volume || 0)) : 1; }
function webSetVolume(x, silent){
  var v = webV(); if (!v) return;
  x = Math.max(0, Math.min(1, Number(x)));
  try { v.muted = x <= 0; v.volume = x; } catch(e){}
  try { localStorage.setItem('pk_vol', String(Math.round(x * 100))); } catch(e){}
  syncVolUI();
  if (!silent) showGest('音量 ' + Math.round(x * 100) + '%');
}
function webMuteToggle(){
  var v = webV(); if (!v) return;
  if (v.muted || !(v.volume > 0)) {
    var keep = 0.8;
    try { var sv = parseInt(localStorage.getItem('pk_vol') || '', 10); if (isFinite(sv)) keep = sv / 100; } catch(e){}
    try { v.muted = false; if (!(v.volume > 0)) v.volume = keep || 0.8; } catch(e){}
    showGest('取消静音');
  } else {
    try { v.muted = true; } catch(e){}
    showGest('静音');
  }
  syncVolUI();
}
function syncVolUI(){
  var v = webV();
  var pct = v ? Math.round((v.muted ? 0 : (v.volume || 0)) * 100) : 100;
  var t = $('psVolTxt'); if (t) t.textContent = pct + '%';
  var sl = $('psVol'); if (sl && document.activeElement !== sl) sl.value = pct;
  var mb = $('psMute'); if (mb) mb.textContent = (v && v.muted) ? '取消静音' : '静音';
}
function webFsOn(){ return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function syncFsBtn(){ var b = $('pfs'); if (b) b.textContent = webFsOn() ? '退出全屏' : '全屏'; }
/** 全屏: 只把播放器区域撑满(不是浏览器的 F11, F11 会连地址栏一起吃掉) */
function toggleFullscreen(){
  var pl = $('player') || document.documentElement;
  try {
    if (webFsOn()) {
      var ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex) { var r1 = ex.call(document); if (r1 && r1.catch) r1.catch(function(){}); }
      showGest('退出全屏');
    } else {
      var rq = pl.requestFullscreen || pl.webkitRequestFullscreen || pl.webkitEnterFullscreen;
      if (!rq) { try { PK.toast('这个浏览器不支持网页全屏'); } catch(e){} return; }
      var r2 = rq.call(pl);
      if (r2 && r2.catch) r2.catch(function(){});
      showGest('全屏');
    }
  } catch(e){}
  setTimeout(syncFsBtn, 250);
}
/** 键盘左右键用: 相对当前位置进退 N 秒 */
function seekBy(sec){
  var v = webV(); if (!v) return;
  try {
    var d = v.duration, t = (v.currentTime || 0) + sec;
    if (isFinite(d) && d > 0) t = Math.max(0, Math.min(d - 0.5, t)); else t = Math.max(0, t);
    v.currentTime = t;
    showGest((sec > 0 ? '前进 ' : '后退 ') + Math.abs(sec) + ' 秒');
  } catch(e){}
}
/**
 * 浏览器"自动播放策略"挡下了 play() —— 给一个明确的点按入口,
 * 而不是让画面一直黑着、用户以为"网页版坏了"。
 */
function webNeedGesture(){
  try {
    var pl = $('player'); if (!pl || $('webtap')) return;
    var d = document.createElement('div');
    d.id = 'webtap';
    d.textContent = '▶ 点一下开始播放（浏览器要求先交互，之后就有声音）';
    d.style.cssText = 'position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;'
      + 'justify-content:center;background:rgba(0,0,0,.55);color:#fff;font-size:16px;text-align:center;'
      + 'padding:0 18px;box-sizing:border-box;z-index:9;cursor:pointer';
    d.onclick = function(){
      var v = webV();
      try { PK.unmute(); } catch(e){}
      if (v) { var r = v.play(); if (r && r.catch) r.catch(function(){}); }
      if (d.parentNode) d.parentNode.removeChild(d);
      hideLoad(); syncVolUI();
    };
    pl.appendChild(d);
    var v2 = webV();
    if (v2) {
      var once = function(){ if (d.parentNode) d.parentNode.removeChild(d); v2.removeEventListener('playing', once); };
      v2.addEventListener('playing', once);
    }
    hideLoad();
  } catch(e){}
}
/** 网页版界面调整: 该删的入口删掉, 该补的 PC 能力补上 */
function applyWebMode(){
  if (!WEB) return;
  function drop(el){ try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch(e){} }
  // 帮助函数: 抽屉/页面**只隐藏不删节点** —— show()/closeSheets() 会把它们列进去循环设置样式,
  // 节点没了就是 null 访问异常, 整个导航会跟着坏(这是"越界改坏"的典型, 特意记一笔)
  function hide(el){ try { if (el) el.style.display = 'none'; } catch(e){} }
  // ① 只有原生做得到的入口: 投屏 / 解析 / 更新
  drop($('pcastbtn')); drop($('pvipbtn'));
  hide($('pcast')); hide($('pvip'));
  try { var vu = $('v-update'); if (vu) vu.innerHTML = ''; } catch(e){}   // 页面留着(show() 要按 id 取), 内容清空
  try {
    var nav = document.querySelectorAll('#navScroll button');
    for (var i = 0; i < nav.length; i++) if (/更新/.test(nav[i].textContent || '')) drop(nav[i]);
  } catch(e){}
  // 设置抽屉里"用其它播放器打开这条线路"(网页版没有第二播放器可调)
  try {
    var bs = document.querySelectorAll('#pset button');
    for (var j = 0; j < bs.length; j++) if (/其它播放器/.test(bs[j].textContent || '')) drop(bs[j]);
  } catch(e){}
  // ② "横屏"按钮只在真能锁方向的浏览器上留(手机 Chrome 全屏后可锁; 桌面端锁不了, 点了也是白点)
  try { if (!(PK.canLockOrientation && PK.canLockOrientation())) drop($('prot')); } catch(e){}
  // ③ 全屏按钮(PC 看片的刚需, App 里没有这个概念)
  try {
    var top = $('ptop');
    if (top && !$('pfs')) {
      var b = document.createElement('button');
      b.className = 'pbtn'; b.id = 'pfs'; b.textContent = '全屏';
      b.onclick = function(){ toggleFullscreen(); };
      var setBtn = top.querySelector('button[onclick="openPSet()"]');
      top.insertBefore(b, setBtn || null);
    }
  } catch(e){}
  // ④ 音量条: PC 上没有"上下滑改音量"的手势, 没这个就等于没法调音量
  try {
    var pset = $('pset');
    if (pset && !$('psVolRow')) {
      var row = document.createElement('div');
      row.className = 'skiprow'; row.id = 'psVolRow';
      row.innerHTML = '<label>音量</label>'
        + '<input id="psVol" type="range" min="0" max="100" value="100" style="width:40%;vertical-align:middle" />'
        + '<span class="dim" id="psVolTxt" style="font-size:12px">100%</span>'
        + '<button class="pbtn" id="psMute" onclick="webMuteToggle()">静音</button>';
      var head = pset.querySelector('h3');
      if (head) pset.insertBefore(row, head.nextSibling); else pset.appendChild(row);
      var sl = $('psVol');
      if (sl) sl.oninput = function(){ webSetVolume(this.value / 100); };
    }
  } catch(e){}
  // ⑤ 键盘 / 滚轮: 桌面端最顺手的两件事(空格暂停、左右进退、上下/滚轮调音量、F 全屏、M 静音)
  try {
    document.addEventListener('keydown', function(ev){
      var pl = $('player'); if (!pl || ('' + pl.className).indexOf('on') < 0) return;
      var t = ev.target || {};
      if (/INPUT|TEXTAREA|SELECT/.test(t.tagName || '') || t.isContentEditable) return;
      var k = ev.key;
      if (k === ' ' || k === 'k' || k === 'K') { if (!locked) togglePlay(); ev.preventDefault(); }
      else if (k === 'ArrowLeft') { seekBy(-10); ev.preventDefault(); }
      else if (k === 'ArrowRight') { seekBy(10); ev.preventDefault(); }
      else if (k === 'ArrowUp') { webSetVolume(webVol() + 0.05); ev.preventDefault(); }
      else if (k === 'ArrowDown') { webSetVolume(webVol() - 0.05); ev.preventDefault(); }
      else if (k === 'f' || k === 'F') { toggleFullscreen(); ev.preventDefault(); }
      else if (k === 'm' || k === 'M') { webMuteToggle(); ev.preventDefault(); }
    });
    var pl2 = $('player');
    if (pl2) pl2.addEventListener('wheel', function(ev){
      if (locked) return;
      if (ev.shiftKey) seekBy(ev.deltaY > 0 ? -10 : 10);
      else webSetVolume(webVol() + (ev.deltaY > 0 ? -0.05 : 0.05));
      ev.preventDefault();
    }, { passive: false });
    document.addEventListener('fullscreenchange', syncFsBtn);
    document.addEventListener('webkitfullscreenchange', syncFsBtn);
  } catch(e){}
  // ⑥ 首次用户手势后把"浏览器自动静音"摘掉(有手势一定成功), 并恢复上次的音量
  try {
    var sv = parseInt(localStorage.getItem('pk_vol') || '', 10);
    if (isFinite(sv)) webSetVolume(sv / 100, true);
  } catch(e){}
  syncVolUI();
  syncFsBtn();               // 进来先按当前全屏状态写好按钮文案
}

/* 启动 */
initSites();
initPlayerSettings();      // 播放器/直播设置(画面比例/缓冲/超时/OSD/换台)先读回来再画界面
initAutoNext();
initSkipAndHistory();
applyWebMode();           // 网页版: 去掉原生专属入口 + 补上全屏/音量/键盘(APP 里是空函数)

/* 内核自检 + 启动信号:
   - Java 侧 6 秒收不到 bootOk 就判定内核太老, 换提示页(免得白屏);
   - CSS 变量是 Android 7.0 的 WebView 才有的, 老内核上界面会花, 提示一次;
   - Android 4.4 以下(API<19)没有 evaluateJavascript: Java 侧把要回调的脚本排进队列,
     这里开个轮询把它取出来 eval。高版本上 PK.legacy() 是 false, 连定时器都不开。 */
(function(){
  try{
    if (window.__pkLegacyCss && window.PK && PK.compat) {
      var cm = /Chrome\/(\d+)/.exec(navigator.userAgent);
      PK.compat(cm ? ('Chrome/' + cm[1]) : 'WebKit');
    }
  }catch(e){}
  try{
    if (window.PK && PK.legacy && PK.legacy()) {
      setInterval(function(){
        try{
          var s = PK.poll(), n = 0;
          while (s && n < 200) { try { eval(s); } catch(e){} s = PK.poll(); n++; }
        }catch(e){}
      }, 150);
    }
  }catch(e){}
  try{ if (window.PK && PK.bootOk) PK.bootOk(); }catch(e){}
  /* 启动 4 秒后静默问一次更新(没新版就不出声; 有新版会自动下载并拉起安装) */
  try{ if (window.PK && PK.checkUpdate) setTimeout(function(){ checkUpdate(false); }, 4000); }catch(e){}
  /* 直播频道表: 超过 12 小时没更新就自动拉一份(用户不用管) */
  try{ if (window.PK && PK.liveAuto) setTimeout(function(){ PK.liveAuto(); }, 6000); }catch(e){}
})();