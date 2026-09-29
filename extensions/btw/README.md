# btw

Ask a side question without adding it to the conversation. `/btw` sends your
question to the active model with the conversation so far as background, and
shows the answer in a `btw` panel above the composer. You can ask while the main
agent is working and keep using the composer while the side answer runs. The
question, answer, and background stay out of the main thread.

Use it when something in the last turn makes you curious, but you do not want it
turned into the agent's next task: a term you have not seen, a decision you want
a second opinion on, or a detail you want explained before you decide what to
ask next.

## Requirements

- A niminal build with the `model.complete` host request, the same one
  `/handoff` uses
- Node.js on your `PATH` (standard library only)

## Install

Copy this directory into a niminal extension root:

```bash
cp -r btw ~/.niminal/extensions/
```

Restart niminal or run `/reload`.

## Use

Ask a side question:

```text
/btw why does the retry helper wait before the second attempt?
```

The panel shows your question and `Thinking…` while the answer runs. When it is
ready, the answer appears there wrapped at 80 columns so long lines stay
readable. The footer also shows `btw thinking` during the request. Your `/btw`
question and answer are not added to the conversation or sent on later turns.

Ask again to continue the side thread. Follow-up questions see the earlier side
answers as well as the main conversation:

```text
/btw and what happens if it never succeeds?
```

## Panel actions

Focus the empty composer and press Tab, then move with the up and down keys and
press Enter:

| Action | What it does |
| --- | --- |
| Open full answer | Opens the latest answer in your `$VISUAL` or `$EDITOR` |
| Close | Removes the panel |

Long answers are trimmed in the panel. Open the full answer when you want the
part that did not fit.

## What the side question sees

The model answers from the conversation, trimmed to the most recent 12 messages,
each capped at 1500 characters, with the whole background capped at 24000
characters. Earlier side questions in this run are included, up to the last 6.

The side question can read and search the workspace with the `read`, `grep`,
`glob`, and `ls` tools. This helps when the code needed for an answer has not
appeared in the conversation. It cannot edit files or run shell commands. If it
cannot find the answer in the conversation or workspace, it says what would
need to be checked instead of guessing.

Each answer can use up to eight read-only tool calls. Large text results are
trimmed before they are sent to the model.

Each side question is a normal model request on your active provider, so it
costs the same as any other request of that size.

## Limitations

- `/btw` uses the conversation available when you start the question. It cannot
  see later messages or output from the still-running turn.
- The panel shows up to 18 lines, counting the question and the answer.
- Closing the panel hides the answer, and there is no way to bring it back other
  than asking again or using Open full answer first.
- The side thread lives in the extension process. `/reload` or a restart forgets
  the earlier side questions.
- Answers are not saved to the session, so `/resume` does not bring them back.

## Next steps

- [Extensions and hooks](https://niminal.dev/guides/extensions-and-hooks/) for
  the host requests and widgets this extension uses
- [handoff](../handoff/) when you want the opposite: carry a summary of this
  conversation into a new session as your next real task
