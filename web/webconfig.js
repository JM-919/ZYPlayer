/* 网页版配置(站点所有者只改这一个文件)
 *
 * 1) 先去 Cloudflare 建一个 Worker, 把 web/proxy/worker.js 整个粘进去,
 *    改掉里面的 TOKEN(建议换成你自己的随机串), 保存后拿到 https://<名字>.<账号>.workers.dev
 * 2) 把地址填到下面 proxy(写完整 'https://…' 最稳; 只写域名也会自动补 https://),
 *    并把 token 改成同一个值
 * 3) worker 里的 ALLOW_HOSTS 留空 [] —— 除非你要收紧, 否则采集源会被 403 'host not allowed'
 * 4) push 后 GitHub Actions 会重新发布 Pages, 打开页面即可搜索/播放
 *
 * 不想改文件也行: 打开页面后执行下面这行(存在 localStorage, 刷新即生效)
 *   localStorage.setItem('zyweb_cfg', JSON.stringify({proxy:'https://xxx.workers.dev', token:'你的TOKEN'})); location.reload();
 */
window.ZYWEB = (function () {
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('zyweb_cfg') || '{}'); } catch (e) {}
  return {
    proxy: saved.proxy || 'https://zyapi.hof12.ccwu.cc',        // ← 例如 'https://zy-proxy.abc.workers.dev'
    token: saved.token || 'a7ebc133-bf1b-4605-a914-cedeeb9b1e7f',   // ← 与 worker 里的 TOKEN 一致
    version: '3.1-web'
  };
})();
