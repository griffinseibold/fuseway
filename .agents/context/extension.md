# @loadout chat participant

`extension/`: a VS Code chat participant. It routes each request itself instead of letting a chat model decide when to call tools. `router.js` has the logic and no `vscode` import (tested by `test/router.test.mjs`); `extension.js` is the VS Code layer. Built into a VSIX by `extension/build.mjs` (a stored zip, no vsce) and installed with `loadout extension`.

## Per request
1. **Route.** Qwen classifies LOCAL or FRONTIER, constrained by a llama.cpp grammar so it can't answer the task instead. LOCAL is final. FRONTIER goes to Haiku (`claude -p` with a one-line system prompt, no tools, run in a temp dir: ~1K tokens instead of ~38K). If the local model is down, everything goes frontier. If a router fails, it errs toward frontier.
2. **Pick a frontier backend** by 5-hour headroom. Claude's `stream-json` output includes a `rate_limit_event` with `unifiedWindows.five_hour.utilization`, saved to `~/.local/state/loadout/claude-limits.json`. Codex writes `rate_limits.primary.used_percent` into its session files under `~/.codex/sessions`. A window whose `resetsAt` has passed counts as full.
3. **Run** an agent CLI in the workspace: local = `codex exec --profile local`, `claude -p --output-format stream-json` (Sonnet by default), `codex exec`. Edits are on by default (`acceptEdits` / `workspace-write`).
4. **Follow-ups** resume the backend's own session (`--resume`, `codex exec … resume <id>`; options must come before `resume`), and get a transcript of turns other backends handled since. Session ids ride in each reply's `metadata`.
5. **Fail over**: a usage-limit error from Claude or Codex retries once on the other, unless the user forced a backend.

## Measured (2026-11-21)
- Routing, `node extension/route-eval.mjs`: 16/16 on the labeled set, with Haiku consulted on 10 (8 real frontier cases and 2 Qwen over-escalations), about 1K tokens each.
- Real chat turns: a JSDoc request went local (12.9K tokens, 19 s). A concurrency question went Qwen FRONTIER, then Haiku FRONTIER, then Claude (46K tokens, 6 s). A forced `/codex` used 74K tokens on a one-sentence answer, because Codex read the context index and the file first.

## Gotchas
- **Updating needs a reload.** VS Code activates a newly installed extension right away, but an update loads only after *Developer: Reload Window*, which also restarts other extensions (including Claude Code). To test changes without a reload, install a copy under a new extension id and participant name.
- **`code chat -m ask "@loadout …"` always goes to the main VS Code instance,** even with `--user-data-dir`. It's useful for end-to-end tests. Each call opens a new chat, so follow-ups can't be tested this way.
- **Replies can be read from disk.** They're saved under `~/.config/Code/User/workspaceStorage/<id>/chatSessions/*.jsonl`, written lazily, sometimes a minute late.
- **Not verified:** whether VS Code's chat view works for `@loadout` without a GitHub sign-in.
