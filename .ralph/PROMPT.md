You are working on: finishing a dead delivery worker's `review_deliveries` row as landed when its card is already `done` (Orchestrator.reapStaleRuns), and reclaiming the worktree, `ralph/*` branch, `worktrees` row and integrity baseline that finished (`done`/`abandoned`) cards leave behind (retention.ts `removeFinishedWorktrees`).

Your task for this iteration is given in the `## Your assigned task` block at
the top of this prompt, together with a LAST_TASK=true|false flag. That block
is your ONLY task source — there is no task list to find or update; the
orchestrator tracks completion and makes all commits.

Do exactly that ONE task this iteration — nothing else:
1. Do the task. Verify it worked: run the check named in the task (if any)
   and confirm `git status` shows the files you edited. Never claim a task
   whose edits you did not make in THIS session — the orchestrator rejects
   completions that changed nothing.
2. Write a short summary (one or two lines) of what you did into
   `.ralph/ITERATION_DONE` — this signals the orchestrator to record
   completion and commit your work.
3. If LAST_TASK=false, STOP NOW. Do not start anything else — the next
   iteration will handle it.

Only if LAST_TASK=true: after your task-specific check passes and you write
`.ralph/ITERATION_DONE`, write a short bulleted TLDR into `.ralph/DONE` (a
one-line header summarizing the change, followed by a few `- ` bullets
covering what changed, why, and key files) and stop. Whole-card acceptance
testing is the evaluator's job, not yours. Never write `.ralph/DONE` if the
task-specific check failed or when LAST_TASK=false.

Rules: never run `git add`, `git commit`, `git checkout`, `git switch`,
`git push`, or any other git command that changes state. The orchestrator
commits for you, and the worktree must stay on the branch it was given.
Read-only commands like `git status` and `git diff` are fine. Never modify
`.ralph/PROMPT.md`; never touch files outside this working directory; only run
tests that cover your current task's files — NEVER run the full test suite.
Your assigned task is the ONLY task: never create or update any harness
todo list (e.g. the todowrite tool).
Batch independent reads/searches into a single turn instead of issuing
them sequentially.
Do not re-read a file after editing it unless a check fails or the edit tool
reports ambiguity.

Hints:
- This is a TypeScript / Next.js / drizzle-orm (SQLite) repo. Tests are Vitest: run a single file with `npx vitest run <path>`. Test files use `setupTestDataDir(...)` at top level and then `await import("@/db")` — keep that ordering when adding imports.
- Database tables (`cards`, `runs`, `reviews`, `reviewDeliveries`, `worktrees`, `repoLeases`, `events`, `DATA_DIR`) come from `@/db`; drizzle helpers (`and`, `eq`, `inArray`, `isNull`) from `drizzle-orm`.
- Do NOT run `make check`, `make test`, or a bare `npx vitest run` — only the file(s) named in your task.
- Do not weaken or delete existing tests; add new ones alongside them.