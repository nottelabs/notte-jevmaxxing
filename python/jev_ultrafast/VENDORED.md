# Vendored from browser-use/jev-ultrafast

Source: https://github.com/browser-use/jev-ultrafast at commit `452c1ad2dd628008f1d5608f28158d76e49e6cc0` (MIT, see `LICENSE`).

Copied: `__init__.py`, `agent.py`, `browser.py`, `demo.py`, `model.py`, `questions.py`, `snapshot.js`.
Not copied: `static/` (this repo serves its own UI from `python/public/`).

Only change: `browser.py` no longer imports `browser_harness`. Its two imports (`ensure_daemon`, `cdp`) were
replaced by a `cdp` placeholder that `notte_jev/browser.py` overrides with a direct websocket to the Notte
session, and the `ensure_daemon()` call in `Browser.__init__` was removed (`NotteBrowser` has its own `__init__`).
That drops the `browser-harness` dependency (and its `cdp-use`, `fetch-use` dependencies), which was installed
but never used here.

To update: copy the same files from a newer commit and reapply that change.
