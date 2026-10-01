---
name: setup-pstack
description: Configure which models pstack uses per role. Prefer the /setup-pstack command; this skill documents the config shape and pstack_config fallback. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Write `~/.niminal/pstack/models.json` so subagent `role` arguments resolve to models.

## Preferred path

Run the slash command:

```text
/setup-pstack
```

It walks each role with a short picker and saves the JSON file. Re-run anytime.

## Skill fallback

If the command UI is unavailable, use the `pstack_config` tool:

1. `action: "list-models"` for candidates (`inherit-parent` is always valid).
2. `action: "set"` with `role` plus `model` or `models` (array for panel roles).
3. `action: "get"` to confirm.

Never write a model id you have not confirmed is available for this provider.
`inherit-parent` and `auto` mean: omit `model` on the child so it uses the parent session model.

## Config shape

```json
{
  "version": 1,
  "roles": {
    "feature, refactoring": "inherit-parent",
    "bug-fix": "inherit-parent",
    "perf-issue": "inherit-parent",
    "hillclimb": "inherit-parent",
    "judgment and prose": "inherit-parent",
    "hardest tasks": "inherit-parent",
    "how explorer": "inherit-parent",
    "how explainer": "inherit-parent",
    "why investigators": "inherit-parent",
    "why synthesizer": "inherit-parent",
    "reflect tooling": "inherit-parent",
    "reflect judgment, divergent, synthesizer": "inherit-parent",
    "arena runners": ["inherit-parent"],
    "arena cross-judge pool": ["inherit-parent"],
    "swarm workers": "inherit-parent",
    "architect runners": ["inherit-parent"],
    "interrogate reviewers": ["inherit-parent"]
  }
}
```

Panel roles may be string arrays: one subagent per entry. `swarm workers` is the
default for every worker unless a race names another model per arm.

## After setup

Shift-Tab to **Poteto**, then use `/skill:poteto-mode` (or rely on the mode
prompt) for playbooks. Optionally offer `/skill:create-verification-skill` if
the project has no `verify-*` harness yet.
