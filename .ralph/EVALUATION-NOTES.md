# Evaluation notes (attempt started 2026-09-25T21:03:47Z)

- Read .ralph/DONE and `git diff beta...HEAD -- . ':!.ralph'` — 8 files changed, all in scope (orchestrator, retention, boot, reviewService comments, 4 tests).
- GATE.md: `make check` exit 0 (1m 1s) before this attempt.
- grep criteria AC4–AC14 (recoveredAfterWorkerLoss in orchestrator + test, `ok: 1, error: null`, removeFinishedWorktrees export, no removeAbandonedWorktrees in src/ (exit 1 as expected), FINISHED_STATUSES + removeBaseline in retention.ts, awk ordering check, boot.ts call+log, retention.test.ts regression + idempotency strings) — ALL PASS.
- `npx vitest run src/server/orchestrator.reaper.test.ts` → exit 0 (11/11 passed)
- `npx vitest run src/server/retention.test.ts` → exit 0 (6/6 passed)
- `npx vitest run src/server/boot.test.ts src/server/reviewService.test.ts` → exit 0 (18/18 passed)
- `npx eslint <6 files>` → exit 0; `npx tsc --noEmit` → exit 0.
- `make check` — not re-run per instructions; GATE.md shows exit 0 in 1m 1s.
- Code review: reviews table has unique index on runId; only other insert(reviews) is the reject path → approved row ⇒ merge landed. releaseStaleLeases still runs after the loop. No unrelated changes.
- VERDICT written: approve. SUMMARY.md written.
- Doc reconciliation (approve-only): docs/ARCHITECTURE.md (reaper paragraph), docs/TROUBLESHOOTING.md (stale-delivery message entry), specs/25-web-and-worker-processes.md (decision 6 amendment) — added the landed-recovery case and the finished-card worktree sweep.
