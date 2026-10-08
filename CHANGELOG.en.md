> 本文档只讲**网页版**（Cloudflare Worker 上的静态站 + Service Worker 代理）。安卓 App 的说明在
> 工程根目录 `README.md` / `介绍.md` / `CHANGELOG*.md`，两边不许混写。

# Changelog (web edition)

### Fix · landscape / portrait / fullscreen were all broken (2026-10-09)

Reported as "the web player's landscape, portrait and fullscreen are all broken". Reproduced on the
real device (default phone browser Via, WebView engine) and pinned to three causes:

1. **`screen.orientation.lock()` exists but always rejects**
   (`NotSupportedError: … is not available on this device`). The old code trusted the mere presence of
   the function, so the button stayed but did nothing, and the rejection was swallowed by a `catch`.
   **Fix**: use the real lock when it works; otherwise rotate the player content ourselves — the whole
   `#player` is wrapped in `#pklayer`, sized `innerHeight × innerWidth` and rotated 90°, so holding the
   phone sideways gives a full-screen upright picture. The layer removes itself as soon as the device
   really rotates. Pressing "portrait" while the phone is still physically sideways rotates it −90°.
2. **Tapping "landscape" also hit "back" and closed the player** — the click the browser synthesises
   after `touchend` landed on whatever button had moved under the same coordinate. **Fix**: the rotation
   is applied one beat later (350 ms); requested mode and applied mode are tracked separately.
3. **"Back" inside fullscreen left a black screen** (the player was hidden while the browser stayed in
   fullscreen). **Fix**: closing the player now exits fullscreen and clears the rotation layer.

Fullscreen itself was hardened too (all vendor prefixes + iOS `video.webkitDisplayingFullscreen`,
honest `false` when the API is missing), and the player gestures are axis-swapped under the rotated
layer. New self-test gates `[1h]`/`[1i]` (25 checks) lock all three invariants down.

### Fix · Douban posters + clarify Douban's role (2026-10-07 late night)

* **Third cause of blank posters**: the Service Worker's fallback upstream used to depend on whether the proxy
  config had been read; without it the raw **418** was handed to the `<img>`. The fallback is now unconditional
  (the site itself is the Worker, so same-origin `/p` works too).
* **Douban's role is now fixed to three things**: rating / poster / plot. Playback always goes through the
  scraper sources: tapping a collection item searches all sources by title, then opens the detail page.
* Detail page now fills the gaps: the source's poster wins, otherwise Douban's (proxied with a Referer);
  if the source has no plot, Douban's intro is shown.

### Fix · portrait layout was clipped (2026-10-07 late night)

While copying the blog's responsive approach I changed two things I should not have; both reverted:

* **Scroll model**: the blog is a normal web page (document scroll), but this UI is an app shell with
  `#main` scrolling internally. Switching to document scroll made narrow screens clip overflowing content —
  reverted to the app's original scroll model (only the *layout* part of the responsive work is kept).
* **Percentage padding on the player control bars**: nice on wide screens, but it pushed the "选集" button
  off-screen on phones — now only applies at ≥880px; phones keep the app's 12px.
* Also removed a few leftover player style lines from the deleted skin (gradient bars, pill buttons, glow).

### Fix · Douban posters were blank (2026-10-07 late night)

* The API returns `cover.url` (**no `pic` field**), so the card `src` was always empty;
* Even with the right URL, Douban's image CDN gates on `Referer` (none → 418, our origin → 403, douban → 200)
  and an `<img>` cannot set it — posters now go through the proxy (`/p?...&r=https://m.douban.com/`),
  with the Worker/relay filling the Referer server-side. Verified: `200 · 53,132 B · image/jpeg`.

## 2026-10-07 (evening) · Douban-driven home + blog-style responsive layout

* **Home/refresh now use Douban collections** (now showing / hot movies / hot TV / variety / anime):
  the home page no longer depends on any scraper source. Tapping an item searches all sources by title
  and opens the first same-title result.
* **Removed the tiny `vdev` badge**: the build check still runs quietly (auto-reload when idle,
  console note while watching).
* **Web defaults**: silent hints ON, on-screen OSD OFF, avoid burned-in-ad sources OFF.
* **Blog-style responsive layout**: natural document scrolling, 1080px container, fluid
  `repeat(auto-fill,minmax(...))` grids, breakpoints 560/720/880/1180 (same approach as felixdsh2.eu.cc).

## 2026-10-07 · VOD-only: live TV removed, new skin reverted

* **Live TV removed from the web edition entirely**: the top-bar entry, the live page, the channel tables and
  the live-related settings rows are gone; all live code in the bridge (feed fetching/parsing/merging/probing,
  `PK.live*`) was deleted (~6.3 KB). **This edition is video-on-demand only.**
* **New skin reverted**: the Aurora Glass layer (floating header island, aurora palette, large rounded cards,
  ~6.5 KB of CSS) was removed; the pre-skin styling is back. Only the desktop responsive layout is kept.
* **Reverted the regressions that broke VOD**: the Worker no longer rewrites playlists (it dragged segments
  onto the overseas egress → 403 from domestic CDNs); media goes back through the Service Worker, fetching
  from the user's own network. The live-only Worker path and the "bad source memory" were removed too.
* **No more premature errors**: the transient 404/timeout while hls.js starts no longer shows a message;
  the reason is only kept on screen when playback truly cannot start and there is no fallback source.
* **Docs are separated**: web docs live in `web/` only; Android docs stay at the project root.


## 1.0.0-web — first public web release

* **Split out of the Android project**: this repo now hosts the web edition only; the UI sources
  live in `web/site/` (kept in sync with the local Android project by `build-web.mjs`).
* **Site and proxy on one host**: the static site is bundled into the Cloudflare Worker which also
  serves the `/f` and `/p` proxy endpoints — no DNS permission required. A second host
  `zyapi.hof12.ccwu.cc` is kept as a spare entry point.
* **Fixed "no sound on desktop"**: the `muted` left behind by browser autoplay policies is cleared
  before playback, and when a policy still blocks `play()` the page shows an explicit
  "tap to start" overlay. Added a volume slider / mute button in Settings plus `↑`/`↓` and
  mouse-wheel volume control.
* **Fixed "rotation does not work"**: enter fullscreen first, then lock orientation (which is what
  browsers require); the button is hidden on desktop browsers that cannot lock at all.
* **Removed Android-only features from the web UI** (buttons, entry points and drawers):
  DLNA casting, VIP parse lines, TVBox spider jars, launching an external player, in-app updates
  and local-file playback. The Android app is untouched.
* **Better desktop player**: fullscreen button, keyboard shortcuts
  (`Space`/`←→`/`↑↓`/`F`/`M`/`Shift`+wheel) and mouse-wheel volume.
* Page title `PikachuTV` → **ZY影视**.
* Two proxy pitfalls documented in code and docs: target URLs now travel as base64url in `q`,
  and the proxy **must** send a User-Agent (UA-less requests get an HTML `403 Forbidden By WAF`
  from CMS WAFs which the proxy would pass through verbatim, looking like a blocked proxy).
