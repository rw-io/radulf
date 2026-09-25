VERDICT: approve

## What I verified

Every acceptance criterion was run in this worktree and passed:

- `npx vitest run src/server/orchestrator.reaper.test.ts` → exit 0 (11/11, including the pre-existing failed-delivery test and the new "finishes a dead worker's delivery as landed when its card is already done").
- `npx vitest run src/server/retention.test.ts` → exit 0 (6/6, including the new done-card reclaim test and the "a baseline that cannot be deleted leaves the worktree, branch and row for a retry" ordering regression).
- `npx vitest run src/server/boot.test.ts src/server/reviewService.test.ts` → exit 0 (18/18).
- All grep/awk criteria pass: `recoveredAfterWorkerLoss: true` in orchestrator.ts and asserted in the reaper test; `ok: 1, error: null` CAS present; `export async function removeFinishedWorktrees` in retention.ts; `grep -rq removeAbandonedWorktrees src/` exits 1 (old name fully gone, including boot.ts, boot.test.ts, retention.test.ts, reviewService.ts/.test.ts comments); `FINISHED_STATUSES` and `removeBaseline` used in retention.ts; awk ordering check confirms `removeBaseline(row.runId)` precedes `await removeWorktree(row…)` inside the function body; boot.ts has the renamed call and the `finished-card worktree(s)` log line; retention.test.ts has the ordering/failure test name and `toBe(0)` idempotency assertion.
- `npx eslint <6 changed files>` → exit 0; `npx tsc --noEmit` → exit 0.
- `make check` — not re-run per instructions; GATE.md records exit 0 in 1m 1s before this attempt.

Code review against the card:

- (a) `reapStaleRuns` now reads the card and looks up an approved `reviews` row for `delivery.runId` (the table has a unique index on `runId`, so `.get()` is exact) before deciding; `done` or approved-row → new private `finishLandedDelivery` (CAS on `status = running` → `finished, ok = 1, error = null`, emits `review.decided` with `decision: approved`, `mergeCommit` from the reviews row when present, `recoveredAfterWorkerLoss: true`, no card move). Otherwise the exact previous `failDelivery` path runs with its unchanged message. `releaseStaleLeases(live)` still runs after the loop, so the lease is released in both branches. The only other `insert(reviews)` in src is the reject path (`decision: "rejected"`), so an approved row really does mean `completeApproval` ran after the merge landed.
- (b) `removeFinishedWorktrees` selects `removedAt IS NULL` rows for `inArray(cards.status, FINISHED_STATUSES)` and calls `removeBaseline(row.runId)` (null-guarded) before `removeWorktree`, with a comment explaining why baseline-first keeps a failed pass retryable. JSDoc, boot.ts comment, call and both log lines updated as the card asks.
- (c) Tests match the card's required assertions (delivery ok=1/no error, newest `review.decided` has no `deliveryFailed`, card stays `done`, lease gone, no `needs_attention` move; done card's worktree/branch/baseline/row all reclaimed while a `review` card's are untouched; second call returns 0).
- No unrelated changes; the diff is confined to the 8 files the card names or implies.

## For the human reviewer

- Behaviour change to double-check semantically: a delivery whose worker died with an approved `reviews` row but a card still in `reviewing` (worker killed between the `insert(reviews)` and the `moveCard(reviewing → done)` CAS) is now also finished as landed with the card left in `reviewing`. This is what the card's "(or a `reviews` row with `decision = 'approved'` exists…)" clause asks for; the boot-time orphan sweep will still eventually park that run-less `reviewing` card. Fine per the card, but worth knowing.
- The shutdown drain path (`releaseOwnedWork` → `failDelivery`) was deliberately left unchanged — the card scopes the fix to `reapStaleRuns` — so a drain that times out after the card moved to `done` still records a failed delivery. Possible follow-up card.

```findings
[
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 1484, "issue": "releaseOwnedWork() still calls failDelivery unconditionally on the shutdown-drain-timeout path, so the same 'merge landed, card done, delivery row still running' state produced by a timed-out drain is not recovered as landed — out of this card's stated scope (reapStaleRuns only), candidate for a follow-up." },
  { "severity": "suggestion", "file": "src/server/retention.ts", "line": 128, "issue": "removeFinishedWorktrees has no per-row try/catch, so one row whose baseline cannot be deleted aborts the rest of that pass's rows until the next pump tick (boot.ts logs the error); pre-existing loop shape and the new regression test depends on the throw propagating, so not disqualifying." },
  { "severity": "suggestion", "file": "src/server/retention.test.ts", "line": 54, "issue": "seed() still names its temp dir prefix 'ralph-abandoned-wt-' though it now also seeds done cards — cosmetic." }
]
```
