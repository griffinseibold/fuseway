# loadout

One agent setup for every repo, and one local model per machine. Claude Code, Codex and Copilot Chat read the same `AGENTS.md`, share a context cache, and hand work to each other and to your local model through the `fusion` MCP server. Each frontier call goes through the official CLI, so it spends your flat-rate subscription instead of API credits.

## Install
Everything runs on your machine. The only calls that leave it are the ones Claude Code and Codex make to your own subscriptions.

**With VS Code:** install `loadout.vsix` (*Extensions: Install from VSIX…*). The extension carries the whole CLI and runs it with VS Code's own Node. When VS Code starts, it checks your setup and offers fixes for anything missing.

**From a clone:**
```bash
git clone <this repo> ~/loadout && node ~/loadout/bin/loadout.mjs setup
```
`setup` puts `loadout` on your PATH, finds or recommends a local model and configures it, installs the extension, and ends with `loadout doctor`. Rerun `loadout doctor` any time.

**You need:**
- The `claude` and `codex` CLIs, signed in to your subscriptions. `doctor` gives the install command for whichever is missing.
- A local model server. `loadout model` finds one on the usual ports, takes `--url` for one elsewhere, or with `--recommend` picks a model for your GPU and RAM and prints the download and run commands. The table is [local-llm/models.json](local-llm/models.json).

**Per repo:** nothing for `@loadout`, which works in any open folder. For the shared agent setup (AGENTS.md, the context cache, skills, the fusion MCP server and `.agents/routing.json`), run **Loadout: Add to This Repo** or `loadout init`.

## Chat: `@loadout` in VS Code
```bash
loadout extension
```
This builds and installs a chat participant that routes each request itself. The local model classifies it for free, and Claude Haiku double-checks anything that looks hard. Deterministic rules decide first. Security words, a large attachment, a repo path you've pinned, or the local model failing twice all go frontier, and simple jobs like docstrings stay local. Frontier work goes to Claude Code or Codex, whichever subscription has more of its 5-hour window left. Each reply says who answered and what it cost. `/local`, `/claude` and `/codex` force a backend, and `/usage` shows both windows. See [extension/README.md](extension/README.md).

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
| `bin/loadout.mjs` | The CLI: `setup`, `doctor`, `init`, `model`, `extension` |
| `extension/` | The `@loadout` chat participant: `router.js` (routing and backends), `route-eval.mjs` (routing accuracy) |
| `template/` | What `init` writes: the `AGENTS.md` section and starter files |
| `.agents/fusion/` | MCP server: `ask_local`, `ask_claude`, `ask_codex`, `critique`. See `.agents/context/fusion.md` |
| `.agents/skills/` | pstack, committed. `scripts/bootstrap.sh` updates it from upstream |
| `.agents/context/` | This repo's own context cache |
| `.agents/tasks/` | Jobs to point an agent at: `refresh-context.md` (installed into repos), `tune-local-model.md` |
| `local-llm/` | `models.json` (recommendations per hardware tier) and `bench.sh` (speed, context-fit and tool-call checks) |

## Credits
Skills: [pstack](https://github.com/backnotprop/pstack) by Lauren Tan (poteto), MIT.
