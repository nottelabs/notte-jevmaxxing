# notte-jevmaxxing (Python)

[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) on [Notte](https://docs.notte.cc) cloud browsers, as a local inspector.

```bash
uv sync
cp .env.example .env   # NOTTE_API_KEY, TYPESAFE_API_KEY, TEXT_MODEL_API_KEY (OpenRouter)
uv run --env-file .env notte-jevmaxxing
```

Open http://127.0.0.1:8766. Each Start opens a fresh Notte session and embeds its live viewer.

- `notte_jev/__init__.py` starts a Notte session and runs jev on it.
- `notte_jev/browser.py` is jev's browser over the session's CDP websocket, with commands pipelined for a remote browser.
- `jev_ultrafast/` is vendored from upstream without its Browser Harness dependency; see `jev_ultrafast/VENDORED.md`.
- `public/` is the UI.

This server keeps the agent and the CDP websocket in process memory across requests, so it is a local tool.
The hosted version is the Next.js app in `../next`.
