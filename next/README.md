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
