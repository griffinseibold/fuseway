# loadout

One agent setup for every repo, and one local model per machine. Claude Code, Codex and Copilot Chat read the same `AGENTS.md`, share a context cache, and hand work to each other and to your local model through the `fusion` MCP server. Each frontier call goes through the official `claude` or `codex` CLI. Signed in with your plan, those calls draw from your subscription limits, the same windows as your own sessions (per [Anthropic's support page](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), updated October 2026). They don't touch API credits.

## Install
Everything runs on your machine. The only calls that leave it are the ones Claude Code and Codex make to your own subscriptions.

**Install the extension in VS Code** (`loadout.vsix`, via *Extensions: Install from VSIX…*), then type `@loadout` in the chat. On startup it checks the machine and offers **Set Up**. That opens a terminal that installs and signs in to the `claude` and `codex` CLIs if they're missing. It also finds your local model server, or downloads the model recommended for your GPU (after asking) and starts it in Docker. The extension carries the CLI and runs it with VS Code's own Node.

**Or from a clone:** `git clone <this repo> ~/loadout && node ~/loadout/bin/loadout.mjs setup` does the same from a terminal.

**Per repo:** nothing for `@loadout`, which works in any open folder. For the shared agent setup (AGENTS.md, the context cache, skills, the fusion MCP server and `.agents/routing.json`), run **Loadout: Add to This Repo** or `loadout init`.

**Local model, by hand:** `loadout model` finds a running server on the usual ports, or takes `--url` for one elsewhere. `--recommend` shows what fits your GPU and RAM ([local-llm/models.json](local-llm/models.json)), and `--install` downloads and starts it. With no usable GPU, everything goes to Claude or Codex.

## Chat: `@loadout` in VS Code
```bash
loadout extension
```
This builds and installs a chat participant that routes each request itself. The local model classifies it for free, and Claude Haiku double-checks anything that looks hard. Structural rules decide first: a large attachment, a repo path you've pinned, or the local model failing twice all go frontier. The local model then matches the request against a catalog of 79 kinds of work (security, data, architecture and so on, versus docs, formatting and helpers). Anything near a frontier rule escalates, and Haiku breaks ties. Frontier work goes to Claude Code or Codex, whichever has more room left in its 5-hour and weekly windows. A reserve of Claude's windows (20% by default) stays free for your own Claude Code sessions. Each reply says who answered and what it cost. `/local`, `/claude` and `/codex` force a backend, and `/usage` shows both windows. See [extension/README.md](extension/README.md).

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
