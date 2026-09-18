"""jev's Browser on a Notte session, tuned for a remote browser.

jev-ultrafast assumes a local Chrome where a CDP round trip costs under a
millisecond. A Notte session answers in ~200 ms, so every sequential command
is visible. This keeps jev's observe/act/guard logic and changes the transport:

- one direct websocket to the session (no Browser Harness daemon to spawn),
- the session's own tab is reused (the live viewer streams it) and load is awaited with one call,
- input events are sent back to back and confirmed together,
- commands jev would send one after another travel together: the freshness check with
  the target lookup, and the settle wait with the element snapshot,
- the first freshness check and the screenshot run while the model decides.

No page script is copied from jev. The command jev is about to send is captured, sent
ahead of time (or chained with another), and handed back when jev asks for it.
"""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from itertools import count

import jev_ultrafast.agent as jev_agent
import jev_ultrafast.browser as jev
from websockets.sync.client import connect

VIEWPORT = {"viewport_width": 1120, "viewport_height": 780}
TIMEOUT = 30  # seconds; a remote browser can stall far longer than local Chrome
# jev reads nothing from these replies, so they need not be awaited one by one.
DEFERRED = ("Input.", "Emulation.")
# Resolves true once the requested page has loaded; the tab's initial about:blank answers false and is asked again.
LOADED = """new Promise(r => location.href === 'about:blank' ? setTimeout(() => r(false), 50)
  : document.readyState === 'complete' ? r(true) : addEventListener('load', () => r(true)))"""
CONNECTIONS = {}  # CDP session id -> Connection, for jev's module-level cdp() calls
LATE = {}  # id(page) -> replies requested for that page and not collected yet
POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="notte-cdp")


Jev = jev.Browser


class Captured(Exception):
    """Carries the command jev was about to send."""


class Connection:
    def __init__(self, url):
        self.socket = connect(url, max_size=None, open_timeout=TIMEOUT)
        self.lock = threading.RLock()
        self.ids = count(1)
        self.deferred = {}
        self.inbox = {}  # replies nobody has asked for yet
        self.ahead = {}  # command -> id of the copy already sent
        self.capturing = False
        self.unwanted = set()  # ids whose replies are dropped on arrival

    def send(self, method, session_id=None, **params):
        message = {"id": next(self.ids), "method": method, "params": params}
        if session_id:
            message["sessionId"] = session_id
        with self.lock:
            self.socket.send(json.dumps(message))
        return message["id"]

    def wait(self, *ids):
        """Results for ids, in order. Deferred commands sent before them are confirmed in the same read."""
        with self.lock:
            deferred, self.deferred = self.deferred, {}
            while not all(i in self.inbox for i in (*deferred, *ids)):
                reply = json.loads(self.socket.recv(timeout=TIMEOUT))
                if reply.get("id") in self.unwanted:
                    self.unwanted.discard(reply["id"])
                elif "id" in reply:
                    self.inbox[reply["id"]] = reply
            replies = {i: self.inbox.pop(i) for i in (*deferred, *ids)}
        for i in (*deferred, *ids):
            if "error" in replies[i]:
                raise RuntimeError(f"{deferred.get(i, 'CDP')}: {replies[i]['error'].get('message')}")
        return [replies[i].get("result", {}) for i in ids]

    def capture(self, function, *args):
        """The first command function(*args) would send, as (method, session_id, params), without sending it."""
        with self.lock:
            self.capturing = True
            try:
                function(*args)
            except Captured as captured:
                return captured.args
            finally:
                self.capturing = False

    def send_ahead(self, method, session_id, params):
        """Send now; the same command asked for later gets this reply instead of another round trip."""
        with self.lock:
            self.ahead[json.dumps([method, session_id, params], sort_keys=True)] = self.send(method, session_id, **params)

    def forget(self, *ids):
        """Nobody will ask for these replies, nor for anything sent ahead."""
        with self.lock:
            for i in (*ids, *self.ahead.values()):
                if i is not None and self.inbox.pop(i, None) is None:
                    self.unwanted.add(i)
            self.ahead = {}

    def __call__(self, method, session_id=None, **params):
        with self.lock:
            if self.capturing:
                raise Captured(method, session_id, params)
            sent = self.ahead.pop(json.dumps([method, session_id, params], sort_keys=True), None)
            if sent is not None:
                return self.wait(sent)[0]
            sent = self.send(method, session_id, **params)
            if method.startswith(DEFERRED):
                self.deferred[sent] = method
                return {}
            return self.wait(sent)[0]


