"""One dedicated headed Chrome; no bridge, queue, login or prompt on startup."""
import os
import signal
import subprocess
import sys
import time
import urllib.request

children = []
stopping = False
exit_code = 0
chrome_process = None
display = os.environ.get("DISPLAY", ":0")
cdp_port = int(os.environ.get("CHROME_CDP_PORT", "9222"))
vnc_port = int(os.environ.get("VNC_PORT", "5900"))
viewer_port = int(os.environ.get("NOVNC_PORT", "6080"))
profile = os.environ.get("CHROME_PROFILE", "/home/node/profile")


def stop(_sig=None, _frame=None):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)


def start(argv):
    child = subprocess.Popen(argv)
    children.append(child)
    return child


def wait_ready(check, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and not stopping:
        if any(p.poll() is not None for p in children):
            raise RuntimeError("browser component exited during startup")
        try:
            if check():
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.2)
    raise RuntimeError("browser startup readiness timeout")


def cdp_ready():
    with urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/version", timeout=1) as r:
        return r.status == 200


try:
    # VNC and CDP are loopback-only inside this container. noVNC is reachable
    # through the explicitly reviewed Docker host port mapping.
    start(["Xtigervnc", display, "-geometry", "1440x900", "-depth", "24",
           "-rfbport", str(vnc_port), "-SecurityTypes", "None", "-localhost", "yes",
           "-AlwaysShared", "-nolisten", "tcp"])
    wait_ready(lambda: os.path.exists("/tmp/.X11-unix/X" + display.split(":")[-1]))
    start(["openbox"])
    chrome = ["google-chrome-stable", "--user-data-dir=" + profile,
              "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + str(cdp_port),
              "--no-first-run", "--no-default-browser-check", "--window-size=1440,900"]
    if os.environ.get("CHROME_PROXY_SERVER"):
        chrome.append("--proxy-server=" + os.environ["CHROME_PROXY_SERVER"])
    chrome_process = start(chrome + [os.environ.get("CHROME_START_URL", "about:blank")])
    wait_ready(cdp_ready)
    # Basic TCP proxy/static web only; optional websockify auth/token plugins
    # and their third-party dependencies are not installed or enabled.
    start(["python3", "-m", "websockify", "--web=/opt/novnc",
           str(viewer_port), f"127.0.0.1:{vnc_port}"])
    while not stopping:
        if any(p.poll() is not None for p in children):
            raise RuntimeError("browser component exited; stopping this instance")
        time.sleep(0.5)
except Exception as error:
    print("browser: " + str(error), file=sys.stderr)
    exit_code = 1
finally:
    # Keep X alive until Chrome has flushed its dedicated persistent profile.
    if chrome_process is not None and chrome_process.poll() is None:
        chrome_process.terminate()
        try:
            chrome_process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            chrome_process.kill()
    for p in reversed(children):
        if p.poll() is None:
            p.terminate()
    deadline = time.monotonic() + 5
    for p in children:
        try:
            p.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            p.kill()
sys.exit(exit_code)
