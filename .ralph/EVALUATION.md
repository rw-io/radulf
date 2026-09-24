VERDICT: approve

## Summary

This attempt did exactly what the previous `revise` asked and nothing else: commit `b0ec567` deletes the dead `DIRTY_CHECKOUT_ERROR` export from `src/server/git.ts`, inlines the actionable dirty-checkout message (`target checkout ${repoPath} has uncommitted changes — commit or stash them there, then press Retry merge`) in `mergeBranch`, and re-attaches the `mergeBranch` JSDoc to the function. `git diff --name-only edc634f HEAD -- . ':!.ralph'` lists only `src/server/git.ts`. The follow-up "task 2" commit (`5a8fa4f`) changed no source — the loop correctly recognised its own plan's grep checks were inverted and did not reintroduce the constant.

The whole card is implemented, as verified in the previous round and re-checked now:

- `mergeBranch` (`src/server/git.ts`) probes `git rev-parse -q --verify MERGE_HEAD` before any checkout or dirty check. MERGE_HEAD == `rev-parse <branch>` → `git merge --abort` and proceed; any other sha → `{ ok: false, error }` naming `repoPath` and saying "a merge started outside Radulf is in progress … finish or abort it there … before retrying". No git state is touched on that path.
- `git merge-base --is-ancestor <branch> <baseBranch>` short-circuits to `{ ok: true, mergeCommit, alreadyMerged: true }`, with `mergeCommit` = first line of `rev-list --reverse --ancestry-path --merges <branch>..<baseBranch>` (base tip fallback); `onCommitted` is not fired and no checkout happens.
- `ReviewService.deliver` spreads `alreadyMerged: true` into the `completeApproval` payload, which `decided()` emits as `review.decided`; the card page renders the raw payload, so it is visible in the activity.
- `reapStaleRuns` reason: `worker <id> stopped heartbeating during delivery — press Retry merge; Radulf will abort the half-finished merge it left in <repo.path>, or record it if it already landed` (falls back to "the repo checkout" if the repo row is gone). Same string goes to the delivery row, `card.moved` reason and `review.decided.deliveryFailed`.
- Tests: the four real-repo cases in `git.test.ts` ("mergeBranch recovery" suite), the reaper assertion in `orchestrator.reaper.test.ts`, and the `alreadyMerged` → `review.decided` + `completeApproval` case in `reviewService.test.ts` all exist and pass.

## Acceptance criteria — all pass

Reviewer regression:
- `grep -Fq 'target checkout has uncommitted changes"' src/server/git.ts` → exit 1 ✔
- `grep -c DIRTY_CHECKOUT_ERROR src/server/git.ts` → `0` ✔
- `grep -q 'target checkout ${repoPath} has uncommitted changes' src/server/git.ts` → exit 0 ✔
- `grep -q 'Retry merge' src/server/git.ts` → exit 0 ✔
- `grep -A1 'cover. \*/' src/server/git.ts | grep -q 'export async function mergeBranch'` → exit 0 ✔

Card-wide:
- All greps (`MERGE_HEAD`, `merge-base` + `--is-ancestor`, `--ancestry-path`, `alreadyMerged` in git.ts / reviewService.ts / git.test.ts / reviewService.test.ts, `outside Radulf`, `press Retry merge` in orchestrator.ts and the reaper test) → exit 0 ✔
- `vitest run src/server/git.test.ts` → 33 passed ✔
- `vitest run src/server/reviewService.test.ts` → 15 passed ✔
- `vitest run src/server/orchestrator.reaper.test.ts` → 10 passed ✔
- `tsc --noEmit` → exit 0 ✔
- `eslint` on the six named files → exit 0 ✔
- `git diff --name-only HEAD~1 -- . ':!.ralph'` → empty (HEAD is the no-op task-2 commit); `edc634f..HEAD` → only `src/server/git.ts` ✔ (no other files changed to address the feedback)
- `make check` → gate exit 0 in 56s (test + lint + typecheck + build + split-process check) ✔

Additionally ran a throwaway scenario (temp test file, deleted afterwards, tree clean): own abandoned merge is aborted and redone ending on base; a second `mergeBranch` call then returns `alreadyMerged: true` with the same merge commit; an empty run branch (tip == base tip) returns `alreadyMerged: true` with the base tip.

## For the human reviewer

- **Empty run branch semantics changed.** A run branch with no commits beyond base now returns `ok: true, alreadyMerged: true, mergeCommit: <base tip>` and the card goes to Done, where before it failed with `merge commit failed: nothing to commit`. This follows the card's explicit "fall back to the base tip" rule, but it means an empty-diff approval is recorded as merged rather than parked.
- **Ownership test is sha-only.** "Radulf's own merge" is decided purely by `MERGE_HEAD == rev-parse <branch>`, per the card. An operator who manually ran `git merge ralph/<run>` into some *other* branch in the parent checkout would have that merge aborted by Retry merge. Unlikely, and exactly what the card specifies, but worth knowing.
- **Original branch after recovery.** When the dead worker had already switched HEAD to the base branch, the retry sees `original == baseBranch` and ends there; the operator's pre-delivery branch cannot be recovered (that information died with the worker). Pre-existing limitation, not introduced here.
- Docs reconciled on approve: `docs/TROUBLESHOOTING.md` (new message wording, foreign-merge error, dead-worker reason), `docs/ARCHITECTURE.md` (one sentence on the recovery pre-checks), `docs/IMPROVEMENT_RUNS.md` (message literal).

```findings
[
  { "severity": "suggestion", "file": "src/server/git.ts", "line": 379, "issue": "A run branch with zero commits beyond base is now reported as alreadyMerged (mergeCommit = base tip) and the card completes instead of parking with 'nothing to commit' — follows the card's fallback rule, but an empty-diff approval silently succeeds." },
  { "severity": "suggestion", "file": "src/server/git.ts", "line": 366, "issue": "Ownership of an in-progress merge is judged only by MERGE_HEAD == <branch> sha, so an operator's manual merge of the same run branch into a different branch in the parent checkout would be aborted; checking HEAD == baseBranch as well would make the abort strictly Radulf's own." }
]
```
