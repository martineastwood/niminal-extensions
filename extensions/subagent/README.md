# subagent

Give the model, and yourself, isolated subagents. Each run starts a fresh
headless niminal session with read-only tools, works on one task, and returns a
report plus its token usage.

Subagents see only the task you give them, never the main conversation, so a
task must be self-contained. Every subagent is asked to finish with a report: a
short summary, its findings with file paths and line numbers, and whatever it
could not determine.

Ask for one subagent, a parallel batch, or a chain where each step builds on the
last report. A run can also go to the background, so you can keep working and
collect its report when it is ready.

## Requirements

- Node.js on your `PATH` (standard library only)
- `niminal` on your `PATH`, or set `NIMINAL_BIN` to a binary path

## Install

Copy this directory into an extension root:

```bash
cp -r subagent ~/.niminal/extensions/
```

Restart niminal or run `/reload`.

## Use

Ask for delegated work in the chat, for example:

```text
investigate how feature C works using subagents

check the auth flow and the storage path in parallel, then summarize both

start a background subagent to map the storage layer, then read src/auth.cpp
yourself and collect the review when it is done
```

The `subagent` tool takes:

| Argument | Required | Meaning |
| --- | --- | --- |
| `task` | one of these three | Complete, self-contained instructions for one subagent |
| `tasks` | one of these three | Parallel batch of `{ agent, task, label }` items, all started at once |
| `chain` | one of these three | Sequential `{ agent, task, label }` steps, up to 8. In a step task, `{previous}` is replaced by the report before it |
| `label` | no | Short name shown in the Subagents panel, e.g. `parser-investigation` |
| `agent` | no | Agent for the call, such as `explore` or `general`. Defaults to `general`. A batch or chain item can name its own |
| `run_in_background` | no | Return as soon as the run starts, with an id, instead of waiting for the report. Not available with `chain` |
| `timeout_seconds` | no | Kill each run after this many seconds. Defaults to 1800 |

### Collect a background run

`run_in_background` answers with an id straight away, so the model can carry on
and collect the report when it needs it:

```text
start a background subagent to audit the migrations, then check the CLI myself
```

The `subagent_result` tool takes that `id` and an optional `wait_seconds` (up to
300). It returns the report once the run is done, or what the run is doing now if
it is still going:

```text
collect subagent 3 and summarize its findings
```

Reports stay collectable for the rest of the session, so a background run started
in one turn can be collected in the next.

## Agents

| Agent | Tools | Use it for |
| --- | --- | --- |
| `explore` | `read`, `grep`, `glob`, `ls` | Finding where code lives and how it works. The cheapest, fastest agent |
| `general` | `explore` tools plus `skill` | Multi-step research that should consult your skills or instructions |

Both agents are read-only, so a subagent can report on your code but never change
it. No agent can start further subagents.

The model sees every agent in its tool schema, one line each, as
`name (tools): description`. Writing a good `description` is what lets it pick
the right agent: `explore` reads and searches only, while `general` can also
consult your skills.

### Add your own agent

Drop a Markdown file in `~/.niminal/subagents/` or `~/.agents/subagents/` and it
joins the agent list. The prompt is the file body, and the frontmatter sets the
description, tools, model, and reasoning:

```markdown
---
description: Reviews a change for bugs and missing tests
tools: read,grep,glob
model: claude-sonnet-4-5
thinking: high
---
You review a proposed change. Read the diff and the surrounding code, then list
concrete bugs, missing tests, and anything you could not verify.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | no | Shown to the model next to the agent's tools, which is how it picks an agent. Defaults to the prompt's first line |
| `tools` | no | Comma-separated read-only tools. Defaults to all of them |
| `model` | no | Model for this agent. Overrides `default_model` |
| `thinking` | no | Reasoning level for this agent: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Defaults to `thinking` in `subagents.json`, then your session level |
| `max_steps` | no | Tool-loop cap for this agent, e.g. `40`. Defaults to `max_steps` in `subagents.json`, then your niminal config |
| `name` | no | Agent name. Defaults to the file name |

The file name is the agent name, so `reviewer.md` gives you
`agent: "reviewer"`. A later file replaces an earlier one with the same name:
project agents beat global ones, `.niminal` beats `.agents` in the same scope,
and either can replace a built-in like `explore`.

Project agent files load only in a trusted workspace, so a repository you have
not approved cannot change how subagents behave. Trust one with `--approve` or
`/trust on`, and the extension warns on stderr when it skips those files.

Agent files are read only. A `tools` value that names anything outside `read`,
`grep`, `glob`, `ls`, and `skill` is dropped, and the extension warns on stderr.
If every tool is dropped, the agent falls back to all read-only tools.

## Run a subagent yourself

```text
/subagent explore find where the retry policy is implemented

