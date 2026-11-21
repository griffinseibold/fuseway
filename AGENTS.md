# AGENTS.md

<!-- Replace this line with one sentence on what this project is. It anchors every decision an agent makes. -->
**Project:** _TODO: one sentence._

## Commands
<!-- An agent should be able to build, test and lint from this list alone. -->
- Build: `TODO`
- Test: `TODO`
- Lint/format: `TODO`

## How to work
1. **Local context first.** Read `.agents/context/index.md` before exploring the codebase or calling MCP servers or the web. When you learn something durable (how a subsystem works, a gotcha, a command), add it to `.agents/context/` and link it from the index. Keep entries short and in terms of concepts, not line numbers.
2. **Smallest change that solves the problem.** No speculative abstractions or drive-by refactors.
3. **Prove it works.** Run the tests or the actual artifact before saying something is done. Say what you ran.
4. **Engineering playbooks.** For any non-trivial task, read `.agents/skills/poteto-mode/SKILL.md` (pstack, installed by `scripts/bootstrap.sh`) and follow its playbooks. pstack was written for Cursor, so its **Harness** section maps the tools to yours.
   - **This file wins on conflicts.** Where pstack says to open a PR, babysit one or ship a stack, commit to the default branch instead (see Git).
   - **Local model:** don't load `poteto-mode`, because it pulls in too many skills for a small context window. Read only the one or two `principle-*` skills the task needs, starting with `principle-laziness-protocol` and `principle-prove-it-works`.

## Who does what
| Work | Agent |
|---|---|
| Updating `.agents/context/`, tests, docs, boilerplate, mechanical refactors, log triage, first drafts | Local model (Qwen via llama.cpp) |
| Planning, architecture, hard bugs, reviewing local-model output | Claude Code or Codex |

- From a chat, hand work across with the `fusion` MCP tools: `ask_local` first, `ask_claude` or `ask_codex` to escalate, `critique` only at checkpoints (a finished plan or final diff).
- Use default reasoning effort. Use high effort only for planning and hard bugs.
- A local-model agent that is stuck after two attempts stops and writes up what it tried in `.agents/context/handoff.md` for a frontier agent.

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
