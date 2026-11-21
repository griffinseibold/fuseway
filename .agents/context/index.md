# Context index

The local knowledge cache for this repo. Agents read this before exploring and add to it when they learn something durable. The local model owns upkeep (see `.agents/tasks/refresh-context.md`).

Rules: one topic per file, short, concepts over line numbers, and update it in the same commit as the code change.

| File | What it covers |
|---|---|
| [local-llm.md](local-llm.md) | Which local model and why (benchmarks), how to start it in homelab, and the Copilot and Codex settings |
| [loadout-cli.md](loadout-cli.md) | How `loadout init` merges into a repo and how `loadout model` finds, checks and configures a local model |
| [fusion.md](fusion.md) | The MCP server that hands chat work to the local model, Claude Code and Codex, and logs usage |
