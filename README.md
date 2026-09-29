# niminal extensions and tools

Make [niminal](https://niminal.dev) do more without waiting for a release. This
repository collects small add-ons you can drop into a niminal folder and use
right away: extra slash commands, model tools, and integrations with the
software you already run.

Everything here is optional and standalone. Install the pieces you want, skip
the rest, and remove any of them by deleting a directory.

## What's in here

There are two kinds of add-on.

**Extensions** are long-running programs that niminal starts with your session.
They can add slash commands, register tools the model can call, and react to
lifecycle events like the start and end of a turn.

| Extension | What it does | Docs |
| --- | --- | --- |
| [handoff](./extensions/handoff/) | Carry context from a long conversation into a clean session | [README](./extensions/handoff/README.md) |
| [herdr](./extensions/herdr/) | Report niminal's state to a [Herdr](https://herdr.dev) pane | [README](./extensions/herdr/README.md) |
| [panel_demo](./extensions/panel_demo/) | Add `/panel_demo` to show a widget panel with action buttons | [README](./extensions/panel_demo/README.md) |
| [pirate](./extensions/pirate/) | Add `/pirate` to make the agent answer like a pirate | [README](./extensions/pirate/README.md) |
| [powerline_footer](./extensions/powerline_footer/) | Add `/footer_demo` to show the provider and model in the footer | [README](./extensions/powerline_footer/README.md) |
| [session_cleanup](./extensions/session_cleanup/) | Delete session files older than 30 days when you quit | [README](./extensions/session_cleanup/README.md) |
| [subagent](./extensions/subagent/) | Delegate work to isolated read-only subagents, from the model or `/subagent` | [README](./extensions/subagent/README.md) |
| [todo](./extensions/todo/) | Give the agent a `todo` tool and a task list widget above the composer | [README](./extensions/todo/README.md) |

**Tools** are one-shot programs that niminal runs only when the model calls
them. They show up as typed tools next to the built-in ones.

| Tool | What it does | Docs |
| --- | --- | --- |
| [tavily-search](./tools/tavily-search/) | Add a `web_search` tool backed by the Tavily search API | [README](./tools/tavily-search/README.md) |

## Before you install

**Extensions and tools are executable programs.** niminal starts every
extension it finds and keeps it running for the session, and it runs tools in
your workspace. They can read and write files, run commands, and reach the
network, depending on what they declare and what you approve.

Read the source of anything you install, and only install add-ons you trust.

## Install an extension

Clone this repository, then copy the extension you want into your global
extensions folder and mark it executable:

```bash
git clone https://github.com/martineastwood/niminal-extensions.git
cp -r niminal-extensions/extensions/pirate ~/.niminal/extensions/
chmod +x ~/.niminal/extensions/pirate/extension.py
```

Restart niminal, or run `/reload` if it is already open. The extension's slash
commands and tools are available immediately.

`~/.niminal/extensions/` works everywhere. If you use the portable `~/.agents/`
layout, those folders work too.

## Install a tool

Tools go in a tools folder instead:

```bash
cp -r niminal-extensions/tools/tavily-search ~/.niminal/tools/
chmod +x ~/.niminal/tools/tavily-search/web-search.py
```

Restart niminal or run `/reload`. The model can now call the tool by name.

Some tools need a little setup, such as an API key in an environment variable.
Check the tool's README for the details.

## Install for one project

To keep an add-on with a specific project instead of your whole machine, put it
in the project's own folder:

```text
<workspace>/.niminal/extensions/<name>/
<workspace>/.niminal/tools/<name>/
```

Project add-ons load only in trusted workspaces. If you are not sure a
workspace is safe, review its add-ons before trusting it.

## Write your own

If you can write a program that reads and writes lines of JSON, you can write
an extension in whatever language you like: Python, JavaScript, C++, Rust,
Go, or shell.

- [Extensions and hooks](https://niminal.dev/guides/extensions-and-hooks/) covers
  the folder layout, the manifest, the protocol, and examples.
- [External tools](https://niminal.dev/guides/external-tools/) covers `tool.json`,
  capabilities, and how the model calls a tool.

## Learn more

- [Files and directories](https://niminal.dev/reference/files-and-directories/)
  for every place niminal looks for add-ons
- [Permissions](https://niminal.dev/guides/permissions/) for how tool approval works
