# loadout CLI

`bin/loadout.mjs`, Node 22, no dependencies. Two layers: `init` is per repo, `model` is per machine.

## init [dir] [--no-pstack]
- **Owned by loadout** (copied, overwritten on rerun): `.agents/fusion/`, `.agents/tasks/refresh-context.md`, `.agents/skills/` (pstack).
- **Owned by the repo** (merged, never overwritten):
  - `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`: loadout's text goes between `<!-- loadout:begin -->` and `<!-- loadout:end -->`, replaced in place on rerun. New files come from `template/`. `CLAUDE.md` is left alone if it already has an `@AGENTS.md` line.
  - `.mcp.json`, `.vscode/mcp.json`, `.vscode/extensions.json`: a `fusion` entry is merged in. A file that isn't plain JSON (comments) is skipped, and the entry to add is printed.
  - `.gitignore`: missing lines appended.
- Running it in the loadout repo itself is a no-op for the owned files.
- Every file reports `created`, `updated`, `unchanged` or `skipped`; a second run reports no changes (tested).

## model
- `--url URL` (declared) or discovery over the usual local ports; `--model ID` and `--ctx N` override what the server reports.
- Checks: `GET /models`, context from llama-server's `/props`, and a real tool call (300 s timeout, since an on-demand server may still be loading).
- Writes `~/.config/loadout/local.json` (the one source of truth; fusion reads it), `~/.codex/local.config.toml` (only if missing or marked as managed by loadout), and the *Loadout local* group in VS Code's `chatLanguageModels.json` (other groups kept).
- `--recommend [--vram GiB] [--ram GiB] [--gpu amd|nvidia|apple]`: hardware from `nvidia-smi`, amdgpu sysfs, or Apple unified memory (65% counted as VRAM), then the first matching tier in `local-llm/models.json`. Prints download and run commands for that GPU's backend, with the llama.cpp build pinned.

## Test
`node --test test/*.test.mjs`: init into a repo with existing files, idempotency, an empty repo, a commented `.vscode/mcp.json`, and recommendation tiers.
