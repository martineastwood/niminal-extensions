---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
---

# How

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem: enough to build a working mental model, not annotated source code.

Role lines live in `~/.niminal/pstack/models.json`. Pass `role` on each `subagent` call (`how explorer`, `how explainer`). Omit `model` when the role is `inherit-parent` or unset.

## Step 1. Assess complexity

If the scope is ambiguous, state your interpretation. The user can redirect.

- **Simple** (one module, one narrow mechanism, a single subsystem such as trust, permissions, or one API): one subagent explores and explains. Go to Step 2b.
- **Complex** (many services, a cross-cutting feature, a full architectural tour): parallel scouts, then one explainer. Go to Step 2a.

**When in doubt, take the simple path.** Most "how does X work in this repo?" questions are simple.

## Step 2a. Explore (complex only)

Decompose into 2 to 4 angles. Issue **exactly one** `subagent` tool call with a **`tasks` array** (2 to 4 items). Do **not** issue multiple `subagent` calls in the same turn. Parallelism only happens inside one call's `tasks` list.

For each task:

- `agent`: `"scout"` (read-only recon; do not use `general` for explorers)
- `role`: `"how explorer"`
- `label`: short angle name
- `task`: body from `references/explorer-prompt.md` with `{QUESTION}` and `{EXPLORATION_ANGLE}` filled in

Then go to Step 3.

## Step 2b. Direct explain (simple)

Issue **one** `subagent` call:

- `agent`: `"scout"` or `"general"` (prefer scout unless you need `skill`)
- `role`: `"how explainer"`
- `task`: prompt from `references/explainer-prompt.md` with explorer findings left empty or omitted

Go to Step 4.

## Step 3. Synthesize (complex only)

After every explorer returns, issue **one** `subagent` call:

- `agent`: `"general"` (or `"scout"` if no skill needed)
- `role`: `"how explainer"`
- `task`: `references/explainer-prompt.md` with `{EXPLORER_FINDINGS_ALL}` filled from scout reports

Go to Step 4.

## Step 4. Present

Present the explainer (or scout) report to the user. Light edits for conversation context are fine. Do not substantially rewrite it.

**Stop after presenting.** Do not:

- re-read the codebase to "confirm" the report
- write or run Python, shell, or other scripts to verify the explanation
- open extra todos for verification, proof, or follow-up exploration

Cited paths and line numbers in the report are the evidence. If something looks wrong, say so in one sentence and ask whether to dig further. Otherwise end the turn.


## Output format

Use the sections in `references/explainer-prompt.md` when they apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
