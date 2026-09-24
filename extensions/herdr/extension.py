#!/usr/bin/env python3
"""Report niminal's lifecycle state to a Herdr pane.

Active only when niminal runs inside a Herdr pane (HERDR_ENV=1). Maps:
  session_start -> idle
  turn_start    -> working
  turn_end      -> idle
  shutdown      -> release-agent
Reports carry --agent-session-id so Herdr exposes the niminal session
reference. Seq is monotonic across extension restarts so a fresh instance
never reports below its predecessor's seq (Herdr drops stale seqs).
See https://herdr.dev/docs/integrations/#integrate-your-own-agent
"""
import json
import os
import subprocess
import sys
import time

HERDR_BIN = os.environ.get("HERDR_BIN_PATH", "")
HERDR_PANE = os.environ.get("HERDR_PANE_ID", "")
SOURCE = "custom:niminal"
AGENT = "niminal"
ACTIVE = os.environ.get("HERDR_ENV") == "1" and HERDR_BIN != "" and HERDR_PANE != ""
seq = int(time.time() * 1000)
session_id = ""


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def next_seq():
    global seq
    seq = max(seq + 1, int(time.time() * 1000))
    return seq


def herdr(args):
    subprocess.run([HERDR_BIN, "pane"] + args, check=False, timeout=5)


def report(state):
    herdr(["report-agent", HERDR_PANE,
           "--source", SOURCE, "--agent", AGENT,
           "--state", state, "--seq", str(next_seq())]
          + (["--agent-session-id", session_id] if session_id else []))


def release():
    herdr(["release-agent", HERDR_PANE,
           "--source", SOURCE, "--agent", AGENT,
           "--seq", str(next_seq())])


send({"type": "register", "commands": [],
      "events": ["session_start", "turn_start", "turn_end"]})

for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        continue
    kind = message.get("type")
    if kind == "shutdown":
        if ACTIVE:
            try:
                release()
            except Exception:
                pass
        break
    if ACTIVE and kind == "event":
        event = message.get("event")
        payload = message.get("payload") or {}
        if payload.get("session_id"):
            session_id = payload["session_id"]
        try:
            if event == "turn_start":
                report("working")
            elif event in ("session_start", "turn_end"):
                report("idle")
        except Exception:
            pass  # never let a herdr hiccup stall a niminal turn
    send({"type": "response", "id": message.get("id", "")})
