# Agent company

`company/` (`fuseway company …` and `@fuseway /company`) runs a mission: an owner-configured CEO profile plans a JSON task graph, and enabled worker profiles (local, Claude, Codex, Grok) carry it out in an isolated git worktree. The user-facing guide is `company/README.md`.

- **Owner input is fixed.** `.fuseway/company.json` (roster, budget, leader) and the mission file must be committed before a run, and the working tree must be clean. Protected verifier files are snapshotted in memory and restored before grading, so a team can't pass by editing the tests.
- **Grading runs outside the models:** mission `checks` are argv arrays run without a shell. A challenge first runs them at the baseline commit and stops, without spending quota, if they already pass.
- **Leadership** changes only from controller-recorded evidence: a challenger needs paired wins on three distinct missions and more wins than losses, with the same roster/budget policy and the same observed CEO model and effort. A model never elects itself.
- **State** lives under `.fuseway/company/` (gitignored): `runs/`, `worktrees/`, `leader.json`, `cancel/` and `lock/`. A crashed controller leaves `lock/`, which is removed by hand after checking `lock/owner.json`.
- **Tests:** `test/company.test.mjs` uses real git worktrees and subprocess checks. `test/company-package.test.mjs` builds the VSIX, extracts it, and runs the bundled CLI with only `router.js` replaced.
