# Fuseway

`@fuseway` in VS Code's chat routes work between the local model, Claude Code, and Codex. Grok Build is available by explicit selection:

1. Deterministic rules decide first (see below).
2. Otherwise, your local model classifies it without subscription usage. Simple work stays local.
3. When it says the request needs a frontier model, Claude Haiku double-checks (about 1K tokens of your Claude subscription).
4. Frontier work goes to Claude Code or Codex, whichever subscription has more of its 5-hour window left. If one hits its limit mid-request, the other takes over.

Repository work runs through an agent CLI that reads and edits the workspace. A first-turn arithmetic question or an explicit text transformation such as "Rewrite this text: ..." can use the local chat endpoint directly, with no repository context or tools. Attachments or conversation history keep the agent path.

Each reply shows the actual model IDs reported by the backend, the observed reasoning effort when available, direct or agent execution, tokens, and routing reason. If model identity is unavailable, it says `unknown` and shows the requested model separately. Claude can report several models in one call. `/usage` and `/stats` group calls by model and execution mode.

## Rules
**Structural rules** look at the conversation, not the words, and decide on their own:

| Rule | Goes to |
|---|---|
| A recognizable continuation, such as "make it shorter", at most 300 characters after a frontier turn, with no attachments | The same backend after size and path checks |
| "That didn't work" after 2 local turns in a row | Frontier |
| Prompt plus attached files over half the local model's context | Frontier |
| An attached file under a path in `frontierPaths` | Frontier |
| More than 2 attached files | Frontier |
| A local run that fails or comes back empty | Retried on frontier |

**The rule catalog** ([rules.json](rules.json)) has 79 kinds of work: 46 that need a frontier model (security, data, architecture, hard debugging, infrastructure, money, time zones, legal and more) and 33 the local model can do (docs, formatting, conversions, small helpers, sample data, styling, translations and more). For each request, the local model reads the whole catalog and reports which rules the request is related to, even loosely:

- **A strong frontier match** goes frontier.
- **A frontier keyword or a weak frontier match** goes to Haiku with that rule as a hint. A request that mentions passwords, migrations, production and so on never goes local on the local model's word alone.
- **A strong local match or a local keyword** stays local.
- **No match:** the local model's own call decides, and Haiku checks it when that call is frontier.

The catalog doesn't change between requests, so llama-server caches it. Matching takes about 4 s on the first request and about 1 s after that.

**Per repo**, `.agents/routing.json` can:
- `rules`: add catalog entries, `{ "id", "route": "frontier" | "local", "description", "keywords"?, "example"? }`
- `disable`: switch off built-in rules by id
- `frontierKeywords`, `localKeywords`: shorthand for one repo rule each
- `frontierPaths`: globs that always go frontier
- `maxLocalShare`, `localAttempts`, `followUpChars`, `maxLocalFiles`: change the thresholds

Keywords match whole words; one ending in `*` is a stem (`migrat*` matches "migration").

## It learns which router to trust
`/stats` shows the scoreboard. The decision maker starts as the cascade above. Two other candidates are measured alongside it: **local-only** (no Haiku, so free) and **Haiku alone**. Each candidate's name includes its local model, so a new model starts with no history and has to earn its place.

- **Outcomes, deterministically:** an explicit success or failure phrase in your next message provides an outcome. Moving on or choosing another backend provides no outcome. A thumbs up or down overrides inferred outcomes. Old "moved on" successes no longer train the router. Execution errors and quota failover do not label task difficulty. A local answer's outcome labels what the right call was; frontier answers don't, because they can't show local would have failed.
- **Quietly in the background:** after a turn, when nothing else is running, it replays complete saved routing inputs for other candidates, including the full prompt, prior requests, attachment metadata, context size, and resolved rules. Legacy truncated decisions are skipped. Thin candidates then receive shipped cases. Incoming requests cancel running background inference. Free routers always run. Paid ones stay within `fuseway.learning.dailyPaidTokens` (20K a day by default).
- **Recent beats long:** results lose half their weight every 7 days. Volume earns nothing beyond 15 recent results, so a model that has done well lately beats one that has been okay for months. Paid tokens and latency count against a router.
- **Slow to switch:** a challenger needs 15 recent results and a 3-point lead, and the decision maker changes at most once a day. The status bar says when it does. A router tied to a local model you've replaced hands over right away.
- **Agents** are grouped by backend, observed model and effort, and execution mode. Calls appear immediately; success rates count only judged calls.
- **Task costs** include routing and retries, local and frontier tokens, elapsed time, and escalation counts. They describe the router that actually served a task. Shadow routing decisions do not have measured task costs. Failed backends can omit token usage, so totals include reported usage only.

