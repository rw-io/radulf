# 33: Gitea delivery, and pushing every approved merge

Decided 2026-10-30. Amends **decision 6** and [15](15-github-pr-delivery.md)
for Gitea and Forgejo repositories only: approval still pushes the branch and
opens a pull request, but Radulf now waits for the pull request's CI and merges
it itself. Amends [21](21-clone-on-register.md)'s "no fetch after the clone"
residual, because a merge that is pushed has to start from the remote's base.
GitHub delivery is untouched: it stays on `gh`, and Radulf still never merges a
GitHub pull request.

Two changes ship together because they share one credential:

1. **Gitea and Forgejo connections.** A token entered in Settings lets Radulf
   clone, fetch, push, open a pull request, read its CI status and merge it,
   with nothing configured on the machine Radulf runs on.
2. **Push after a local merge.** An approved card that is merged locally is
   pushed to the remote. "Done" means the work is on the remote, not only on
   the machine running Radulf.

## Motivation

Production Radulf runs on its own VM and works on repositories hosted at
`gitea.chilleh.ca`. Three things are wrong with that today:

1. **Approved work never leaves the VM.** `mergeBranch` merges into the base
   branch of Radulf's own clone and stops. Nothing pushes it. The card says Done
   while the work exists only on a disk nobody else can see.
