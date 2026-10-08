# ZY影视 · 网页版

> **本文档只讲「网页版」**（`web/`）。安卓 App 的文档在**工程根目录**（`README.md` / `介绍.md` / `CHANGELOG*.md`）与
> `pikachu-dl/README.md`。两套文档**分开保存、互不混写**：网页版仓库（GitHub）里只有网页版文档。

> **在线地址：<https://zyplayer.hof12.ccwu.cc/>**（手机 / 电脑浏览器直接打开，无需安装）
>
> 这是 ZY影视 的网页版：影视聚合搜索 + 多源播放 + 广告过滤，全部跑在浏览器里。
> 本文件同时是 GitHub 仓库首页 README（推送时复制到仓库根目录）。

一套界面两种跑法：`index.html` / `app.js` 与安卓 App **完全是同一份**，网页版只是把
「原生那层」换成了 JS —— 桥接（`bridge.js`）、本地代理与广告过滤（Service Worker + `adfilter.js`）、
跨域代理（Cloudflare Worker）。

---

## 〇、本版范围：**只做点播，不做直播**

网页版已经**整体摘掉直播功能**（入口按钮、直播页、频道表、相关设置与代码全部移除）——
浏览器对国内直播源有 http 混合内容 / 端口白名单 / 地区限制三重硬限制，留着只会让人以为播放器坏了。
**点播（搜索 / 详情 / 换源 / 播放 / 广告过滤）是唯一方向。** 要看直播请用安卓 App。

## 〇之前 · 首页与默认开关

* **首页 = 豆瓣榜单**，豆瓣「看过」写的那一批 collection **全都真测过**，线上可用的 14 个按
  「电影 / 剧集 / 综艺 / 动漫 / 纪录」分成四组填进首页那张分类下拉（选完记住，下次进来还是它）：

  | 分组 | 榜单（括号内为 collection id） |
  |---|---|
  | 电影 | 正在上映 `movie_showing`、热门电影 `movie_hot`、豆瓣 Top250 `movie_top250`、一周口碑榜 `movie_weekly_best`(10 条)、经典老片 `movie_classic` |
  | 剧集 | 热门剧集 `tv_hot`、国产剧 `tv_domestic`、欧美剧 `tv_american`、韩剧 `tv_korean`、日剧 `tv_japanese`、华语口碑剧集榜 `tv_chinese_best_weekly`(10 条) |
  | 综艺 | 综艺 `tv_variety_show` |
  | 动漫 | 动漫 `tv_animation` |
  | 纪录 | 纪录片 `tv_documentary` |

  **收起时是一排四个**（固定 4 列，屏再窄也不换行）：`正在上映 / 热门剧集 / 综艺 / 纪录片`；
  「更多榜单 ▾」单独占一整行，点开才是上面那张完整分组表（动漫只在展开后出现）。
  收起态**不显示分组标题**（就干净一排）。，
  点一下 14 个全铺开（按钮变「收起榜单 ▴」，状态记在本地）。**折叠时当前选中的榜单永远可见** ——
  否则收起后高亮跑到看不见的地方，用户会以为"点了没反应"。

  这 14 个榜单**同时铺成「榜单面板」**（网页端首页搜索框下面，`#dbboards`）：
  `display:grid` + `repeat(auto-fill,minmax(96px,1fr))`，分组标题 `grid-column:1/-1` 跨整行 ——
  手机竖屏约 3 列、平板 6~7 列、桌面 10 列左右，屏多宽就铺多满（首页不再空一大片）；
  最窄 560px 以下换成 `minmax(84px,1fr)` 与更小的字号。**面板与下拉二选一**：网页端用面板
  （`html.web #typeSel{display:none}`），安卓端面板 `display:none`、照旧用分类下拉。
  当前选中项加 `.on` 高亮（绿底），点一下即换榜单并重拉首页。

  **实测为空、不许写进表里的 id**（省得以后又有人去试）：`movie_coming_soon`、`movie_new`、
  `movie_domestic`、`movie_american`、`tv_anime`、`tv_cartoon`、`anime`、`movie_documentary`、
  `tv_talk_show`、`tv_show_hot`。榜单表在 `web/bridge.js` 的 `CHARTS`，`web/selftest.mjs` 的 **[1c]** 把
  「表里必须有这 14 个、不许有那些空 id、选项要真的进到请求里」钉住。

