# fusion: one chat, many models

An MCP server (`.agents/fusion/server.mjs`, Node 22, no dependencies; `fuseway init` copies it into each repo) that lets whichever chat you're in hand work to other models. It calls the official CLIs headless, so each call spends that tool's flat-rate subscription instead of API credits.

| Tool | Runs | Costs |
|---|---|---|
| `ask_local` | POST to `/chat/completions` on the machine's local model: `LOCAL_LLM_URL` if set, else `~/.config/fuseway/local.json` (written by `fuseway model`), else `localhost:8080` | Nothing. Has no file access, so the prompt must carry what it needs |
| `ask_claude` | `claude -p` in the workspace, default model `sonnet` | Claude subscription quota |
| `ask_codex` | `codex exec`, default effort `medium` | ChatGPT subscription quota |
| `critique` | Claude and Codex in parallel, read-only | Both |

## How it behaves
- **Read-only by default.** Claude runs in plan mode and Codex in its `read-only` sandbox. `write: true` switches to `acceptEdits` / `workspace-write`. Only one agent should write at a time.
- **No memory between calls.** Each call starts cold, and the CLI loads its own system prompt and AGENTS.md: about 38K tokens of startup for Claude and 22K for Codex, mostly cache reads. Pass file paths, not file contents. `claude --bare` would avoid this but needs an API key, so it can't use the subscription.
- **No recursion.** Children get `FUSION_CHILD=1`, and a server started with it lists no tools. Claude children also run with `--strict-mcp-config` and no servers.
- **Usage log.** Every call appends one line to `.agents/usage.jsonl` (gitignored): backend, tokens, time, and for Claude the API-list-price equivalent (on a subscription that's quota, not money). Summarize with `node .agents/fusion/server.mjs report [days]`.
- **Codex binary.** `CODEX_BIN`, else `codex` on PATH, else the copy bundled with the ChatGPT desktop app at `/usr/lib/chatgpt/resources/codex`.

## Registered in
- Copilot Chat: `.vscode/mcp.json`
- Claude Code: `.mcp.json` (approve it when prompted)
- Both are merged in by `fuseway init`.
- Codex: not registered. Add `[mcp_servers.fusion]` to `~/.codex/config.toml` if Codex becomes the main chat.

## Test
`node .agents/fusion/smoke.mjs [tool ...]` drives the server over stdio and checks each real reply (spends a little quota). Set `LOCAL_LLM_URL` if the local model isn't at the default.

## Gotchas
- `codex exec` waits for stdin unless stdin is closed; the server spawns children with stdin ignored.
- Env vars: `FUSION_WORKSPACE` (cwd for backends, default repo root), `FUSION_TIMEOUT_MS` (default 10 min), `FUSION_LOG`, `CLAUDE_BIN`, `LOCAL_LLM_MODEL`.
