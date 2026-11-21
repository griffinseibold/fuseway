# Loadout

`@loadout` in VS Code's chat picks the cheapest model that can handle each request:

1. Deterministic rules decide first (see below).
2. Otherwise, your local model classifies it (free, about 0.3 s). Simple work stays local.
3. When it says the request needs a frontier model, Claude Haiku double-checks (about 1K tokens of your Claude subscription).
4. Frontier work goes to Claude Code or Codex, whichever subscription has more of its 5-hour window left. If one hits its limit mid-request, the other takes over.

Every backend is an agent CLI that reads and edits the workspace itself. Each reply ends with who handled it, the tokens it used, and why it was routed there.

## Rules
Checked in order; the first match wins:

| Rule | Goes to |
|---|---|
| A short message (300 characters or less) right after a Claude or Codex turn | The same backend |
| "That didn't work" after 2 local turns in a row | Frontier |
| Prompt plus attached files over half the local model's context | Frontier |
| An attached file under a path in `frontierPaths` | Frontier |
| A frontier keyword: security, auth, passwords, secrets, crypto, migrations, design and architecture, concurrency, production incidents, flaky tests… | Frontier |
| More than 2 attached files | Frontier |
| A local keyword (docstring, rename, format, convert, commit message, summarize…) in a short request | Local |
| A local run that fails or comes back empty | Retried on frontier |

A repo adds its own in `.agents/routing.json`: `frontierPaths`, `frontierKeywords` and `localKeywords` are added to the defaults, and the numbers (`maxLocalShare`, `localAttempts`, `followUpChars`, `maxLocalChars`, `maxLocalFiles`) replace them.

## Commands
Chat: `/local`, `/claude`, `/codex` force a backend; `/usage` shows both subscription windows and recent calls.
Settings: `loadout.allowEdits`, `loadout.claudeModel`, `loadout.codexEffort`, `loadout.frontier`.

Command palette: **Loadout: Check Setup**, **Loadout: Set Up Local Model**, **Loadout: Add to This Repo**.

Needs the `claude` and `codex` CLIs signed in to your subscriptions, and `loadout model` for the local model.
