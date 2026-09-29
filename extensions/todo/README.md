# todo

Give the agent a `todo` tool and a task list you can see. Ask for work with
several steps and the agent writes the plan down, marks the task it is on, and
checks tasks off as they finish. A **Todos** widget above the composer shows the
list and how much is done.

Tasks are saved per workspace and session, so the list survives a `/reload` or
a context compaction.

## Requirements

- Python 3, using only the standard library
- macOS or Linux: the extension uses `fcntl` to lock the todo file

## Install

Copy this directory into a niminal extension root:

```bash
cp -r todo ~/.niminal/extensions/
```

Restart niminal or run `/reload`.

## Use

Ask for multi-step work and mention the list:

```text
implement the settings screen and track the work in todos
```

The agent creates the steps up front with `create` and a `subjects` list, marks
one `in_progress` as it starts it, and marks it `completed` when the work and
its checks are done. The widget updates as it goes.

Review the list yourself at any time:

```text
/todo
```

## Working with the widget

The widget sits above the composer while you have unfinished tasks, and shows:

- the title `Todos`
- each task as `#id subject`. The in-progress task shows its `activeForm`
  label, or `In progress` when it does not have one
- completed tasks with a `✓` marker and dimmed text
- a progress bar for the finished share, for example `2/5 complete`

The widget is read-only. The agent updates it as it works.

When the last unfinished task is marked complete, the widget closes itself and
niminal shows a notification such as `All 3 tasks complete`. The finished tasks
stay in the saved list, so `/todo` then shows them instead of an empty list, and
the widget comes back if the agent adds another task.

To close the list early, ask the agent to clear the todos.

## The `todo` tool

| Action | Required arguments | What it does |
| --- | --- | --- |
| `create` | `subject`, or `subjects` for several at once | Adds pending task(s) and returns their ids |
| `update` | `id`, plus `subject`, `description`, `activeForm`, or `status` | Changes one task |
| `list` | none | Lists unfinished tasks grouped by status |
| `get` | `id` | Shows one task |
| `delete` | `id` | Marks a task deleted |
| `clear` | none | Removes every task |

Other arguments: `description` and `activeForm` add detail and a
present-continuous label such as "Running tests", and `status` is `pending`,
`in_progress`, or `completed`. Passing `subjects` creates one pending task per
name, in order; `description` and `activeForm` apply to the single-`subject`
form only. Deleted tasks stay in the saved file, and `list` hides them unless
you pass `includeDeleted`. Completed tasks also stay in the saved file, and
`list` shows them only when you ask for that status, for example
`{"action": "list", "status": "completed"}`.

Marking a task `in_progress` returns any other in-progress task to `pending`, so
the list keeps a single current task. `clear` does not reuse ids.

After any action except `list`, the tool result ends with a one-line summary of
the open tasks, so the agent always sees the current work without repeating
finished or deleted tasks. Use `list` when you want the full view, including
descriptions.

niminal asks for permission the first time the agent uses the tool, and one
approval you choose to remember covers the rest of the session. This includes
`list` and `get`: a tool is read-only as a whole, so reads and writes share one
approval.

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
  completed. The `todo` tool still sees every task.
- The extension targets macOS and Linux. On Windows, `fcntl` is unavailable.
- Tasks live in `~/.niminal/todos/`; there is no per-project file to commit.