* 榜单来源 `m.douban.com/rexxar/api/v2/subject_collection/...`：
  好处是**首页不依赖任何采集源**（源全挂首页也还在），「刷新」就是重新拉一次榜单；榜单条目只有片名/海报/评分，
  **点进去会自动按片名去聚合搜索**、拿到同名结果再进详情。
* **默认开关**（都可在播放器「设置」里改）：静默提示 **开**、画面上显示(OSD) **关**、避开烧录广告源 **关**、广告过滤 **开**。
* **自适应照静态博客的做法**：文档自然滚动、容器限宽 1080px、卡片/选集用 `repeat(auto-fill,minmax(...))` 流式网格，
  断点 560 / 720 / 880 / 1180（参考用户自己的博客 felixdsh2.eu.cc）。

## 一、能做什么

| 能力 | 网页版 | 说明 |
|---|---|---|
| 聚合搜索（20+ 采集源） | ✅ | 走自建 CORS 代理取数 |
| 详情 / 换源 | ✅ | 只切「同一部剧 + 同一集」，与 App 同规则 |
| 播放（hls.js）+ **广告过滤** | ✅ | m3u8 由 Service Worker 清洗：CUE/SCTE-35 广告块、注入字幕组、广告分片、异目录插入块、短插播块 |
| 需要 Referer / UA 的片源 | ✅ | 代理服务端代填 Referer / User-Agent |
| 解密 TVBox 配置（含 AES） | ✅ | WebCrypto AES-128-CBC，同款抽取逻辑 |
| 豆瓣评分 | ✅ | 同样过代理 |
| 看片进度 / 继续观看 | ✅ | 存 localStorage |
| 倍速 / 连播 / 跳过片头片尾 / 画面比例 / 音量 / 全屏 | ✅ | 电脑上还支持键盘与滚轮（见下） |

**只属于安卓端、网页版做不了的功能，入口已经全部移除**（不是灰着占地方，是按钮和抽屉都不在了）：

* 投屏（DLNA）—— 浏览器起不了 SSDP/UDP，也没有任意 TCP；
* 解析线路 / 平台页面嗅探 —— App 靠隐藏 WebView 在网络层截流，浏览器读不到跨域 iframe；
* 蜘蛛源（TVBox jar）—— 需要 DexClassLoader 跑 jar；
* 调起外部播放器、应用内更新、播放本地已下载文件 —— 都是原生能力。

## 二、电脑上怎么用

打开页面 → 搜索 → 点一集 → 播放。

* **没声音？** 浏览器有「自动播放策略」：第一次播放前点一下页面任意位置即可（页面会显示
  「▶ 点一下开始播放」）。播放器**设置**里也有音量条 / 静音按钮，`↑↓` 或鼠标滚轮同样能调音量。
* **快捷键**：`空格`/`K` 播放暂停，`←`/`→` 快退快进 10 秒，`↑`/`↓` 或滚轮调音量，
  `F` 全屏（只全屏播放器区域，不是浏览器的 F11），`M` 静音，`Shift`+滚轮前后跳 10 秒。
* **画面太暗/太亮**：在画面上竖直滑动即可（网页版映射为画面亮度，不动系统）。
* **手机上的横竖屏**：点「横屏」按钮 = 先全屏 + 再横过来。**方向锁靠不住**（实测 Via / 各家
  WebView 里 `screen.orientation.lock()` 函数存在却永远抛 `NotSupportedError`，iOS Safari 压根没这 API），
  所以锁不上时网页版会自己把播放器内容**整体转 90°**（伪横屏），用户把手机横过来就是满屏画面；
  手机真转了 / 真竖回来了，那一层会自动撤掉。按「竖屏」而手机物理上还横着（谁也拧不过传感器）时，
  同一层反着转 −90°。桌面窗口天生"宽>高"，不做伪横屏，那个按钮在那里就是"全屏/退出全屏"。
* **全屏里按「返回」**：会连全屏一起收掉（以前只关播放器不退全屏 → 整屏黑，只能按系统返回键救回来）。

## 三、部署（两条路，任选）

### A. Cloudflare Worker 一体（当前线上就是这个）

一个 Worker 同时提供站点静态资源与 `/f` `/p` 代理，**不需要 DNS 权限**（Worker 自定义域会自己建记录）：

```bash
node web/build-web.mjs
CF_API_TOKEN=xxx CF_ACCOUNT_ID=xxx node web/deploy-worker.mjs --domain 你的域名
```

### B. GitHub Pages + 独立代理

