# herdr

Report niminal's lifecycle state to a [Herdr](https://herdr.dev) pane.

When niminal runs inside a Herdr pane (`HERDR_ENV=1`), this extension maps:

| niminal event | Herdr state |
| --- | --- |
| `session_start` | idle |
| `turn_start` | working |
| `turn_end` | idle |
| shutdown | release-agent |

Reports include `--agent-session-id` so Herdr can expose the niminal session reference.

## Requirements

- [Herdr](https://herdr.dev) with niminal running in a Herdr pane
- Python 3 (stdlib only)

## Install

Copy this directory into a niminal extensions root:

```bash
cp -r herdr ~/.niminal/extensions/
```

Restart niminal or run `/reload`.
