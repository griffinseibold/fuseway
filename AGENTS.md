# AGENTS.md

**Project:** loadout installs one shared agent setup (AGENTS.md, a context cache, pstack skills and the `fusion` MCP server) into any repo, and sets up each machine's local model, so Claude Code, Codex and Copilot share instructions and hand work to each other.

## Commands
- Build: none (Node 22, no dependencies)
- Test: `node --test test/*.test.mjs` (CLI), `node .agents/fusion/smoke.mjs` (fusion against the real backends; spends a little quota)
- Routing accuracy: `node extension/route-eval.mjs` (real Qwen and Haiku; about 10K Claude tokens)
- Lint/format: `node --check bin/loadout.mjs .agents/fusion/*.mjs extension/*.js && bash -n local-llm/bench.sh scripts/bootstrap.sh`
- Files under `template/` and `.agents/fusion/` are what `loadout init` installs into other repos: change them with that in mind.

<!-- loadout:begin -->
## How to work
1. **Local context first.** Read `.agents/context/index.md` before exploring the codebase or calling MCP servers or the web. When you learn something durable (how a subsystem works, a gotcha, a command), add it to `.agents/context/` and link it from the index. Keep entries short and in terms of concepts, not line numbers.
2. **Smallest change that solves the problem.** No speculative abstractions or drive-by refactors.
3. **Prove it works.** Run the tests or the actual artifact before saying something is done. Say what you ran.
4. **Engineering playbooks.** For any non-trivial task, read the entry skill in `.agents/skills/` and follow its playbooks: `poteto-mode/SKILL.md` (pstack) or `using-superpowers/SKILL.md` (Superpowers), whichever is installed. pstack was written for Cursor, so its **Harness** section maps the tools to yours.
   - **This file wins on conflicts,** for example where a playbook says to open a PR and this repo says otherwise.
   - **Local model:** don't load the entry skill, because it pulls in too many skills for a small context window. Read only the one or two skills the task needs (with pstack, start with `principle-laziness-protocol` and `principle-prove-it-works`).

## Who does what
| Work | Agent |
|---|---|
| Updating `.agents/context/`, tests, docs, boilerplate, mechanical refactors, log triage, first drafts | Local model |
| Planning, architecture, hard bugs, reviewing local-model output | Claude Code or Codex |

- From a chat, hand work across with the `fusion` MCP tools: `ask_local` first, `ask_claude` or `ask_codex` to escalate, `critique` only at checkpoints (a finished plan or final diff).
- Use default reasoning effort. Use high effort only for planning and hard bugs.
- A local-model agent that is stuck after two attempts stops and writes up what it tried in `.agents/context/handoff.md` for a frontier agent.
<!-- loadout:end -->

## Parallel agents
- One agent per git worktree: `git worktree add ../<repo>.worktrees/<task> -b <task>`. Never edit files outside your own worktree.
- **If another agent's work blocks you, stop and say so plainly:** which agent or worktree, and what you are waiting on.
- Merge back with a fast-forward or rebase onto the default branch, then remove the worktree.

## Git
- Commit straight to the default branch. Don't open pull requests unless asked.
- Make small commits with imperative messages. Never commit secrets, `.env` files or model weights.

## Boundaries
- **Fine without asking:** editing this repo, running tests and builds, pushing to this repo's default branch.
- **Ask first:** installing system packages, deleting anything outside the repo, deploying, and anything that posts, sends or changes something in an outside service.