class NotteBrowser(Jev):
    def __init__(self, cdp_url):
        self.cdp = Connection(cdp_url)
        # Drive the session's own tab: it is the one the Notte live viewer streams.
        pages = [t for t in self.cdp("Target.getTargets")["targetInfos"] if t["type"] == "page"]
        self.target = pages[0]["targetId"] if pages else self.cdp("Target.createTarget", url="about:blank")["targetId"]
        self.session = self.cdp("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
        CONNECTIONS[self.session] = self.cdp
        self.speculative = self.stale = False
        self.late = {}
        # The viewport is already set by the Notte session; these ride along with the navigation.
        self.call("Emulation.setDeviceMetricsOverride", width=1120, height=780, deviceScaleFactor=1, mobile=False)
        self.call("Emulation.setFocusEmulationEnabled", enabled=True)

    def open(self, url):
        self.call("Page.navigate", url=url)
        deadline = time.monotonic() + 15
        while url != "about:blank" and time.monotonic() < deadline:
            try:  # one awaited call instead of polling; a navigation underneath it just asks again
                reply = self.call("Runtime.evaluate", expression=LOADED, awaitPromise=True, returnByValue=True)
                if reply.get("result", {}).get("value") is True:
                    break
            except RuntimeError:
                time.sleep(0.02)
        return self

    def call(self, method, **params):
        return self.cdp(method, session_id=self.session, **params)

    def observe(self, screenshot=True):
        self.cdp.forget(self.late.get("marker"), self.late.get("shot"))
        LATE.pop(id(self.late.get("page")), None)
        info = None
        if getattr(self, "after_input", None):
            # jev waits for the page to settle, then reads it: two round trips. Chained in the page, it is one.
            _, _, settle = self.cdp.capture(Jev.observe, self, False)  # also consumes after_input, as jev does
            chained = f"({settle['expression']}).then(() => {jev.READ_STATE})"
            try:
                reply = self.call("Runtime.evaluate", expression=chained, awaitPromise=True, returnByValue=True)
                info = None if reply.get("exceptionDetails") else reply.get("result", {}).get("value")
            except RuntimeError:  # a navigation interrupted the wait; jev ignores that too
                pass
            if info is not None:
                info["fingerprint"] = jev.fingerprint(info)
        if info is None:
            info = super().observe(screenshot=False)
        # The screenshot is only looked at by people. It is requested now and collected once the model has decided.
        shot = self.cdp.send("Page.captureScreenshot", self.session, format="jpeg", quality=72) if screenshot else None
        self.late = LATE[id(info)] = {"browser": self, "page": info, "shot": shot, "marker": None}
        return info

    def fresh(self, page, action=None):
        if action is not None or not self.speculative:
            return super().fresh(page, action)
        if self.stale:  # found while the model was deciding; say so, and the agent observes again
            self.stale = False
            return False
        # Before a decision the page was read a moment ago. Check it while the model thinks, not before.
        late = LATE.get(id(page))
        if late is None or late["marker"] is not None:
            return super().fresh(page)
        method, session, params = self.cdp.capture(Jev.fresh, self, page)
        late["marker"] = self.cdp.send(method, session, **params)
        return True

    def act(self, action, page, text=None):
        if action["kind"] in {"click", "fill"}:
            # Their target lookup only reads the page, so it can travel with the freshness check.
            request = {"operation": "act", "session": self.session, "action": action, "text": text}
            for command in (self.cdp.capture(Jev.fresh, self, page, action), self.cdp.capture(jev_operation, request)):
                if command:
                    self.cdp.send_ahead(*command)
        try:
            return super().act(action, page, text)
        finally:
            self.cdp.forget()

    def close(self):
        if self.target:
            self.target = None  # the tab belongs to the session and goes away with it
            CONNECTIONS.pop(self.session, None)
            self.cdp.socket.close()


def cdp(method, session_id=None, **params):
    return CONNECTIONS[session_id](method, session_id=session_id, **params)


def browser_operation(request):
    result = jev_operation(request)
    CONNECTIONS[request["session"]].wait()  # execution is confirmed before jev logs it
    return result


def choose(page, goal, history):
    decision = jev_choose(page, goal, history)
    late = LATE.pop(id(page), None)
    if late:  # both were sent before the model call and have long arrived
        browser = late["browser"]
        browser.late = {}
        sent = [i for i in (late["marker"], late["shot"]) if i is not None]
        replies = dict(zip(sent, browser.cdp.wait(*sent)))
        if late["shot"]:
            page["screenshot"] = replies[late["shot"]]["data"]
        marker = replies.get(late["marker"])
        if marker and (marker.get("exceptionDetails") or marker.get("result", {}).get("value") != page["marker"]):
            browser.stale = True
            raise jev.StalePage("Page changed during the decision. Choose again.")
    return decision


def field_text(context):
    try:
        return jev_field_text(context)
    except ValueError as error:  # one malformed reply from the text model should not end the run
        if "no valid field value" not in str(error):
            raise
        return jev_field_text(context)


def command(self, name, body=None):
    browser = self.state["browser"]
    if isinstance(browser, NotteBrowser):
        browser.speculative = name == "predict"
    try:
        return jev_command(self, name, body)
    finally:
        if isinstance(browser, NotteBrowser):
            browser.speculative = False


jev_operation, jev.browser_operation, jev.cdp = jev.browser_operation, browser_operation, cdp
jev_choose, jev_agent.choose = jev_agent.choose, choose
jev_field_text, jev_agent.field_text = jev_agent.field_text, field_text
jev_command, jev_agent.Agent.command = jev_agent.Agent.command, command


def use_session(session):
    """Make the next jev Agent open its page in this started Notte session.

    The websocket and the tab are connected in the background right away, while the
    caller is still busy (the inspector embeds the live viewer in that time).
    """
    warm = POOL.submit(NotteBrowser, session.cdp_url())
    jev_agent.Browser = lambda url: warm.result().open(url)
