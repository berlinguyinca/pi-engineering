"""A REAL Herdr control plane (ControlPlaneServer + CollabService) on loopback for Pi's /room live test.

Usage:  python herdr-live-room-server.py <key-file-to-write>
Needs the Herdr checkout on PYTHONPATH (the test sets it). Nothing is read from the environment: the user token is
random, written to the 0600 file named on argv, and never printed. Prints ONE JSON line when ready:
  {"base": ..., "room": ..., "agent_id": ..., "agent_name": ...}
then serves until SIGTERM, or until its parent is gone.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import signal
import sys
import tempfile
import threading
import time

from herdr_engineering.control_plane.api import ControlPlaneServer
from herdr_engineering.control_plane.collab_attention import normalize_insights
from herdr_engineering.control_plane.collab import CollabService, FileEventLog, StaticTokenAuthenticator
from herdr_engineering.control_plane.repo import ControlPlaneRepo

key_file = sys.argv[1]
token = "pi-room-" + secrets.token_hex(16)
fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as fh:
    fh.write(token + "\n")

tmp = tempfile.TemporaryDirectory()
svc = CollabService(StaticTokenAuthenticator({"alice": hashlib.sha256(token.encode()).hexdigest()}),
                    sink=FileEventLog(os.path.join(tmp.name, "log")), max_agents_per_user=20, max_log_events=100_000,
                    public_config={"public_url": "http://127.0.0.1:0/", "client_id": "pi-live", "hosted_ui_domain": "auth.invalid"})
svc.insights = normalize_insights({"enabled": True})   # the attention inbox is OFF by default (403 insights_disabled)
alice = svc.authenticate(f"Bearer {token}", None)
project = svc.create_project(alice, {"name": "pi live"})["project_id"]
room = svc.create_room(alice, project, {"name": "Pi live room"})["room_id"]
enr = svc.dispatch("POST", ["agents", "enrollment", "start"], {}, {"device_id": "dev-1", "harness_type": "pi"}, f"Bearer {token}", None)[1]
agent = svc.dispatch("POST", ["agents", "enrollment", "complete"], {}, {"code": enr["code"], "device_id": "dev-1", "instance_id": "i-1"}, "", None)[1]
status, granted = svc.dispatch("POST", ["rooms", room, "agents"], {}, {"agent_id": agent["agent_id"], "actions": ["read", "post", "execute", "instruct"]}, f"Bearer {token}", None)
assert status == 201, granted
roster = svc.list_room_agents(alice, room)["agents"]

srv = ControlPlaneServer(ControlPlaneRepo(), host="127.0.0.1", port=0, collab=svc, api_keys={"ik-" + secrets.token_hex(8): "ingest"},
                         public_port=0, public_host="127.0.0.1")
threading.Thread(target=srv.serve, daemon=True).start()
srv.wait_until_ready()
base = f"http://127.0.0.1:{srv.public_port}"
svc.public_config["public_url"] = base + "/"
signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
parent = os.getppid()
print(json.dumps({"base": base, "room": room, "agent_id": agent["agent_id"], "agent_name": roster[0]["name"]}), flush=True)
while os.getppid() == parent:
    time.sleep(1.0)
os._exit(0)
