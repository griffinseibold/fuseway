# Repository agent company

Fuseway 0.4.0 runs an owner-configured CEO and delegated workers in isolated Git worktrees. Local, Claude Code, Codex and opt-in Grok Build profiles use the existing connected CLI backends. Multiple profiles can select models and effort. Each profile has an explicit `enabled` flag and `roles` from `ceo`, `builder`, `researcher`, `reviewer`. Only builders receive write permission. Model CLI sandboxes provide operational containment, not hostile-process isolation. Use trusted repositories, model tools and owner acceptance commands. Non-software operations remain future work.

## Run the example

Run these commands in your repository with Fuseway on PATH. `init` and `status` make no model calls.

```sh
fuseway company init
```

Edit `.fuseway/company.json`. Its top-level `version: 1` identifies the owner configuration format. The default leader and workers use your configured local model. Enable only connected profiles you want to spend quota on. Optional `model` selects an exact backend model and `effort` accepts `low`, `medium` or `high` for Codex and its local profile. Grok starts disabled. Run `fuseway model` separately if your local backend needs setup.

Init preserves existing config, example mission and verifier. It creates `.fuseway/example-mission.json` and `.fuseway/check-greeting.mjs`. The example asks the CEO to delegate a greeting file to a builder, then have a reviewer inspect it. Its external Node verifier checks the file's exact contents. Add these files and the updated `.gitignore` to Git, then commit. A run requires a clean committed baseline.

```sh
git add .fuseway/company.json .fuseway/example-mission.json .fuseway/check-greeting.mjs .gitignore
git commit -m 'Configure repository company'
fuseway company run .fuseway/example-mission.json
fuseway company status
```

`run` uses the current leader. To compare enabled CEOs, enable at least two CEO profiles, commit config, and run the same mission as a paired challenge.

```sh
fuseway company challenge .fuseway/example-mission.json
fuseway company status
fuseway company stop run-ID
```

A challenge first runs acceptance at the unchanged baseline. If acceptance already passes or the verifier cannot execute, it stops before spending model quota. Otherwise each candidate receives the same mission, owner verifiers, initial Git commit, worker roster and team budget. Each CEO returns a JSON task graph. Workers run in dependency order, one writer at a time, with outputs passed to dependent workers. The controller validates task count, roster IDs and dependencies before any worker call.

In VS Code use `@fuseway /company init`, `/company run .fuseway/example-mission.json`, `/company challenge .fuseway/example-mission.json`, `/company status`, or `/company stop run-ID`. `/company` alone shows status. Everything after the subcommand is a path or run ID, never a shell command. Normal prompt routing is unchanged.

## Write a mission

Mission JSON has four fields. Checks are argv arrays run directly without shell parsing. Protect every verifier, test, fixture or config file that controls grading. Protected paths must name files inside the repository, with no symlinks or parent traversal. The controller additionally protects the company config and mission file.

```json
{
  "id": "greeting",
  "goal": "Delegate greeting.txt containing exactly Hello Fuseway! followed by a newline to a builder, then delegate inspection to a reviewer.",
  "checks": [["node", ".fuseway/check-greeting.mjs"]],
  "protectedPaths": [".fuseway/check-greeting.mjs"]
}
```

Acceptance runs outside the model. The controller holds the owner's verifier bytes and executable modes in memory and restores them before grading. Deleting or rewriting protected tests cannot earn a passing result. Checks must be nonempty. Choose meaningful checks; the system cannot judge whether an owner verifier measures the intended goal.

## Inspect results and apply reviewed work

The original checkout is unchanged by runs and challenges. Run progress reports its run ID and phase immediately, so another terminal can request cancellation. The JSON printed by each command includes exact workspace paths and verification evidence. Status shows the 20 newest run summaries and links to complete records.

- `.fuseway/company/runs/run-ID.json` stores durable mission/trial state, candidate requests, full requested worker profiles, observed CEO/worker model IDs and effort, plans, attempts, output, usage, elapsed time and acceptance results.
- `.fuseway/company/worktrees/run-ID/PROFILE` contains each candidate's work. `baseline` contains challenge preflight work.
- `.fuseway/company/leader.json` stores the leader separately from trial records.
- `.fuseway/company/cancel/run-ID.json` is a run-scoped cancellation request.
- `.fuseway/company/lock/` prevents simultaneous controllers. `status` and `stop` remain available.

Review a completed trial using `git -C PATH diff` and `git -C PATH status --short`. Inspect untracked files too. Copy reviewed changes into your original repository and run your own checks before committing. Automatic `apply` is intentionally unsupported and returns these review instructions. Nothing auto-publishes or deploys.

Records survive restarts. An unfinished record never implies success. After a controller crash, inspect the run and confirm the controller exited, then remove `.fuseway/company/lock/` manually to permit another run. Stop never kills a persisted PID. Worktrees and evidence remain for review; remove them manually with `git worktree remove PATH` after review.

## Budgets and leadership

Owner `budget.calls` bounds top-level model invocations per team, including CEO planning and every worker attempt. The maximum overall challenge calls is `calls` multiplied by the number of enabled CEO profiles, at most 16 profiles and 32 calls each. There are no automatic retries. `teamMs` bounds team setup, calls and checks. `challengeMs` bounds the entire run/challenge, including baseline preflight. `checkMs` limits each acceptance process. Cancellation and deadlines propagate to model CLIs and subprocesses. CLI descendants and provider internals are outside Fuseway's hard accounting boundary.

Optional `observedTokens` is a stop threshold after responses arrive. Third-party CLI billing and token ceilings cannot be guaranteed before the response. Unknown or incomplete usage is recorded explicitly and cannot count as cheap work. No dollar prices or shadow-team costs are invented. Efficiency compares top-level invocation counts, not inferred price. Reports label tokens, calls and milliseconds separately.

The configured leader starts provisional. A challenger needs wins on at least three distinct paired mission contents and IDs, and more wins than losses. A verified completion beats a failed team. When both complete with known usage, fewer top-level calls wins. Equal results retain the incumbent. The latest pair for each mission content replaces earlier replays. Renaming an unchanged mission does not add evidence. A tie between challengers retains the incumbent.

Each pair shares baseline, mission, verifiers, roster and budget fingerprints. Evidence across missions requires unchanged roster/budget policy and requested plus observed CEO identities. Changed or unknown model identities cannot inherit another model's record. Changes in observed CEO effort also reset its evidence. The controller alone records promotions; model suggestions never select their own leader. Weak, sparse or tied evidence leaves leadership unchanged.

Failed or cancelled `run` and `challenge` commands return a nonzero exit status after printing their final record. Ctrl+C requests cancellation and permits the controller to save its state and release its lock.
