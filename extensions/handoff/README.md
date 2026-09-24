# handoff

Move the useful context from a long conversation into a clean niminal session.
The extension asks your active model to prepare a focused handoff prompt, opens
the result in your external editor, then places the edited draft in a new
session's composer.

## Requirements

- A niminal build with `model.complete`, `ui.editor`, and session actions
- Python 3, using only the standard library
- `$VISUAL` or `$EDITOR`, with `nano` used as the fallback

## Install

Copy this directory into a niminal extension root:

```bash
cp -r handoff ~/.niminal/extensions/
chmod +x ~/.niminal/extensions/handoff/extension.py
```

Restart niminal or run `/reload`.

## Use

Describe the work you want to continue in the new session:

```text
/handoff implement phase two of the plan
```

niminal generates a self-contained prompt from the effective conversation
context. If the session was compacted, that context includes the latest summary
and the messages retained after it.

Edit and save the prompt when your editor opens. niminal then starts a clean
session and places the result in the composer. Review it and press Enter when you
are ready. The previous session remains available through `/resume`.

The command requires the interactive TUI. Cancelling generation or closing the
editor without a usable prompt leaves you in the current session.
