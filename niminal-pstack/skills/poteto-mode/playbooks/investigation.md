### Investigation

**You own the answer. Plan, route, write.**

Investigation requests are read-only. They produce a cited explanation or a recommendation, not a code change.

1. Route through the **how** skill. For motivation questions, also route through the **why** skill.
2. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
3. Produce the `how`-shaped output (Overview / Key Concepts / How It Works / Where Things Live / Gotchas), or a recommendation with a tradeoffs table if the request is a decision between alternatives.
4. Apply the **unslop** skill to the reply, then stop.

**After `how` (or `why`) returns, present and end the turn.** Do not re-walk the tree, spawn another explorer, or write/run scripts (Python, shell, one-off probes) to "confirm" the answer. Path:line citations from the report are sufficient evidence for this playbook. **Prove It Works** and "never hand the human a check you could run" apply to behavioral claims about a change you made, not to architectural explanations of existing code.

Keep the todo list to the four steps above. Do not add verify, repro, or script items. Mark each step done when the matching skill output is in hand.

No PR, no babysit, no `architect` unless the investigation precedes a code change. If it does, hand back to the user and re-route to Bug fix or Feature.

**Reply:** the investigation output. For "are we sure?" answers, include your real judgment with reasons. Push back if the premise is wrong (see Autonomy).
