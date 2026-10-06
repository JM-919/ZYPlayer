# ZY影视 · Web Edition

> **本文档只讲「网页版」**（`web/`）。安卓 App 的文档在**工程根目录**（`README.md` / `介绍.md` / `CHANGELOG*.md`）与
> `pikachu-dl/README.md`。两套文档**分开保存、互不混写**：网页版仓库（GitHub）里只有网页版文档。

> **Live: <https://zyplayer.hof12.ccwu.cc/>** — open it in any phone/desktop browser, no install.
>
> This is the web edition of ZY影视: aggregated movie/TV search, multi-source playback and
> ad filtering, all inside the browser. This file is also the repo's root README.

One UI, two runtimes: `index.html` / `app.js` are **the exact same files** as in the Android app.
The web edition only replaces the native layer with JavaScript — a bridge (`bridge.js`),
a Service Worker acting as the local proxy + ad filter (`sw.js` + `adfilter.js`),
and a tiny CORS proxy (`proxy/worker.js`).

## Scope: **video-on-demand only, no live TV**

The web edition has **dropped live TV entirely** (entry button, page, channel tables, settings and code all removed):
browsers cannot play most domestic IPTV streams (mixed content, port allow-lists, geo-blocking), and keeping it only
made the player look broken. Use the Android app for live TV.

## What works

| Capability | Web | Notes |
|---|---|---|
| Aggregated search (20+ CMS sources) | ✅ | fetched through a self-hosted CORS proxy |
| Detail page / source switching | ✅ | only switches to “same title + same episode”, identical rule to the app |
| Playback (hls.js) + **ad filtering** | ✅ | m3u8 is cleaned by the Service Worker: CUE/SCTE-35 ad blocks, injected subtitle groups, ad segments, cross-directory insert blocks, short mid-roll blocks |
| Sources needing Referer / UA | ✅ | the proxy fills them in server-side |
| Decrypting TVBox configs (incl. AES) | ✅ | WebCrypto AES-128-CBC, same extraction logic |
| Douban ratings | ✅ | also through the proxy |
| Watch progress / continue watching | ✅ | stored in localStorage |
| Speed / auto-next / skip intro&outro / aspect ratio / volume / fullscreen | ✅ | desktop also gets keyboard + wheel controls |

**Android-only features that a browser simply cannot do have been removed from the web UI**
(buttons and drawers are gone, not merely greyed out):

* DLNA casting — no SSDP/UDP sockets, no arbitrary TCP in a browser;
* “VIP parse lines” / platform-page sniffing — the app sniffs traffic in a hidden WebView;
  a browser cannot read cross-origin iframes;
* TVBox spider jars — they need DexClassLoader;
* launching an external player, in-app updates, playing locally downloaded files — all native.

## On a desktop

Search → pick an episode → play.

* **No sound?** Browsers require a user gesture before unmuted playback: click anywhere once
  (the page shows “▶ tap to start”). There is also a volume slider / mute button in the player
  **Settings**, and `↑`/`↓` or the mouse wheel adjust volume.
* **Shortcuts**: `Space`/`K` play-pause, `←`/`→` seek ±10 s, `↑`/`↓` or wheel = volume,
  `F` fullscreen (player area only, not the browser F11), `M` mute, `Shift`+wheel jumps ±10 s.
* **Screen too dark/bright**: drag vertically on the video (mapped to a CSS brightness filter).
* **Phone rotation**: the “landscape” button enters fullscreen first and then locks orientation
  (browsers only allow locking while fullscreen); desktop browsers cannot lock, so that button is hidden.

## Deployment

**A. Single Cloudflare Worker (what the live site uses)** — one Worker serves both the static
site and the `/f` `/p` proxy; no DNS permission needed:

```bash
node web/build-web.mjs
CF_API_TOKEN=xxx CF_ACCOUNT_ID=xxx node web/deploy-worker.mjs --domain your.domain
```

**B. GitHub Pages + a separate proxy** — set Pages source to *GitHub Actions*, deploy
`web/proxy/worker.js` as a Cloudflare Worker (change `TOKEN`, **keep `ALLOW_HOSTS = []`** —
it is the upstream allow-list; filling it in makes every source return 403), then put its URL
into `web/webconfig.js` → `proxy` (or set it at runtime via `localStorage 'zyweb_cfg'`).

## Local preview

```bash
node web/build-web.mjs
python3 -m http.server 8080 -d web/dist     # http://localhost:8080
```

The Service Worker only runs on `https://` or `localhost`.

## Implementation notes

* **Zero UI changes**: `app.js` only talks to `window.PK` / `window.VOD`; the web edition implements
  both in JS. `PK.web = true` tells the UI it is in a browser, so native-only entry points are removed
  and fullscreen/volume/keyboard support is added.
* **Same ad filter**: `web/adfilter.js` is a JS port of the app's `AdFilter.java`; on identical real
  playlists both delete exactly the same segments (708→699 / 1240→1240).
* **Service Worker replaces the local proxy**: it intercepts `/p?q=…&r=…&c=…`, cleans the m3u8 and
  rewrites every URI (including `URI="…"`) to go through the proxy; segments pass through untouched (Range/206 kept).
* **Target URLs travel as base64url in the `q` parameter** (`u=<URL>` kept only for old clients):
  one less escaping layer and less likely to trip edge “SSRF-looking” rules.
* **The proxy must send a User-Agent**: some CMS sites sit behind a WAF that rejects UA-less
  requests with an HTML `403 Forbidden By WAF`, which the proxy would pass through verbatim —
  it looks exactly like “the proxy is blocked”. Root-caused after a full round of testing.
* **Caching (all three layers exist)**: HTTP ETag + `must-revalidate`; Cloudflare edge cache
  (`cf-cache-status: HIT`) with the same revalidation; and hls.js pre-buffering
  (60 s target / 3 min max / 80 MB cap, adjustable in settings) plus a 40-playlist Service Worker cache.
  If you still see an old page, hard-refresh (`Ctrl/Cmd+Shift+R`).

## Disclaimer

For personal study and private use only. Do not use commercially or to redistribute infringing content.
All parsing relies on public third-party endpoints that come and go.
