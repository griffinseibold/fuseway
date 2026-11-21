# Local model

The homelab repo (`~/projects/homelab`) owns the server: llama-server (Vulkan) in its Kind cluster, at `http://llm.localhost:8080/v1`. Fuseway only points at it. The dev box, the "gaming PC" and the homelab GPU host are the same machine (RX 6800, 16 GB).

## Choice (2026-11-21, llama.cpp b10731)
| Model (unsloth UD-IQ3_XXS) | VRAM at 64K ctx | pp 8K | pp 32K | tg | Tool calls | Codex tasks |
|---|---|---|---|---|---|---|
| **Qwen3.6-35B-A3B** (MoE, default) | 13.3 GB | 955 t/s | 775 t/s | 101 t/s | 3/3 | 2/2, 17–27 s |
| Qwen3.8-27B (dense) | 12.8 GB | 211 t/s | 188 t/s | 32 t/s | 3/3 | 2/2, 63–96 s |
| Qwen3-8B Q4_K_M (old) | — | — | — | — | not tested at 32K | too weak for agent mode |

The MoE wins because the local model's job is fast turns and routing; hard work escalates to Claude or Codex through the `fusion` tools. The 27B was slightly more precise (the MoE once garbled a variable name) but 3.5× slower per turn. Both files are in `~/models`. The KV cache is small on these hybrid models: the MoE fits 128K context in 14 GB, but 64K leaves room for desktop apps (about 1 GB of VRAM).

Rerun the numbers with `local-llm/bench.sh speed|fit|tools`.

## Running it
It runs on demand. In the homelab repo:
- `./scripts/lab-mode.py llm --wait`: start the LLM (and Open WebUI), stop Argo CD apps. Use this for a coding session.
- `./scripts/lab-mode.py apps`: back to normal; the LLM unloads 5 minutes after nothing needs it, which frees the GPU for gaming.
- `./scripts/lab-mode.py status`: what is running and why.

The server has no API key and is bound to host loopback.

## Clients
`fuseway model` writes all of these from one check of the server (it read the 64K context from llama-server's `/props` and confirmed tool calls). Rerun it after changing the model.
- **Copilot Chat:** custom models are per user, in `~/.config/Code/User/chatLanguageModels.json`, as a **Custom Endpoint** group named *Fuseway local*. The group's `apiKey` is optional; VS Code only accepts it as a reference into its secret store, so a plain-text key in the file reads as missing. If the picker asks for a key, type anything in *Chat: Manage Language Models*.
- **Codex:** `~/.codex/local.config.toml`, used with `codex --profile local`. Codex 0.167 reads each profile from its own `<name>.config.toml` and refuses a `[profiles.x]` table in `config.toml`. Responses API (`wire_api = "responses"`).
- **fusion `ask_local`:** `~/.config/fuseway/local.json`; `LOCAL_LLM_URL` overrides it.

## Gotchas
- Without `--jinja` llama-server makes no tool calls; homelab's deployment had it missing until the MoE switch.
- `-c` is shared across llama-server's parallel slots (unified KV), so one long request can use the whole 64K.
- Codex logs `failed to refresh available models` against llama-server; harmless.
