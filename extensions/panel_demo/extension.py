#!/usr/bin/env python3
import json
import sys


items = [
    {"text": "Collect the inputs", "state": "done"},
    {"text": "Render the widget", "state": "active"},
    {"text": "Check the layout", "state": "pending"},
]


def send(value):
    print(json.dumps(value), flush=True)


def widget():
    return {"key": "panel_demo", "title": "Panel · simulated demo",
            "content": [{"type": "list", "items": items}],
            "actions": [
                {"id": "advance", "label": "Advance active item"},
                {"id": "done", "label": "Mark active item done"},
            ]}


send({"type": "register", "commands": [
    {"name": "panel_demo", "description": "Show a simulated widget panel"}
]})

for line in sys.stdin:
    message = json.loads(line)
    kind = message.get("type")
    if kind == "shutdown":
        break
    if kind == "initialize":
        continue
    if kind == "command":
        send({"type": "response", "id": message["id"], "widget": widget(),
              "message": "Showing a simulated panel."})
    elif kind == "ui_action" and message.get("widget") == "panel_demo":
        action = message.get("action")
        if action == "advance":
            items[1]["text"] = "Render the widget · refined"
        elif action == "done":
            items[1]["text"] = "Render the widget · done"
            items[1]["state"] = "done"
        send({"type": "update", "widget": widget()})
