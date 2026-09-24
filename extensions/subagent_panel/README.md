# subagent_panel

Show a subagent activity panel above the composer, with a task list and
**Steer** and **Stop** buttons. A UI demo of extension widgets: the panel shows
fixed example work items and does not start real child agents.

For real subagents, see [spawn_agent](../spawn_agent/).

## Requirements

- Python 3, using only the standard library

## Install

Copy this directory into a niminal extension root:

```bash
cp -r subagent_panel ~/.niminal/extensions/
chmod +x ~/.niminal/extensions/subagent_panel/extension.py
```

Restart niminal or run `/reload`.

## Use

Show the panel:

```text
/subagents_demo
```

The widget appears above the composer, titled `Subagents · simulated demo`, with
three items: one done, one active, and one pending.

To press a button, focus the empty composer and press Tab, move with the up and
down keys, then press Enter. Escape closes the selector.

| Button | What it does |
| --- | --- |
| **Steer active task** | Appends `· checking edge cases` to the active item |
| **Stop active task** | Marks the active item `· stopped` and done |

Both buttons refresh the panel in place, so you can watch the list change
without leaving the composer.

## Limitations

- The panel is a demo: it never starts a subagent, and the items reset when the
  extension restarts.
- There is no action to hide the panel. Use `/reload` to restart the extension
  and clear it, or remove the extension directory.
