# pirate

Toggle pirate mode and the agent responds like a stereotypical pirate while
still completing your task correctly. A small demo of changing model behavior
from an extension.

## Requirements

- Python 3, using only the standard library

## Install

Copy this directory into a niminal extension root:

```bash
cp -r pirate ~/.niminal/extensions/
```

Restart niminal or run `/reload`.

## Use

Toggle pirate mode:

```text
/pirate
```

Each press flips it on or off. A `pirate mode` indicator appears in the footer
while it is enabled. When on, every model request in the session carries pirate
instructions appended to the system prompt, so the agent answers with
"Arrr!", "Shiver me timbers!", and so on. The extra instructions apply only to
model requests; they are never written into the saved session.

Disabling pirate mode restores normal responses from the next request on.
