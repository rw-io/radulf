VERDICT: revise

## Summary

The functional work is complete and correct: `mergeBranch` detects `MERGE_HEAD`, aborts Radulf's own abandoned merge, refuses a foreign one with an "outside Radulf" error naming the repo path, short-circuits an already-landed branch with `{ ok: true, mergeCommit, alreadyMerged: true }` (oldest merge on the ancestry path, falling back to the base tip, `onCommitted` skipped), `deliver` forwards `alreadyMerged` into `review.decided`, and the reaper's Needs Attention reason is actionable. All four real-repo tests, the reaper test and the reviewService test the card asked for exist and pass. `tsc`, `eslint` and `make check` all exit 0.

**One acceptance criterion fails**, introduced by the loop's final task (commit `bc32378`, "task 6"):

```
$ grep -Fq 'target checkout has uncommitted changes"' src/server/git.ts; echo $?
0          # ← criterion requires this grep to FAIL (exit 1)
$ grep -Fn 'target checkout has uncommitted changes' src/server/git.ts
339:export const DIRTY_CHECKOUT_ERROR = "target checkout has uncommitted changes";
```

Task 3 had already produced the correct actionable message (`target checkout ${repoPath} has uncommitted changes — commit or stash them there, then press Retry merge`), which satisfied this criterion. Task 6 then hoisted the phrase into an exported `DIRTY_CHECKOUT_ERROR` constant whose literal is exactly the old bare string, so the "old bare error string is gone" check regresses. The constant is dead as an export — nothing in `src/` imports it (`grep -rn DIRTY_CHECKOUT_ERROR src/` → only its definition and the one use inside `mergeBranch`), and its docstring's claim that "the UI/tests can match it" is not true of any current code. It also wedges itself between `mergeBranch`'s long JSDoc block (lines ~321–335, "Merge the ralph branch into the repo's base branch…") and the function, so that docstring no longer attaches to `mergeBranch`.

## What to change (exactly)

**File: `src/server/git.ts`**

1. Delete the exported constant and its 3-line docstring (currently lines 336–340):
   ```ts
   /** Leading phrase of the error `mergeBranch` returns when the shared parent
    * checkout has uncommitted changes. Kept as a constant so the UI/tests can
    * match it without depending on the path and remediation hint that follow. */
   export const DIRTY_CHECKOUT_ERROR = "target checkout has uncommitted changes";
   ```
   so that the existing `/** Merge the ralph branch into the repo's base branch. …` JSDoc is once again immediately followed by `export async function mergeBranch(`.

2. In the dirty-check branch of `mergeBranch` (currently line ~409), inline the message so the bare literal `"target checkout has uncommitted changes"` does not appear anywhere in the file. Revert to the wording from task 3, which already meets the card and the criterion:
   ```ts
   return {
     ok: false,
     error: `target checkout ${repoPath} has uncommitted changes — commit or stash them there, then press Retry merge`,
   };
   ```

3. Verify:
   ```
   grep -Fq 'target checkout has uncommitted changes"' src/server/git.ts   # must exit 1
   grep -q 'Retry merge' src/server/git.ts                                 # must exit 0
   node_modules/.bin/vitest run src/server/git.test.ts                     # 33 tests, exit 0
   node_modules/.bin/tsc --noEmit && node_modules/.bin/eslint src/server/git.ts
   ```
   The existing test "names the dirty checkout and tells the operator how to recover" asserts `toContain(dir)`, `toContain("uncommitted changes")`, `toContain("Retry merge")` and keeps passing with the inlined message. No other file needs to change.

## Verified (all passed)

- `vitest run src/server/git.test.ts` → 33 passed
- `vitest run src/server/reviewService.test.ts` → 15 passed
- `vitest run src/server/orchestrator.reaper.test.ts` → 10 passed
- `vitest run src/server/reviewService.pr.test.ts src/server/orchestrator.lifecycle.test.ts` → 122 passed
- All `grep` criteria except the one above (MERGE_HEAD, merge-base/is-ancestor, ancestry-path, alreadyMerged in git.ts/reviewService.ts/tests, outside Radulf, Retry merge, reaper reason phrases, `mergeBranch recovery` suite, `press Retry merge` in reaper test)
- `tsc --noEmit` → 0; `eslint` on the six changed files → 0; gate `make check` → 0
- Diff contains only the six files the card names; no unrelated changes.

## Notes for the human reviewer (once re-approved)

- A run branch with *no* commits beyond base now returns `ok: true, alreadyMerged: true, mergeCommit: <base tip>` instead of failing with `merge commit failed: nothing to commit`. This follows the card's explicit "fall back to the base tip" rule, but it means an empty-diff approval is recorded as merged rather than parked — worth being aware of.
- In the `alreadyMerged` path `onCommitted` (→ `recordRefWrite`) is intentionally skipped per the card; the base-ref move made by the dead worker was never recorded either, so any still-open run on the same repo may see it as an unexplained ref move at its run-end integrity check. Out of scope for this card, but a follow-up candidate.
- `docs/TROUBLESHOOTING.md` ("Approving a merge") and `docs/IMPROVEMENT_RUNS.md` (Gotchas) document the dirty-checkout message and should gain entries for the new "merge started outside Radulf" error and the `alreadyMerged` outcome on approve.

```findings
[
  { "severity": "critical", "file": "src/server/git.ts", "line": 339, "issue": "Acceptance criterion fails: `grep -Fq 'target checkout has uncommitted changes\"' src/server/git.ts` succeeds because the DIRTY_CHECKOUT_ERROR constant re-introduces the old bare literal; inline the message in mergeBranch and delete the constant." },
  { "severity": "important", "file": "src/server/git.ts", "line": 336, "issue": "The exported DIRTY_CHECKOUT_ERROR constant is dead code (nothing imports it) and its placement detaches mergeBranch's JSDoc block from the function." },
  { "severity": "suggestion", "file": "src/server/git.ts", "line": 385, "issue": "A run branch with no commits beyond base is now reported as alreadyMerged with mergeCommit = base tip (per the card's fallback), whereas before it failed with 'nothing to commit' — intended per spec, but flagging for reviewer awareness." }
]
```