Everything stays in `~/.local/state/fuseway/learning.jsonl` on this machine. Turn it off with `fuseway.learning.enabled`.

## Commands
Chat: `/local`, `/claude`, `/codex`, `/grok` force a backend; `/usage` shows both subscription windows and recent calls. `/version` shows the installed extension version, packaged build commit when available, and workspace Git state. `/status` adds the configured local model and subscription usage. Both commands bypass model calls and do not claim the remote is current. `/stats` shows router evidence, model calls, and observed task costs.
Settings: `fuseway.allowEdits`, `fuseway.claudeModel`, `fuseway.codexEffort`, `fuseway.codexModel` and `fuseway.grokModel` (optional model IDs), `fuseway.frontier`.

Command palette: **Fuseway: Check Setup**, **Fuseway: Set Up Local Model**, **Fuseway: Add to This Repo**.

Needs the `claude` and `codex` CLIs signed in to your subscriptions, and `fuseway model` for the local model.

## Connect Grok Build

1. Install the [official Grok Build CLI](https://docs.x.ai/build/overview) on the machine running VS Code.
2. Run `grok login` in a terminal, or configure `XAI_API_KEY` through Grok's supported authentication. Restart VS Code if its environment needs the new executable or variable.
3. Use `@fuseway /grok` to send a request to Grok. Run `grok models` to list available model IDs. Set `fuseway.grokModel` to choose one; empty uses the CLI default.

Set `fuseway.frontier` to `grok` to send automatically classified frontier work to Grok. The default `balance` setting continues to choose between Claude and Codex. Grok's quota is unavailable to this adapter, so it is excluded from automatic headroom balancing. A quota error under the Grok preference retries on a balanced subscription backend. A forced `/grok` never switches backends.

Grok runs in the workspace, reads `AGENTS.md`, and resumes its own sessions. Fuseway passes the `workspace` sandbox when edits are enabled and `read-only` otherwise. Grok MCP calls and subagent spawning are disabled for these child runs. `GROK_BIN` overrides executable discovery.

Replies and reports use model IDs from Grok's terminal `modelUsage` metadata. Terminal usage totals include the input cache buckets and are counted once. Missing or incomplete usage is marked unknown. Costs are recorded only when Grok reports a complete cost. Account access and billing follow your Grok CLI authentication; Fuseway does not assume a consumer Grok subscription covers CLI or API usage.

This connection uses Grok Build's [native headless protocol](https://docs.x.ai/build/cli/headless-scripting). It does not add Grok to the separate fusion MCP server.

## Agent company

Version 0.4.0 includes the repository company CLI and modules in the VSIX. Use `@fuseway /company init`, edit `.fuseway/company.json`, then commit config, `.fuseway/example-mission.json`, `.fuseway/check-greeting.mjs` and `.gitignore`. The default local CEO delegates to a local builder and reviewer. Enable connected frontier profiles explicitly; Grok starts disabled.

Run `@fuseway /company run .fuseway/example-mission.json`, then `/company status`. To compare teams, enable at least two CEO profiles, commit config and use `/company challenge .fuseway/example-mission.json`. Stop with `/company stop run-ID`. The same workflow is available through `fuseway company` or `node PATH-TO-EXTENSION/bin/fuseway.mjs company`.

Each trial reports its workspace at `.fuseway/company/worktrees/run-ID/PROFILE`, and persistent evidence lives in `.fuseway/company/runs/run-ID.json`. Review `git -C PATH diff` and `git -C PATH status`, including untracked files, then copy reviewed changes manually. Source is unchanged; automatic apply is unsupported. Owner checks run externally after protected verifier restoration. Local models can lead; a replacement needs three distinct paired mission wins and more wins than losses. CLI sandboxes are operational containment and token limits are observed stop thresholds. Init/status make no model calls. See the bundled `company/README.md` for mission JSON, budgets, cancellation, crash recovery, exact output locations and election rules.
