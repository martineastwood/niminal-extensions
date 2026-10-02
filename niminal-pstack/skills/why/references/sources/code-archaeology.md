# Code Archaeology (git + in-repo)

## What this source contains

- Commit history (messages, dates, authors, diffs)
- PR descriptions, review comments, and discussion threads (via `gh`)
- Inline code comments, TODOs, FIXMEs, deprecation notes
- ADRs (architectural decision records) if the repo keeps them
- Tests. Names and assertions often encode the edge cases that motivated a change
- Related files modified in the same commits (co-change signal)
- CHANGELOG entries, release notes in the repo
- Issue/ticket IDs mentioned in commit messages and PR bodies

The most trustworthy source, tied directly to the code, and the most complete. Everything that went through the repo should be here.

## How to search it

You have six read-only `git` subcommands: `status`, `log`, `diff`, `show`, `blame`, `branch`.

- `log` with `limit`, plus optional `ref`, `path`, `search`, and `follow`. `search` is the pickaxe: commits that added or removed that exact text. `follow` crosses renames and needs a `path`. Expand the seed commit list yourself with these rather than waiting for the parent.
- `show` with `ref <hash>`: the commit's message and full diff. Your highest-value call.
- `blame` with `path` and optional `start` / `end`: who last touched each line, and when. Point it at the target line range to find the last-touch commits.
- `diff` with `ref` and `path`: what changed between that ref and the working tree, scoped to one path. Useful for co-change signal when you name an adjacent file.

Only `gh` needs a shell, so PR bodies, review comments, and linked issues stay parent-side: Step 2 of the skill runs those and hands you the results in the seed. When the seed lacks one and it matters, record the exact query under Additional Leads. Don't guess at what a PR said.

For the in-repo evidence, your `grep` and `glob` tools replace the `rg` examples:

- TODOs, FIXMEs, and notes near the target: `grep` for `TODO|FIXME|HACK|XXX|NOTE`, then read the surrounding lines.
- ADRs: `glob` for `docs/adr/**` and `**/*.md`, then `grep` for `architecture decision` or the symbol.
- Related tests: `grep` for the symbol, filtered to test paths. Test names often encode the why.
- CHANGELOG and release notes: `grep` the target symbol across `CHANGELOG*` and `docs/`.

## What good evidence looks like here

- A PR description that explains the problem being solved, not just the change ("This fixes the pagination bug that caused X")
- A long review thread where alternatives were debated
- An inline comment near the target line that explains a non-obvious constraint
- A test named `test_handles_edge_case_when_X` that reveals an edge case motivating the code
- A commit message that references a ticket or incident ID
- A CHANGELOG entry that summarizes the user-visible rationale

## Common pitfalls

- **Squash-merge flatlands.** If the repo squashes PRs, individual commits in the branch history are lost. Fall back to PR body and comments.
- **Misleading commit messages.** "Small refactor" sometimes hides an intentional behavior change. Look at the diff, not the message.
- **Cargo-culted patterns.** The author may have copied a pattern without understanding why. Check if the pattern originated earlier in the codebase and investigate *that* commit.
- **Bot commits and auto-merges.** Dependabot, Renovate, and automated backports usually don't carry motivation. Skip them when trying to find intent.
- **Treating code as evidence of intent.** The code itself isn't evidence for why it exists. Evidence comes from commit messages, PRs, comments, tests, docs. Don't cite "the function is named X" as evidence of intent.

## What to return

Every commit/PR/comment that bears on the question, with:
- The exact text (quoted)
- The hash / PR number / file:line
- Author and date
- Whether it's direct (explicitly addresses the question) or circumstantial