/subagent reviewer check the change I just made
```

The report is printed in your session. A leading word names the agent only when
it matches one, so `/subagent find the parser` runs the default agent on the
whole line.

## Choose the model

A subagent runs on the model its agent file sets, then on `default_model` from
`subagents.json` or `SUBAGENT_DEFAULT_MODEL`. When neither sets one, it inherits
your session model.

Neither built-in agent sets a model, so give the agent file one whenever a run
should use something other than your session model, for example a cheaper model
for search work:

```markdown
---
description: Finds where code lives, on a cheaper model
tools: read,grep,glob,ls
model: claude-haiku-4-5
---
You are a read-only code search subagent. Locate the code the task asks about,
then report the files and functions that matter.
```

A subagent keeps your session's provider and takes only the model id, so use the
id form that provider expects: `claude-haiku-4-5` on Anthropic, `gpt-5` on
OpenAI, `openai/gpt-4o-mini` on OpenRouter. The id goes to niminal as `--model`.
An id the provider does not know fails the run, and the report starts with
`subagent failed:` followed by the provider's message.

The model id comes from the agent file or the config, never from the tool call,
so pick an agent instead: "two explore subagents, one for each package".

## Run subagents in parallel, in a chain, or in the background

- **Several calls in one step.** When the model calls `subagent` more than once
  in the same step, the calls run at the same time, up to `max_concurrent`.
  Further calls wait for a slot and start as one frees up, so a wide fan-out
  cannot surprise you with a bill.
- **One call, several tasks.** A `tasks` batch starts every item at once and
  waits for all of them, so a fixed fan-out does not depend on how many calls the
  model happens to emit.
- **One call, in order.** A `chain` runs each step after the one before it and
  substitutes `{previous}` with that report, which suits review-then-fix work:
  "have a scout map the retry path, then have a reviewer check the plan against
  it."
- **One call, keep working.** `run_in_background` returns an id at once and
  leaves the run going. Collect it with `subagent_result`, in the same turn or a
  later one.

Each run keeps its own timeout, and a batch or chain item can name its own agent,
so one call can mix `explore` and `general`.

## Watch the subagents work

While anything is queued or running, a **Subagents** panel sits above the
composer with one row per subagent:

```text
╭─ Subagents · 1 running · 1 queued ──────────────────╮
│ 1 done · 15.5k in                                   │
│   ✓ #1 auth-flow · read src/auth/session.cpp · 38s  │
│   › #2 storage · grep: needle · 12s · 4.1k in       │
│   · #3 parser · queued                              │
│   [1] Stop storage                                  │
│   Tab focus · ↑/↓ choose · enter run · esc close    │
╰─────────────────────────────────────────────────────╯
```

Each row shows the run id, the label, what the subagent is doing right now, how
long it has been running, and the tokens it has spent. `›` marks a running
subagent, `·` a queued one, and `✓` a finished one. Rows for finished subagents
stay visible while others are still working, so a fan-out shows what already
reported back.

To stop a run, press Tab on an empty composer, choose an action with the arrow
keys, and press Enter. Stopping a queued run drops it before it starts. When the
last subagent finishes, the panel disappears on its own. Stopping a run is
reported to the model as "stopped by the user", so it knows the report is
incomplete rather than finished.

The panel only shows live state. A finished row fades when nothing is running,
and its report stays collectable by id, so the model can still fetch it in a
later turn.

## Teaching the model when to delegate

The tool description covers what the tool is. For orchestration policy, add a
short section to your `AGENTS.md`:

```markdown
## Subagents
The `subagent` tool runs isolated, read-only agents that cannot see this
conversation, so tasks must be self-contained: include file paths, what to look
for, and what to report.

- Use it for broad investigation, parallel research, and double-checking.
  Do the trivial lookups yourself.
- Split a large investigation into 2-3 subagents with distinct tasks, either as
  several calls or one `tasks` batch.
- Chain steps when one result informs the next; `{previous}` carries the report.
- Start long jobs with `run_in_background` and collect them with
  `subagent_result` when you need the answer.
- Synthesize their reports; don't paste them verbatim.
```

## Configuration

Set shared defaults in `~/.niminal/subagents.json`. The extension reads
`subagents.json` from the same folders as agent files, so it also picks up
`~/.agents/subagents.json`, `<workspace>/.agents/subagents.json`, and
`<workspace>/.niminal/subagents.json`. A project file overrides a global file,
`.niminal` overrides `.agents` in the same scope, and environment variables
override them all.

| Key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `max_concurrent` | `SUBAGENT_MAX_CONCURRENT` | `4` | Subagents allowed to run at once. Further calls wait for a slot |
| `timeout_seconds` | `SUBAGENT_TIMEOUT_SECONDS` | `1800` | Seconds before a stuck subagent is killed. Per-call `timeout_seconds` overrides it |
| `default_agent` | | `general` | Agent used when the model omits one |
| `default_model` | `SUBAGENT_DEFAULT_MODEL` | unset | Model for subagents whose agent file sets none |
| `thinking` | | your session level | Reasoning level for subagents whose agent file sets none |
| `max_steps` | | your niminal `max_steps` | Tool-loop cap for subagents whose agent file sets none |

```json
{
  "max_concurrent": 4,
  "timeout_seconds": 1800,
  "default_agent": "general",
  "default_model": "claude-haiku-4-5",
  "thinking": "low",
  "max_steps": 40
}
```

`NIMINAL_BIN` names the binary the extension launches for subagents. It falls
back to `niminal/build/niminal` in the workspace when that exists, then
`niminal` on your `PATH`.

## Limitations

- Subagents are read-only. They can report on your code but never change it, and
  a headless subagent has no permission prompt.
- Agent files are read at startup. Run `/reload` after adding or editing one.
- A `chain` runs in the foreground, because each step needs the report before it.
  A running subagent cannot be sent new instructions: you can watch and stop it,
  but not steer it.
- Each run uses `--no-session`, so subagent transcripts stay out of your session
  list, which also means a run cannot be resumed.
- The panel is live state only. Once a run leaves it, the tool calls it made are
  gone; what remains is the report, which stays collectable by id until the
  newest 32 runs push it out.
- Each subagent inherits your provider and model configuration unless an agent
  file or `default_model` sets a model.
- A cancelled run is stopped, but the report it had produced is dropped when the
  run is still queued. A running subagent's partial report is kept.
- Project agents are ignored until the workspace is trusted, and a subagent then
  loads the same project skills and instructions your session does.
- The extension targets POSIX. On Windows, wrap `extension.mjs` in a `.cmd` that
  calls `node "%~dp0extension.mjs" %*`.
- Running subagents are stopped when niminal exits. A subagent that ignores
  `SIGTERM` gets 1.5 seconds before it is killed.
