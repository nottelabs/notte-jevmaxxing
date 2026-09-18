"""jev's Browser on a Notte session, tuned for a remote browser.

jev-ultrafast assumes a local Chrome where a CDP round trip costs under a
millisecond. A Notte session answers in ~200 ms, so every sequential command
is visible. This keeps jev's observe/act/guard logic and changes the transport:

- one direct websocket to the session (no Browser Harness daemon to spawn),
- the session's own tab is reused (the live viewer streams it) and load is awaited with one call,
- input events are sent back to back and confirmed together,
- the element snapshot and the screenshot travel in the same flight.
"""

import json
import threading
import time
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


class Connection:
    def __init__(self, url):
        self.socket = connect(url, max_size=None, open_timeout=TIMEOUT)
        self.lock = threading.RLock()
        self.ids = count(1)
        self.deferred = {}

    def send(self, method, session_id=None, **params):
        message = {"id": next(self.ids), "method": method, "params": params}
        if session_id:
            message["sessionId"] = session_id
        with self.lock:
            self.socket.send(json.dumps(message))
        return message["id"]

    def wait(self, *ids):
        """Results for ids, in order. Deferred commands sent before them are confirmed in the same read."""
        replies = {}
        with self.lock:
            deferred, self.deferred = self.deferred, {}
            while not all(i in replies for i in (*deferred, *ids)):
                reply = json.loads(self.socket.recv(timeout=TIMEOUT))
                if "id" in reply:
                    replies[reply["id"]] = reply
        for i in (*deferred, *ids):
            if "error" in replies[i]:
                raise RuntimeError(f"{deferred.get(i, 'CDP')}: {replies[i]['error'].get('message')}")
        return [replies[i].get("result", {}) for i in ids]

    def __call__(self, method, session_id=None, **params):
        with self.lock:
            sent = self.send(method, session_id, **params)
            if method.startswith(DEFERRED):
                self.deferred[sent] = method
                return {}
            return self.wait(sent)[0]


class NotteBrowser(jev.Browser):
    def __init__(self, cdp_url, url):
        self.cdp = Connection(cdp_url)
        # Drive the session's own tab: it is the one the Notte live viewer streams.
        pages = [t for t in self.cdp("Target.getTargets")["targetInfos"] if t["type"] == "page"]
        self.target = pages[0]["targetId"] if pages else self.cdp("Target.createTarget", url="about:blank")["targetId"]
        self.session = self.cdp("Target.attachToTarget", targetId=self.target, flatten=True)["sessionId"]
        CONNECTIONS[self.session] = self.cdp
        # The viewport is already set by the Notte session; these ride along with the navigation.
        self.call("Emulation.setDeviceMetricsOverride", width=1120, height=780, deviceScaleFactor=1, mobile=False)
        self.call("Emulation.setFocusEmulationEnabled", enabled=True)
        self.call("Page.navigate", url=url)
        deadline = time.monotonic() + 15
        while url != "about:blank" and time.monotonic() < deadline:
            try:  # one awaited call instead of polling; a navigation underneath it just asks again
                reply = self.call("Runtime.evaluate", expression=LOADED, awaitPromise=True, returnByValue=True)
                if reply.get("result", {}).get("value") is True:
                    break
            except RuntimeError:
                time.sleep(0.02)

    def call(self, method, **params):
        return self.cdp(method, session_id=self.session, **params)

    def close(self):
        if self.target:
            self.target = None  # the tab belongs to the session and goes away with it
            CONNECTIONS.pop(self.session, None)
            self.cdp.socket.close()


def cdp(method, session_id=None, **params):
    return CONNECTIONS[session_id](method, session_id=session_id, **params)


def browser_operation(request):
    connection = CONNECTIONS[request["session"]]
    if request["operation"] != "observe":
        result = jev_operation(request)
        connection.wait()  # execution is confirmed before jev logs it
        return result
    session = request["session"]
    sent = [connection.send("Runtime.evaluate", session, expression=jev.READ_STATE, returnByValue=True)]
    if request.get("screenshot", True):
        sent.append(connection.send("Page.captureScreenshot", session, format="jpeg", quality=72))
    state, *shot = connection.wait(*sent)
    info = None if state.get("exceptionDetails") else state.get("result", {}).get("value")
    if info is None:
        raise jev.StalePage("Document is navigating")
    info["fingerprint"] = jev.fingerprint(info)
    if shot:
        info["screenshot"] = shot[0]["data"]
    return info


jev_operation, jev.browser_operation, jev.cdp = jev.browser_operation, browser_operation, cdp


def use_session(session):
    """Make the next jev Agent open its tab in this started Notte session."""
    cdp_url = session.cdp_url()
    jev_agent.Browser = lambda url: NotteBrowser(cdp_url, url)
