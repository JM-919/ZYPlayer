#!/usr/bin/env node
/**
 * 把界面(index.html / app.js / hls.min.js / legacy.css) 组装成可直接托管的静态站点。
 *
 *   node web/build-web.mjs            → 生成 web/dist/
 *
 * 界面源码在哪:
 *   本地(有 Android 工程时)以 `pikachu-dl/android/assets/` 为准 —— 那是 App 与网页版共用的同一份界面,
 *   并顺手**同步一份**到 `web/site/`, 免得仓库里那份过期;
 *   只有网页版(没有 Android 目录, 比如 GitHub 上这个仓库)时, 直接用 `web/site/`。
 *   所以"GitHub 仓库里不带安卓代码"与"本地改一处两边都对"这两件事可以同时成立。
 *
 * 做四件事:
 *   ① 复制界面源码 → web/dist/
 *   ② 注入 <script src="bridge.js"> 与 Service Worker 注册(界面代码一个字都不用改)
 *   ③ 复制 bridge.js / sw.js / adfilter.js
 *   ④ 写 webconfig.js: 站点所有者填 CORS 代理地址(也可以运行时在设置里改, 存 localStorage)
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');
const dist = join(here, 'dist');

const SPA_FILES = ['index.html', 'app.js', 'hls.min.js', 'legacy.css',
                  // 赞助页的两张收款码: 占位图是 svg; 站点所有者把真实收款码存成同名 .png 即自动替换
                  'sponsor_alipay.svg', 'sponsor_wechat.svg'];
// 用户自己放的真实收款码(可选, 有就一起带上; 前端 <img> 优先 png, 失败才回落到 svg 占位图)
const SPA_OPTIONAL = ['sponsor_alipay.png', 'sponsor_wechat.png', 'sponsor_alipay.jpg', 'sponsor_wechat.jpg'];
const androidAssets = join(rootDir, 'pikachu-dl', 'android', 'assets');
const siteDir = join(here, 'site');

let assets = siteDir;
if (existsSync(androidAssets)) {
  assets = androidAssets;
  // 本地改完界面顺手把仓库里那份对齐(内容一样就不动, 免得每次构建都改 mtime)
  mkdirSync(siteDir, { recursive: true });
  for (const f of SPA_FILES.concat(SPA_OPTIONAL)) {
    const src = join(androidAssets, f), dst = join(siteDir, f);
    if (!existsSync(src)) continue;
    const a = readFileSync(src), b = existsSync(dst) ? readFileSync(dst) : null;
    if (!b || !a.equals(b)) {
      cpSync(src, dst);
      console.log('[web] 同步界面 → web/site/' + f);
    }
  }
} else if (!existsSync(siteDir)) {
  console.error('找不到界面源码(既没有 pikachu-dl/android/assets, 也没有 web/site)');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const f of SPA_FILES.concat(SPA_OPTIONAL)) {
  if (existsSync(join(assets, f))) cpSync(join(assets, f), join(dist, f));
}
['bridge.js', 'sw.js', 'adfilter.js'].forEach(f => cpSync(join(here, f), join(dist, f)));

// legacy.css 由 tools/legacy_css.py 生成; 现代浏览器根本不会去请求它, 有就行
const legacy = join(dist, 'legacy.css');
if (!existsSync(legacy)) writeFileSync(legacy, '/* 老内核兼容样式; 见 tools/legacy_css.py */\n');

