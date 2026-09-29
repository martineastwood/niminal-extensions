# session_cleanup

Keep `~/.niminal/sessions/` from growing forever. When you quit niminal, this
extension deletes session files you have not touched for 30 days.

## Requirements

- Python 3, using only the standard library

## Install

Copy this directory into a niminal extension root:

```bash
cp -r session_cleanup ~/.niminal/extensions/
chmod +x ~/.niminal/extensions/session_cleanup/extension.py
```

Restart niminal or run `/reload`. There is nothing else to configure: the
extension deletes nothing until the next time you quit niminal.

## How it works

Every time you quit, the extension looks at the files under
`~/.niminal/sessions/` and removes the ones whose last change is older than the
retention window. That includes deleted sessions in `.trash/` and
`.recovery-<timestamp>` backups beside a session.

Your current session is always kept, and so is anything you used inside the
window, so `/resume` and `/search` keep working for recent conversations.

## Change the retention window

Set `NIMINAL_SESSION_CLEANUP_DAYS` in the environment niminal starts in. To keep
two months of history:

```bash
export NIMINAL_SESSION_CLEANUP_DAYS=60
```

The default is 30 days. Values that are not a positive whole number are ignored
and 30 days is used instead.

```bash
NIMINAL_SESSION_CLEANUP_DAYS=90 niminal
```

## Troubleshooting

Deletion is based on each file's last modification time, not on the timestamp in
its name, so a session you sent a message in recently survives even if you
started it months ago.

The extension only runs on quit. Reloading extensions with `/reload`, or
switching sessions with `/new`, `/resume`, or `/fork`, does not trigger cleanup.

Nothing is deleted until niminal quits, and only files older than the window are
removed. To keep a session past the window, resume it and exchange one message
before it expires, or copy it out of `~/.niminal/sessions/`.

## Next steps

- [Files and directories](https://niminal.dev/reference/files-and-directories/)
  for the paths niminal writes
- [Sessions](https://niminal.dev/guides/sessions/) for `/resume`, `/fork`, and
  session history
