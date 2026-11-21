# @loadout chat participant

`extension/`: a VS Code chat participant. It routes each request itself instead of letting a chat model decide when to call tools. `router.js` has the logic and no `vscode` import (tested by `test/router.test.mjs`); `extension.js` is the VS Code layer. Built into a VSIX by `extension/build.mjs` (a stored zip, no vsce) and installed with `loadout extension`.

## Per request
0. **Rules** (`applyRules`, table `DEFAULT_RULES`, extended per repo by `.agents/routing.json`) decide first, with no model involved. They cover: follow-ups stay with the same frontier backend, 2 failed local tries escalate, size over half the local context, pinned repo paths, frontier and local keywords, and file count. Attached files come from `request.references`, minus the instruction files VS Code attaches to every request (ids `vscode.instructions…`).
1. **Route.** Qwen classifies LOCAL or FRONTIER, constrained by a llama.cpp grammar so it can't answer the task instead. LOCAL is final. FRONTIER goes to Haiku (`claude -p` with a one-line system prompt, no tools, run in a temp dir: ~1K tokens instead of ~38K). If the local model is down, everything goes frontier. If a router fails, it errs toward frontier.
2. **Pick a frontier backend** by 5-hour headroom. Claude's `stream-json` output includes a `rate_limit_event` with `unifiedWindows.five_hour.utilization`, saved to `~/.local/state/loadout/claude-limits.json`. Codex writes `rate_limits.primary.used_percent` into its session files under `~/.codex/sessions`. A window whose `resetsAt` has passed counts as full.
3. **Run** an agent CLI in the workspace: local = `codex exec --profile local`, `claude -p --output-format stream-json` (Sonnet by default), `codex exec`. Edits are on by default (`acceptEdits` / `workspace-write`).
4. **Follow-ups** resume the backend's own session (`--resume`, `codex exec … resume <id>`; options must come before `resume`), and get a transcript of turns other backends handled since. Session ids ride in each reply's `metadata`.
5. **Fail over**: a usage-limit error from Claude or Codex retries once on the other. A local run that errors or comes back empty retries on frontier. Neither happens when the user forced a backend.

## Setup from VS Code
The VSIX bundles `bin/loadout.mjs`, `template/`, `.agents/fusion`, `.agents/skills`, the refresh task and `local-llm/` at their repo paths. `extension.js` runs the CLI with `process.execPath` and `ELECTRON_RUN_AS_NODE=1`, so VS Code's own Node runs it. On startup (`onStartupFinished`) it runs `doctor --json` and shows one notification if anything needs fixing. The commands are Check Setup, Set Up Local Model and Add to This Repo.

## Measured (2026-11-21)
- Routing, `node extension/route-eval.mjs`: 16/16 on the labeled set. Without rules, Haiku was consulted on 10 (about 10K tokens). With rules, 11 of the 16 were decided by rules, Haiku was consulted on 3 (3.2K tokens), and decisions averaged 0.47 s. The keyword list was written with this set in view, so expect real use to be worse.
- Real chat turns: a JSDoc request went local (12.9K tokens, 19 s). A concurrency question went Qwen FRONTIER, then Haiku FRONTIER, then Claude (46K tokens, 6 s). A forced `/codex` used 74K tokens on a one-sentence answer, because Codex read the context index and the file first.

## Gotchas
- **Updating needs a reload.** VS Code activates a newly installed extension right away, but an update loads only after *Developer: Reload Window*, which also restarts other extensions (including Claude Code). To test changes without a reload, install a copy under a new extension id and participant name.
- **`code chat -m ask "@loadout …"` always goes to the main VS Code instance,** even with `--user-data-dir`. It's useful for end-to-end tests. Each call opens a new chat, so follow-ups can't be tested this way.
- **Replies can be read from disk.** They're saved under `~/.config/Code/User/workspaceStorage/<id>/chatSessions/*.jsonl`, written lazily, sometimes a minute late.
- **VS Code attaches instruction files to every request** as references: `AGENTS.md`, `CLAUDE.md` and `copilot-instructions.md`, `kind: promptFile`. Counting them as attachments sent a one-line JSDoc request to Codex; they're filtered out now.
- **Not verified:** whether VS Code's chat view works for `@loadout` without a GitHub sign-in, and the local-failure and usage-limit retries in a live chat (only the decisions are unit-tested).
