#!/usr/bin/env python3
import json
import os
import sys


def send(value):
    print(json.dumps(value), flush=True)


def provider_and_model(message):
    # The command carries the session's current choice. The environment only
    # holds what niminal started this process with, which a session change does
    # not refresh, so it is the fallback.
    context = message.get("context") or {}
    provider = context.get("provider") or os.environ.get("NIMINAL_PROVIDER", "provider")
    model = context.get("model") or os.environ.get("NIMINAL_MODEL", "model")
    return provider, model


send({"type": "register", "commands": [
    {"name": "footer_demo", "description": "Show a styled extension footer"}
]})

for line in sys.stdin:
    message = json.loads(line)
    kind = message.get("type")
    if kind == "shutdown":
        break
    if kind in ("initialize",):
        continue
    if kind == "command":
        if message.get("arguments", "").strip() == "clear":
            status = {"key": "model", "segments": []}
        else:
            provider, model = provider_and_model(message)
            status = {"key": "model", "segments": [
                {"text": " niminal ", "style": "emphasis"},
                {"text": provider, "style": "accent"},
                {"text": " / ", "style": "muted"},
                {"text": model, "style": "success"},
            ]}
        send({"type": "response", "id": message["id"], "status": status,
              "message": "Footer status updated."})
