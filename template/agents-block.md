## How to work
1. **Local context first.** Read `.agents/context/index.md` before exploring the codebase or calling MCP servers or the web. When you learn something durable (how a subsystem works, a gotcha, a command), add it to `.agents/context/` and link it from the index. Keep entries short and in terms of concepts, not line numbers.
2. **Smallest change that solves the problem.** No speculative abstractions or drive-by refactors.
3. **Prove it works.** Run the tests or the actual artifact before saying something is done. Say what you ran.
4. **Engineering playbooks.** If `.agents/skills/poteto-mode/` exists (pstack), read its `SKILL.md` for any non-trivial task and follow its playbooks. pstack was written for Cursor, so its **Harness** section maps the tools to yours.
   - **This file wins on conflicts,** for example where pstack says to open a PR and this repo says otherwise.
   - **Local model:** don't load `poteto-mode`, because it pulls in too many skills for a small context window. Read only the one or two `principle-*` skills the task needs, starting with `principle-laziness-protocol` and `principle-prove-it-works`.

## Who does what
| Work | Agent |
|---|---|
| Updating `.agents/context/`, tests, docs, boilerplate, mechanical refactors, log triage, first drafts | Local model |
| Planning, architecture, hard bugs, reviewing local-model output | Claude Code or Codex |

- From a chat, hand work across with the `fusion` MCP tools: `ask_local` first, `ask_claude` or `ask_codex` to escalate, `critique` only at checkpoints (a finished plan or final diff).
- Use default reasoning effort. Use high effort only for planning and hard bugs.
- A local-model agent that is stuck after two attempts stops and writes up what it tried in `.agents/context/handoff.md` for a frontier agent.
