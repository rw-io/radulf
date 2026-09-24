You are working on: making `mergeBranch` in src/server/git.ts recover a half-finished approval merge left in the shared parent checkout by a dead delivery worker (abort Radulf's own abandoned merge, record an already-landed one as `alreadyMerged`, refuse a foreign in-progress merge by name), and making the dirty-checkout error and the stale reaper's Needs Attention reason actionable.

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

Task-specific hints:
- Run vitest via the project-local binary exactly as the task states, e.g.
  `node_modules/.bin/vitest run src/server/git.test.ts -t "mergeBranch recovery"`.
  Never `make test`, `make check`, or a bare `vitest run` — those run everything.
- The git-state rule above applies to THIS working directory only. Tests in
  src/server/git.test.ts legitimately create throwaway repos under
  `os.tmpdir()` and run `git merge`, `git checkout`, etc. inside them via the
  sync `git(dir, ...)` helper from `@/testUtils/gitRepo` — that is fine and expected.
- In src/server/git.ts use the existing helpers: `git(cwd, ...args)` throws on
  a non-zero exit; `tryGit(cwd, ...args)` returns `{ ok, out }`. Match the
  surrounding style; keep new fields on `mergeBranch`'s return type optional so
  the existing `vi.fn()` mocks in other test files keep compiling.
- Reason/error strings must match the task text literally where it quotes
  them — tests and the evaluator grep for those exact phrases.