1. 仓库 Settings → Pages → Source 选 **GitHub Actions**（本仓库的 workflow 会自动构建 `web/dist` 并发布）；
2. 另建一个 Cloudflare Worker：把 `web/proxy/worker.js` 整个粘进去，`TOKEN` 换成你自己的随机串，
   **`ALLOW_HOSTS` 保持 `[]` 不要动**（它是「允许代理去取的上游站点」白名单，写死会导致所有采集源 403）；
3. 把地址填进 `web/webconfig.js` 的 `proxy`（也可以打开页面后在运行时改，存在 localStorage）：
   ```js
   localStorage.setItem('zyweb_cfg', JSON.stringify({ proxy: 'https://zy-proxy.xxx.workers.dev', token: '你的TOKEN' }));
   location.reload();
   ```

想全自动：给仓库配 Secrets `CF_API_TOKEN` 与 Variables `CF_ACCOUNT_ID / CF_ZONE_ID / CF_WORKER_NAME / CF_DOMAIN`，
之后 push 就会自动更新线上站点（没配则跳过该步，只构建）。

### 改播放链路的自测(强烈建议先跑)

```bash
node web/selftest.mjs      # 桥/Service Worker 的代理不变量, 全绿才算改对
```

它钉死的是**被改坏过好几次**的不变量: 已经是代理地址的 URL 不许再包一层(否则 Worker 会
fetch 自己 → Cloudflare 522)、没 SW 时必须交回原始地址(塞 Worker 地址会让国内 CDN 403)、
SW 改写清单时不动已是代理的行。CI 里也跑了这一步。

## 四、本地预览

```bash
node web/build-web.mjs
python3 -m http.server 8080 -d web/dist     # 打开 http://localhost:8080
```

Service Worker 只在 `https://` 或 `localhost` 下生效 —— 用 `file://` 直接打开会退化成
「没有广告过滤、需要 Referer 的源播不了」。

界面源码在 `web/site/`（`index.html` / `app.js` / `hls.min.js` / `legacy.css`）。
本地若同时存在安卓工程，`build-web.mjs` 会以安卓工程那份为准并**自动同步**到这里，
所以「仓库里不带安卓代码」与「本地改一处两边都生效」可以同时成立。

## 五、几个实现要点（踩过的坑都写在这里）

* **界面零改动**：`app.js` 只认 `window.PK` / `window.VOD`，网页版就把这两个对象用 JS 实现出来；
  `PK.web = true` 让界面知道「这是浏览器」，据此收掉原生专属入口并补上全屏/音量/键盘。
* **广告过滤同源**：`web/adfilter.js` 是 App 里 `AdFilter.java` 的 JS 端口，规则一一对应；
  实测同一份真实清单，两边删除结果完全一致（708→699 / 1240→1240）。
* **本地代理换成 Service Worker**：拦 `/p?q=…&r=…&c=…` 清洗 m3u8 并把清单里每条地址
  （含 `URI="…"`）改写成走代理；分片原样透传（保留 Range/206）。
* **目标地址一律用 base64url 放在 `q` 参数里**（`u=<URL>` 仅作老客户端兜底）：
  少一层转义、也不容易被边缘规则当成「疑似 SSRF」。
* **代理必须带 User-Agent**：实测采集站的 WAF 会直接拒掉「没有 UA」的请求并回一张
  `403 Forbidden By WAF` 的 HTML，代理会把它原样透传，看起来就像「代理被墙了」。
  所以 `web/proxy/worker.js` 里补了默认 UA —— 这是排查了整整一轮才定位到的坑。
* **关于缓存（三层，都有）**：
  1. 浏览器 HTTP 缓存 —— 资源带 ETag + `must-revalidate`，改了就立刻生效，没改走 304；
  2. Cloudflare 边缘缓存 —— `cf-cache-status: HIT`，同样按 ETag 回源校验；
  3. 播放缓存 —— hls.js 预缓冲（目标 60 秒 / 上限 3 分钟 / 字节上限 80MB，设置里可切档位），
     进度条上那段浅色就是「已缓存到哪」；Service Worker 还缓存了最近 40 份清单。
     页面更新后看到旧内容时，强制刷新一次（`Ctrl/Cmd+Shift+R`）即可。

## 六、免责声明

仅供个人学习与自用，请勿用于商业用途或传播侵权内容。
解析能力来自公开的第三方接口，它们随时可能失效，一条不通换一条是常态。
