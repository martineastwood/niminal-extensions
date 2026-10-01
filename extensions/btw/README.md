# btw

Open a separate chat about your current niminal session. Type `/btw`, ask questions
in the modal, then close it to return to the main conversation. Your side questions
and answers stay out of the main conversation and saved session.

```text
/btw
```

The modal has its own composer and scrolling transcript. Ask your first question,
press Enter, then keep chatting there without typing `/btw` again.

## Install

You need Node.js on your `PATH` and a niminal build that supports modal extension
widgets and `model.complete` with read-only tools.

From the extensions directory, copy btw into your extension root:

```bash
cp -r btw ~/.niminal/extensions/
```

Restart niminal or run `/reload`.

## Chat in the modal

You can open the modal with an optional first question:

```text
/btw why does the retry helper wait before the second attempt?
```

| Input | Effect |
| --- | --- |
| Enter | Send your question when the previous answer has finished |
| PageUp, PageDown | Scroll the side conversation |
| Mouse wheel | Scroll the side conversation |
| Escape or click **Close** | Discard the side chat and return to the main conversation |

You can write your next question while an answer runs. Close is available at any
time. Each opening starts a fresh side chat; closing discards its transcript and
any unfinished answer. A model request already running may finish in the
background, and a new answer may wait for that request to finish.

## What btw knows

The side chat receives the main conversation available when you open the modal.
That snapshot stays fixed throughout the side chat, even if the main agent keeps
working. It includes the conversation still available in the session context;
content removed by compaction is not restored. Images and attachments are
represented by text markers, rather than sent to the side model.

Follow-up questions include earlier successful side questions and answers. The
side model can inspect the workspace with `read`, `grep`, `glob`, and `ls`. It
cannot edit files or run shell commands. Workspace reads see files as they are at
the time of the lookup, rather than a snapshot of their contents.

## Limitations

- The main agent can keep working while the modal is open. Closing the modal
  preserves its progress and returns you to the main composer.
- Side chats are temporary. Closing, changing sessions, reloading extensions, or
  restarting niminal discards them.
- Each answer is a paid request on your active model and provider, where applicable.
- Each answer can use up to eight read-only tool calls; large tool results are trimmed.
- The main snapshot and side history must fit your model's context window. If the
  provider rejects a long conversation, close the modal and compact the main
  conversation before opening a fresh side chat.

## Next steps

See [extensions and hooks](https://niminal.dev/guides/extensions-and-hooks/) to
build an extension, or use [handoff](../handoff/) to carry a summary into a new
main session.
