#!/usr/bin/env python3
"""Transfer the useful context from this session into a new one."""

import json
import sys
import uuid


SYSTEM_PROMPT = """You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:
1. Summarizes relevant context, including decisions, approaches, and findings.
2. Lists relevant files that were discussed or modified.
3. Clearly states the next task based on the user's goal.
4. Is self-contained so the new thread can proceed without the old conversation.

Format the response as the prompt the user can submit to start the new thread. Be concise but include all necessary context. Do not add a preamble such as "Here's the prompt".

Use this shape when it fits:
## Context
[Relevant context, decisions, and files]

## Task
[Clear description of what to do next]"""


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def content_text(parts):
    lines = []
    for part in parts:
        kind = part.get("type")
        if kind == "text":
            lines.append(part.get("text", ""))
        elif kind == "tool_use":
            lines.append("[tool call: {} {}]".format(
                part.get("name", "unknown"),
                json.dumps(part.get("input", {}), ensure_ascii=False)))
        elif kind == "tool_result":
            lines.append("[tool result{}]\n{}".format(
                " (error)" if part.get("is_error") else "",
                part.get("content", "")))
        elif kind in ("image", "file"):
            lines.append("[{}]".format(kind))
        elif kind == "source":
            lines.append("[source: {} {}]".format(
                part.get("title", ""), part.get("url", "")).rstrip())
    return "\n".join(line for line in lines if line)


def serialize(messages):
    sections = []
    for message in messages:
        body = content_text(message.get("content", []))
        if body:
            sections.append("{}:\n{}".format(
                message.get("role", message.get("type", "message")).upper(), body))
    return "\n\n".join(sections)


def host_request(method, **fields):
    request_id = str(uuid.uuid4())
    send({"type": "host_request", "id": request_id, "method": method, **fields})
    for line in sys.stdin:
        try:
            response = json.loads(line)
        except ValueError:
            continue
        if response.get("type") == "shutdown":
            return None
        if response.get("type") == "cancel":
            return None
        if response.get("type") == "host_response" and response.get("id") == request_id:
            return response
    return None


def command_response(command_id, **fields):
    send({"type": "response", "id": command_id, **fields})


def handoff(message):
    command_id = message.get("id", "")
    goal = message.get("arguments", "").strip()
    context = message.get("context") or {}
    if not goal:
        command_response(command_id,
                         message="Usage: /handoff <goal for the new session>")
        return
    if context.get("mode") != "tui":
        command_response(command_id,
                         message="handoff requires interactive mode")
        return
    conversation = serialize(context.get("messages") or [])
    if not conversation:
        command_response(command_id, message="No conversation to hand off")
        return

    send({"type": "update", "status": {
        "key": "handoff", "text": "generating handoff"}})
    generated = host_request(
        "model.complete",
        system_prompt=SYSTEM_PROMPT,
        prompt="## Conversation History\n\n{}\n\n## User's Goal for New Thread\n\n{}".format(
            conversation, goal),
        max_tokens=4096)
    send({"type": "update", "status": {"key": "handoff", "text": ""}})
    if not generated or generated.get("cancelled") or generated.get("error"):
        command_response(command_id, message="Handoff generation cancelled" if not generated
                         or generated.get("cancelled") else
                         "Handoff generation failed: " + generated["error"])
        return
    draft = (generated.get("result") or {}).get("text", "").strip()
    if not draft:
        command_response(command_id, message="Handoff generation returned no text")
        return

    edited = host_request("ui.editor", title="Edit handoff prompt", text=draft)
    result = (edited or {}).get("result") or {}
    if not edited or edited.get("cancelled") or edited.get("error") or result.get("cancelled"):
        command_response(command_id, message="Handoff cancelled")
        return
    prompt = result.get("text", "").strip()
    if not prompt:
        command_response(command_id, message="Handoff cancelled: prompt is empty")
        return
    command_response(command_id,
                     session={"action": "new", "editor_text": prompt},
                     notification={"level": "info",
                                   "message": "Handoff ready. Submit when ready."})


send({"type": "register", "commands": [{
    "name": "handoff",
    "description": "Transfer context to a new focused session"
}]})

for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        continue
    kind = message.get("type")
    if kind == "shutdown":
        break
    if kind == "command" and message.get("name", "").lower() == "handoff":
        handoff(message)
