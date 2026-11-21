# Task: refresh the context cache

A standing job for the **local model**, so frontier agents read summaries instead of spending quota on exploration.

1. Run `git log --since="<last refresh>" --stat` to see what changed since the last refresh, which is the date at the bottom of `.agents/context/index.md`.
2. For each changed area, update its `.agents/context/<topic>.md`, or create one: what it does, how it fits with the rest, gotchas, and the commands to exercise it. Stay under ~60 lines per file.
3. Delete entries that no longer match the code.
4. Update the index table and the refresh date, then commit with the message `context: refresh`.

Don't change any code in this task.
