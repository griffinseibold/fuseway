# loadout

One agent setup for every repo, and one local model per machine. Claude Code, Codex and Copilot Chat read the same `AGENTS.md`, share a context cache, and hand work to each other and to your local model through the `fusion` MCP server. Each frontier call goes through the official CLI, so it spends your flat-rate subscription instead of API credits.

## Install once per machine
```bash
git clone <this repo> ~/loadout
ln -s ~/loadout/bin/loadout.mjs ~/.local/bin/loadout   # needs Node 22
loadout model                                          # find, check and configure your local model
```
`loadout model` works in one of three ways:
- **You already have a server:** `loadout model --url http://host:port/v1`.
- **It discovers one:** with no flags it probes homelab (`llm.localhost:8080`), llama-server (`:8080`), Ollama (`:11434`), LM Studio (`:1234`) and vLLM (`:8000`).
- **It recommends one:** `loadout model --recommend` reads your GPU's VRAM and your RAM (AMD, NVIDIA, Apple Silicon or CPU only) and prints the model, the download and the run command. Add `--vram 24 --ram 64` to ask about other hardware. The table is [local-llm/models.json](local-llm/models.json).

Once it has a server, it checks that tool calls work, then configures:
- **fusion `ask_local`:** `~/.config/loadout/local.json`
- **Codex:** `codex --profile local` (`~/.codex/local.config.toml`)
- **VS Code:** the model picker (`chatLanguageModels.json`)

## Chat: `@loadout` in VS Code
```bash
loadout extension
```
This builds and installs a chat participant that routes each request itself. The local model classifies it for free, and Claude Haiku double-checks anything that looks hard. Frontier work goes to Claude Code or Codex, whichever subscription has more of its 5-hour window left. Each reply says who answered and what it cost. `/local`, `/claude` and `/codex` force a backend, and `/usage` shows both windows. See [extension/README.md](extension/README.md).

## Add to a repo
```bash
cd my-repo && loadout init          # or: loadout init path/to/repo [--no-pstack]
```
It never overwrites your files, and it's safe to rerun:
- It adds a marked section to an existing `AGENTS.md`, `CLAUDE.md` and `.github/copilot-instructions.md`, and creates them if they're missing.
- It merges `fusion` into `.mcp.json` and `.vscode/mcp.json`.
- It copies the server into `.agents/fusion/`, so teammates need nothing installed but Node and the CLIs.
- It adds pstack skills and a `.agents/context/` cache.

Then fill in the **Project** and **Commands** sections of `AGENTS.md`.

## What's here
| Path | Purpose |
|---|---|
| `bin/loadout.mjs` | The CLI: `init`, `model`, `extension` |
| `extension/` | The `@loadout` chat participant: `router.js` (routing and backends), `route-eval.mjs` (routing accuracy) |
| `template/` | What `init` writes: the `AGENTS.md` section and starter files |
| `.agents/fusion/` | MCP server: `ask_local`, `ask_claude`, `ask_codex`, `critique`. See `.agents/context/fusion.md` |
| `.agents/skills/` | pstack, committed. `scripts/bootstrap.sh` updates it from upstream |
| `.agents/context/` | This repo's own context cache |
| `.agents/tasks/` | Jobs to point an agent at: `refresh-context.md` (installed into repos), `tune-local-model.md` |
| `local-llm/` | `models.json` (recommendations per hardware tier) and `bench.sh` (speed, context-fit and tool-call checks) |

## Credits
Skills: [pstack](https://github.com/backnotprop/pstack) by Lauren Tan (poteto), MIT.