2. **Pull request delivery only speaks GitHub.** `gh` is the whole
   integration (15's non-goals say so), so a Gitea repository has no pull
   request path at all.
3. **Every credential is configured on the server.** Spec 21's clone and 15's
   push both use "the operator's own, host-side" credentials: an SSH key in the
   persisted home, or `gh auth setup-git`. On a VM that is redeployed from a
   pinned commit, that is configuration outside the app that the operator has
   to remember and redo.

The operator also does not want to review a change twice. The in-app review is
the review. A pull request on Gitea exists for **feature tracking and CI/CD**,
not as a second place where a human reads the diff.

## Why Radulf may now merge the pull request it opens

Spec 15 kept decision 8 intact by never merging: the pull request was "a
narrower release than a local merge" because a second human still had to accept
it. That second human is gone by the operator's choice, and the argument has to
be made again rather than inherited.

It holds, because nothing new is released:

```
 evaluate ──▶ In Review ──▶ [approval] ──┬──▶ merge to local base, push base     (this spec, all remotes)
                                         ├──▶ push branch, open PR                (15, GitHub, unchanged)
                                         └──▶ push branch, open PR, wait for CI,
                                              Radulf merges the PR                (this spec, Gitea/Forgejo)
```

The Gitea path writes the same commits to the same remote base branch that the
first path's push already writes, after the same approval, from the same
host-side code path. It is strictly more conservative than the first path,
because a red CI run stops it. Approval here means what it means everywhere
else: a human's, or auto-approve's when the card or workspace has it on.
Auto-approve already bypasses decision 8 for local merges and is recorded on
`card.auto_approved`; this spec does not widen it.

Spec 15's draft rule (an auto-approved delivery opens a draft) does not carry
over to Gitea. A draft exists so a human knows a pull request was not seen by
one; a pull request Radulf is about to merge is not waiting for anyone.

## Threat model delta

Relative to [14](14-sandboxing.md), which stands unchanged:

- **The agent gains no new reach.** `git push`, `fetch` and `clone` stay
  blocked inside the sandbox over HTTPS and SSH. No tool binding exists or may
  be added for connections, tokens, pushing, pull requests or merging. These
  are host-side only, downstream of approval, permanently.
- **New credential: a Gitea access token, stored by Radulf.** Spec 15 avoided
  storing a credential by letting `gh` hold it. This spec stores one, because
  the whole point is that the server needs no setup. The token:
  - is encrypted at rest with `settingsCrypto` (the key derived from
    `data/auth-secret`), following the precedent `jiraApiToken` set;
  - is never returned to a client after it is saved: reads get the existing
    `REDACTED` stand-in, and the UI can only replace or remove it;
  - is never placed on a command line (the process table is readable by other
    processes of the same user), never written into `.git/config` or a remote
    URL, and never present in an agent's environment;
  - never appears in an event payload, transcript, log line, error message or
    card export. Git and HTTP error output is scrubbed of it before it is
    stored or shown.
- **A stolen token's blast radius** is what its scopes allow on that Gitea
  instance. The Settings help text names the minimum scopes and recommends a
  token for a dedicated account or with access limited to the repositories
  Radulf works on.

## Decisions

### 1. Connections

A **connection** is a forge server Radulf can authenticate to: a kind, a base
URL, and a token. Settings → Repositories gains a connection section beside the
existing GitHub panel.

- **Kinds built now: Gitea and Forgejo.** Forgejo serves Gitea's API, so they
  are one implementation with two labels. **GitLab is designed for, not
  built**: nothing here may assume a Gitea-only shape where GitLab's would
  differ (merge requests, pipelines instead of commit statuses, project paths
  with subgroups), but no GitLab code ships in this spec.
- **Several connections may exist,** keyed by base URL. Today there is one.
- **Saving checks the token** with an authenticated identity call and shows
  "Signed in to gitea.chilleh.ca as `<login>`", or the server's error. The
  check is cached briefly and re-run when a delivery fails, matching
  `githubStatus`.
- **Help text names the scopes** a token needs: repository read and write (push,
  delete branches, open, merge and close pull requests, read commit statuses
  and Actions logs) and user read (the identity check).

### 2. Which repository uses which connection

A repository uses a connection when its `origin` belongs to that server.
Matching on the hostname alone is not enough: Gitea serves SSH from its own
host, and the operator's remotes look like
`git@ssh.gitea.chilleh.ca:homelab/argo.git` while the web and API live at
`https://gitea.chilleh.ca`. **An SSH remote on a different host than the web
URL must match without the operator typing anything extra.** A workable
mechanism: parse `owner/repo` from the remote, ask each connection's API for
that repository, and accept the connection whose reported SSH or clone URL is
the remote. Cache the result per repository. The builder may choose another
mechanism that meets the requirement.

A repository with no matching connection behaves exactly as it does today.

### 3. One token covers every remote operation

For a repository that matches a connection, every remote git operation Radulf
performs uses the token over HTTPS: clone on register (21), fetch, the
push-after-merge push, and the pull request branch push. If the remote is an
SSH address, Radulf still talks HTTPS to the repository's HTTPS clone URL. The
repository's configured `origin` is never rewritten. A fresh VM with a
connection saved and no SSH key can therefore register, deliver and merge.

The token reaches git through a host-side credential mechanism fed by the
environment of that one git process (a `GIT_ASKPASS` helper, or a
`credential.helper` that reads an environment variable). The builder picks
one, subject to the constraints in the threat model.

A repository with no matching connection keeps using host-side credentials as
today, with `GIT_TERMINAL_PROMPT=0` and SSH `BatchMode`.

### 4. Push after a local merge

When approval delivers by local merge (pull request delivery off), the base
branch is pushed to `origin` after the merge.

- **Per-repository setting, `pushAfterMerge`.** Default **on** for a repository
  Radulf cloned itself (21, the clone lives in Radulf's repos directory) and
  **off** for one registered by local path. A local-path checkout is often the
  operator's own working copy, and pushing its base branch would push any of
  the operator's unpushed commits along with Radulf's. A clone the operator
  cannot push to (a read-only upstream) can turn it off.
- **Applies to every remote,** GitHub included. For a repository without a
  matching connection it uses host-side credentials.
- **Fetch first, only when pushing.** Before the merge, Radulf fetches
  `origin`'s copy of the base branch and **reconciles** the local base with it:
  - local base behind: fast-forward it;
  - both moved: an ordinary merge of the remote base into the local base,
    committed by Radulf as a merge commit;
  - that merge conflicts: Needs Attention, nothing merged, nothing pushed.

  Nothing is ever force-pushed, reset, or rewritten, locally or on the remote.
  The existing base sync into the worktree (15 step 3, 29 decision 1) then
  runs against the reconciled base, so a conflict between the card and remote
  work hands back to the loop the way it does now. With `pushAfterMerge` off
  there is no fetch: delivery is exactly what it is today.
- **Pushes the base branch only.** No tags, no other branches.
- **Done means pushed.** If the push is rejected because the remote moved
  during the merge, Radulf reconciles again and retries the push once. Any
  other push failure (auth, network), or a second rejection, sends the card to
  Needs Attention with the reason and a **Retry push** action that runs the
  reconcile and the push again. The local merge is not undone.
- **Improvement Run cards never push**, for the reason 15 found: their base is
  a local-only `ralph/improve-*` branch whose accumulation model is the local
  merge.

### 5. Gitea pull request delivery

When approval delivers by pull request and the repository matches a Gitea or
Forgejo connection, the existing `openPr` setting and card flag select this
path instead of `gh`. Effective `openPr` is still
`card.openPr || settings.openPr`, read at approval time.

```
 approval
   ├─ 1. claim, integrity check                     (15, unchanged)
   │     fetch, base sync from the REMOTE base      (15 step 3, changed)
   ├─ 2. strip .ralph, commit                       (15, unchanged)
   ├─ 3. push the card branch with the token
   ├─ 4. open the PR, or reuse the open one for this branch
   │      (release the repo delivery lease here)
   ├─ 5. wait for CI on the PR head commit
   │      ├─ success, or no CI ─▶ 6
   │      ├─ failure ─▶ decision 6
   │      └─ timeout ─▶ Needs Attention
   └─ 6. merge (retake the lease)
          ├─ merge commit, delete the remote branch
          ├─ reconcile the local base with the merged remote base
          ├─ reclaim the worktree
          └─ card ─▶ Done
```

- **The base sync uses the remote base.** On this path step 1 fetches and
  merges `origin`'s base branch into the worktree, not the local base branch
  15 syncs from today (`mergeBaseIntoWorktree(run.worktreePath, baseBranch)`).
  The PR targets the remote base, and syncing from the local one could carry
  local-only commits (a sibling card's merge awaiting Retry push, operator
  commits) into the PR.
- **Done means merged on the remote.** Step 6's local reconcile (decision 4's
  rule) keeps the next card's base current. If it conflicts, the card is
  still Done because its work is on the remote; a warning event is recorded,
  and the next delivery on that repository stops at its own reconcile.
- **Title and body** come from the card and evaluator summary, as in 15.
- **The PR URL** is recorded on the delivery event and the card summary, and
  shown on the card while it waits.
- **Waiting is durable.** The wait survives a server restart and a web/worker
  split (25): its state lives in the database and is polled by the worker, not
  held in a timer.
- **Waiting holds nothing.** The per-repo delivery lease (25 decision 6) is
  released once the PR is open and retaken only to merge, so one slow CI run
  does not block every other delivery to that repository. A waiting card does
  not count against the per-repo concurrency cap (20).
- **CI status** is the combined commit status of the PR head commit.
  Immediately after a push there may be no status yet, so a commit with no
  status is given a **grace window of 2 minutes** for one to appear. If none
  does, the repository is treated as having no CI and the PR is merged. Once
  a status has appeared, it is waited for until it succeeds or fails, up to a
  **CI timeout of 2 hours** from the latest push, after which the card goes to
  Needs Attention with a link to the PR.
- **Merge style is a merge commit**, matching the local `--no-ff` merge. The
  remote branch is deleted after the merge.
- **Not mergeable at merge time** (the base moved while CI ran): fetch, sync
  the worktree from the remote base again, push, and return to step 5. A
  conflict hands back to the loop as in step 1.
- **While a card waits, the only operator action is Abandon.** Abandon closes
  the PR, deletes the remote branch, and reclaims the worktree. Pull back and
  restart stay unavailable, as they are for any card in review today
  (`PULLBACK_STATUSES`, `abandon`'s `safeStatuses`). Leaving the PR open on
  abandon was rejected: someone could merge work on Gitea that Radulf had
  stopped watching.
- **The forge refuses the merge** for any other reason (branch protection
  wants approving reviews, the token lacks the scope): Needs Attention with the
  server's message and a Retry action.
- **Someone acts on the PR while Radulf waits.** Merged on Gitea: fast-forward
  the local base, reclaim the worktree, card goes to Done. Closed without
  merging: Needs Attention. Radulf does not reopen it.
- **A retry reuses the open PR for the branch** rather than opening a second
  one, as 15's `findOpenPullRequest` does for GitHub.

### 6. A CI failure goes back to the loop

A failed CI run on a Radulf PR goes back to the loop **the way a merge conflict
does, not the way a rejection does**: a new plan version gains a fix-CI task
carrying the feedback, the card returns to the queue on the same worktree and
branch, and only the loop runs (the path `reloopForConflict` takes today). There
is no re-plan, no plan critic, and no plan approval, whatever
`reviewPlanBeforeImplementation` says. A CI failure is a concrete defect in
approved work, not a change of direction. The feedback names each failing
check, links to it, and includes the tail of its log where the Gitea Actions
API provides one. The CI verdict is recorded on the delivery record, not as a
rejection of the run.

- After the loop finishes, the card follows its normal path: evaluation, then
  In Review, then approval by a human or by auto-approve, whichever the card's
  settings call for. **A CI fix is new code and gets approved like any other
  change.** Delivery then pushes the new commits to the same branch, the same
  PR updates, and CI runs again.
- **At most 2 CI round-trips per card.** A third CI failure sends the card to
  Needs Attention with the PR link instead of back to the loop.
- The feedback is untrusted input to the loop in the same way a human's
  rejection text is. It is placed in the loop's feedback, never executed by
  the host.

### 7. What the UI shows

- **Settings → Repositories:** the connection section (decision 1), and per
  repository, the `pushAfterMerge` toggle (decision 4).
- **The "Open pull requests" availability check** (`/api/github/status` today,
  read by the New Task dialog and Settings) answers per repository: a
  Gitea-matched repository is available when its connection's token checks out,
  regardless of `gh`. The reason shown when it is unavailable names the
  connection, not `gh`.
- **A waiting card** shows that it is waiting for CI, with the PR link. It is
  not an attention state.

The visual layout is left to the builder and follows the existing GitHub panel
and Settings conventions.

## Settings and data model additions

| Key | Where | Meaning |
|---|---|---|
| connections | new storage, builder's choice of table or setting | kind, base URL, encrypted token, last check result. Several allowed. |
| `pushAfterMerge` (bool) | `repos` | Decision 4. Default true for a clone made by 21, false otherwise. Existing rows are backfilled by that rule. |
| matched connection (cache) | `repos` or alongside connections | Decision 2's result, so matching is not repeated on every render. |
| PR wait state | delivery records | PR number and URL, head commit, CI round-trip count, timestamps for the grace window and timeout. Builder's choice of columns. |

Migrations are generated with the project's Drizzle tooling (`make`).

## Failure semantics

Consistent with 14 and 15, fail loudly and never fall back silently:

- **A failed Gitea delivery never falls back to a local merge**, and a failed
  push-after-merge never falls back to "Done".
- **Every failure leaves the card recoverable** in Needs Attention with the
  reason and a retry that repeats only the failed step: push, PR creation,
  wait, or merge.
- **Nothing is ever force-pushed.** A rejected non-fast-forward is surfaced,
  not resolved.
- **A missing or invalid token** makes the PR option unavailable for that
  repository with the reason shown, the way a logged-out `gh` does today, and
  sends an in-flight delivery to Needs Attention.

## Non-goals

- **Any change to GitHub delivery.** It stays on `gh`, keeps its draft rule,
  and Radulf still never merges a GitHub PR. A GitHub token and auto-merge are
  a separate decision.
- **Building GitLab.** Designed for here, built when there is a GitLab to test
  against.
- **Reading PR review comments back into a card.** Still out of scope, as in 15.
- **Labels, reviewers, milestones, PR templates, squash or rebase merge
  styles.**
- **A general "sync from remote" action** for repositories. Fetching here
  happens only as part of delivery.
- **Any model-reachable surface** for connections, tokens, pushing, pull
  requests or merging. Permanent.

## Constraints

- This fork must stay mergeable with `lhansen-dev/radulf` (`PRODUCT.md`). The
  work lands as PR-sized commits that keep the forge-specific code in its own
  module, the way `github.ts` holds all of `gh`.
- The token constraints in the threat model are requirements, each with a test.

## Acceptance tests

1. **Connection.** Saving a valid token shows the account; an invalid token
   shows the server's error; a saved token is never returned by any API, and
   is stored encrypted.
2. **Matching.** A repository with `origin` `git@ssh.gitea.chilleh.ca:o/r.git`
   matches a connection at `https://gitea.chilleh.ca`. A repository on an
   unrelated host matches nothing and behaves as today.
3. **No server credentials.** With no SSH key and no git credential helper on
   the host, a matched repository can be cloned by URL (21), and a card on it
   can be delivered both by local merge with push and by Gitea PR.
4. **Token hygiene.** The token does not appear in any spawned process's
   arguments, in the repository's `.git/config`, in any event, log, transcript
   or card export, or in the error text of a failed push against a bad remote.
   A sandboxed agent cannot read it from the process table or `/proc`.
5. **Push after merge.** A clone pushes its base after a local merge; a
   local-path repository with the toggle off does not; turning it on pushes.
6. **Reconcile.** Remote base ahead of local: local base is fast-forwarded and
   the card's merge lands on top. Both moved: the remote base is merged into
   the local base, then the card's merge, then the push. That merge conflicts:
   Needs Attention, nothing merged, nothing pushed. With `pushAfterMerge` off,
   no fetch happens.
7. **Push failure.** Remote moved during the merge: reconcile and one retry
   succeed without operator action. Auth failure: card in Needs Attention,
   local merge intact, Retry push pushes it and moves the card to Done.
8. **Gitea PR, green CI.** Push, PR opened, status success, PR merged with a
   merge commit, remote branch deleted, local base fast-forwarded, worktree
   reclaimed, card Done.
9. **No CI.** No status appears within the grace window: PR merged.
10. **Red CI.** A fix-CI task with the failing check names and log tail is
    added to the plan and only the loop runs, with no re-plan or plan approval
    even when `reviewPlanBeforeImplementation` is on. After re-approval the
    same PR receives the new commits. A third failure goes to Needs Attention.
    The base sync for the PR uses the remote base: a local-only commit on the
    local base does not appear in the PR.
11. **Timeout.** A status stays pending past the CI timeout: Needs Attention
    with the PR link.
12. **Durability.** Restarting the server while a card waits for CI resumes the
    wait and completes the merge.
13. **Lease.** While one card waits for CI, another card on the same
    repository can be delivered.
14. **External action.** PR merged on Gitea while waiting: card Done. PR
    closed: Needs Attention.
15. **Abandon while waiting.** The PR is closed, the remote branch deleted, and
    the worktree reclaimed.
16. **GitHub unchanged.** 15's acceptance tests pass unmodified.
17. **Regression, from 14.** `git push`, `fetch` and `clone` still fail inside
    the sandbox over HTTPS and SSH.

## Amendments to prior specs and docs, when this ships

- **Decision 6** in `00-overview`: approval on a Gitea or Forgejo repository
  delivers by PR and Radulf merges it after CI; a local merge is pushed.
  **Decision 8** gains the note that a Radulf merge of its own PR follows the
  same approval as a local merge.
- **15**: its "never merges" and draft rules now apply to GitHub only. Its
  non-goal "Forges other than GitHub" is answered for Gitea and Forgejo.
- **21**: "No fetch after the clone" is amended; delivery fetches the base
  when it pushes or delivers by Gitea PR. Its credentials paragraph gains
  connections.
- `docs/DESIGN_HISTORY.md`: a row for 33, and 15 and 21 marked as amended by
  it (in the same commit as this spec).
- `docs/HOW_IT_WORKS.md`, `docs/DOCKER.md` (the credentials section that tells
  the operator to run `gh auth setup-git`), and `PRODUCT.md`'s delivery and
  forge lines are rewritten in the change that ships the behavior.

## Rollout

No backlog handling is designed. The operator confirmed on 2026-10-30 that
production holds no approved local merges that were never pushed, so the first
push from each clone carries only the card being delivered.

## Decided by the spec author

The operator decided: tokens over REST instead of `glab`/`tea`; setup in the
app with nothing configured on the server; Gitea first; Radulf merges its own
PR after approval; the PR exists for tracking and CI; local merges are pushed;
both ship together; GitHub is left as it is; a CI failure goes back into the
loop to be fixed; no rollout backlog exists.

These were the author's calls and are open to the operator's correction:

- Gitea and Forgejo built now, GitLab designed for but not built.
- The token is used over HTTPS even when `origin` is SSH.
- `pushAfterMerge` per repository, on for clones and off for local-path repos.
- Fetch and reconcile before merging: fast-forward, or merge the remote base
  into the local base; stop only on a conflict. No fetch when
  `pushAfterMerge` is off.
- The Gitea PR path syncs from the remote base, not the local one.
- A CI failure re-enters the loop the way a merge conflict does (no re-plan,
  no plan approval), and the fix goes through the card's normal approval
  again. At most 2 CI round-trips.
- While a card waits for CI, only Abandon is offered, and it closes the PR.
- A Gitea card is Done once its PR is merged on the remote, even if the local
  reconcile afterwards conflicts.
- Grace window of 2 minutes, CI timeout of 2 hours, both constants.
- Merge commits, and the remote branch deleted after merge.
- No draft PRs on Gitea.

## Left to the builder

- The connection storage shape and the matching mechanism, within decisions 1
  and 2.
- The git credential mechanism, within the threat model's constraints.
- How the PR wait is scheduled in the worker, within decision 5's durability
  and lease rules.
- The UI layout.
- The exact Gitea API calls, including whether to use the forge's own
  "merge when checks succeed" instead of polling, provided failures still
  reach the loop as decision 6 requires.
