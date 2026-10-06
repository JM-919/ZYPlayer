# Changelog (web edition)

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
