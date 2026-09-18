# notte-jevmaxxing

[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) running on [Notte](https://docs.notte.cc) cloud browsers.
Type a task, press Start, and watch Jev pick each action from the page's action space over the live Notte viewer.

| | |
|---|---|
| [`next/`](next) | The hosted app: Next.js, one streaming serverless request per run. Deploy this one. |
| [`python/`](python) | The original local inspector in Python, with jev vendored without Browser Harness. |

Both run the same loop with the same page reader (`python/jev_ultrafast/snapshot.js`) and the same guard checks.
