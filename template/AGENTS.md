# AGENTS.md

<!-- Replace this line with one sentence on what this project is. It anchors every decision an agent makes. -->
**Project:** _TODO: one sentence._

## Commands
<!-- An agent should be able to build, test and lint from this list alone. -->
- Build: `TODO`
- Test: `TODO`
- Lint/format: `TODO`

{{LOADOUT_BLOCK}}

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
