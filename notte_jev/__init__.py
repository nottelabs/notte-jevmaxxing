"""Plug a Notte browser session into jev-ultrafast.

jev-ultrafast drives Chrome over CDP. A Notte session exposes a CDP websocket,
so all this does is: start a session, give jev a browser on that websocket
(see browser.py), run the agent.
"""

from contextlib import contextmanager

from notte_sdk import NotteClient

from .browser import VIEWPORT, use_session


@contextmanager
def notte_agent(url, goal, **session_kwargs):
    """Yield a jev_ultrafast.Agent whose browser is a Notte session.

    session_kwargs go straight to NotteClient().Session(...), e.g.
    proxies=True, solve_captchas=True, open_viewer=True.
    """
    session = NotteClient().Session(**{**VIEWPORT, **session_kwargs})
    session.start()
    try:
        use_session(session)
        from jev_ultrafast import Agent

        with Agent(url, goal) as agent:
            yield agent
    finally:
        session.stop()


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

    from jev_ultrafast import Agent, demo

    current = {"session": None}

    def stop_current(wait=False):
        # Stopping a session takes ~15s; do it in the background so the next Start isn't blocked.
        demo.AGENT = None  # the tab dies with its session
        session, current["session"] = current["session"], None

        def cleanup():
            try:
                session and session.stop()
            except Exception:
                pass

        worker = threading.Thread(target=cleanup, daemon=not wait)
        worker.start()
        if wait:
            worker.join()

    def command(name, body):
        if name == "session":
            # Answered as soon as the session exists, so the page can embed the live viewer while the agent sets up.
            stop_current()
            # No proxies: pages load about 2x faster. Pass proxies=True for sites that block datacenter IPs.
            session = NotteClient().Session(proxies=False, idle_timeout_minutes=5, max_duration_minutes=30, **VIEWPORT)
            session.start()
            current["session"] = session
            return {"viewer_url": session.response.viewer_url}
        if name != "reset":
            return demo_command(name, body)
        url, goal = body.get("scenario", "").strip(), body.get("goal", "").strip()
        if not url.startswith(("http://", "https://")):
            raise ValueError("Enter a full http(s) URL")
        if not 0 < len(goal) <= 2000:
            raise ValueError("Enter a task of 1–2,000 characters")
        if current["session"] is None:
            raise ValueError("Open a session first")
        use_session(current["session"])
        # The embedded Notte viewer shows the live browser; screenshots are kept only for step replay.
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
