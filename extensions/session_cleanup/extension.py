#!/usr/bin/env python3
"""Delete old session files when niminal exits."""

import json
import os
import sys
import time
from pathlib import Path

DEFAULT_DAYS = 30
SESSIONS = Path.home() / ".niminal" / "sessions"


def retention_days():
    raw = os.environ.get("NIMINAL_SESSION_CLEANUP_DAYS", "")
    return int(raw) if raw.isdigit() and int(raw) > 0 else DEFAULT_DAYS


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def sweep(keep):
    cutoff = time.time() - retention_days() * 86_400
    for pattern in ("*.jsonl", "*.jsonl.recovery-*"):
        for path in SESSIONS.rglob(pattern):
            try:
                if path.name != f"{keep}.jsonl" and path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                continue


send({"type": "register", "commands": [], "events": ["session_shutdown"]})

for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        continue
    if message.get("type") == "shutdown":
        break
    if message.get("type") == "event" and message.get("event") == "session_shutdown":
        payload = message.get("payload") or {}
        if payload.get("reason") == "quit":
            sweep(payload.get("session_id", ""))
        send({"type": "response", "id": message.get("id", "")})
