# powerline_footer

Show the provider and model you are running in the footer, styled like a
powerline prompt. A small demo of extension footer status.

## Requirements

- Python 3, using only the standard library

## Install

Copy this directory into a niminal extension root:

```bash
cp -r powerline_footer ~/.niminal/extensions/
chmod +x ~/.niminal/extensions/powerline_footer/extension.py
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

The values come from the session, so they match the provider and model you
started niminal with.

Clear it again:

```text
/footer_demo clear
```

## Limitations

- The provider and model are read when niminal starts the extension, so after
  switching model or provider mid-session, run `/reload` to refresh the footer.
- The segment only appears after you run `/footer_demo`; it does not show up on
  its own at startup.
