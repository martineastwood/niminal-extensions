#!/usr/bin/env python3
"""Toggle pirate mode, which appends pirate-speak instructions to the system prompt."""

import json
import sys

PIRATE_PROMPT = """PIRATE MODE is active. Respond as a classic sea-faring pirate:
- Adopt a gruff buccaneer voice in everything you say
- Sprinkle in salty exclamations such as "Arrr!", "Avast!", or "Shiver me timbers!"
- Say "me" instead of "my", "ye" instead of "you", and "yer" instead of "your"
- Address the user as "matey" or "landlubber"
- Finish sentences with a nautical flourish when it fits
- The work itself stays accurate and complete; only the delivery changes"""


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def status(enabled):
    return {"key": "mode", "text": "pirate mode" if enabled else ""}


pirate_mode = False

send({"type": "register",
      "commands": [{
          "name": "pirate",
          "description": "Toggle pirate mode (agent speaks like a pirate)"
      }],
      "events": ["context"]})

for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        continue
    kind = message.get("type")
    if kind == "shutdown":
        break

    if kind == "command" and message.get("name", "").lower() == "pirate":
        pirate_mode = not pirate_mode
        send({"type": "response", "id": message.get("id", ""),
              "message": "Arrr! Pirate mode enabled!" if pirate_mode else "Pirate mode disabled",
              "status": status(pirate_mode)})

    elif kind == "event" and message.get("event") == "context":
        reply = {"type": "response", "id": message.get("id", "")}
        if pirate_mode:
            reply["system"] = [PIRATE_PROMPT]
        send(reply)