let inject = `
<!-- 网页版: JS 桥(替代 Android 侧) + Service Worker(本地代理/广告过滤)
     必须插在 app.js **之前**: 界面代码靠 window.PK 判断"这是在浏览器里"(PK.web),
     插在后面的话 app.js 解析时 PK 还不存在, 网页端专属的界面调整(去掉投屏/解析/更新入口、
     补全屏与音量)就全都不会生效 —— 这个顺序踩过坑。 -->
<script src="webconfig.js?v=__BUILD__"></script>
<script src="bridge.js?v=__BUILD__"></script>
<script>window.__ZYBUILD='__BUILD__';</script>
<script>
(function () {
  if (!navigator.serviceWorker) { console.warn('[ZY影视 网页版] 这个浏览器没有 Service Worker, 广告过滤/需要 Referer 的源会失效'); return; }
  var scope = location.pathname.replace(/[^/]*$/, '');
  navigator.serviceWorker.register(scope + 'sw.js', { scope: scope }).then(function () {
    console.log('[ZY影视 网页版] Service Worker 已注册');
  }).catch(function (e) { console.warn('[ZY影视 网页版] Service Worker 注册失败(需要 https 或 localhost): ' + e.message); });
  navigator.serviceWorker.addEventListener('message', function (ev) {
    if (ev.data && ev.data.type === 'adstats' && window.ZY_onAdStats) window.ZY_onAdStats(ev.data);
  });
})();
</script>
`;
const idx = join(dist, 'index.html');
let html = readFileSync(idx, 'utf8');
// 注入判据必须用"注入块自己的标记", 不能用 indexOf('bridge.js') ——
// 界面源码里有注释提到过 bridge.js, 于是那个判断永远为真、整段注入被跳过,
// 产物里没有 <script src="bridge.js">, window.PK 永远不存在:
// 表现就是"首页不加载 + 直播出不来 + 该删的按钮又回来"(2026-10 真踩过)。
const MARK = '<!-- 网页版: JS 桥';
// 构建指纹: 写进产物 + 资源 URL 的 ?v= —— 这样每次部署浏览器都会当成新地址去取,
// 不会再出现"界面一点没变"(实测被缓存坑过好几轮)。
const BUILD = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
// 给 <html> 打上 web 标记(第一帧就有): 网页端的响应式样式全部写成 `html.web …`,
// App 侧匹配不到; 放这里而不是只靠 JS, 是为了避免"首帧还是手机版样式"的闪动。
html = html.replace(/<html(\s|>)/, '<html class="web"$1');
inject = inject.replace(/__BUILD__/g, BUILD);
if (html.indexOf(MARK) < 0) {
  // 插在界面脚本之前的第一个标记处; 找不到标记才退回 </body>
  const marks = ['<script src="hls.min.js">', '<script src="app.js">', '</body>'];
  let placed = false;
  for (const m of marks) {
    const at = html.indexOf(m);
    if (at > 0) { html = html.slice(0, at) + inject + html.slice(at); placed = true; break; }
  }
  if (!placed) { console.error('[web] 构建失败: 找不到可插入位置(hls.min.js / app.js / </body>)'); process.exit(1); }
} else {
  console.log('[web] 注: 注入块已存在, 跳过(重复构建)');
}
writeFileSync(idx, html);

if (existsSync(join(here, 'webconfig.js'))) {
  cpSync(join(here, 'webconfig.js'), join(dist, 'webconfig.js'));
} else writeFileSync(join(dist, 'webconfig.js'), `/* 网页版配置: 把 proxy 改成你自己部署的 CORS 代理地址(见 web/proxy/worker.js)
   也可以在页面上运行时修改: localStorage.setItem('zyweb_proxy', 'https://xxx.workers.dev') */
window.ZYWEB = (function () {
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('zyweb_cfg') || '{}'); } catch (e) {}
  return {
    proxy: saved.proxy || '',        // 例: 'https://zy-proxy.xxx.workers.dev'
    token: saved.token || 'zyweb',   // 与 worker 里的 TOKEN 一致
    version: '3.1-web'
  };
})();
`);

/* 产物自检(硬闸门): 桥必须在、且在界面脚本之前。
   以前这一步没有, 于是"注入被静默跳过"一直没人发现, 一直到浏览器里 window.PK 不存在才暴露。 */
{
  const built = readFileSync(idx, 'utf8');
  // 注意用 'src="bridge.js'(不带收尾引号): 现在脚本都带 ?v=版本号
  const iBridge = built.indexOf('src="bridge.js');
  const iApp = built.indexOf('src="app.js');
  if (iBridge < 0) { console.error('[web] 构建失败: 产物里没有 <script src="bridge.js...">, 网页端会整片坏掉'); process.exit(1); }
  if (iApp > 0 && iBridge > iApp) { console.error('[web] 构建失败: bridge.js 必须插在 app.js 之前, 否则 PK 迟一步, 界面适配不会生效'); process.exit(1); }
  if (built.indexOf('src="webconfig.js') < 0) { console.error('[web] 构建失败: 产物里没有 webconfig.js'); process.exit(1); }
  if (built.indexOf('__ZYBUILD') < 0) { console.error('[web] 构建失败: 产物里没有构建指纹 __ZYBUILD'); process.exit(1); }
  console.log('[web] 自检通过: 桥在界面脚本之前, webconfig 已注入');
}

// 界面自己的两个脚本也带版本号(HTML 里的引用改名, 文件本体不变)
html = html.replace('<script src="app.js">', '<script src="app.js?v=' + BUILD + '"></script>')
           .replace('<script src="hls.min.js">', '<script src="hls.min.js?v=' + BUILD + '"></script>');
writeFileSync(idx, html);
writeFileSync(join(dist, 'version.json'), JSON.stringify({ v: BUILD }) + '\n');
console.log('[web] 构建版本: ' + BUILD);

writeFileSync(join(dist, '.nojekyll'), '');
console.log('[web] 生成完毕: ' + dist);
console.log('[web] 别忘了在 webconfig.js(或页面设置里)填 CORS 代理地址, 否则只有允许跨域的接口能用');
