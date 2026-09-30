# powerline_footer

Show the provider and model you are running in the footer, styled like a
powerline prompt. A small demo of extension footer status.

## Requirements

- Python 3, using only the standard library

## Install

Copy this directory into a niminal extension root:

```bash
cp -r powerline_footer ~/.niminal/extensions/
```

Restart niminal or run `/reload`.

## Use

Add the footer segment:

```text
/footer_demo
```

The footer then reads `niminal <provider> / <model>`, with each part in its own
style:

| Segment | Style |
| --- | --- |
| ` niminal ` | emphasis |
| provider | accent |
| ` / ` | muted |
| model | success |

The values come from the session at the moment you run the command, so they
follow `/provider`, `/model`, and a session you resume or start.

Clear it again:

```text
/footer_demo clear
```

## Limitations

- The segment shows the provider and model from the last time you ran
  `/footer_demo`, so run it again after the values change.
- The segment only appears after you run `/footer_demo`; it does not show up on
  its own at startup.
- The footer is this extension's own status segment. It is not refreshed by
  `/reload`, which restarts the extension and clears the segment until you run
  `/footer_demo` again.
