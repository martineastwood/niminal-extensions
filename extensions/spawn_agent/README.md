# spawn_agent

Give the model a `spawn_agent` tool that runs isolated subagents. Each call
starts a fresh headless niminal session, lets it work with read-only tools, and
returns the subagent's final report plus its token usage.

Subagents see only the task you give them, never the main conversation, so the
model writes self-contained tasks. Progress from each subagent (tool calls and
token usage) streams into the active tool display while it runs.

## Requirements

- Node.js on your `PATH` (standard library only)
- `niminal` on your `PATH`, or set `NIMINAL_BIN` to a binary path

## Install

Copy this directory into an extension root:

```bash
cp -r spawn_agent ~/.niminal/extensions/
chmod +x ~/.niminal/extensions/spawn_agent/extension.mjs
```

Restart niminal or run `/reload`.

## Use

Ask for delegated work in the chat, for example:

```text
investigate how feature C works using subagents
```

The tool takes:

| Argument | Required | Meaning |
| --- | --- | --- |
| `task` | yes | Complete, self-contained instructions for the subagent |
| `label` | no | Short name shown in progress output |

Subagents run with `--tools read,grep,glob,ls,skill` and cannot spawn
further subagents. Each run uses `--no-session`, so subagent transcripts do not
appear in your session list.

## Teaching the model when to delegate

The tool description covers what the tool is. For orchestration policy, add a
short section to your `AGENTS.md`:

```markdown
## Subagents
`spawn_agent` runs an isolated subagent. It cannot see this conversation,
so tasks must be self-contained: include file paths, what to look for,
and what to report.

- Use it for broad investigation, parallel research, and double-checking.
  Do the trivial lookups yourself.
- Split a large investigation into 2-3 subagents with distinct tasks.
- Synthesize their reports; don't paste them verbatim.
```

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `NIMINAL_BIN` | unset | Binary the extension launches for subagents. Falls back to `niminal/build/niminal` in the workspace when it exists, then `niminal` on your `PATH` |
| `SPAWN_AGENT_TIMEOUT_SECONDS` | `1800` | Seconds before a stuck subagent is killed |

## Limitations

- Subagents run headless, so there is no permission UI. The read-only tool
  allowlist is the safety boundary.
- Each subagent inherits your provider and model configuration; there is no
  per-call model selection yet.
- The extension targets POSIX. On Windows, wrap `extension.mjs` in a `.cmd`
  that calls `node "%~dp0extension.mjs" %*`.
- Running subagents are stopped when niminal exits. A subagent that ignores
  `SIGTERM` gets 1.5 seconds before it is killed.
