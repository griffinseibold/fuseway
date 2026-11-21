# Loadout

`@loadout` in VS Code's chat picks the cheapest model that can handle each request:

1. Deterministic rules decide first (see below).
2. Otherwise, your local model classifies it (free, about 0.3 s). Simple work stays local.
3. When it says the request needs a frontier model, Claude Haiku double-checks (about 1K tokens of your Claude subscription).
4. Frontier work goes to Claude Code or Codex, whichever subscription has more of its 5-hour window left. If one hits its limit mid-request, the other takes over.

Every backend is an agent CLI that reads and edits the workspace itself. Each reply ends with who handled it, the tokens it used, and why it was routed there.

## Rules
**Structural rules** look at the conversation, not the words, and decide on their own:

| Rule | Goes to |
|---|---|
| A short message (300 characters or less) right after a Claude or Codex turn | The same backend |
| "That didn't work" after 2 local turns in a row | Frontier |
| Prompt plus attached files over half the local model's context | Frontier |
| An attached file under a path in `frontierPaths` | Frontier |
| More than 2 attached files | Frontier |
| A local run that fails or comes back empty | Retried on frontier |

**The rule catalog** ([rules.json](rules.json)) has 79 kinds of work: 46 that need a frontier model (security, data, architecture, hard debugging, infrastructure, money, time zones, legal and more) and 33 the local model can do (docs, formatting, conversions, small helpers, sample data, styling, translations and more). For each request, the local model reads the whole catalog and reports which rules the request is related to, even loosely:

- **A strong frontier match** goes frontier.
- **A frontier keyword or a weak frontier match** goes to Haiku with that rule as a hint. A request that mentions passwords, migrations, production and so on never goes local on the local model's word alone.
- **A strong local match or a local keyword** stays local.
- **No match:** the local model's own call decides, and Haiku checks it when that call is frontier.

The catalog doesn't change between requests, so llama-server caches it. Matching takes about 4 s on the first request and about 1 s after that.

**Per repo**, `.agents/routing.json` can:
- `rules`: add catalog entries, `{ "id", "route": "frontier" | "local", "description", "keywords"?, "example"? }`
- `disable`: switch off built-in rules by id
- `frontierKeywords`, `localKeywords`: shorthand for one repo rule each
- `frontierPaths`: globs that always go frontier
- `maxLocalShare`, `localAttempts`, `followUpChars`, `maxLocalFiles`: change the thresholds

Keywords match whole words; one ending in `*` is a stem (`migrat*` matches "migration").

## It learns which router to trust
`/stats` shows the scoreboard. The decision maker starts as the cascade above. Two other candidates are measured alongside it: **local-only** (no Haiku, so free) and **Haiku alone**. Each candidate's name includes its local model, so a new model starts with no history and has to earn its place.

- **Outcomes, deterministically:** your next message saying it didn't work, or switching backends, is a failure. Moving on is a success. A thumbs up or down overrides both. A local answer's outcome labels what the right call was; frontier answers don't, because they can't show local would have failed.
- **Quietly in the background:** after a turn, when nothing else is running, it fills in the other routers' answers and gives thin candidates labeled cases. Your own resolved requests come first, then the shipped set. Free routers always run. Paid ones stay within `loadout.learning.dailyPaidTokens` (20K a day by default).
- **Recent beats long:** results lose half their weight every 7 days. Volume earns nothing beyond 15 recent results, so a model that has done well lately beats one that has been okay for months. Paid tokens and latency count against a router.
- **Slow to switch:** a challenger needs 15 recent results and a 3-point lead, and the decision maker changes at most once a day. The status bar says when it does. A router tied to a local model you've replaced hands over right away.
- **Agents** (backend, model and effort) get the same recency-weighted success rate, plus tokens, time and share of the 5-hour window per call.

Everything stays in `~/.local/state/loadout/learning.jsonl` on this machine. Turn it off with `loadout.learning.enabled`.

## Commands
Chat: `/local`, `/claude`, `/codex` force a backend; `/usage` shows both subscription windows and recent calls.
Settings: `loadout.allowEdits`, `loadout.claudeModel`, `loadout.codexEffort`, `loadout.frontier`.

Command palette: **Loadout: Check Setup**, **Loadout: Set Up Local Model**, **Loadout: Add to This Repo**.

Needs the `claude` and `codex` CLIs signed in to your subscriptions, and `loadout model` for the local model.
