#!/usr/bin/env python3
import fcntl
import hashlib
import json
import os
import sys
from pathlib import Path


STATUSES = ("pending", "in_progress", "completed", "deleted")
SESSION_ID = os.environ.get("NIMINAL_SESSION_ID", "default")

TOOL = {
    "name": "todo",
    "description": (
        "Track multi-step work in a persistent todo list. Use this for tasks with several steps "
        "or when the user asks to track work. Create the tasks up front with subjects, mark the "
        "current task in_progress when you start it, and mark each task completed only after its "
        "work and checks are done. Every result lists the open tasks. State is saved for this "
        "workspace and session."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["create", "update", "list", "get", "delete", "clear"]},
            "subject": {"type": "string", "description": "Short, imperative task name."},
            "subjects": {"type": "array", "items": {"type": "string"},
                         "description": "Create several tasks in one call, in order. Use instead of subject for a new plan."},
            "description": {"type": "string", "description": "Optional task detail."},
            "activeForm": {"type": "string", "description": "Present-continuous label shown while in progress."},
            "id": {"type": "integer", "minimum": 1},
            "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
            "includeDeleted": {"type": "boolean", "default": False},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
    "capabilities": ["read", "write"],
}


def send(value):
    print(json.dumps(value), flush=True)


def state_path():
    key = hashlib.sha256(f"{Path.cwd().resolve()}\0{SESSION_ID}".encode()).hexdigest()
    return Path.home() / ".niminal" / "todos" / key[:2] / f"{key[2:]}.json"


def load_state(path=None):
    path = path or state_path()
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"tasks": [], "next_id": 1}
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read todo state: {error}") from error
    if not isinstance(state, dict) or type(state.get("next_id")) is not int or not isinstance(state.get("tasks"), list):
        raise ValueError("todo state file has an invalid format")
    for task in state["tasks"]:
        if (not isinstance(task, dict) or type(task.get("id")) is not int or
                not isinstance(task.get("subject"), str) or task.get("status") not in STATUSES):
            raise ValueError("todo state file contains an invalid task")
    return state


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def task_text(task):
    text = f"[{task['status']}] #{task['id']} {task['subject']}"
    if task.get("activeForm") and task["status"] == "in_progress":
        text += f" ({task['activeForm']})"
    if task.get("description"):
        text += f"\n  {task['description']}"
    return text


def list_text(state, status=None, include_deleted=False):
    statuses = [status] if status else ["in_progress", "pending"] + (["deleted"] if include_deleted else [])
    groups = []
    for current in statuses:
        rows = [task for task in state["tasks"] if task["status"] == current]
        if rows:
            groups.append(current.replace("_", " ").title() + ":\n" +
                          "\n".join("  " + task_text(task) for task in rows))
    return "\n\n".join(groups) if groups else "No tasks."


def open_tasks(state):
    return [task for task in state["tasks"] if task["status"] in ("pending", "in_progress")]


def summary_text(state):
    tasks = open_tasks(state)
    if not tasks:
        return "No open tasks."
    return "Open tasks: " + "; ".join(
        f"#{task['id']} {task['subject']} ({task['status'].replace('_', ' ')})"
        for task in tasks)


def make_widget(state):
    tasks = [task for task in state["tasks"] if task["status"] != "deleted"]
    if not open_tasks(state):
        return {"key": "tasks", "title": "", "content": [], "actions": []}
    ordered = sorted(tasks, key=lambda task: (
        ("in_progress", "pending", "completed").index(task["status"]), task["id"]))
    complete = sum(task["status"] == "completed" for task in tasks)
    visible = ordered[:10]
    items = []
    for task in visible:
        label = f"#{task['id']} {task['subject']}"
        if task["status"] == "in_progress":
            label += f" ({task.get('activeForm') or 'In progress'})"
        items.append({"text": label, "state": {
            "pending": "pending", "in_progress": "active", "completed": "done"
        }[task["status"]]})
    content = [{"type": "list", "items": items}]
    if len(ordered) > len(visible):
        content.append({"type": "text", "text": f"+{len(ordered) - len(visible)} more tasks"})
    content.append({"type": "progress", "label": f"{complete}/{len(tasks)} complete",
                    "value": complete, "max": len(tasks)})
    return {"key": "tasks", "title": "Todos", "content": content, "actions": []}


def update_task(state, params):
    task_id = params.get("id")
    if type(task_id) is not int or task_id < 1:
        raise ValueError("id must be a positive integer")
    task = next((item for item in state["tasks"] if item["id"] == task_id), None)
    if task is None or task["status"] == "deleted":
        raise ValueError(f"#{task_id} not found")
    fields = [name for name in ("subject", "description", "activeForm", "status") if name in params]
    if not fields:
        raise ValueError("update requires subject, description, activeForm, or status")
    before = dict(task)
    for name in fields:
        value = params[name]
        if name == "subject" and (not isinstance(value, str) or not value.strip()):
            raise ValueError("subject cannot be empty")
        if name == "status" and value not in ("pending", "in_progress", "completed"):
            raise ValueError("status must be pending, in_progress, or completed")
        if name in ("description", "activeForm"):
            if not isinstance(value, str):
                raise ValueError(f"{name} must be a string")
            if value == "":
                task.pop(name, None)
                continue
        task[name] = value.strip() if name == "subject" else value
    demoted = 0
    if task["status"] == "in_progress":
        for other in state["tasks"]:
            if other is not task and other["status"] == "in_progress":
                other["status"] = "pending"
                demoted += 1
    if task == before and demoted == 0:
        return f"No change: #{task_id} already has those values."
    return f"Updated {task_text(task)}"


