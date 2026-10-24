"""Browser readiness only; never read credentials or send platform messages."""
import json
import socket
import struct
import urllib.request

with urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=2) as r:
    assert "Chrome/" in json.load(r)["Browser"]
with urllib.request.urlopen("http://127.0.0.1:6080/vnc.html", timeout=2) as r:
    assert r.status == 200
with socket.create_connection(("127.0.0.1", 5900), timeout=2) as s:
    def read_exact(size):
        data = b""
        while len(data) < size:
            chunk = s.recv(size - len(data))
            if not chunk:
                raise RuntimeError("VNC handshake closed early")
            data += chunk
        return data

    assert read_exact(12) == b"RFB 003.008\n"
    s.sendall(b"RFB 003.008\n")
    security_types = read_exact(read_exact(1)[0])
    assert 1 in security_types  # loopback-only server, SecurityTypes=None
    s.sendall(b"\x01")
    assert struct.unpack("!I", read_exact(4))[0] == 0
    s.sendall(b"\x01")  # shared session; complete authentication before disconnect
    server_init = read_exact(24)
    name_length = struct.unpack("!I", server_init[20:24])[0]
    assert name_length <= 4096
    read_exact(name_length)
