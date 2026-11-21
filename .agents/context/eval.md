# Whole-task eval

`eval/run-tasks.mjs` answers the headline question: does local-first routing save frontier tokens without losing task success?

- **Tasks** (`eval/tasks.mjs`) are tiny Node repos: start files, a spec, a `test.mjs`, and a reference solution that is never shown to agents. `--check-tests` proves each test fails on the start files and passes on the solution. Run it after adding a task.
- **Arms:** `frontier` sends every task to one frontier agent (the baseline). `local-first` routes with the real cascade, runs the local model if it says local, and escalates to the same frontier agent with the failing test output if the tests still fail. Both arms use the same frontier agent (`--frontier codex|claude`, `--effort`).
- **Grading is the tests only,** run by the harness after restoring `test.mjs`, never a model's opinion.
- **Report** (`--report`): N, passes, routed local, solved locally, escalations, frontier tokens, Haiku routing tokens, local tokens, failed attempts by backend, and time. The savings figure includes Haiku's routing tokens.
- **Hygiene:** the router was tuned on `extension/route-cases.json` only. These tasks are the test set, so don't tune the catalog or thresholds against them; add new tasks instead.
- **Pilot (2026-11-21, N=3 per arm, Codex medium):** both arms passed 3/3. Local-first used 78K frontier tokens vs 235K, with 2 tasks solved locally. Each Codex task cost ~78K tokens (mostly Codex's own startup context) and about 1% of a Plus 5-hour window. That's in `eval/pilot-2026-11-21.jsonl`, a smoke test only.
