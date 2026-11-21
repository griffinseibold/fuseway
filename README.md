# fuseway

**The lowest-cost way to use several coding agents, if you already pay for Claude and ChatGPT.** Type `@fuseway` in VS Code chat. Your local model takes the cheap work for free, and the rest goes to Claude Code or Codex, whichever subscription has more room left. Every reply says who answered and what it cost.

What it combines, that the tools it learned from each do one piece of:
- **Routing by how much of each subscription you have left,** read from the windows Claude Code and Codex report.
- **Local-first by default:** rules and a 79-rule catalog, matched by your local model, decide what needs a frontier model. A background learner scores routers and agents on real outcomes and promotes a better decision maker as the evidence comes in.
- **Local model setup for each machine:** find a server, or recommend one for your GPU and download and start it, then check that tool calls work.
- **One shared agent setup per repo:** a single AGENTS.md for Claude Code, Codex and Copilot, a context cache, skills, and the `fusion` MCP server.

Each frontier call goes through the official `claude` or `codex` CLI. Signed in with your plan, those calls draw from your subscription limits, the same windows as your own sessions (per [Anthropic's support page](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), updated October 2026). They don't touch API credits.

**Builds on:** [PAL MCP](https://github.com/BeehiveInnovations/pal-mcp-server) (one session reaching several models over MCP, which fusion follows), [Ruler](https://github.com/intellectronica/ruler) (one set of rules for every coding agent), and [pstack](https://github.com/backnotprop/pstack) or [Superpowers](https://github.com/obra/superpowers) for the skills.

## Install
Everything runs on your machine. The only calls that leave it are the ones Claude Code and Codex make to your own subscriptions.

**Install the extension in VS Code:** download `fuseway.vsix` from the [latest release](https://github.com/griffinseibold/fuseway/releases/latest), run *Extensions: Install from VSIX…*, then type `@fuseway` in the chat. On startup it checks the machine and offers **Set Up**. That opens a terminal that installs and signs in to the `claude` and `codex` CLIs if they're missing. It also finds your local model server, or downloads the model recommended for your GPU (after asking) and starts it in Docker. The extension carries the CLI and runs it with VS Code's own Node.

**Or from a clone:** `git clone https://github.com/griffinseibold/fuseway ~/fuseway && node ~/fuseway/bin/fuseway.mjs setup` does the same from a terminal.

**Per repo:** nothing for `@fuseway`, which works in any open folder. For the shared agent setup (AGENTS.md, the context cache, skills, the fusion MCP server and `.agents/routing.json`), run **Fuseway: Add to This Repo** or `fuseway init`.

**Local model, by hand:** `fuseway model` finds a running server on the usual ports, or takes `--url` for one elsewhere. `--recommend` shows what fits your GPU and RAM ([local-llm/models.json](local-llm/models.json)), and `--install` downloads and starts it. With no usable GPU, everything goes to Claude or Codex.

## Chat: `@fuseway` in VS Code
```bash
fuseway extension
```
This builds and installs a chat participant that routes each request itself. The local model classifies it for free, and Claude Haiku double-checks anything that looks hard. Structural rules decide first: a large attachment, a repo path you've pinned, or the local model failing twice all go frontier. The local model then matches the request against a catalog of 79 kinds of work (security, data, architecture and so on, versus docs, formatting and helpers). Anything near a frontier rule escalates, and Haiku breaks ties. Frontier work goes to Claude Code or Codex, whichever has more room left in its 5-hour and weekly windows. A reserve of Claude's windows (20% by default) stays free for your own Claude Code sessions. Each reply says who answered and what it cost. `/local`, `/claude` and `/codex` force a backend, and `/usage` shows both windows. See [extension/README.md](extension/README.md).

## Add to a repo
```bash
cd my-repo && fuseway init          # or: fuseway init path/to/repo --skills pstack|superpowers|none
```
It never overwrites your files, and it's safe to rerun:
- It adds a marked section to an existing `AGENTS.md`, `CLAUDE.md` and `.github/copilot-instructions.md`, and creates them if they're missing.
- It merges `fusion` into `.mcp.json` and `.vscode/mcp.json`.
- It copies the server into `.agents/fusion/`, so teammates need nothing installed but Node and the CLIs.
- It adds skills (pstack by default, or Superpowers, or none) and a `.agents/context/` cache.

Then fill in the **Project** and **Commands** sections of `AGENTS.md`.

## What's here
| Path | Purpose |
|---|---|
| `bin/fuseway.mjs` | The CLI: `setup`, `doctor`, `init`, `model`, `extension` |
| `extension/` | The `@fuseway` chat participant: `router.js` (routing and backends), `route-eval.mjs` (routing accuracy) |
| `template/` | What `init` writes: the `AGENTS.md` section and starter files |
| `.agents/fusion/` | MCP server: `ask_local`, `ask_claude`, `ask_codex`, `critique`. See `.agents/context/fusion.md` |
| `.agents/skills/` | pstack, committed. `scripts/bootstrap.sh` updates it from upstream |
| `.agents/context/` | This repo's own context cache |
| `.agents/tasks/` | Jobs to point an agent at: `refresh-context.md` (installed into repos), `tune-local-model.md` |
| `local-llm/` | `models.json` (recommendations per hardware tier) and `bench.sh` (speed, context-fit and tool-call checks) |

## Credits
Skills: [pstack](https://github.com/backnotprop/pstack) by Lauren Tan (poteto), MIT, bundled. [Superpowers](https://github.com/obra/superpowers) by Jesse Vincent, MIT, downloaded by `fuseway init --skills superpowers`. Ideas: [PAL MCP](https://github.com/BeehiveInnovations/pal-mcp-server), [Ruler](https://github.com/intellectronica/ruler).

## License
MIT. See [LICENSE](LICENSE).
