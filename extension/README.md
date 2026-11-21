# Loadout

`@loadout` in VS Code's chat picks the cheapest model that can handle each request:

1. Your local model classifies it (free, about 0.3 s). Simple work stays local.
2. When it says the request needs a frontier model, Claude Haiku double-checks (about 1K tokens of your Claude subscription).
3. Frontier work goes to Claude Code or Codex, whichever subscription has more of its 5-hour window left. If one hits its limit mid-request, the other takes over.

Every backend is an agent CLI that reads and edits the workspace itself. Each reply ends with who handled it, the tokens it used, and why it was routed there.

Commands: `/local`, `/claude`, `/codex` force a backend; `/usage` shows both subscription windows and recent calls.
Settings: `loadout.allowEdits`, `loadout.claudeModel`, `loadout.codexEffort`, `loadout.frontier`.

Needs Node 22, the `claude` and `codex` CLIs signed in to your subscriptions, and `loadout model` for the local model.
