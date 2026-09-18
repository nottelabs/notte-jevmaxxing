"""Plug a Notte browser session into jev-ultrafast.

jev-ultrafast drives Chrome through Browser Harness, which accepts any CDP
websocket via BU_CDP_WS. A Notte session exposes exactly that, so all this
does is: start a session, point the harness at its CDP URL, run the agent.
"""

import os
from contextlib import contextmanager

from notte_sdk import NotteClient


@contextmanager
def notte_agent(url, goal, **session_kwargs):
    """Yield a jev_ultrafast.Agent whose browser is a Notte session.

    session_kwargs go straight to NotteClient().Session(...), e.g.
    proxies=True, solve_captchas=True, open_viewer=True.
    """
    session = NotteClient().Session(**session_kwargs)
    session.start()
    name = f"notte-{session.session_id[:8]}"  # one harness daemon per session
    try:
        _point_harness_at(name, session.cdp_url())
        from jev_ultrafast import Agent

        with Agent(url, goal) as agent:
            yield agent
    finally:
        from browser_harness.admin import restart_daemon  # "restart" only stops

        restart_daemon(name)
        session.stop()


def _point_harness_at(name, cdp_ws):
    # The daemon subprocess reads these from os.environ when spawned.
    os.environ["BU_NAME"] = name
    os.environ["BU_CDP_WS"] = cdp_ws
    # The client side caches BU_NAME at import time; override in case
    # browser_harness (or jev_ultrafast) was imported before we ran.
    from browser_harness import _ipc, admin, helpers

    helpers.NAME = admin.NAME = name
    helpers.SOCK = _ipc.sock_addr(name)
    # A remote browser answers slower than local Chrome; the harness default of 5s pauses runs mid-click.
    import functools

    import jev_ultrafast.browser as jev_browser

    jev_browser.cdp = functools.partial(helpers.cdp, _response_timeout=30)


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Run jev-ultrafast on a Notte browser.")
    parser.add_argument("--url", required=True)
    parser.add_argument("--goal", action="append", required=True, help="Repeat for an ordered list of goals.")
    parser.add_argument("--viewer", action="store_true", help="Open the Notte live viewer.")
    parser.add_argument("--proxies", action="store_true", help="Use Notte's default proxies.")
    args = parser.parse_args()

    with notte_agent(args.url, args.goal, open_viewer=args.viewer, proxies=args.proxies) as agent:
        for state in agent.run():
            print(f"{state['elapsed_ms']:>5} ms  {len(state['history'])} actions  {state['status']}")
        print(state["page"]["url"])


def inspector():
    """Serve the Notte Jevmaxxing UI (http://127.0.0.1:8766).

    Reuses jev's demo server and agent loop. Every Start gets a fresh Notte
    session, so an idle or expired browser connection never breaks a new task.
    """
    import threading
    from pathlib import Path

    from browser_harness.admin import restart_daemon
    from jev_ultrafast import Agent, demo

    current = {"session": None, "name": None}

    def stop_current(wait=False):
        # Stopping a session takes ~15s; do it in the background so the next Start isn't blocked.
        demo.AGENT = None  # the tab dies with its session
        old = (current["session"], current["name"])
        current.update(session=None, name=None)

        def cleanup():
            session, name = old
            for step in (lambda: name and restart_daemon(name), lambda: session and session.stop()):
                try:
                    step()
                except Exception:
                    pass

        worker = threading.Thread(target=cleanup, daemon=not wait)
        worker.start()
        if wait:
            worker.join()

    def command(name, body):
        if name != "reset":
            return demo_command(name, body)
        url, goal = body.get("scenario", "").strip(), body.get("goal", "").strip()
        if not url.startswith(("http://", "https://")):
            raise ValueError("Enter a full http(s) URL")
        if not 0 < len(goal) <= 2000:
            raise ValueError("Enter a task of 1–2,000 characters")
        stop_current()
        # No proxies: pages load about 2x faster. Pass proxies=True for sites that block datacenter IPs.
        session = NotteClient().Session(proxies=False, idle_timeout_minutes=5, max_duration_minutes=30)
        session.start()
        current.update(session=session, name=f"notte-{session.session_id[:8]}")
        _point_harness_at(current["name"], session.cdp_url())
        demo.AGENT = Agent(url, goal, screenshots=True)
        return demo.response_state()

    demo_command, demo.command = demo.command, command
    class _Root:  # jev's server reads ROOT / "static" / file; serve the repo's public/ instead
        parent = Path(__file__).parent.parent

        def __truediv__(self, part):
            return self.parent / ("public" if part == "static" else part)

    demo.ROOT = _Root()
    demo.load_environment()
    try:
        demo.main()
    finally:
        stop_current(wait=True)
