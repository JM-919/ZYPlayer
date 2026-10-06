#!/usr/bin/env node
/**
 * 把网页版部署成 Cloudflare Worker 的"静态资源 + 代理"一体服务。
 *
 *   CF_API_TOKEN=xxx CF_ACCOUNT_ID=xxx node web/deploy-worker.mjs
 *   可选: CF_WORKER_NAME(默认 cool-sea-dfd8)、CF_ZONE_ID + --domain <主机名>(顺带绑自定义域)
 *
 * 为什么不用 wrangler: 工程里没有 node_modules, 而这条链路一共四步, Node 18+ 自带的
 * fetch/FormData/Blob 就够 —— 零依赖, GitHub Actions 里也能直接跑。
 *
 * 四步(Cloudflare 静态资源上传协议, 全部实测过):
 *   ① 按 md5 算清单 {" /index.html": {hash,size}, …}
 *      必须 md5(32 位十六进制); 用 sha256(64 位)会被拒:
 *      `Invalid manifest: file hash size of 64 is too large`
 *   ② POST …/workers/scripts/<名字>/assets-upload-session → {jwt, buckets}
 *   ③ POST …/workers/assets/upload?base64=true            → {jwt}(完成令牌)
 *      多部分表单: 字段名 = 文件 md5, 字段值 = 该文件 base64
 *   ④ PUT  …/workers/scripts/<名字>: metadata 带
 *      { main_module, compatibility_date, assets:{ jwt, config:{ not_found_handling } } },
 *      worker.js 作为 application/javascript+module 一起传
 *
 * 资源与 Worker 的分工(默认行为, 不用 run_worker_first):
 *   命中资源 → Cloudflare 直接回(不经过 Worker, 更快);
 *   没命中 → 交给 worker.js 的 fetch(`/f`、`/p` 靠这个走代理);
 *   not_found_handling=single-page-application → 前端路由兜底交给 index.html。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, 'dist');
const WORKER = join(here, 'proxy', 'worker.js');

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const SCRIPT = process.env.CF_WORKER_NAME || 'cool-sea-dfd8';
const ZONE = process.env.CF_ZONE_ID || '';
const args = process.argv.slice(2);
const domainArg = args.indexOf('--domain') >= 0 ? args[args.indexOf('--domain') + 1] : '';

if (!TOKEN || !ACCOUNT) { console.error('缺 CF_API_TOKEN / CF_ACCOUNT_ID'); process.exit(1); }
if (!existsSync(DIST) || !existsSync(WORKER)) { console.error('先跑 node web/build-web.mjs 生成 web/dist'); process.exit(1); }

async function api(path, { method = 'GET', body, headers = {}, authorizedBy } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + (authorizedBy || TOKEN), ...headers },
    body
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (!json.success) {
    throw new Error(`${method} ${path} 失败: ${(json.errors || []).map(e => e.message).join('; ') || text.slice(0, 300)}`);
  }
  return json.result;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

const files = walk(DIST);
const manifest = {};
const bytes = {};
for (const p of files) {
  const key = '/' + relative(DIST, p).split(sep).join('/');
  const buf = readFileSync(p);
  const hash = createHash('md5').update(buf).digest('hex');
  manifest[key] = { hash, size: buf.length };
  bytes[hash] = buf;
}
console.log(`[部署] web/dist ${files.length} 个文件, ${Object.values(manifest).reduce((a, b) => a + b.size, 0)} 字节`);

const session = await api(`/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/assets-upload-session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest })
});
console.log(`[部署] 上传会话 ok(${(session.buckets || []).length} 个桶)`);

// 手搓 multipart: 不用 fetch 自带的 FormData —— 实测 Node 的 FormData 打到这个端点会被回
// `Unauthorized`, 而同样是这几行、换成显式拼出来的 multipart 就通(和 curl 的行为一致)。
function multipart(parts) {
  const B = '----zyweb' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const p of parts) {
    const head =
      `--${B}\r\n` +
      `Content-Disposition: form-data; name="${p.name}"` + (p.filename ? `; filename="${p.filename}"` : '') + '\r\n' +
      (p.type ? `Content-Type: ${p.type}\r\n` : '') + '\r\n';
    chunks.push(Buffer.from(head, 'utf8'), p.data, Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${B}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${B}` };
}

const up = multipart(Object.entries(bytes).map(([hash, buf]) => ({
  name: hash, data: Buffer.from(buf.toString('base64'), 'utf8')
})));
// buckets 为 0 = 这批文件 Cloudflare 已经有了(内容寻址去重), 此时**不需要**再传内容,
// 直接用会话 jwt 当完成令牌 —— 头一次部署是全 0 还是空手上去试, 会回 `Unauthorized`。
let doneJwt = session.jwt;
if ((session.buckets || []).length) {
  const done = await api(`/accounts/${ACCOUNT}/workers/assets/upload?base64=true`, {
    method: 'POST', headers: { 'Content-Type': up.type }, body: up.body, authorizedBy: session.jwt
  });
  doneJwt = done.jwt;
  console.log('[部署] 静态资源上传 ok');
} else {
  console.log('[部署] 静态资源 Cloudflare 已有(内容相同), 跳过上传');
}

const metadata = {
  main_module: 'worker.js',
  compatibility_date: '2026-10-06',
  assets: { jwt: doneJwt, config: { not_found_handling: 'single-page-application' } }
};
const sp = multipart([
  { name: 'metadata', data: Buffer.from(JSON.stringify(metadata), 'utf8'), type: 'application/json' },
  { name: 'worker.js', filename: 'worker.js', data: readFileSync(WORKER), type: 'application/javascript+module' }
]);
await api(`/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}`, {
  method: 'PUT', headers: { 'Content-Type': sp.type }, body: sp.body
});
console.log(`[部署] Worker ${SCRIPT} 已更新(静态资源 + 代理)`);

if (domainArg && ZONE) {
  try {
    await api(`/accounts/${ACCOUNT}/workers/domains`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone_id: ZONE, hostname: domainArg, service: SCRIPT, environment: 'production' })
    });
    console.log(`[部署] 已绑定 ${domainArg}`);
  } catch (e) { console.warn('[部署] 绑定域名跳过: ' + e.message); }
}
console.log('[部署] 完成 ✓');
