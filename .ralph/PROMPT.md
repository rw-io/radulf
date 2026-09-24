You are working on: making the worker's graceful SIGTERM drain (`Orchestrator.hasInFlightWork()` in src/server/orchestrator.ts, used by src/server/shutdown.ts) also wait for a `review_deliveries` row this worker has claimed as `running`, with tests in src/server/orchestrator.lifecycle.test.ts.

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
- Tests use vitest; run a single file with `npx vitest run <file>` and a
  single test with `-t "<title substring>"`. Never run bare `npx vitest run`.
- `src/server/orchestrator.lifecycle.test.ts` is large (~3200 lines). Use
  Grep to find `describe("graceful shutdown"`, the `await import("@/db")`
  destructuring, and the top-level `beforeEach` instead of reading the whole
  file. Add new tests INSIDE the existing `describe("graceful shutdown")`
  block, after its last `it(...)`.
- Existing helpers in that test file: `card(id, status)`, `plan(id)`,
  `completedRun(cardId, runId)`, `getCard(id)`, `deferred<T>()`, `settle()`,
  and `mocks.mergeBranch` (a `vi.fn()`). `db`, `eq`, `now`, `runs`, `cards`
  are already imported; `reviewDeliveries` / `repoLeases` come from `@/db`.
- `Orchestrator.approve(runId)` is a public method; `orchestrator.workerId`
  is public readonly; `startDraining()` and `pump()` are public.