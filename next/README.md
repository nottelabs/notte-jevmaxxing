# notte-jevmaxxing (Next.js)

The hosted version: [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)'s loop in TypeScript on [Notte](https://docs.notte.cc) cloud browsers.

```bash
npm install
cp .env.example .env.local   # NOTTE_API_KEY, TYPESAFE_API_KEY, TEXT_MODEL_API_KEY (OpenRouter)
npm run dev                  # http://localhost:3000
npm run guards               # 22 freshness/execution checks on a real Notte browser, no model calls
```

## How it is serverless

One run is one request. `POST /api/run` starts a Notte session, streams its `viewer_url` first (the page embeds the
live viewer), then holds the session's CDP websocket for the run and streams every step as a line of JSON. The session
is stopped when the run ends or the client disconnects (Stop aborts the request). Nothing is kept between requests,
so any instance can serve any run. Step replay lives in the browser tab.

- `lib/agent.ts` is the loop: page -> indexed elements -> operation + target -> execution.
- `lib/browser.ts` is observe / fresh / act with jev's guards. Commands that do not depend on each other share a round trip.
- `lib/cdp.ts` is one websocket where every command is a promise.
- `lib/model.ts` has the TypeSafe decision and the text helper.
- `lib/snapshot.ts` is jev's page reader, generated verbatim by `scripts/sync-snapshot.mjs` from `../python/jev_ultrafast/snapshot.js`.

## Deploying on Vercel

- Set the project's **Root Directory** to `next`.
- Add the variables from `.env.example`. **Set `RUN_PASSWORD`** on anything public: every Start spends Notte and model credits.
- `vercel.json` pins functions to `iad1`. Each CDP command is a round trip to the Notte browser, so the function
  should run in the region closest to it; measure and change `regions` if that is not `iad1`.

## Wikipedia race

Open `/race` for Jev vs a Cerebras-hosted model in two Notte browsers. The original inspector remains at `/`.
Set `NOTTE_API_KEY`, `TYPESAFE_API_KEY`, and `CEREBRAS_API_KEY` in `.env.local`.
`TYPESAFE_MODEL` defaults to `jev-latest`; `CEREBRAS_MODEL` defaults to `gpt-oss-120b` with low reasoning effort.

For recording, click **Prepare browsers** first. Both sessions wait on the starting article without making model calls. Once both viewers show Wikipedia, click **Start race** for a three-second countdown. Preparation and countdown are excluded from race timing. The prepared sessions expire after 90 seconds if you do not start; Cancel releases them sooner. The start capability is encrypted, expires with the preparation, and works across Vercel instances without an in-memory coordination map.

The UI labels the model as well as the provider. Other Cerebras models must support strict JSON-schema outputs.
No text-helper key is needed for a race. The existing `RUN_PASSWORD` protects both run endpoints.

Both browsers resolve the target and load the start before a shared server timer begins. Each model receives
the current article's first 6,000 characters, visited titles, and the first 250 unique eligible links in DOM order.
The same extraction and instructions apply to both providers. Links beyond the viewport are allowed: the executor
scrolls to the chosen link and clicks it through CDP. Navigation, references, namespaces, external links, and search
are excluded. A link to the target is never injected or prioritized by the executor.

Visited state includes both landed article titles and clicked redirect aliases. Each offered link carries an
`already_visited` flag, supplied to both models and Jev's choice descriptions. Revisited links remain available;
this makes the history explicit without turning the race into a hard no-revisit game. The models can still loop.

The server verifies arrival using the loaded article's canonical URL, including redirects. Lowest elapsed finish
time wins; both contestants can finish. Each has 20 hops and a shared 120-second deadline. Setup is excluded;
inference, clicking, and page loading are included. Model latency reports successful requests, not failed calls.
Failures and limits remain visible. Download race data to keep the paths, timings, and model IDs.

Stop or disconnect cancels model calls and closes both browser connections. Session cleanup is kept alive with
Next.js `after()`, with a five-minute session duration as a fallback. Runs require two concurrent Notte sessions.
This is a live demonstration, not a statistically controlled benchmark; website and provider latency vary.

```bash
npm run test:race  # Offline rule, lifecycle, and provider-adapter tests
npx playwright install chromium  # One-time browser test setup
npm run test:wiki-browser  # Local DOM tests for hidden/sidebar links and click guards
npm run build
```
