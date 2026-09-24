VERDICT: approve

## What I verified

Diff scope: `git diff ralph/improve-1790275413089...HEAD -- . ':!.ralph'` touches exactly the three files the card names (`src/server/orchestrator.ts` +16/-2, `src/server/shutdown.ts` +9/-7, `src/server/orchestrator.lifecycle.test.ts` +119). No unrelated changes.

Acceptance criteria, all run by me in this worktree:

| Criterion | Result |
|---|---|
| `grep -q 'private ownsRunningDelivery()' src/server/orchestrator.ts` | PASS |
| `grep -q 'this.ownsRunningRun() \|\| this.ownsRunningDelivery() \|\| this.cardInStatus(RUNNING_STATUSES)' src/server/orchestrator.ts` | PASS |
| `grep -qi 'deliver' src/server/shutdown.ts` | PASS |
| `grep -q 'a run or review delivery still active' src/server/shutdown.ts` | PASS |
| `grep -q 'counts a review delivery this worker is running as in-flight work' …lifecycle.test.ts` | PASS |
| `grep -q 'waits for a review delivery mid-merge to finish before reporting idle' …lifecycle.test.ts` | PASS |
| `grep -q 'a draining worker stops claiming pending deliveries' …lifecycle.test.ts` | PASS |
| `npx vitest run src/server/orchestrator.lifecycle.test.ts -t "graceful shutdown"` | exit 0, **4 passed** (1 pre-existing + the 3 new ones, confirmed by name with `--reporter=verbose`) |
| `npx vitest run …lifecycle.test.ts …reaper.test.ts reviewService.test.ts boot.test.ts` | exit 0, 143 passed / 4 files |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint src/server/orchestrator.ts src/server/shutdown.ts src/server/orchestrator.lifecycle.test.ts` | exit 0 |
| `make check` | exit 0 per repository gate (1m 3s), not re-run |

Definition-of-done items checked against the code, not just the greps:

1. `ownsRunningDelivery()` is private, queries `review_deliveries` for `status = 'running' AND workerId = this.workerId` with `.limit(1).get()`, and `hasInFlightWork()` returns the exact three-way disjunction in the order specified. JSDoc on `hasInFlightWork()` and the comment block at the top of `shutdown.ts` both now name review deliveries as drained work.
2. Both `shutdown.ts` log lines updated: the drain-start line ("draining in-flight runs and review deliveries") and the deadline-elapsed line ("a run or review delivery still active"). No other file referenced the old strings.
3. Tests: (a) covers own-worker running → true, other worker → false, `finished` → false, `pending` → false, with a baseline `false` assertion on a `reviewing` card + completed run before the row is inserted — this proves the new branch is what flips the result (`RUNNING_STATUSES` is planning/looping/evaluating, so `reviewing` was never counted). (b) mocks `mergeBranch` on a deferred promise, calls `orchestrator.approve(runId)`, `startDraining()` mid-merge, asserts `hasInFlightWork()` true with the delivery row `running`/owned, resolves, then asserts `hasInFlightWork()` false, card `done`, delivery `finished`/`ok: 1`, and no leftover repo lease. (c) `startDraining()` then insert a `pending` delivery, `pump()`, settle: row stays `pending`/`workerId: null`, no repo lease, `mergeBranch` never called. I confirmed `claimPendingDeliveries()` is only reached from `pump()`, whose first line is `if (this.draining || this.passive) return;`, so (c) exercises the real claiming path.
4. `make check` green per gate.

`beforeEach` now also clears `review_deliveries` and `repo_leases`, so the new rows don't leak into neighbouring tests.

## For the human reviewer

- The DONE note says "a draining worker's `pump()` no longer claims pending deliveries" as if it were new. It isn't — the `this.draining` guard on `pump()` pre-dates this card. Test (c) simply pins that behaviour, which is what the card asked for. Nothing to fix, just don't read it as a behaviour change.
- The deadline log line is a static `"a run or review delivery still active"`; it does not say *which* one was active. That is literally the card's example string and the acceptance criterion greps for it, so it satisfies the card. Making it precise would need `hasInFlightWork()` (or a sibling) to return more than a boolean — a follow-up if operators want it.
- Docs: I reconciled `specs/25-web-and-worker-processes.md` §11 (the SIGTERM sentence) and `docs/DOCKER.md` (the "stopping a worker" sentence) so they name a claimed review delivery as drained work alongside the run.

```findings
[
  { "severity": "suggestion", "file": "src/server/shutdown.ts", "line": 37, "issue": "The timeout log line is a fixed 'a run or review delivery still active' and cannot tell the operator which of the two was actually still active; matches the card's example so not blocking." }
]
```
