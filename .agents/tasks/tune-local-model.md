# Task: tune the local model for a machine

For Claude Code (or Codex) running on the machine that has the GPU. `loadout model --recommend` gives a starting point from a table; this task measures it and updates the table.

## Steps
1. **Check the stack.** `docker --version`, plus `vulkaninfo --summary` (AMD/Intel) or `nvidia-smi` (NVIDIA). Check whether a model server already runs: `loadout model` probes the usual ports. **Ask before installing system packages.**
2. **Get candidates** into `~/models`: the recommended tier from `loadout model --recommend`, and the tier above or below it.
3. **Benchmark** with `local-llm/bench.sh speed <file>` and `local-llm/bench.sh fit <file> 32768 65536 131072`. Stop any other model server first: both need the whole GPU. For agent work, **prompt processing at long context matters more than generation speed**, because every Copilot or Codex turn resends a 15–30K-token prompt.
4. **Test tool calling** on a running server with `local-llm/bench.sh tools <url>`, and run one real task through `codex exec` against it. A model that fails here is useless in agent mode.
5. **Pick a default** (quality first, unless prompt processing at 32K is painfully slow) and run it where the machine serves models (on the homelab box, the homelab repo's `llm` deployment; Flux deploys it after a push to `main`).
6. **Configure:** `loadout model` (or `--url`). Check that it reports the right context and that tool calls work.
7. **Record:** add or update the tier in `local-llm/models.json` with a `measured` line, and the numbers and rationale in `.agents/context/local-llm.md`. Commit.
