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
    """Serve jev's local inspector (http://127.0.0.1:8766) on a Notte browser.

    Only the Google Flights scenario works here: the travel/research fixtures
    are served from localhost, which a cloud browser cannot reach.
    """
    from jev_ultrafast import demo

    demo.load_environment()
    session = NotteClient().Session(open_viewer=True, idle_timeout_minutes=15, max_duration_minutes=30)
    session.start()
    name = f"notte-{session.session_id[:8]}"
    try:
        _point_harness_at(name, session.cdp_url())
        demo.main()
    finally:
        from browser_harness.admin import restart_daemon

        demo.close_browser()
        restart_daemon(name)
        session.stop()
