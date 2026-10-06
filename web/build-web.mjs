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

const SPA_FILES = ['index.html', 'app.js', 'hls.min.js', 'legacy.css'];
const androidAssets = join(rootDir, 'pikachu-dl', 'android', 'assets');
const siteDir = join(here, 'site');

let assets = siteDir;
if (existsSync(androidAssets)) {
  assets = androidAssets;
  // 本地改完界面顺手把仓库里那份对齐(内容一样就不动, 免得每次构建都改 mtime)
  mkdirSync(siteDir, { recursive: true });
  for (const f of SPA_FILES) {
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
for (const f of SPA_FILES) {
  if (existsSync(join(assets, f))) cpSync(join(assets, f), join(dist, f));
}
['bridge.js', 'sw.js', 'adfilter.js'].forEach(f => cpSync(join(here, f), join(dist, f)));

// legacy.css 由 tools/legacy_css.py 生成; 现代浏览器根本不会去请求它, 有就行
const legacy = join(dist, 'legacy.css');
if (!existsSync(legacy)) writeFileSync(legacy, '/* 老内核兼容样式; 见 tools/legacy_css.py */\n');

const inject = `
<!-- 网页版: JS 桥(替代 Android 侧) + Service Worker(本地代理/广告过滤) -->
<script src="webconfig.js"></script>
<script src="bridge.js"></script>
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
if (html.indexOf('bridge.js') < 0) html = html.replace('</body>', inject + '</body>');
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

writeFileSync(join(dist, '.nojekyll'), '');
console.log('[web] 生成完毕: ' + dist);
console.log('[web] 别忘了在 webconfig.js(或页面设置里)填 CORS 代理地址, 否则只有允许跨域的接口能用');