def create_tasks(state, params):
    subjects = params.get("subjects")
    if subjects is None:
        subject = params.get("subject")
        if not isinstance(subject, str) or not subject.strip():
            raise ValueError("subject is required for create")
        task = {"id": state["next_id"], "subject": subject.strip(), "status": "pending"}
        for field in ("description", "activeForm"):
            value = params.get(field)
            if value is not None:
                if not isinstance(value, str):
                    raise ValueError(f"{field} must be a string")
                if value:
                    task[field] = value
        state["tasks"].append(task)
        state["next_id"] += 1
        return f"Created {task_text(task)}"
    if (not isinstance(subjects, list) or not subjects or
            any(not isinstance(item, str) or not item.strip() for item in subjects)):
        raise ValueError("subjects must be a non-empty list of non-empty strings")
    created = []
    for subject in subjects:
        created.append({"id": state["next_id"], "subject": subject.strip(), "status": "pending"})
        state["tasks"].append(created[-1])
        state["next_id"] += 1
    return "Created " + ", ".join(f"#{task['id']} {task['subject']}" for task in created)


def apply_action(state, params):
    action = params.get("action")
    if action == "create":
        return create_tasks(state, params)
    if action == "update":
        return update_task(state, params)
    if action == "list":
        status = params.get("status")
        if status is not None and status not in STATUSES:
            raise ValueError("status must be pending, in_progress, completed, or deleted")
        include_deleted = params.get("includeDeleted", False)
        if not isinstance(include_deleted, bool):
            raise ValueError("includeDeleted must be a boolean")
        return list_text(state, status, include_deleted)
    if action == "get":
        task_id = params.get("id")
        if type(task_id) is not int or task_id < 1:
            raise ValueError("id must be a positive integer")
        task = next((item for item in state["tasks"] if item["id"] == task_id), None)
        if task is None:
            raise ValueError(f"#{task_id} not found")
        return task_text(task)
    if action == "delete":
        task_id = params.get("id")
        if type(task_id) is not int or task_id < 1:
            raise ValueError("id must be a positive integer")
        task = next((item for item in state["tasks"] if item["id"] == task_id), None)
        if task is None or task["status"] == "deleted":
            raise ValueError(f"#{task_id} not found")
        task["status"] = "deleted"
        return f"Deleted #{task_id}: {task['subject']}"
    if action == "clear":
        count = len(state["tasks"])
        state["tasks"] = []
        return f"Cleared {count} tasks."
    raise ValueError("action must be create, update, list, get, delete, or clear")


def run_tool(params):
    action = params.get("action")
    path = state_path()
    if action in ("create", "update", "delete", "clear"):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.with_suffix(".lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = load_state(path)
            result = apply_action(state, params)
            save_state(path, state)
    else:
        state = load_state(path)
        result = apply_action(state, params)
    return result, state


def response(message_id, message, state, is_error=False):
    send({"type": "response", "id": message_id,
          "content": [{"type": "text", "text": message}],
          "is_error": is_error, "widget": make_widget(state)})


send({"type": "register", "commands": [
    {"name": "todo", "description": "Show the current task list"}
], "tools": [TOOL], "events": ["session_start"]})

for line in sys.stdin:
    message = json.loads(line)
    kind = message.get("type")
    if kind == "shutdown":
        break
    if kind == "initialize":
        SESSION_ID = message.get("session_id") or SESSION_ID
    elif kind == "event" and message.get("event") == "session_start":
        SESSION_ID = message.get("payload", {}).get("session_id") or SESSION_ID
        state = load_state()
        send({"type": "response", "id": message["id"], "widget": make_widget(state)})
    elif kind == "command" and message.get("name") == "todo":
        state = load_state()
        summary = list_text(state) if open_tasks(state) else list_text(state, "completed")
        send({"type": "response", "id": message["id"],
              "message": "No todos yet. Ask me to add tasks." if summary == "No tasks." else summary,
              "widget": make_widget(state)})
    elif kind == "tool" and message.get("name") == "todo":
        try:
            params = message.get("arguments", {})
            before = load_state()
            result, state = run_tool(params)
            if params.get("action") != "list":
                result += "\n\n" + summary_text(state)
            response(message["id"], result, state)
            completed = sum(task["status"] == "completed" for task in state["tasks"])
            was_completed = sum(task["status"] == "completed" for task in before["tasks"])
            if completed > was_completed and not open_tasks(state):
                send({"type": "update", "notification": {
                    "level": "info",
                    "message": f"All {completed} task{'s' if completed > 1 else ''} complete"}})
        except (ValueError, OSError) as error:
            try:
                state = load_state()
            except ValueError:
                state = {"tasks": [], "next_id": 1}
            response(message["id"], f"Error: {error}", state, True)
