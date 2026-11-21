# loadout CLI

`bin/loadout.mjs`, Node 22, no dependencies. Two layers: `init` is per repo, `model` is per machine.

## init [dir] [--skills pstack|superpowers|none]
- **Owned by loadout** (copied, overwritten on rerun): `.agents/fusion/`, `.agents/tasks/refresh-context.md`, `.agents/skills/`. pstack is bundled. Superpowers is `git clone --depth 1` of obra/superpowers at install time, with its commit in `SUPERPOWERS_VERSION` and its license as `SUPERPOWERS_LICENSE`. `--no-pstack` still means `--skills none`.
- **Owned by the repo** (merged, never overwritten):
  - `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`: loadout's text goes between `<!-- loadout:begin -->` and `<!-- loadout:end -->`, replaced in place on rerun. New files come from `template/`. `CLAUDE.md` is left alone if it already has an `@AGENTS.md` line.
  - `.mcp.json`, `.vscode/mcp.json`, `.vscode/extensions.json`: a `fusion` entry is merged in. A file that isn't plain JSON (comments) is skipped, and the entry to add is printed.
  - `.gitignore`: missing lines appended.
  - `.agents/routing.json`: a starter with empty lists, created only if missing (rules for `@loadout`).
- Running it in the loadout repo itself is a no-op for the owned files.
- Every file reports `created`, `updated`, `unchanged` or `skipped`; a second run reports no changes (tested).

## setup and doctor
- `setup`: link `~/.local/bin/loadout` (when that's on PATH), run `model --install`, install the extension when running from a clone, then `doctor`, and offer to run the fixes it can.
- `model --install [--yes] [--dry-run]`: use any server discovery finds; otherwise take the recommended tier, download it (Range resume from `.partial`, sha256 checked before the rename), run the pinned llama.cpp image as Docker container `loadout-llm` on 127.0.0.1:8080 with `--restart unless-stopped`, wait for `/health`, then configure. Asks first unless `--yes`. On a Mac it downloads, then prints the native `llama-server` command, because Docker there can't reach the GPU.
- `doctor [--json]`: checks `claude auth status` (JSON `loggedIn`), `codex login status` (which prints to stderr, so read both streams), that the local model answers and makes tool calls, that the Codex local profile exists, and Node 22+ (a warning only, since fusion needs it). Each failed check has `fix` (text) and `run` (a command, or null when it needs a person). The extension runs `doctor --json` on startup, and its Set Up button sends the `run` commands to a terminal. Commands starting `loadout` become the bundled CLI under VS Code's Node.
- The CLI is importable (tests import `download`, `serverPlan`, `dockerArgs`): `main` runs only when `realpath(argv[1])` is this file, which also works through the `~/.local/bin` symlink.
- Windows: `which` tries PATHEXT extensions, so it finds `claude.cmd` and `codex.exe`. That part is untested.

## model
- `--url URL` (declared) or discovery over the usual local ports; `--model ID` and `--ctx N` override what the server reports.
- Checks: `GET /models`, context from llama-server's `/props`, and a real tool call (300 s timeout, since an on-demand server may still be loading).
- Writes `~/.config/loadout/local.json` (the one source of truth; fusion reads it), `~/.codex/local.config.toml` (only if missing or marked as managed by loadout), and the *Loadout local* group in VS Code's `chatLanguageModels.json` (other groups kept).
- `--recommend [--vram GiB] [--ram GiB] [--gpu amd|nvidia|apple]`: hardware from `nvidia-smi`, amdgpu sysfs, or Apple unified memory (65% counted as VRAM), then the first matching tier in `local-llm/models.json`. Prints download and run commands for that GPU's backend, with the llama.cpp build pinned.

## Test
`node --test test/*.test.mjs`: init into a repo with existing files, idempotency, an empty repo, a commented `.vscode/mcp.json`, and recommendation tiers.
