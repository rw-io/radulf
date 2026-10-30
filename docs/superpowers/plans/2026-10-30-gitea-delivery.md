# Gitea Delivery and Push After Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Gitea or Forgejo token saved in Settings lets Radulf clone, push, open a pull request, wait for its CI and merge it; and every local merge on a repository with push-after-merge on is pushed to its remote.

**Architecture:** Forge code lives in its own modules (`gitea.ts` for HTTP, `forgeConnections.ts` for the encrypted store, `forgeMatch.ts` for repo matching, `giteaDelivery.ts` for the PR flow and CI wait), so `reviewService.ts` only gains a branch point and the fork stays mergeable upstream. Git gains token-authenticated fetch and push that read the token from the process environment through an inline credential helper. The CI wait is a durable `pr_waits` row polled from the worker tick, with the card parked in a new `awaiting_ci` status that holds no lease and no pipeline slot.

**Tech Stack:** TypeScript, Next.js App Router (this repo's version: read `node_modules/next/dist/docs/` before touching routes), Drizzle ORM on SQLite, vitest, git CLI, the Gitea REST API v1.

**Spec:** `specs/33-gitea-delivery-and-push-after-merge.md` (read it in full before Task 1; this plan argues from it).

## Global Constraints

- Every shell command that touches node runs with the nvm preamble: `source ~/.nvm/nvm.sh && export PNPM_HOME="$HOME/.local/share/pnpm" && export PATH="$PNPM_HOME:$PATH"`. Run tools only through `make` (`make test`, `make lint`, `make typecheck`, `make db-generate`, `make check`).
- There is no single-file test target (`Makefile:120` runs `vitest run` with no arguments) and AGENTS.md forbids invoking vitest directly. Every "run the tests" step means `make test` and reading the named files' results; the whole suite takes seconds.
- Tests use `setupTestDataDir` (`src/testUtils/testDataDir.ts`). Never point a test at `./data`.
- No em dashes, en dashes, or spaced hyphens used as dashes anywhere you write: code comments, UI copy, commit messages, docs.
- Commits: Conventional Commits, subject under 72 characters, `(spec 33)` in the subject of each `feat`/`fix` commit, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run `make check` before each commit.
- The token is never on a command line, never written to `.git/config` or into a remote URL, never in an event payload, log line, transcript, error message, card export, or API response. Error text from git and from Gitea is passed through `scrubSecret` before it is stored or returned.
- No tool binding, prompt text, or other model-reachable surface may reference connections, tokens, pushing, pull requests, or merging.
- Nothing is ever force-pushed, reset, or rewritten, locally or on the remote.
- GitHub delivery is unchanged: `src/server/reviewService.pr.test.ts` passes without edits.
- Improvement Run cards (`belongsToImprovementRun`) never push and never open a PR.
- Values from the spec: CI grace window **2 minutes** (`CI_GRACE_MS = 2 * 60_000`); CI timeout **2 hours from the latest push** (`CI_TIMEOUT_MS = 2 * 60 * 60_000`); **at most 2 CI round-trips**, the third failure goes to Needs Attention (`MAX_CI_ROUNDS = 2`); merge style **merge commit**; remote branch **deleted after merge**.
- Gitea API auth header: `Authorization: token <token>`. API root: `<baseUrl>/api/v1`.

## Review Focus

1. **A base URL with a sub-path or trailing slash** (`https://host/gitea/`): API calls and the HTTPS clone URL must keep `/gitea` and drop only the trailing slash. Pinned in Task 1 (normalize) and Task 3 (clone URL).
2. **A token pasted with a trailing newline or spaces**: it is trimmed before it is checked and stored. Pinned in Task 1.
3. **Gitea unreachable during the CI wait** (network blip, Gitea restarting): the wait stays `waiting` and is retried on a later tick; only the 2 hour timeout ends it. Pinned in Task 8.
4. **The base branch missing on the remote** (renamed or deleted there): delivery stops in Needs Attention with a reason that names the branch, not a stack trace. Pinned in Task 5.
5. **A card branch name with a slash** (`ralph/fix-x-abc123`) in API paths and push refspecs: branch-delete URLs keep the slashes as path separators with each segment encoded; refspecs use `refs/heads/<branch>`. Pinned in Task 8.

---

### Task 1: Encrypted connection store and the Gitea identity check

**Files:**
- Modify: `src/db/schema.ts` (new `forgeConnections` table; export it from `@/db` the way the other tables are)
- Create: generated migration under `drizzle/` via `make db-generate`
- Create: `src/server/gitea.ts`
- Create: `src/server/forgeConnections.ts`
- Test: `src/server/forgeConnections.test.ts`, `src/server/gitea.test.ts`

**Interfaces:**
- Produces (schema): table `forge_connections`: `id text pk`, `kind text not null` (`"gitea" | "forgejo"`), `base_url text not null unique`, `token text not null` (ciphertext), `account text`, `check_error text`, `checked_at text`, `created_at text not null`, `updated_at text not null`.
- Produces (`gitea.ts`):
  - `type GiteaAuth = { baseUrl: string; token: string }`
  - `class GiteaError extends Error { status: number | null }` (status null for a network failure)
  - `giteaRequest<T>(auth: GiteaAuth, method: "GET" | "POST" | "PATCH" | "DELETE", apiPath: string, body?: unknown): Promise<T>` where `apiPath` starts with `/` and is appended to `${baseUrl}/api/v1`. Throws `GiteaError` with the response body's `message` field (or the first 300 chars of text) on non-2xx; 10 second timeout; `cache: "no-store"`. Returns `undefined as T` on 204 or an empty body.
  - `getAuthenticatedUser(auth: GiteaAuth): Promise<{ login: string }>` (`GET /user`)
- Produces (`forgeConnections.ts`):
  - `type ForgeKind = "gitea" | "forgejo"`
  - `type ForgeConnection = { id: string; kind: ForgeKind; baseUrl: string; account: string | null; checkError: string | null; checkedAt: string | null; updatedAt: string }` (no token field, ever)
  - `normalizeBaseUrl(raw: string): string`: trims, requires `http:` or `https:`, keeps any path, strips trailing slashes, drops query and fragment. Throws `ClientError` otherwise.
  - `listConnections(): ForgeConnection[]`
  - `connectionAuth(id: string): GiteaAuth` (decrypts; server-only; throws `ClientError` if missing)
  - `saveConnection(input: { kind: ForgeKind; baseUrl: string; token: string }): Promise<ForgeConnection>`: trims the token, calls `getAuthenticatedUser`, and on failure throws `ClientError(<server message>, 400)` without storing. On success upserts by normalized `baseUrl`, storing `encryptSecret(token)` from `./settingsCrypto`, `account`, `checkedAt`, `checkError: null`.
  - `deleteConnection(id: string): void`
  - `checkConnection(id: string, options?: { refresh?: boolean }): Promise<ForgeConnection>`: re-runs the identity call at most every 30 seconds per id unless `refresh`; writes `account`/`checkError`/`checkedAt`.
  - `invalidateConnectionCheck(id: string): void`
  - `scrubSecret(text: string, secret: string): string`: replaces every occurrence of `secret` with `***`; returns `text` unchanged when `secret` is empty.

- [ ] **Step 1: Write the failing tests**

`forgeConnections.test.ts` (stub `fetch` with `vi.stubGlobal`):
- `stores the token encrypted`: after `saveConnection({ kind: "gitea", baseUrl: "https://gitea.example/", token: " tok123\n" })`, the raw row's `token` starts with `"enc:v1:"` and `decryptSecret(row.token) === "tok123"`; the stubbed fetch saw header `Authorization: token tok123`.
- `never returns the token`: `Object.keys(listConnections()[0])` does not include `"token"`, and `JSON.stringify(listConnections())` does not contain `"tok123"`.
- `rejects a bad token without storing`: fetch returns 401 `{"message":"user does not exist"}`; `saveConnection` rejects with a `ClientError` whose message contains `user does not exist`; `listConnections()` is empty.
- `upserts by base url`: saving `https://gitea.example` twice with different tokens leaves one row holding the second token.
- `normalizeBaseUrl keeps a sub-path`: `normalizeBaseUrl("https://host/gitea/") === "https://host/gitea"`; `normalizeBaseUrl("ftp://host")` throws.
- `scrubSecret`: `scrubSecret("fatal: tok123 bad", "tok123") === "fatal: *** bad"`.
- `checkConnection caches for 30s`: two calls without `refresh` make one fetch; with `refresh: true`, two.

`gitea.test.ts`:
- `giteaRequest builds the api url under a sub-path`: auth `{ baseUrl: "https://host/gitea", token: "t" }`, `GET /user` hits `https://host/gitea/api/v1/user`.
- `giteaRequest surfaces the server message`: 404 `{"message":"not found"}` throws `GiteaError` with `status === 404` and message containing `not found`.
- `giteaRequest maps a network failure to status null`.

- [ ] **Step 2: Run them and confirm they fail** (module not found).
- [ ] **Step 3: Add the table to `src/db/schema.ts` and run `make db-generate`.** Name the migration file whatever drizzle-kit produces; commit it.
- [ ] **Step 4: Implement `gitea.ts` and `forgeConnections.ts` to the interfaces above.**
- [ ] **Step 5: Run the two test files; expect PASS.**
- [ ] **Step 6: `make check`, then commit**

```bash
git add src/db/schema.ts drizzle/ src/server/gitea.ts src/server/forgeConnections.ts src/server/gitea.test.ts src/server/forgeConnections.test.ts
git commit   # feat(forge): store Gitea connections with an encrypted token (spec 33)
```

---

### Task 2: Connection routes and the Settings section

**Files:**
- Create: `src/app/api/forge/connections/route.ts` (GET list, POST save)
- Create: `src/app/api/forge/connections/[id]/route.ts` (GET check with `?refresh=1`, DELETE)
- Create: `src/app/settings/forgeConnections.tsx` (`ForgeConnectionsSection`)
- Modify: `src/app/settings/page.tsx:436` (render `<ForgeConnectionsSection />` directly after `<GithubSection />`)
- Modify: `src/app/settings/settingsUI.tsx:7` (Repositories description mentions Gitea)
- Test: `src/app/api/forge/connections/connectionsRoute.test.ts`

**Interfaces:**
- Consumes: `listConnections`, `saveConnection`, `deleteConnection`, `checkConnection` (Task 1); `json`, `handle`, `err` from `src/app/api/_lib`; `record` from `src/server/requestValidation`.
- Produces: `GET /api/forge/connections` returns `ForgeConnection[]`; `POST` with `{ kind, baseUrl, token }` returns `201` and the `ForgeConnection`; `GET /api/forge/connections/:id?refresh=1` returns the checked `ForgeConnection`; `DELETE` returns `{ ok: true }`.

- [ ] **Step 1: Write the failing route tests**
- `POST returns the connection without the token`: response JSON has `account`, no `token` key, and the raw response text does not contain the submitted token.
- `POST with an invalid kind returns 400`.
- `GET lists without tokens`.
- `DELETE removes the row`.

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement the routes** following `src/app/api/github/status/route.ts`'s use of `handle`/`json`.
- [ ] **Step 4: Implement `ForgeConnectionsSection`** in the style of `GithubSection` (`page.tsx:40-105`): a list of saved connections, each showing the status dot, `Signed in to <host> as <account>` or the `checkError`, a Re-check button (calls `?refresh=1`), and Remove. An add form with kind (Gitea, Forgejo), base URL, and a password-type token input. The token input is cleared after save and is never pre-filled. Fixed copy:
  - Heading: `Gitea and Forgejo connections`
  - Description: `Clone, push, and deliver pull requests that Radulf merges once CI passes, with a token instead of credentials on this machine.`
  - Help under the token field: `Needs repository read and write and user read access. A token for a dedicated account, or one limited to the repositories Radulf works on, limits what a leaked token can reach.`
- [ ] **Step 5: Run the route tests; expect PASS.**
- [ ] **Step 6: `make check`, then commit** (`feat(settings): add Gitea and Forgejo connections (spec 33)`).

---

### Task 3: Match a repository to its connection

**Files:**
- Create: `src/server/forgeMatch.ts`
- Modify: `src/server/gitea.ts` (add `getRepository`)
- Test: `src/server/forgeMatch.test.ts`

**Interfaces:**
- Consumes: `listConnections`, `connectionAuth` (Task 1); `tryGit` from `./git`.
- Produces (`gitea.ts`): `getRepository(auth: GiteaAuth, owner: string, repo: string): Promise<{ sshUrl: string; cloneUrl: string; htmlUrl: string } | null>` (`GET /repos/{owner}/{repo}`, maps `ssh_url`/`clone_url`/`html_url`; 404 returns null).
- Produces (`forgeMatch.ts`):
  - `type ParsedRemote = { host: string; owner: string; repo: string; ssh: boolean }`
  - `parseRemote(url: string): ParsedRemote | null`: accepts `https://host[:port]/[prefix/]owner/repo[.git]`, `ssh://user@host[:port]/owner/repo[.git]`, scp-style `user@host:owner/repo[.git]`. `owner` and `repo` are the last two path segments; `host` includes a non-default port.
  - `type ForgeRepoRef = { connection: ForgeConnection; owner: string; repo: string; cloneUrl: string }`
  - `matchRemoteUrl(url: string): Promise<ForgeRepoRef | null>`
  - `matchRepo(repoPath: string): Promise<ForgeRepoRef | null>` (reads `git remote get-url origin`, then `matchRemoteUrl`; no origin returns null)
- Matching rule: for each connection, if `parsed.host === new URL(connection.baseUrl).host`, match with `cloneUrl = ${connection.baseUrl}/${owner}/${repo}.git`. Otherwise, if `parsed.ssh`, call `getRepository` on that connection and match when the returned `sshUrl` equals the remote after both are normalized (strip a trailing `.git`, lowercase the host); use the returned `cloneUrl`. Lookup errors count as no match for that connection.
- Cache: module-level `Map<string, ForgeRepoRef | null>` keyed by `${url}|${fingerprint}`, where `fingerprint` is every connection's `id:updatedAt` joined; recomputed per call from `listConnections()` so a connection saved in another process changes the key.

- [ ] **Step 1: Write the failing tests**
- `parses the operator's ssh remote`: `parseRemote("git@ssh.gitea.chilleh.ca:homelab/argo.git")` equals `{ host: "ssh.gitea.chilleh.ca", owner: "homelab", repo: "argo", ssh: true }`.
- `parses https with a sub-path`: `parseRemote("https://host/gitea/o/r.git")` gives owner `o`, repo `r`, `ssh: false`.
- `matches on the same host without an api call`: connection `https://gitea.example`, remote `https://gitea.example/o/r.git`; fetch not called; `cloneUrl === "https://gitea.example/o/r.git"`.
- `keeps the sub-path in the clone url`: connection `https://host/gitea`, remote `https://host/o/r`; `cloneUrl === "https://host/gitea/o/r.git"`.
- `matches an ssh remote on another host through the api`: connection `https://gitea.chilleh.ca`, remote `git@ssh.gitea.chilleh.ca:homelab/argo.git`, stubbed `GET /api/v1/repos/homelab/argo` returns `ssh_url: "git@ssh.gitea.chilleh.ca:homelab/argo.git"`, `clone_url: "https://gitea.chilleh.ca/homelab/argo.git"`; result `cloneUrl` is that clone URL.
- `unrelated host matches nothing`: api returns 404; result null.
- `caches until connections change`: second identical call makes no fetch; after `saveConnection` of a second connection, the next call fetches again.

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: `make check`, then commit** (`feat(forge): match a repository to its Gitea connection (spec 33)`).

---

### Task 4: Token-authenticated fetch and push, and clone on register

**Files:**
- Modify: `src/server/git.ts` (after `pushBranch`, inside the "Spec 15: remote delivery" section)
- Modify: `src/server/repoClone.ts` (`cloneRepository`)
- Create: `src/server/remoteTarget.ts`
- Test: `src/server/git.remote.test.ts`, `src/server/repoClone.test.ts` (extend if it exists, else create)

**Interfaces:**
- Consumes: `matchRemoteUrl`, `matchRepo`, `ForgeRepoRef` (Task 3); `connectionAuth`, `scrubSecret` (Task 1).
- Produces (`git.ts`):
  - `type RemoteTarget = { kind: "origin" } | { kind: "forge"; url: string; username: string; token: string }`
  - `forgeGitEnv(username: string, token: string): NodeJS.ProcessEnv`: `remoteEnv()` plus `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=credential.helper` / `GIT_CONFIG_VALUE_0=""` (clears inherited helpers such as gh's), `GIT_CONFIG_KEY_1=credential.helper` / `GIT_CONFIG_VALUE_1` set to an inline shell helper that, for `get`, prints `username=$RADULF_FORGE_USER` and `password=$RADULF_FORGE_TOKEN`; and those two variables. The helper text names the variables, never the values.
  - `fetchBranchHead(cwd: string, target: RemoteTarget, branch: string): Promise<{ ok: true; sha: string } | { ok: false; error: string; missing: boolean }>`: `git fetch --no-tags <origin|url> refs/heads/<branch>` then `rev-parse FETCH_HEAD`. Writes no `refs/remotes/*` ref (avoids spec 19 ref-move noise). `missing` is true when git reports the remote ref does not exist. Uses `GIT_REMOTE_TIMEOUT_MS`.
  - `pushRef(cwd: string, target: RemoteTarget, refspec: string): Promise<{ ok: true } | { ok: false; error: string; rejected: boolean }>`: never `--force`; `rejected` true when output matches `/\[rejected\]|non-fast-forward|fetch first/`. Errors pass through `scrubSecret` when the target is a forge.
  - `cloneRemote(url, dest, cwd, auth?: { httpsUrl: string; username: string; token: string })`: with `auth`, clones from `auth.httpsUrl` under `forgeGitEnv`, then `git remote set-url origin <url>` so the configured origin is what the operator typed.
- Produces (`remoteTarget.ts`):
  - `forgeTarget(ref: ForgeRepoRef): RemoteTarget` (`{ kind: "forge", url: ref.cloneUrl, username: ref.connection.account ?? "radulf", token: connectionAuth(ref.connection.id).token }`)
  - `resolveRemoteTarget(repoPath: string): Promise<{ target: RemoteTarget; forge: ForgeRepoRef | null }>` (`matchRepo`, else `{ kind: "origin" }`)

- [ ] **Step 1: Write the failing tests** (real git, temp dirs, a local bare repo as the remote)
- `fetchBranchHead returns the remote tip and writes no remote-tracking ref`: bare remote ahead of the clone by one commit; result `sha` equals the bare repo's `main`; `git for-each-ref refs/remotes` output is unchanged.
- `fetchBranchHead reports a missing branch`: branch `nope`; `ok: false`, `missing: true`, error contains `nope`.
- `pushRef pushes and reports a rejection`: push `main:refs/heads/main` succeeds; after the bare repo moves independently, a second push returns `ok: false, rejected: true`.
- `the credential helper serves the token from the environment`: `git credential fill` run with `forgeGitEnv("bot", "tok-xyz")` and stdin `protocol=https\nhost=gitea.example\n\n` prints `password=tok-xyz`; capture the argv passed to `execBounded` for a `pushRef` with a forge target (spy on `./exec`) and assert no element contains `tok-xyz`.
- `the token never lands in .git/config`: after `cloneRemote` with `auth` against a `file://` bare repo used as `httpsUrl`, `git config --get remote.origin.url` equals the typed URL and `.git/config` does not contain the token.
- `cloneRepository clones through the token when the url matches a connection` (`repoClone.test.ts`, mock `matchRemoteUrl` and `cloneRemote`): `cloneRemote` receives `auth.httpsUrl === ref.cloneUrl`; with no match it receives no `auth`.
- `a sandboxed agent cannot read the token from /proc`: find the Linux sandbox test that runs a real bwrap command (`grep -ln "skipIf" src/server/sandbox/*.test.ts`) and add a case beside it. Spawn a host child (`sleep 30`) with `RADULF_FORGE_TOKEN=canary-33` in its environment, run `cat /proc/*/environ 2>/dev/null | tr '\0' '\n'` inside the sandbox, and assert the output does not contain `canary-33`. The spec review found the sandbox gives agent bash its own PID namespace and a fresh `/proc`; this test pins it. Skip on non-Linux, like its neighbors.

- [ ] **Step 2: Run; expect FAIL** (the `/proc` case is expected to pass immediately; that is fine, it is a regression pin).
- [ ] **Step 3: Implement the git helpers, `remoteTarget.ts`, and the `cloneRepository` change.** `cloneRemote`'s current signature is `cloneRemote(url: string, dest: string, cwd: string)` (`src/server/git.ts:641`); `auth` is a new optional fourth parameter.
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: `make check`, then commit** (`feat(git): fetch, push and clone with a forge token (spec 33)`).

---

### Task 5: Reconcile the base and push after a local merge

**Files:**
- Modify: `src/db/schema.ts` (`repos.pushAfterMerge`), plus `make db-generate`
- Modify: `src/server/repos.ts` (add `pushAfterMergeFor`)
- Modify: `src/server/git.ts` (add `fastForwardBranch`)
- Create: `src/server/baseReconcile.ts`
- Modify: `src/server/reviewService.ts:540-576` (the local-merge branch of `deliver`)
- Modify: `src/app/api/repos/[id]/route.ts:20-40` (PATCH accepts `pushAfterMerge`)
- Modify: `src/app/settings/page.tsx` (`ReposSection`, beside `GateCommandField` at line 1089: a "Push after merge" `ToggleRow`)
- Test: `src/server/baseReconcile.test.ts`, `src/server/reviewService.push.test.ts`, extend `src/app/api/repos/[id]/repoRoute.test.ts`

**Interfaces:**
- Consumes: `fetchBranchHead`, `pushRef`, `RemoteTarget` (Task 4); `resolveRemoteTarget` (Task 4); `mergeBranch`, `hasRemote`, `tryGit` (existing); `recordRefWrite` (existing, `integrity.ts`).
- Produces (schema): `repos.push_after_merge integer` nullable. Null means "use the default".
- Produces (`repos.ts`): `pushAfterMergeFor(repo: Repo): boolean` = when `repo.pushAfterMerge` is null, whether `repo.path` is inside `CLONES_DIR` (from `@/db`; `path.relative(CLONES_DIR, repo.path)` is non-empty, not absolute, and does not start with `..`); otherwise `repo.pushAfterMerge === 1`.
- Produces (`git.ts`): `fastForwardBranch(repoPath: string, branch: string, sha: string): Promise<{ ok: boolean; error?: string }>`: when `branch` is checked out in `repoPath`, `git merge --ff-only <sha>` (refuse with an error if the tree is dirty, matching `mergeBranch`'s message style); otherwise `git update-ref refs/heads/<branch> <sha> <old-sha>`.
- Produces (`baseReconcile.ts`):
  - `type ReconcileResult = { ok: true; remoteSha: string } | { ok: false; error: string }`
  - `reconcileBase(repoPath: string, baseBranch: string, target: RemoteTarget, onRefWrite: (sha: string) => void): Promise<ReconcileResult>`: fetch; remote tip already in local base: no-op; local base an ancestor of the remote tip: `fastForwardBranch`; both moved: `mergeBranch(repoPath, baseBranch, remoteSha, \`ralph: merge remote ${baseBranch} into ${baseBranch}\`, onRefWrite)`. A missing remote branch returns `error: "\`<base>\` does not exist on the remote; it may have been renamed or deleted there"`. A conflict returns `error: "local \`<base>\` and the remote's have diverged and conflict: <git output>"`. Calls `onRefWrite` for every ref move.
  - `pushBase(repoPath: string, baseBranch: string, target: RemoteTarget, onRefWrite: (sha: string) => void): Promise<{ ok: true } | { ok: false; error: string }>`: `pushRef(repoPath, target, \`refs/heads/${b}:refs/heads/${b}\`)`; on `rejected`, `reconcileBase` once and push once more.
- Behavior in `deliver` (local-merge branch): let `push = pushAfterMergeFor(repo) && !belongsToImprovementRun(...) && await hasRemote(repo.path)`. When `push`: resolve the target, `reconcileBase` before `mergeBranch` (failure: `needs_attention` with the error, `decided(..., { reconcileFailed })`, no merge); after a successful merge, `pushBase` (failure: `needs_attention` with reason `merged into \`<base>\` locally, but the push failed: <error>. Press Retry merge to push it.`, `decided(..., { pushFailed })`, and **no** `completeApproval`). The existing Retry merge then re-runs `deliver`: reconcile is a no-op, `mergeBranch` returns `alreadyMerged`, and `pushBase` runs. When not `push`: exactly today's code path, no fetch.

- [ ] **Step 1: Write the failing tests**

`baseReconcile.test.ts` (real git, bare remote, `{ kind: "origin" }` target):
- `fast-forwards a local base that is behind`: local `main` ends at the remote tip; no merge commit created; `onRefWrite` called once with that sha.
- `merges when both moved`: local `main` has a new merge commit whose parents are the old local tip and the remote tip.
- `stops on a conflict without moving the base`: same file edited both sides; `ok: false`, error contains `diverged and conflict`; local `main` sha unchanged; no `MERGE_HEAD` left.
- `is a no-op when local is ahead`.
- `names a missing remote branch`: base `trunk` absent on the remote; error contains ``\`trunk\` does not exist on the remote``.
- `pushBase retries once after a rejection`: remote moves between reconcile and push (simulate by pushing to the bare repo from a second clone inside a `pushRef` spy's first call); final remote `main` contains both commits.

`reviewService.push.test.ts` (mock `./git`'s `mergeBranch`, `hasRemote`, `removeWorktree`, and `./baseReconcile`; pattern from `reviewService.pr.test.ts:1-60`):
- `clone with push on reconciles, merges, pushes, then completes`: call order `reconcileBase` < `mergeBranch` < `pushBase`; card `done`.
- `push off does nothing remote`: repo `pushAfterMerge: 0`; neither `reconcileBase` nor `pushBase` called; card `done`.
- `local-path repo defaults to off, clone path defaults to on`: `pushAfterMergeFor` on `{ pushAfterMerge: null, path: "<CLONES_DIR>/x" }` is true and on `/home/u/x` is false.
- `push failure leaves the merge and parks the card`: `pushBase` returns `{ ok: false, error: "auth failed" }`; card `needs_attention`, latest exit reason contains `Press Retry merge to push it`; no approved `reviews` row; `removeWorktree` not called.
- `retry pushes the already-merged base`: then `retryMerge` with `mergeBranch` returning `alreadyMerged`; `pushBase` called; card `done`.
- `reconcile conflict merges nothing`: `reconcileBase` fails; `mergeBranch` not called; card `needs_attention`.
- `improvement-run card never pushes`.

`repoRoute.test.ts`: `PATCH { pushAfterMerge: true }` stores `1`; `false` stores `0`; a non-boolean returns 400.

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Schema change and `make db-generate`.**
- [ ] **Step 4: Implement `fastForwardBranch`, `baseReconcile.ts`, `pushAfterMergeFor`, the `deliver` change, the PATCH field, and the Settings toggle** (`title="Push after merge"`, `description="Push the base branch to its remote after Radulf merges an approved card. On by default for repositories Radulf cloned."`).
- [ ] **Step 5: Run; expect PASS, including `reviewService.test.ts` and `reviewService.pr.test.ts` unchanged.**
- [ ] **Step 6: `make check`, then commit** (`feat(review): push the base branch after a local merge (spec 33)`).

---

### Task 6: Gitea PR delivery up to an open PR, and the `awaiting_ci` status

**Files:**
- Modify: `src/db/schema.ts` (`CARD_STATUSES` gains `"awaiting_ci"`; new `prWaits` table), plus `make db-generate`
- Modify: `src/shared/cardStatus.ts` (`STATUS_LABELS.awaiting_ci = "Waiting for CI"`; add to `ACTIVE_STATUSES`)
- Modify: `src/server/orchestrator.ts:1729` (`assertRepoRemovable` also refuses while a card is `awaiting_ci`)
- Modify: `src/server/gitea.ts` (pull request calls)
- Create: `src/server/giteaDelivery.ts`
- Modify: `src/server/reviewService.ts:533-538` (branch point)
- Test: `src/server/reviewService.gitea.test.ts`, extend `src/server/gitea.test.ts`

**Interfaces:**
- Consumes: `matchRepo`, `ForgeRepoRef` (Task 3); `forgeTarget`, `fetchBranchHead`, `pushRef` (Task 4); `checkConnection`, `invalidateConnectionCheck` (Task 1); `mergeBaseIntoWorktree`, `stripRalphForDelivery`, `git` (existing).
- Produces (schema): table `pr_waits`: `id text pk`, `card_id text not null`, `run_id text not null` (references `runs.id`, cascade), `repo_id text not null`, `connection_id text not null`, `owner text not null`, `repo text not null`, `branch text not null`, `base_branch text not null`, `pr_number integer not null`, `pr_url text not null`, `head_sha text not null`, `status text not null` (`"waiting" | "merged" | "ci_failed" | "closed" | "timed_out" | "abandoned" | "failed"`), `pushed_at text not null`, `created_at text not null`, `ended_at text`, `detail text`; index on `status`.
- Produces (`gitea.ts`):
  - `type GiteaPull = { number: number; url: string; state: "open" | "closed"; merged: boolean; mergeable: boolean; headSha: string; mergeCommitSha: string | null }`
  - `findOpenPull(auth, owner, repo, head: string, base: string): Promise<GiteaPull | null>` (`GET /repos/{o}/{r}/pulls?state=open&limit=50&page=N`, paging until a short page; match `head.ref === head && base.ref === base`)
  - `createPull(auth, owner, repo, input: { head: string; base: string; title: string; body: string }): Promise<GiteaPull>`
  - `getPull(auth, owner, repo, index: number): Promise<GiteaPull>`
- Produces (`giteaDelivery.ts`):
  - `type GiteaDeliveryHooks = { moveCard: ReviewServiceDependencies["moveCard"]; decided(cardId: string, runId: string, payload: Record<string, unknown>): void; reloopForConflict(card: Card, run: Run, baseBranch: string, error: string, merged: Awaited<ReturnType<typeof mergeBaseIntoWorktree>>): Promise<boolean> }`
  - `class GiteaDelivery { constructor(hooks: GiteaDeliveryHooks); deliver(card: Card, run: Run, repo: Repo, baseBranch: string, expectedStatus: "review" | "needs_attention", approvedBy: ApprovedBy, forge: ForgeRepoRef): Promise<{ ok: boolean; error?: string }> }`
  - `giteaPullRequestBody(card: Card, approvedBy: ApprovedBy): string`: the card description, the `## Summary` section when present (as `pullRequestBody` does), and the footer `Opened by Radulf from card \`<id>\`, approved by a human. Radulf merges it once CI passes.` or `... approved by Radulf's evaluator under auto-approve. Radulf merges it once CI passes.`
- `deliver` order: `checkConnection(forge.connection.id, { refresh: true })` with a `checkError` is an unmet precondition (card back to `expectedStatus`, as `deliverPullRequest`'s `unmet` does); `fetchBranchHead(run.worktreePath, target, baseBranch)` (failure: `needs_attention`); `mergeBaseIntoWorktree(run.worktreePath, remoteSha)` (conflict: `hooks.reloopForConflict` with the result; other failure: `needs_attention`); `stripRalphForDelivery`; `pushRef(run.worktreePath, target, \`HEAD:refs/heads/${run.branch}\`)`; `findOpenPull` else `createPull` (title `card.title`); insert a `pr_waits` row (`status: "waiting"`, `head_sha` = `git rev-parse HEAD` in the worktree, `pushed_at: now()`); `moveCard(card.id, "reviewing", "awaiting_ci", \`waiting for CI on ${prUrl}\`)`; emit `review.pr_opened` with `{ delivery: "gitea", prUrl, grantedBy, reusedOpenPr }`. Every failure after the precondition calls `invalidateConnectionCheck` and goes to `needs_attention` with a scrubbed reason; none falls back to a merge.
- Branch point in `ReviewService.deliver`: inside the existing `openPr` condition, `const forge = await matchRepo(repo.path); if (forge) return this.gitea.deliver(...)`; otherwise the unchanged `deliverPullRequest`. `ReviewService` constructs `this.gitea = new GiteaDelivery({ moveCard: this.deps.moveCard, decided, reloopForConflict: (...a) => this.reloopForConflict(...a) })`.

- [ ] **Step 1: Write the failing tests** (`reviewService.gitea.test.ts`, mocking `./git`, `./gitea`, `./forgeMatch`, `./forgeConnections`, `./github`, `./settings` as `reviewService.pr.test.ts` does)
- `matched repo delivers through gitea, never gh`: `openPr: 1`; `githubStatus` and `createPullRequest` not called; `pushRef` called with the forge target and `HEAD:refs/heads/<branch>`; `createPull` called with `head: run.branch`, `base: "main"`; card `awaiting_ci`; one `pr_waits` row `waiting` with the PR URL; `removeWorktree` not called; no approved `reviews` row yet.
- `syncs from the remote base, not the local one`: `mergeBaseIntoWorktree` receives the sha from `fetchBranchHead`, not `"main"`.
- `reuses an open pr`: `findOpenPull` returns a PR; `createPull` not called; event payload `reusedOpenPr: true`.
- `bad token is an unmet precondition`: `checkConnection` returns `checkError: "401"`; card back to `review`; nothing pushed.
- `base conflict hands back to the loop`: `mergeBaseIntoWorktree` conflicted; `reloopForConflict` called; nothing pushed.
- `push failure parks the card and scrubs the token`: `pushRef` error contains the token string; the stored exit reason does not.
- `unmatched repo keeps the gh path`: `matchRepo` null; `createPullRequest` called as before.
- `auto-approved body says so`: `giteaPullRequestBody(card, "auto")` contains `under auto-approve`.
- `waiting holds no lease`: after the delivery finishes with the card `awaiting_ci`, `repo_leases` has no row for the repo, and a second card on the same repo in `review` can be approved and delivered (its `claimDelivery` succeeds).

`gitea.test.ts`: `findOpenPull pages until it finds the branch` (first page 50 non-matching, second page has it).

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Schema, status, label, `assertRepoRemovable`; `make db-generate`.** Fix every exhaustiveness error `make typecheck` reports for the new status (for example `STATUS_LABELS`) by adding the `awaiting_ci` case, nothing more. Do not add `awaiting_ci` to `RUNNING_STATUSES` or `ATTENTION_STATUSES`: the first would count it against the spec 20 concurrency cap (`pipelineLoad`, `orchestrator.ts:1606`), the second would call it a human decision.
- [ ] **Step 4: Implement the gitea calls, `giteaDelivery.ts`, and the branch point.** `giteaDelivery.ts` takes `ApprovedBy` and the row types with `import type` from `./reviewService` and `@/db`, so the two modules do not import each other at runtime.
- [ ] **Step 5: Run; expect PASS, with `reviewService.pr.test.ts` unchanged.**
- [ ] **Step 6: `make check`, then commit** (`feat(review): deliver Gitea repos as a pull request (spec 33)`).

---

### Task 7: The CI wait, the merge, and abandon

**Files:**
- Modify: `src/server/gitea.ts` (status, merge, close, delete branch)
- Modify: `src/server/giteaDelivery.ts` (`pollWaits`, `closeForAbandon`)
- Modify: `src/server/reviewService.ts` (public `pollPullRequestWaits()`; `abandon` accepts `awaiting_ci`; expose `completeApproval` to the hooks)
- Modify: `src/server/orchestrator.ts:1870` (call `this.reviewService.pollPullRequestWaits()` after `claimPendingDeliveries()`)
- Test: `src/server/giteaDelivery.wait.test.ts`, extend `src/server/gitea.test.ts`

**Interfaces:**
- Consumes: everything from Task 6; `reconcileBase`, `pushRef`, `fetchBranchHead` (Tasks 4 and 5); `acquireRepoLease`, `releaseRepoLease` (existing `repoLeases.ts`); `recordRefWrite` (existing).
- Produces (`gitea.ts`):
  - `getCombinedStatus(auth, owner, repo, sha: string): Promise<{ state: "pending" | "success" | "failure" | "error" | null; statuses: Array<{ context: string; state: string; targetUrl: string | null }> }>` (`GET /repos/{o}/{r}/commits/{sha}/status`; `state: null` when `total_count` is 0)
  - `mergePull(auth, owner, repo, index: number, title: string): Promise<{ ok: true } | { ok: false; notMergeable: boolean; message: string }>` (`POST /repos/{o}/{r}/pulls/{index}/merge` with `{ Do: "merge", MergeTitleField: title, delete_branch_after_merge: true }`; 405 or 409 is `notMergeable: true`)
  - `closePull(auth, owner, repo, index: number): Promise<void>` (`PATCH /repos/{o}/{r}/pulls/{index}` with `{ state: "closed" }`)
  - `deleteBranch(auth, owner, repo, branch: string): Promise<void>` (`DELETE /repos/{o}/{r}/branches/<segments>`, each `/`-separated segment `encodeURIComponent`-ed, joined with `/`)
- Extends `GiteaDeliveryHooks` with `completeApproval(card: Card, run: Run, repo: Repo, payload: Record<string, unknown>, outcome: DoneOutcome, mergeCommit?: string): Promise<void>` and `workerId(): string` and `pump(): void`.
- Produces (`giteaDelivery.ts`): `pollWaits(nowMs?: number): Promise<void>`; `closeForAbandon(cardId: string): Promise<void>`. Constants `CI_GRACE_MS`, `CI_TIMEOUT_MS`, `POLL_INTERVAL_MS = 15_000` (per wait, in-process `Map<waitId, lastPolledMs>` so ticks do not hammer Gitea).
- `pollWaits` per `waiting` row, in order:
  1. `getPull`. A `GiteaError` with status null or 5xx: skip this row this tick (Review Focus 3). Merged: finish as merged (step 5). Closed and not merged: wait `closed`, card `awaiting_ci` to `needs_attention` with `the pull request was closed on Gitea without merging: <url>`.
  2. `getCombinedStatus(headSha)`. `null` state: merge if `now - pushedAt >= CI_GRACE_MS`, else wait. `pending`: if `now - pushedAt >= CI_TIMEOUT_MS`, wait `timed_out`, card to `needs_attention` with `CI did not finish within 2 hours: <url>`; else wait. `success`: merge. `failure` or `error`: hand to Task 8's `handleCiFailure` (in this task, a stub that sets `failed` and parks the card; Task 8 replaces it).
  3. Merge: acquire the repo lease (`acquireRepoLease(repo.path, workerId, ...)`; not acquired: skip this tick); CAS the card `awaiting_ci` to `reviewing` (lost: release and skip); `mergePull` with title `ralph: merge "<card.title>" (card <id>)`.
  4. `notMergeable`: `fetchBranchHead` the remote base, `mergeBaseIntoWorktree` with it; conflict: wait `failed` with detail, `hooks.reloopForConflict`; clean: `pushRef` the branch, update `head_sha` and `pushed_at`, card back to `awaiting_ci`. Any other refusal: wait `failed`, card `reviewing` to `needs_attention` with the scrubbed server message.
  5. Merged (by Radulf or on Gitea): wait `merged`; `reconcileBase(repo.path, baseBranch, target, sha => recordRefWrite(...))`, and on failure emit `repo.base_reconcile_failed` with the error but do not park the card; `hooks.completeApproval(card, run, repo, { delivery: "gitea", prUrl, merged: true }, outcome, pull.mergeCommitSha ?? undefined)` where `outcome` is `{ kind: "merge", baseBranch, mergeCommit: pull.mergeCommitSha }` when Gitea reported the merge commit and `{ kind: "pr", prUrl }` otherwise; release the lease in a `finally`.
- Abandon: `ReviewService.abandon` adds `"awaiting_ci"` to `safeStatuses`; for such a card it calls `this.gitea.closeForAbandon(cardId)` before moving it: `closePull` then `deleteBranch`, wait `abandoned`. A Gitea failure here emits `review.pr_close_failed` with the scrubbed error and the abandon still completes.

- [ ] **Step 1: Write the failing tests** (`giteaDelivery.wait.test.ts`: seed a card `awaiting_ci`, its loop run, and a `pr_waits` row; mock `./gitea`, `./git`, `./baseReconcile`, `./forgeConnections`; pass explicit `nowMs`)
- `no status inside the grace window keeps waiting`: `pushedAt` 1 minute before `nowMs`; `mergePull` not called.
- `no status after the grace window merges`: 3 minutes; `mergePull` called with `MergeTitleField` `ralph: merge "<title>" (card <id>)`; card `done`; wait `merged`; `reconcileBase` called; `removeWorktree` called.
- `green ci merges`.
- `pending past two hours times out`: `pushedAt` 121 minutes back, state `pending`; card `needs_attention` with `CI did not finish within 2 hours`.
- `gitea unreachable keeps waiting`: `getPull` throws `GiteaError` with status null; wait still `waiting`; card still `awaiting_ci`.
- `merged on gitea finishes the card`: `getPull` returns `merged: true`; `mergePull` not called; card `done`.
- `closed on gitea parks the card`.
- `not mergeable re-syncs and pushes`: `mergePull` returns `notMergeable`; `pushRef` called; `head_sha` updated; card `awaiting_ci`.
- `lease held elsewhere skips the tick`: lease row for another worker; `mergePull` not called; card `awaiting_ci`.
- `a restarted service resumes the wait`: construct a fresh `ReviewService` against the same DB and call `pollPullRequestWaits()`; the merge completes.
- `local reconcile failure still finishes the card`: `reconcileBase` fails; card `done`; event `repo.base_reconcile_failed` emitted.
- `polls each wait at most every 15 seconds`: two calls 5 seconds apart make one `getPull`.
- `abandon closes the pr and deletes the branch`: `closePull` and `deleteBranch` called with `ralph/x-1`; wait `abandoned`; card `abandoned`.

`gitea.test.ts`:
- `deleteBranch keeps slashes as separators`: branch `ralph/fix x-1` requests `.../branches/ralph/fix%20x-1`.
- `getCombinedStatus maps an empty status to null`.
- `mergePull maps 405 to notMergeable`.

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: `make check`, then commit** (`feat(review): wait for CI and merge the Gitea pull request (spec 33)`).

---

### Task 8: A CI failure goes back to the loop

**Files:**
- Modify: `src/server/gitea.ts` (failed job logs)
- Modify: `src/server/giteaDelivery.ts` (`handleCiFailure`, replacing Task 7's stub)
- Modify: `src/server/reviewService.ts:721-759` (extract `reloopWithTask` from `reloopForConflict`; add `reloopForCi`)
- Test: extend `src/server/giteaDelivery.wait.test.ts`, extend `src/server/gitea.test.ts`

**Interfaces:**
- Produces (`gitea.ts`): `failedJobLogs(auth, owner, repo, headSha: string): Promise<Array<{ name: string; url: string | null; logTail: string }>>`: `GET /repos/{o}/{r}/actions/runs?limit=20`, keep runs with `head_sha === headSha`; for each, `GET /actions/runs/{id}/jobs`, keep `conclusion === "failure"`; `GET /actions/jobs/{job_id}/logs` as text, last 60 lines capped at 4000 characters. Any error yields an empty `logTail` for that job, or an empty array if the run list itself fails.
- Produces (`reviewService.ts`, private):
  - `reloopWithTask(card: Card, input: { preamble: string; task: string; feedback: string; reason: string }): Promise<void>`: the body `reloopForConflict` has today from `appendFeedbackTask` through `pump()` (new plan version with `promptMd = preamble + "\n\n---\n\n" + plan.promptMd`, `feedback`, card to `ready` with `reason`). `reloopForConflict` keeps its signature and calls it.
  - `reloopForCi(card: Card, feedback: string): Promise<void>` with preamble heading `## CI failed on the pull request: fix this first`, the feedback below it, and the instruction to fix the failures and write DONE as usual; task `Follow the CI failure section at the top of your prompt: make the failing checks pass, and run the failing commands locally where you can as this task's targeted verification.`; plan `feedback` `CI failed on <prUrl>`; reason `CI failed; fixing in the loop`.
- Produces (hooks): `GiteaDeliveryHooks.reloopForCi(card: Card, feedback: string): Promise<void>`.
- `handleCiFailure(wait, statuses)`: `rounds` = count of this card's `pr_waits` rows with status `ci_failed`. Mark this wait `ci_failed`. If `rounds >= MAX_CI_ROUNDS` (so this is the third failure), card `awaiting_ci` to `needs_attention` with `CI failed 3 times on <url>; stopping so it does not loop forever`. Otherwise CAS the card `awaiting_ci` to `reviewing`, build feedback (`CI failed on <prUrl>`, then one line per failing status `- <context>: <targetUrl>`, then for each `failedJobLogs` entry a fenced block headed with the job name holding its `logTail`), scrub it, and call `hooks.reloopForCi`. No re-plan, no plan critic, no plan approval: `reloopWithTask` goes straight to `ready`, which is what `reloopForConflict` does today.

- [ ] **Step 1: Write the failing tests**
- `first ci failure re-enters the loop with the failures`: card ends `ready`; latest plan version is previous + 1; its `promptMd` contains `CI failed on the pull request`, the failing context name, its target URL, and the log tail text; its `feedback` is `CI failed on <prUrl>`; wait `ci_failed`.
- `skips plan review even when the card asks for it`: card `reviewPlanBeforeImplementation: 1`; card still ends `ready`, not `plan_review` or `todo`.
- `third failure parks the card`: two prior `ci_failed` rows for the card; card `needs_attention` with `CI failed 3 times`; no new plan version.
- `missing logs still give names and links`: `failedJobLogs` returns `[]`; feedback has the status lines.
- `merge conflict re-entry is unchanged`: an existing `reloopForConflict` test in `reviewService.test.ts` still passes.
- `failedJobLogs keeps only the failed jobs of the head commit` (`gitea.test.ts`).

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: `make check`, then commit** (`feat(review): send a failed Gitea CI run back to the loop (spec 33)`).

---

### Task 9: PR availability per repository, and the waiting card in the UI

**Files:**
- Modify: `src/app/api/github/status/route.ts`
- Modify: `src/app/api/cards/route.ts:34-70` (add `prUrl`)
- Modify: the client card type that declares `latestRun` (find it with `grep -rn "latestRun" src/app --include=*.ts*`) to add `prUrl: string | null`
- Modify: `src/app/page.tsx:55-75` (`awaiting_ci` case) and the card row that renders the status detail (a "View pull request" link when `card.prUrl`)
- Modify: `src/app/card/[id]/page.tsx` (the PR link and the Abandon action for `awaiting_ci`)
- Test: extend `src/app/api/cards/cardsRoute.test.ts`; create `src/app/api/github/status/statusRoute.test.ts` if none exists

**Interfaces:**
- Consumes: `matchRepo`, `checkConnection` (Tasks 1 and 3); `pr_waits` (Task 6).
- Produces: `GET /api/github/status?repoId=X` for a matched repo returns `{ ok: connection.checkError === null, account: connection.account, reason: ok ? null : "forge", detail: ok ? null : \`${host}: ${checkError}\`, hasRemote: true, forge: "gitea" }`; unmatched repos and the no-`repoId` call return today's shape plus `forge: "github"`. The New Task dialog (`src/app/ui/taskDialog.tsx:79-104`) needs no change.
- Produces: `GET /api/cards` includes `prUrl` (the `pr_url` of the card's `waiting` `pr_waits` row, else null).
- Status line: `case "awaiting_ci": return { mark: "◌", detail: "Waiting for CI", tone: "text-violet-300" }`.

- [ ] **Step 1: Write the failing tests**
- `status route uses the connection for a matched repo`: `githubStatus` mocked to fail; matched repo with a healthy connection returns `ok: true`, `forge: "gitea"`.
- `status route reports a broken connection`: `checkError: "401 Unauthorized"`; `ok: false`, `detail` contains the host and `401`.
- `cards route includes the pr url while waiting`.

- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement the routes and the UI changes.**
- [ ] **Step 4: Run; expect PASS.**
- [ ] **Step 5: Drive the app with the `verify` skill:** save a connection with a deliberately bad token (expect the server's error, nothing stored), confirm the Settings section and the repo's "Push after merge" toggle render, and screenshot both.
- [ ] **Step 6: `make check`, then commit** (`feat(ui): show Gitea PR state and availability per repo (spec 33)`).

---

### Task 10: Docs and the locked decisions

**Files:**
- Modify: `specs/00-overview.md:77-104` (decision 6 gains the Gitea amendment; decision 8 gains the note that a Radulf merge of its own PR follows the same approval as a local merge; both dated 2026-10-30 with a link to spec 33)
- Modify: `docs/DESIGN_HISTORY.md` (row 33 status becomes `Current; amends decision 6, 15 and 21`)
- Modify: `docs/HOW_IT_WORKS.md` (step 4: push after merge, Gitea delivery, CI wait, CI failure back to the loop)
- Modify: `docs/DOCKER.md` (credentials section: a Gitea connection replaces `gh auth setup-git` or an SSH key for Gitea repos)
- Modify: `PRODUCT.md:45` and `PRODUCT.md:58` (Gitea and Forgejo delivery shipped; GitLab still designed for, not built)
- Check: `grep -rn "never merges\|only speaks GitHub\|does not integrate" docs/ PRODUCT.md README.md` and correct any sentence these changes make false

- [ ] **Step 1: Make the edits.** Do not edit specs 15 or 21: specs are append-only, and spec 33 plus Design History already record the amendments.
- [ ] **Step 2: `make check`.**
- [ ] **Step 3: Commit** (`docs: document Gitea delivery and push after merge (spec 33)`).

---

### Task 11: End-to-end check against a real Gitea (operator approval required)

This touches a real remote. **Ask the operator before starting**, and use a throwaway repository they name or approve on `gitea.chilleh.ca`, with a token they provide (the `bitwarden` skill can read one if they say so).

- [ ] **Step 1:** In the dev app (`make dev`, port 3001), save the connection and confirm `Signed in to gitea.chilleh.ca as <login>`.
- [ ] **Step 2:** Register the throwaway repo by its SSH URL `git@ssh.gitea.chilleh.ca:<owner>/<repo>.git` with no SSH key in play; confirm the clone succeeds and `git remote get-url origin` still shows the SSH URL.
- [ ] **Step 3:** Run one card with `openPr` on (mock provider is fine). Confirm the PR opens, the card shows Waiting for CI with the link, and after CI (or the 2 minute grace with no CI) the PR is merged with a merge commit, the branch is deleted, and the card is Done.
- [ ] **Step 4:** Run one card with `openPr` off on the same repo; confirm the base branch is pushed.
- [ ] **Step 5:** Report the results with links; no commit unless a fix was needed (fixes go through `make check` and their own `fix:` commit).
