# notte-jevmaxxing

[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) running on [Notte](https://docs.notte.cc) cloud browsers.
Type a task, press Start, and watch Jev pick each action from the page's action space.

```bash
uv sync
cp .env.example .env   # NOTTE_API_KEY, TYPESAFE_API_KEY, TEXT_MODEL_API_KEY (OpenRouter)
uv run --env-file .env notte-jevmaxxing
```

Open http://127.0.0.1:8766. The page starts a Notte session as soon as it opens and embeds its live viewer, so the browser is already streaming when you press Start; each task gets a fresh session. A URL in the task is used as the start page, otherwise google.com.

- `notte_jev/__init__.py` starts a Notte session and runs jev on it.
- `notte_jev/browser.py` is jev's browser over the session's CDP websocket, with commands pipelined for a remote browser.
- `public/` is the UI.
