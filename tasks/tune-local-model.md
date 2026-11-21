# Task: tune the local model for this machine

For Claude Code (or Codex) running on the dev box itself. Goal: the fastest local setup that still does real agent work, wired into VS Code and Codex.

**Known hardware:** RX 6800 (results so far: `.agents/context/local-llm.md`) (16 GB, RDNA2/gfx1030), Ryzen 9 3900X (12 cores), ~48 GB DDR4. Use llama.cpp's Vulkan backend, since it usually beats ROCm on llama.cpp for this card.

## Steps
1. **Check the stack.** Run `vulkaninfo --summary` and `docker --version`, and check whether llama.cpp or Ollama is already installed. Also check whether the homelab cluster already runs a model server. **Ask before installing system packages.**
2. **Get the candidates** into `~/models`:
   - A. `Qwen3.8-27B`, IQ3-class quant (~11–12 GB, e.g. `UD-IQ3_XXS` from `unsloth/Qwen3.8-27B-GGUF`)
   - B. `Qwen3.6-35B-A3B`, Q4-class quant, with experts offloaded to RAM
3. **Benchmark with `local-llm/bench.sh speed|fit`.** For agent work, **prompt processing at a long context matters more than generation speed**, because every Copilot or Codex turn resends a 15–30K token prompt. Measure:
   - pp at 8K and 32K, and tg at 128 tokens
   - B: sweep `--n-cpu-moe` (e.g. 16, 24, 32). DDR4 limits this, so expect less than the DDR5 numbers you'll find online.
   - The largest `-c` that fits each model with a q8_0 KV cache
4. **Test tool calling for real** with `local-llm/bench.sh tools <url>`: it sends a `tools` array and checks for a well-formed `tool_calls` response (`--jinja` is required). A model that fails here is useless in agent mode.
5. **Pick a default** (quality first, unless pp at 32K is painfully slow), then update:
   - the homelab repo: `kubernetes/infrastructure/llm/deployment.yaml` (model file, `--ctx-size`, flags) and `scripts/download-models.sh` (file, URL, sha256). Flux deploys from GitHub, so this lands only after a push to its `main`
   - `.agents/context/local-llm.md`: the Copilot **Custom Endpoint** values (VS Code keeps custom models per user, entered through *Chat: Manage Language Models*). Check the provider's schema in the built-in Copilot extension's `package.json` if the UI changed.
   - `config/codex.local.toml`: confirm whether `wire_api` should be `chat` or `responses`
6. **Smoke test end to end.** Pick the local model in Copilot Chat agent mode, have it add one entry to `.agents/context/`, and check the diff.
7. **Record the results** in `.agents/context/local-llm.md`: the numbers, the chosen flags and why, and the commands to restart. Commit.

Keep the results to one table and a short rationale.
