# niminal-pstack

Niminal port of [pstack](https://github.com/cursor/plugins/tree/main/pstack): sticky Poteto Mode, the full skill and playbook catalog, and writable isolated subagents.

Derived from Cursor's pstack (MIT). See [LICENSE](LICENSE).

## Install

From this repository root (`extensions_and_tools`):

```bash
mkdir -p ~/.niminal/extensions ~/.niminal/skills ~/.niminal/subagents

# Poteto mode + setup-pstack
rm -rf ~/.niminal/extensions/niminal-pstack
cp -r niminal-pstack/extension ~/.niminal/extensions/niminal-pstack

# Skills (playbooks, principles, how/why/swarm, …)
cp -r niminal-pstack/skills/. ~/.niminal/skills/

# Write-capable poteto-agent + comment-sicko
cp -r niminal-pstack/agents/. ~/.niminal/subagents/

# Enhanced subagent (required for write tools and worktrees)
rm -rf ~/.niminal/extensions/subagent
cp -r extensions/subagent ~/.niminal/extensions/subagent

# Optional: todo checklist UI referenced by Poteto mode
rm -rf ~/.niminal/extensions/todo
cp -r extensions/todo ~/.niminal/extensions/todo
```

Always `rm -rf` the extension dest before `cp -r`, or you nest a second copy and keep the old program. The previous read-only subagent build strips `edit`/`write`/`git`/`bash` from agent files.

Restart niminal or run `/reload`. Skills load from `~/.niminal/skills/` (not from
the extension directory).

### Check the install

- Shift-Tab cycles through **Poteto**
- `/skill:poteto-mode` resolves
- `~/.niminal/subagents/poteto-agent.md` exists
- Subagent tool description mentions `worktree`

## Start

1. Shift-Tab until the footer shows **Poteto**.
2. Run `/setup-pstack` once to map roles to models (defaults to `inherit-parent`).
3. Work as usual, or open a playbook explicitly:

```text
/skill:poteto-mode investigate and fix the retry regression, then verify it
```

Individual skills use `/skill:NAME`, for example `/skill:how` and `/skill:no-comments`.

## What you get

| Piece | Role |
| --- | --- |
| Shift-Tab **Poteto** mode | Sticky prompt: match a playbook, cite principles, verify real behavior |
| `skills/` | Full pstack catalog (principles, playbooks, how/why/swarm/arena, …) |
| `agents/poteto-agent.md` | Write-capable implementation delegate |
| `agents/comment-sicko.md` | Comment-only review |
| `/setup-pstack` | Writes `~/.niminal/pstack/models.json` |
| `pstack_config` / `pstack_sessions` / `pstack_todo` | Config, session listing, checklist fallback |

## Subagents and worktrees

Use the enhanced **subagent** extension. Built-in scout/reviewer agents stay read-only. `poteto-agent` can edit when installed under `~/.niminal/subagents/`.

```text
run poteto-agent on this slice with worktree true
```

Worktrees land under `<workspace>/.niminal/worktrees/<slug>`. They are not deleted automatically. JSON-mode children have no approval UI, so write-capable agents are YOLO inside their tool allowlist. Prefer distinct worktrees for parallel writers.

Configure models per role with `/setup-pstack` or `pstack_config`. Pass `role` on `subagent` calls; `inherit-parent` keeps the session model.

Fan out parallel scouts with **one** `subagent` call and a `tasks` array (see `/skill:how`). The main TUI usage footer is parent-session only; cumulative subagent tokens appear in the subagent extension status line and in each tool result.

## Poteto mode tools

The Poteto mode allowlist includes core built-ins plus `skill`, `ask_user`, `subagent`, `subagent_result`, `todo`, and the pstack tools. If you install other extensions (MCP bridges, etc.) and need them in Poteto mode, add their tool names to the mode's `tools` list in `extension/extension.mjs` and `/reload`.

## Scripts

Upstream `watch-pr` and orchestration helpers under `skills/poteto-mode/scripts/` are retained. They need Bun and `gh` when you use those playbooks.

## Provenance

Adapted from Cursor pstack and informed by the [pi-pstack](https://github.com/kkgogogo17/pi-pstack) host rewrite pattern. Niminal-specific changes: Shift-Tab session mode, `subagent` + worktrees, `~/.niminal/pstack/models.json`, and local children only (no Cursor Task / cloud agents).
