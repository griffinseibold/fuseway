# fuseway

Fuseway routes coding requests and runs repository missions with a CEO and delegated agents. Local models, Claude Code, Codex, and opt-in Grok Build use your existing model connections. Type `@fuseway` in VS Code chat, or run the [agent company](company/README.md) from the CLI. Replies and mission records identify the models that did the work.

What it combines:
- **Repository agent companies:** owner-controlled missions, delegated teams, isolated worktrees, verified results and leadership challenges across enabled model profiles.
- **Routing by how much of each subscription you have left,** read from the windows Claude Code and Codex report.
- **Local-first by default:** rules and a 79-rule catalog, matched by your local model, decide what needs a frontier model. A background learner scores routers and agents on real outcomes and promotes a better decision maker as the evidence comes in.
- **Local model setup for each machine:** find a server, or recommend one for your GPU and download and start it, then check that tool calls work.
- **One shared agent setup per repo:** a single AGENTS.md for Claude Code, Codex and Copilot, a context cache, skills, and the `fusion` MCP server.

Each frontier call goes through the official `claude` or `codex` CLI. Signed in with your plan, those calls draw from your subscription limits, the same windows as your own sessions (per [Anthropic's support page](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), updated October 2026). Those subscription connections do not use API credits. Optional Grok Build uses its own CLI authentication and billing; Fuseway does not assume a consumer Grok subscription covers it.

**Builds on:** [PAL MCP](https://github.com/BeehiveInnovations/pal-mcp-server) (one session reaching several models over MCP, which fusion follows), [Ruler](https://github.com/intellectronica/ruler) (one set of rules for every coding agent), and [pstack](https://github.com/backnotprop/pstack) or [Superpowers](https://github.com/obra/superpowers) for the skills.

## Setup
Pick what you want to do, then follow its steps. B and C need A done first.

| I want to… | Follow |
|---|---|
| Chat with `@fuseway` in VS Code | [A](#a-chat-with-fuseway-in-vs-code) |
| Give a repo the shared agent setup (AGENTS.md, skills, the fusion MCP server) | [B](#b-add-the-shared-setup-to-a-repo) |
| Run an agent company on a repo | [C](#c-run-an-agent-company) |

### A. Chat with `@fuseway` in VS Code
**You need:**
- VS Code 1.100 or newer
- Node.js 22 or newer, which brings `npm` for installing the Claude and Codex CLIs
- A Claude Pro or Max plan, a ChatGPT plan that includes Codex, or both
- *Optional, for free local work:* a GPU with 6 GB or more of VRAM and Docker, or a Mac with Apple silicon. Without one, everything goes to Claude or Codex.

**Steps:**
1. Download `fuseway.vsix` from the [latest release](https://github.com/griffinseibold/fuseway/releases/latest).
2. In VS Code, open the Command Palette, run **Extensions: Install from VSIX…**, and pick the file.
3. When the Fuseway notification appears, click **Set Up**. A terminal installs and signs in to the CLIs, and sets up a local model if your machine can run one. Answer its prompts. (No notification? Run **Fuseway: Check Setup**.)
4. Open the chat and type `@fuseway` followed by your request.

### B. Add the shared setup to a repo
**You need:** A done, and the repo open in VS Code.

**Steps:**
1. Run **Fuseway: Add to This Repo** from the Command Palette.
2. Fill in the **Project** and **Commands** sections of `AGENTS.md`.
3. Commit the new files. Teammates need Node 22+ and the `claude` or `codex` CLI, not Fuseway.

### C. Run an agent company
**You need:** A done, and a git repo with everything committed.

**Steps:**
1. In the chat, send `@fuseway /company init`.
2. In `.fuseway/company.json`, set `"enabled": true` on each model you want on the team. The local ones are on already.
3. Commit the new files: `git add .fuseway .gitignore && git commit -m "Set up agent company"`.
4. Send `@fuseway /company run .fuseway/example-mission.json`. It runs the example mission in a separate copy of the repo and checks the result.
5. Send `@fuseway /company status`. It shows where the team's work is; review it with `git -C <path> diff` and copy what you want to keep.

To write your own missions or let models compete for CEO, see the [company guide](company/README.md).

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
| `bin/fuseway.mjs` | The CLI: `setup`, `doctor`, `init`, `model`, `extension`, `company` |
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

## Repository agent company

Fuseway 0.4.0 adds an owner-configured CEO and delegated workers through `fuseway company` and `@fuseway /company`. Local models can lead. Claude, Codex and Grok profiles run only when enabled in the roster.

```sh
fuseway company init
# Review .fuseway/company.json; commit config, example mission, verifier and .gitignore.
fuseway company run .fuseway/example-mission.json
# Enable at least two CEOs and commit config before comparing teams.
fuseway company challenge .fuseway/example-mission.json
fuseway company status
```

Runs keep source unchanged and return isolated workspaces under `.fuseway/company/worktrees/run-ID/PROFILE`. Review with `git -C PATH diff` and `git -C PATH status`, then copy reviewed changes manually. Acceptance runs externally against restored owner verifiers. Leadership requires three distinct paired mission wins and more wins than losses. Init/status spend no model quota. Model CLI sandboxes provide operational containment, and token billing cannot be capped before a response. See the [complete company guide](company/README.md) for the mission format, exact output paths, cancellation, budgets, elections and the complete review journey.
