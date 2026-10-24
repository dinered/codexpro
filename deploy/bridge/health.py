"""Browser readiness only; never read credentials or send platform messages."""
import json
import socket
import urllib.request

with urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=2) as r:
    assert "Chrome/" in json.load(r)["Browser"]
with urllib.request.urlopen("http://127.0.0.1:6080/vnc.html", timeout=2) as r:
    assert r.status == 200
with socket.create_connection(("127.0.0.1", 5900), timeout=2) as s:
    assert s.recv(12).startswith(b"RFB ")
