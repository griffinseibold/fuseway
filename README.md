# loadout

A blank starting repo that sets up Claude Code, Codex and Copilot Chat (with a local model) to work the same way: one `AGENTS.md`, a shared local context cache, pstack's engineering playbooks, and a local Qwen model for the cheap work.

## Start a project from it
```bash
git clone <this repo> my-project && cd my-project
rm -rf .git && git init -b main
./scripts/bootstrap.sh                          # installs pstack skills
docker compose -f local-llm/compose.yaml up -d  # local model on :8080
code .                                          # accept the recommended extensions
```
Then fill in the **Project** and **Commands** sections of `AGENTS.md`.

## What's here
| Path | Purpose |
|---|---|
| `AGENTS.md` | The one instruction file. `CLAUDE.md` imports it, and Copilot and Codex read it directly |
| `.agents/context/` | Local knowledge cache, so agents read it before exploring |
| `.agents/skills/` | pstack (installed by bootstrap, committed). Codex reads it directly, and it's symlinked into `.claude/` and `.github/` |
| `fusion/` | MCP server: `ask_local`, `ask_claude`, `ask_codex`, `critique`, so one chat can use every model. See `.agents/context/fusion.md` |
| `.vscode/` | Settings, the local model in Copilot's picker, and recommended extensions |
| `local-llm/` | llama.cpp server (Vulkan) for the RX 6800 |
| `config/codex.local.toml` | Codex profile that uses the local model |
| `tasks/` | Reusable jobs to point an agent at: `tune-local-model.md`, `refresh-context.md` |

## First run on a new machine
Open Claude Code in this repo and say: *"Do tasks/tune-local-model.md."*

## Credits
Skills: [pstack](https://github.com/backnotprop/pstack) by Lauren Tan (poteto), MIT.
