# Changelog (web edition)

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
