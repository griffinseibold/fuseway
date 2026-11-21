# Task: tune the local model for this machine

For Claude Code (or Codex) running on the dev box itself. Goal: the fastest local setup that still does real agent work, wired into VS Code and Codex.

**Known hardware:** RX 6800 (16 GB, RDNA2/gfx1030), Ryzen 9 3900X (12 cores), ~48 GB DDR4. Use llama.cpp's Vulkan backend, since it usually beats ROCm on llama.cpp for this card.

## Steps
1. **Check the stack.** Run `vulkaninfo --summary` and `docker --version`, and check whether llama.cpp or Ollama is already installed. Also check whether the homelab cluster already runs a model server. **Ask before installing system packages.**
2. **Get the candidates** into `~/models`:
   - A. `Qwen3.8-27B`, IQ3-class quant (~11–12 GB, e.g. `UD-IQ3_XXS` from `unsloth/Qwen3.8-27B-GGUF`)
   - B. `Qwen3.6-35B-A3B`, Q4-class quant, with experts offloaded to RAM
3. **Benchmark with `llama-bench`.** For agent work, **prompt processing at a long context matters more than generation speed**, because every Copilot or Codex turn resends a 15–30K token prompt. Measure:
   - pp at 8K and 32K, and tg at 128 tokens
   - B: sweep `--n-cpu-moe` (e.g. 16, 24, 32). DDR4 limits this, so expect less than the DDR5 numbers you'll find online.
   - The largest `-c` that fits each model with a q8_0 KV cache
4. **Test tool calling for real.** Send a `curl` request with a `tools` array to `/v1/chat/completions` and confirm a well-formed `tool_calls` response (`--jinja` is required). A model that fails here is useless in agent mode.
5. **Pick a default** (quality first, unless pp at 32K is painfully slow), then update:
   - `local-llm/compose.yaml` (model file, `-c`, flags)
   - `.vscode/settings.json`: check that the `customOAIModels` key and schema match the installed VS Code and Copilot Chat versions, and fix them if not. Set `maxInputTokens` to the real context minus output.
   - `config/codex.local.toml`: confirm whether `wire_api` should be `chat` or `responses`
6. **Smoke test end to end.** Pick the local model in Copilot Chat agent mode, have it add one entry to `.agents/context/`, and check the diff.
7. **Record the results** in `.agents/context/local-llm.md`: the numbers, the chosen flags and why, and the commands to restart. Commit.

Keep the results to one table and a short rationale.
