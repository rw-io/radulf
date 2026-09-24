VERDICT: approve

## What I verified

Every acceptance criterion was run by hand in the worktree and passed:

- `grep -q 'export async function findOpenPullRequest' src/server/github.ts` → pass.
- `grep -q '"url,isDraft"'` and `grep -q '"--state"'` on `src/server/github.ts` → pass; the argv is exactly `pr list --head <branch> --base <base> --state open --json url,isDraft --limit 1`, and the test asserts that argv verbatim.
- `grep -q 'findOpenPullRequest'` and `grep -q 'alreadyOpen: true'` on `src/server/reviewService.ts` → pass.
- `grep -q 'findOpenPullRequest: mocks.findOpenPullRequest' src/server/reviewService.pr.test.ts` → pass.
- `grep -q 'findOpenPullRequest' src/server/github.test.ts` → pass; `grep -c 'it('` → 7.
- `npx vitest run src/server/github.test.ts` → 7 passed, exit 0.
- `npx vitest run src/server/reviewService.pr.test.ts` → 13 passed, exit 0 (tests 1–7 untouched in the diff; 8, 8b, 8c added).
- `npx vitest run src/server/reviewService.test.ts` → 15 passed, exit 0.
- `npx tsc --noEmit` → exit 0.
- `npx eslint` on the four files → exit 0 (one warning, see findings).
- `git diff --stat HEAD -- . ':!.ralph'` → empty (all committed); the diff against the base branch touches exactly `src/server/github.ts`, `src/server/github.test.ts`, `src/server/reviewService.ts`, `src/server/reviewService.pr.test.ts`.
- Repository gate `make check` (test + lint + typecheck + build + split-process check) → exit 0.

Code review against the card:

- `findOpenPullRequest` goes through the existing private `run` helper, which was extended additively to also return a trimmed `stdout` (the combined `out` field would have mixed stderr into the JSON). Returns `{ ok: true, pr | null }` on success, `{ ok: false, error }` on non-zero exit, unparseable JSON, or a non-array — a lookup failure is never reported as "no PR".
- In `deliverPullRequest` the lookup sits after the push and before `createPullRequest`. On `existing.ok && existing.pr` it calls `completeApproval` with `{ delivery: "pr", grantedBy, draft: pr.isDraft, prUrl: pr.url, alreadyOpen: true }` (same `grantedBy` derivation as the existing path). On `ok: false` or `pr: null` it falls through to the pre-existing block, which is byte-for-byte unchanged. Nothing routes toward `mergeBranch`.
- `retryMerge` reaches this path via the same claim/deliver step; test 8c drives it from `needs_attention` to `done` without `createPullRequest`.

## For the human reviewer

- Per the card, `draft` on the adopted PR is taken from GitHub's `isDraft`, so a draft PR opened by an auto-approved attempt stays a draft when a human presses Retry merge. That is what the card asked for, but it means the "non-draft PR ⇒ seen by a human" invariant is preserved only in the conservative direction (a human retry never un-drafts).
- `run` in `github.ts` now returns `stdout` in both branches; only `findOpenPullRequest` reads it, the other two callers still use `out`.

```findings
[
  { "severity": "suggestion", "file": "src/server/reviewService.pr.test.ts", "line": 422, "issue": "test 8c assigns `const run = seedRun(...)` but never reads it, producing a @typescript-eslint/no-unused-vars warning (eslint still exits 0)" }
]
```
