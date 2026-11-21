# Context index

The local knowledge cache for this repo. Agents read this before exploring and add to it when they learn something durable. The local model owns upkeep (see `.agents/tasks/refresh-context.md`).

Rules: one topic per file, short, concepts over line numbers, and update it in the same commit as the code change.

| File | What it covers |
|---|---|
| [local-llm.md](local-llm.md) | Which local model and why (benchmarks), how to start it in homelab, and the Copilot and Codex settings |
| [extension.md](extension.md) | The `@fuseway` VS Code chat participant: how it routes (structural rules, the 79-rule catalog matched by the local model), how the background learner scores routers and agents and switches the decision maker, picks a subscription by 5-hour headroom, resumes sessions, and how to test it |
| [fuseway-cli.md](fuseway-cli.md) | How `fuseway init` merges into a repo and how `fuseway model` finds, checks and configures a local model |
| [eval.md](eval.md) | The whole-task eval: local-first vs all-frontier on tasks graded by tests; how to add tasks and keep it honest |
| [skills.md](skills.md) | Which third-party skills ship next to pstack and why, how `scripts/vendor-skills.mjs` pins them, and which were rejected |
| [company.md](company.md) | The agent company: CEO and workers in worktrees, external grading, and how leadership changes |
| [fusion.md](fusion.md) | The MCP server that hands chat work to the local model, Claude Code and Codex, and logs usage |
