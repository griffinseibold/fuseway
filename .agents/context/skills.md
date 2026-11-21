# Skills fuseway ships

`.agents/skills/` holds pstack (vendored, `PSTACK_VERSION`) plus a few third-party skills that `extension/skills.json` routes to. `fuseway init` copies the folder into a repo and links `.claude/skills` and `.github/skills` to it. With `--skills superpowers`, the third-party skills listed in `VENDORED.json` are still copied.

## Third-party skills
- **Vendored by `node scripts/vendor-skills.mjs`.** It clones each source, copies the skill folder and the repo's LICENSE, and records the commit in `.agents/skills/VENDORED.json`. `--locked` refetches the recorded commits. It refuses a skill whose markdown links outside its own folder, because the link would break once installed. addyosmani skills that link to the repo's shared `references/` are refused for that reason.
- **Review before committing.** Read the diff, and run the `skill-inspector` skill (it uses NVIDIA's `skillspector` CLI, Python 3.12+, with `--no-llm`) on new or updated skills.
- **Chosen (2026-11-21):** `skill-inspector` (NVIDIA/SkillSpector, Apache-2.0), `security-audit` (cloudflare/security-audit-skill, MIT; its full mode spends many agent calls and may run target code in a sandbox), and four addyosmani/agent-skills (MIT) that pstack doesn't cover: debugging, API design, CI/CD and frontend UI.
- **Rejected:** claude-octopus and claude-consensus are plugins rather than plain skills. They send code to extra providers (OpenRouter and others), and pstack's `interrogate` and `arena` already cover multi-model review and competing attempts. delegate-local was wound down upstream in October 2026 and duplicates `ask_local`. skill-creator's license is unclear, and it runs many `claude -p` calls.

## Routing to a skill
See [extension.md](extension.md), step 2b. Each entry in `skills.json` needs a skill that is either bundled or listed in the vendor script; `test/skills.test.mjs` checks this.
