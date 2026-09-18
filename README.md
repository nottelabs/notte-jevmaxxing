# notte-jev

[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) running on a [Notte](https://docs.notte.cc) browser session.

jev drives Chrome through Browser Harness, which takes any CDP websocket via `BU_CDP_WS`.
A Notte session gives you one with `session.cdp_url()`. This package wires the two together and nothing else.

```bash
uv sync
cp .env.example .env   # add TYPESAFE_API_KEY + TEXT_MODEL_API_KEY; NOTTE_API_KEY or `notte auth login`
uv run --env-file .env notte-jev \
  --url https://en.wikipedia.org/wiki/Main_Page \
  --goal "Find and open the Wikipedia article about Gödel's incompleteness theorems." \
  --viewer
```

As a library:

```python
from notte_jev import notte_agent

with notte_agent("https://www.google.com/travel/flights?hl=en",
                 "Find one-way flights from Zurich to London on September 20, 2026.",
                 proxies=True, solve_captchas=True) as agent:
    for state in agent.run():
        print(state["elapsed_ms"], state["status"])
```

Keyword arguments go to `NotteClient().Session(...)`. The session and the harness daemon are stopped when the block exits.
