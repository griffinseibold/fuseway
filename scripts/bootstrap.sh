#!/usr/bin/env bash
# Installs pstack (Lauren Tan's engineering skills, MIT) into .agents/skills
# Codex reads .agents/skills directly; Claude Code and Copilot get symlinks.
# Rerun any time to update.
set -euo pipefail
cd "$(dirname "$0")/.."

PSTACK_REPO="${PSTACK_REPO:-https://github.com/backnotprop/pstack.git}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --depth 1 "$PSTACK_REPO" "$tmp/pstack"
mkdir -p .agents/skills
cp -R "$tmp/pstack/skills/." .agents/skills/
[ -f "$tmp/pstack/LICENSE" ] && cp "$tmp/pstack/LICENSE" .agents/skills/PSTACK_LICENSE
git -C "$tmp/pstack" rev-parse HEAD > .agents/skills/PSTACK_VERSION

for dir in .claude .github; do
  mkdir -p "$dir"
  ln -sfn ../.agents/skills "$dir/skills"
done

echo "pstack $(cut -c1-7 .agents/skills/PSTACK_VERSION) installed in .agents/skills"
