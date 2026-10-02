# subagent

Give the model, and yourself, isolated subagents. Each run starts a fresh
headless niminal session, works on one task, and returns a report plus its
token usage. Built-in agents stay read-only. Agent files can opt into write
tools (`edit`, `write`, `bash`) or read-only extras such as `git` via
frontmatter, and optional `cwd` or `worktree: true` isolates writers under
`.niminal/worktrees/`.

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
rm -rf ~/.niminal/extensions/subagent
cp -r subagent ~/.niminal/extensions/subagent
```

Use `rm -rf` first: `cp -r` into an existing directory nests a second `subagent/` folder and leaves the old extension running.

Restart niminal or run `/reload` after you change the extension program itself.

### Workflow prompt templates

Niminal discovers prompt templates from `~/.niminal/prompts/` (and the other
paths in the [prompt templates guide](https://niminal.dev/guides/prompt-templates/)),
not from the extension folder. Copy or symlink the bundled templates:

```bash
mkdir -p ~/.niminal/prompts
cp ~/.niminal/extensions/subagent/prompts/*.md ~/.niminal/prompts/
```

Then use `/scout-and-plan`, `/review`, `/second-opinion`, or `/investigate` in
the TUI. Project prompt folders work too when the workspace is trusted.

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
| `tasks` | one of these three | Parallel batch of items, all started at once |
| `chain` | one of these three | Sequential steps, up to 8. In a step task, `{previous}` is replaced by the report before it |
| `label` | no | Short name shown in the Subagents panel, e.g. `parser-investigation` |
| `agent` | no | Agent for the call, such as `scout` or `reviewer`. Defaults to `general`. A batch or chain item can name its own |
| `model` | no | Model id override (call or per item) |
| `role` | no | Role name from `~/.niminal/pstack/models.json` (call or per item). `inherit-parent` / unset uses the session model |
| `cwd` | no | Working directory for the child (call or per item) |
| `worktree` | no | Create or reuse `.niminal/worktrees/<label>` and run there |
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

Reports stay collectable for the rest of the niminal run, so a background run
started in one turn can be collected in the next. Changing sessions does not
clear them: niminal keeps extensions running, so an id still resolves after
`/new` or `/resume`.

### Parallel batches

Use **one** `subagent` call with a `tasks` array so every item starts together.
Several separate `subagent` calls in the same turn run one after another.

### Token usage in the footer

The main session footer counts **parent** tokens only. Each subagent is a
separate headless niminal process, so its usage is not added to session totals.

This extension keeps a cumulative subagent total for the **current parent
session** and shows it in the footer status line (for example
`subagents ↑1.2M ↓80k`) after runs finish. `/new` and `/resume` clear it.
Per-run usage still appears at the bottom of each tool result. While runs are
active, the Subagents panel shows progress.

## Agents

| Agent | Tools | Use it for |
| --- | --- | --- |
| `scout` | `read`, `grep`, `glob`, `ls`, `git` | Fast codebase recon: paths, entry points, risks |
| `general` | scout tools plus `skill` | Multi-step research that should consult your skills |
| `planner` | `read`, `grep`, `glob`, `ls`, `git` | Read-only implementation plans with verification steps |
| `reviewer` | `read`, `grep`, `glob`, `ls`, `git` | Code review: bugs, tests, edge cases, simplicity |
| `oracle` | `read`, `grep`, `glob`, `ls`, `git` | Second opinion before acting; challenge assumptions |

All built-in agents are read-only. Agent files may list write tools. No agent
can start further subagents (`subagent` / `subagent_result` are blocked).

### Writable agents and worktrees

Omit `tools` for the default read-only set (`read,grep,glob,ls,git,skill`). To allow
edits, set frontmatter such as:

```markdown
---
description: Implements a scoped change in an isolated worktree
tools: read,grep,glob,ls,edit,write,bash,skill
---
```

JSON-mode children have no approval UI, so a write-capable agent is effectively
YOLO inside its allowlist. Prefer `worktree: true` (or a distinct `cwd`) for
writers, especially when running several in parallel. The extension warns when
multiple write-capable jobs share one tree. Worktrees are not deleted
automatically; prune them with `git worktree remove` or the pstack
worktree-cleanup playbook.

```text
run poteto-agent on this bugfix with worktree true
```

The registered tool description lists agents known at extension load time. Agent
files on disk are rediscovered on every `subagent` call, so new or edited agents
work immediately. Run `/reload` if you want the tool description to list new
agent names too.

### Add your own agent

Drop a Markdown file in `~/.niminal/subagents/` or `~/.agents/subagents/` and it
joins the agent list on the next subagent call. The prompt is the file body, and
the frontmatter sets the description, tools, model, and reasoning:

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
| `tools` | no | Comma-separated tools. Defaults to the read-only set (`read,grep,glob,ls,git,skill`). May add the write tools `edit,write,bash`. Nested `subagent` tools are dropped |
| `model` | no | Model for this agent. Used after `models.<name>.<provider>` in `subagents.json` |
| `thinking` | no | Reasoning level for this agent: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Defaults to `thinking` in `subagents.json`, then your session level |
| `max_steps` | no | Tool-loop cap for this agent, e.g. `40`. Defaults to `max_steps` in `subagents.json`, then your niminal config |
| `name` | no | Agent name. Defaults to the file name |

The file name is the agent name, so `reviewer.md` gives you
`agent: "reviewer"`. A later file replaces an earlier one with the same name:
project agents beat global ones, `.niminal` beats `.agents` in the same scope,
and either can replace a built-in like `scout`.

Project agent files load only in a trusted workspace, so a repository you have
not approved cannot change how subagents behave. Trust one with `--approve` or
`/trust on`, and the extension warns on stderr when it skips those files.

Agent files may list write tools. A `tools` value that names `subagent` or
`subagent_result` is dropped, and the extension warns on stderr. If every tool
is dropped, the agent falls back to the read-only default.

## Run a subagent yourself

```text
/subagent scout find where the retry policy is implemented

/subagent reviewer check the change I just made
```

The report is printed in your session. A leading word names the agent only when
it matches one, so `/subagent find the parser` runs the default agent on the
whole line.

## Workflow templates

| Command | What it asks the model to do |
| --- | --- |
| `/scout-and-plan` | Chain `scout` then `planner` on `$ARGUMENTS` |
| `/review` | Run `reviewer` on `$ARGUMENTS` |
| `/second-opinion` | Run `oracle` on `$ARGUMENTS` |
| `/investigate` | Chain `scout` then `oracle` on `$ARGUMENTS` |

Install the templates from `prompts/` as described above.

## Choose the model

Each subagent picks a model id in this order:

1. `models.<agent>.<provider>` in `subagents.json` (see below)
2. `model` in the agent's Markdown frontmatter
3. `default_models.<provider>` in `subagents.json`
4. `default_model` in `subagents.json` or `SUBAGENT_DEFAULT_MODEL`
5. Omit `--model` and inherit your session model

The active provider comes from niminal as `NIMINAL_PROVIDER` (your `/provider`
choice), and niminal keeps it current: `session_start` and
`session_settings_changed` report it again, so `/new`, `/resume`, `/provider`,
and `/model` all follow along. Your session's reasoning level arrives the same
way and becomes the default when no agent or `subagents.json` entry sets one.
Use provider-keyed entries when you switch hosts often and slugs differ:

```json
{
  "models": {
    "scout": {
      "openrouter": "openai/gpt-4o-mini",
      "anthropic": "claude-haiku-4-5",
      "opencode": "deepseek-v4.1-flash"
    },
    "oracle": {
      "openrouter": "anthropic/claude-sonnet-4",
      "anthropic": "claude-sonnet-4-6",
      "opencode": "deepseek-v4.1"
    }
  },
  "default_models": {
    "openrouter": "openai/gpt-4o-mini",
    "anthropic": "claude-haiku-4-5"
  }
}
```

Project `subagents.json` merges with global files: later roots override the same
agent and provider keys. Built-in agent names (`scout`, `oracle`, and so on)
work without custom Markdown files.

You can still set `model` in an agent file for a one-off override. The model id
must match what your active provider expects. The `subagent` tool does not take
a per-call model.

## Run subagents in parallel, in a chain, or in the background

- **Several calls in one step.** When the model calls `subagent` more than once
  in the same step, the calls run at the same time, up to `max_concurrent`.
  Further calls wait for a slot and start as one frees up.
- **One call, several tasks.** A `tasks` batch starts every item at once and
  waits for all of them.
- **One call, in order.** A `chain` runs each step after the one before it and
  substitutes `{previous}` with that report.
- **One call, keep working.** `run_in_background` returns an id at once. Collect
  it with `subagent_result`.

Each run keeps its own timeout, and a batch or chain item can name its own agent.

Tasks are sent to the child niminal on stdin, not as command-line arguments.

Long reports returned to the parent are capped at 2000 lines or 50KB (whichever
comes first), keeping the end of the report. The full text is written to a
private temp file and the path is included when truncation happens. Chain steps
still pass the full prior report through `{previous}`.

## Watch the subagents work

While anything is queued or running, a **Subagents** panel sits above the
composer with one row per subagent. Each row shows the run id, label, current
activity, elapsed time, and tokens spent. Stop actions appear in the panel when
more than one run is live.

## Teaching the model when to delegate

For orchestration policy, add a short section to your `AGENTS.md`:

```markdown
## Subagents
The `subagent` tool runs isolated agents that cannot see this conversation,
so tasks must be self-contained. Prefer worktrees for write-capable agents.

- Use `scout` for recon, `planner` for plans, `reviewer` for review, `oracle`
  before risky decisions, `general` when skills matter.
- Chain steps when one result informs the next; `{previous}` carries the report.
- Start long jobs with `run_in_background` and collect with `subagent_result`.
- Synthesize their reports; don't paste them verbatim.
```

## Configuration

Set shared defaults in `~/.niminal/subagents.json`. The extension reads
`subagents.json` from the same folders as agent files. Environment variables
override file values.

| Key | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `max_concurrent` | `SUBAGENT_MAX_CONCURRENT` | `4` | Subagents allowed to run at once |
| `timeout_seconds` | `SUBAGENT_TIMEOUT_SECONDS` | `1800` | Seconds before a stuck subagent is killed |
| `default_agent` | | `general` | Agent used when the model omits one |
| `default_model` | `SUBAGENT_DEFAULT_MODEL` | unset | Fallback model when no provider map matches |
| `default_models` | | unset | Per-provider fallbacks, e.g. `{ "openrouter": "openai/gpt-4o-mini" }` |
| `models` | | unset | Per-agent, per-provider ids, e.g. `{ "scout": { "anthropic": "…" } }` |
| `thinking` | | your session level | Reasoning level when the agent file sets none |
| `max_steps` | | your niminal `max_steps` | Tool-loop cap when the agent file sets none |

`NIMINAL_BIN` names the binary the extension launches for subagents.

## Limitations

- Built-in agents are read-only. Writable agents opt in via frontmatter and run
  without approval prompts in JSON mode.
- A `chain` runs in the foreground. You can watch and stop a run, not steer it.
- Each run uses `--no-session`, so subagent transcripts are not resumable.
- The panel is live state only; reports stay collectable by id until the newest
  32 runs push them out.
- Run `/reload` after changing `extension.mjs` or to refresh the agent list in
  the registered tool description. A session change does not reload the
  extension, so the tool description keeps the agent names it loaded with.
- Project agents are ignored until the workspace is trusted.
- A session change does not stop anything: running subagents keep going and the
  panel stays up until they finish.
- Running subagents are stopped when niminal exits. A child that ignores
  `SIGTERM` gets 1.5 seconds before it is killed.
