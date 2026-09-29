# panel_demo

Show a panel above the composer with a list and two action buttons. A UI demo of
extension widgets: the panel shows fixed example items and does not do real
work. Use it as a starting point for your own widget, or run it to see how
actions and list states behave.

## Requirements

- Python 3, using only the standard library

## Install

Copy this directory into a niminal extension root:

```bash
cp -r panel_demo ~/.niminal/extensions/
chmod +x ~/.niminal/extensions/panel_demo/extension.py
```

Restart niminal or run `/reload`.

## Use

Show the panel:

```text
/panel_demo
```

The widget appears above the composer, titled `Panel · simulated demo`, with
three items: one done, one active, and one pending.

To press a button, focus the empty composer and press Tab, move with the up and
down keys, then press Enter. Escape closes the selector.

| Button | What it does |
| --- | --- |
| **Advance active item** | Appends `· refined` to the active item |
| **Mark active item done** | Marks the active item `· done` and dims it |

Both buttons refresh the panel in place, so you can watch the list change
without leaving the composer.

## Limitations

- The panel is a demo: the items are fixed and reset when the extension
  restarts.
- There is no action to hide the panel. Use `/reload` to restart the extension
  and clear it, or remove the extension directory.
