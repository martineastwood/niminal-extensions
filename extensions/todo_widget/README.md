# todo_widget

Give the agent a `todo` tool and a task list you can see and click. Ask for
work with several steps and the agent writes the plan down, marks the task it is
on, and checks tasks off as they finish. A **Todos** widget above the composer
shows the list, with buttons to complete a task or clear the finished ones.

Tasks are saved per workspace and session, so the list survives a `/reload` or
a context compaction.

## Requirements

- Python 3, using only the standard library
- macOS or Linux: the extension uses `fcntl` to lock the todo file

## Install

Copy this directory into a niminal extension root:

```bash
cp -r todo_widget ~/.niminal/extensions/
chmod +x ~/.niminal/extensions/todo_widget/extension.py
```

Restart niminal or run `/reload`.

## Use

Ask for multi-step work and mention the list:

```text
implement the settings screen and track the work in todos
```

The agent calls `todo` with `create` for each step, `update` to mark one
`in_progress` as it starts, and `update` again to mark it `completed` when the
work and its checks are done. The widget updates as it goes.

Review the list yourself at any time:

```text
/todos
```

## Working with the widget

The widget sits above the composer and shows:

- each task as `#id subject`, with the in-progress task's `activeForm` label.
  Completed tasks stay in the list with a `✓` marker and dimmed text
- the count in the title, for example `Todos · 2/5 complete`
- **Complete #id** for each unfinished task, and **Clear todos** once every
  task is complete

To use a button, focus the empty composer and press Tab, move with the up and
down keys, then press Enter. Escape closes the selector.

Choosing **Clear todos** removes the list and hides the widget. It only acts
when every task is completed or deleted.

## The `todo` tool

| Action | Required arguments | What it does |
| --- | --- | --- |
| `create` | `subject` | Adds a pending task and returns its id |
| `update` | `id`, plus `subject`, `description`, `activeForm`, or `status` | Changes one task |
| `list` | none | Lists unfinished tasks grouped by status |
| `get` | `id` | Shows one task |
| `delete` | `id` | Marks a task deleted |
| `clear` | none | Removes every task and resets ids |

Other arguments: `description` and `activeForm` add detail and a
present-continuous label such as "Running tests", and `status` is `pending`,
`in_progress`, or `completed`. Deleted tasks stay in the saved file; `list`
hides them unless you pass `includeDeleted`. Completed tasks also stay in the
saved file, and `list` shows them only when you ask for that status, for
example `{"action": "list", "status": "completed"}`.

After any action except `list`, the tool result ends with the current list of
unfinished and deleted tasks, so the agent always sees the open work without
repeating finished tasks.

Because the tool writes saved tasks, niminal asks for permission before the
agent uses it.

## Where tasks are saved

One JSON file per workspace and session:

```text
~/.niminal/todos/<first 2 hex chars>/<rest of hash>.json
```

The file name is a hash of the workspace path and the session id, so two
projects, or two sessions in the same project, keep separate lists. Deleting a
file starts that list over.

## Limitations

- The widget shows the first 10 tasks, in-progress first, then pending, then
  completed, and up to 8 **Complete** buttons. The `todo` tool still sees every
  task.
- The extension targets macOS and Linux. On Windows, `fcntl` is unavailable.
- Tasks live in `~/.niminal/todos/`; there is no per-project file to commit.
