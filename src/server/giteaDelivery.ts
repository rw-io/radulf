/**
 * Spec 33 decision 5: deliver an approved card on a Gitea or Forgejo
 * repository as a pull request there. `deliver` opens the pull request,
 * records a durable `pr_waits` row and parks the card in `awaiting_ci`; the
 * worker tick then polls the wait (`pollWaits`) and merges once CI passes.
 * While it waits the card holds no repo lease: `executeDelivery` releases it
 * once `deliver` returns, so one slow CI run does not block every other
 * delivery to the repository.
 *
 * Host-side and unsandboxed, from the same place spec 15's GitHub delivery
 * runs: downstream of the review claim and the pre-merge integrity check, with
 * no tool binding any agent can reach. The connection's token reaches git only
 * through `forgeTarget`'s process environment and Gitea only through its auth
 * header, and every reason this module stores or returns is scrubbed of it
 * first. No failure here ever falls back to a local merge: the operator asked
 * for a pull request.
 */
import { and, desc, eq, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { cards, db, now, prWaits, runs, type repos } from "@/db";
import { errorMessage } from "@/shared/errorMessage";
import { reconcileBase, type ReconcileResult } from "./baseReconcile";
import { ClientError } from "./clientError";
import { emitEvent } from "./events";
import { checkConnection, connectionAuth, invalidateConnectionCheck, scrubSecret } from "./forgeConnections";
import { matchRepo, type ForgeRepoRef } from "./forgeMatch";
import { closePull, createPull, deleteBranch, failedJobLogs, findOpenPull, getCombinedStatus, getPull, mergePull } from "./gitea";
import { GiteaError, type GiteaAuth, type GiteaCombinedStatus, type GiteaPull } from "./gitea";
import { fetchBranchHead, git, localOnlyCommits, mergeBaseIntoWorktree, pushRef, stripRalphForDelivery } from "./git";
import { recordRefWrite } from "./integrity";
import type { DoneOutcome } from "./jiraAnnounce";
import { forgeTarget } from "./remoteTarget";
import { acquireRepoLease, releaseRepoLease } from "./repoLeases";
import { getRepo } from "./repos";
import type { ApprovedBy, ReviewServiceDependencies } from "./reviewService";
import { getSettings } from "./settings";

type Card = typeof cards.$inferSelect;
type Run = typeof runs.$inferSelect;
type Repo = typeof repos.$inferSelect;
type Wait = typeof prWaits.$inferSelect;
type WaitStatus = Wait["status"];

/** Spec 33: a pushed head with no commit status at all after this long is on
 * a repository with no CI, and is merged. */
export const CI_GRACE_MS = 2 * 60_000;
/** Spec 33: CI still running this long after the latest push sends the card
 * to Needs Attention. */
export const CI_TIMEOUT_MS = 2 * 60 * 60_000;
/** Per wait, so a worker tick every few seconds does not hammer Gitea. */
export const POLL_INTERVAL_MS = 15_000;
/** Spec 33 decision 6: red CI runs a card goes back to the loop for; the
 * next one sends it to Needs Attention. */
export const MAX_CI_ROUNDS = 2;
/** Local-only commits a blocked delivery names; the rest are counted. */
const LOCAL_ONLY_LISTED = 5;

/** No response at all, or Gitea down or restarting: ask again on a later
 * tick rather than fail the card. */
function unreachable(e: unknown): boolean {
  return e instanceof GiteaError && (e.status === null || e.status >= 500);
}

/** What the delivery needs back from `ReviewService`. */
export type GiteaDeliveryHooks = {
  moveCard: ReviewServiceDependencies["moveCard"];
  decided(cardId: string, runId: string, payload: Record<string, unknown>): void;
  reloopForConflict(
    card: Card,
    run: Run,
    baseBranch: string,
    error: string,
    merged: Awaited<ReturnType<typeof mergeBaseIntoWorktree>>,
  ): Promise<boolean>;
  reloopForCi(card: Card, feedback: string): Promise<void>;
  completeApproval(
    card: Card,
    run: Run,
    repo: Repo,
    payload: Record<string, unknown>,
    outcome: DoneOutcome,
    mergeCommit?: string,
  ): Promise<void>;
  workerId(): string;
  pump(): void;
};

/** The PR description: the card's own description and the evaluator's
 * summary, as spec 15's GitHub body has, and a footer saying who released
 * the diff. There is no draft on this path; Radulf merges the PR itself. */
export function giteaPullRequestBody(card: Card, approvedBy: ApprovedBy): string {
  const parts = [card.description.trim()];
  if (card.summary?.trim()) parts.push(`## Summary\n\n${card.summary.trim()}`);
  const approval =
    approvedBy === "auto" ? "approved by Radulf's evaluator under auto-approve" : "approved by a human";
  parts.push(`---\n\nOpened by Radulf from card \`${card.id}\`, ${approval}. Radulf merges it once CI passes.`);
  return parts.filter(Boolean).join("\n\n");
}

export class GiteaDelivery {
  /** waitId to the last time this process polled it, in ms. */
  private readonly lastPolled = new Map<string, number>();
  private polling = false;
  /** Merges and CI hand-offs this process is running, each holding its card
   * in `reviewing` with no delivery row; a shutdown drain waits for them. */
  private claims = 0;

  constructor(private readonly hooks: GiteaDeliveryHooks) {}

  /**
   * The order is spec 15's, with the base taken from the remote:
   *
   *   connection check → fetch and merge the remote base → strip `.ralph`
   *   → push → open the PR, or reuse the open one → wait for CI
   *
   * The base comes from the remote because the PR targets the remote base,
   * and syncing from the local one could carry local-only commits into it.
   */
  async deliver(
    card: Card,
    run: Run,
    repo: Repo,
    baseBranch: string,
    expectedStatus: "review" | "needs_attention",
    approvedBy: ApprovedBy,
    forge: ForgeRepoRef,
  ): Promise<{ ok: boolean; error?: string }> {
    const connectionId = forge.connection.id;
    const host = new URL(forge.connection.baseUrl).host;
    let token = "";
    /** A precondition the operator fixes in Settings and then retries: the
     * card goes back where it was, so the button they used is still there. */
    const unmet = (reason: string) => {
      const error = scrubSecret(reason, token);
      this.hooks.moveCard(card.id, "reviewing", expectedStatus, error);
      this.hooks.decided(card.id, run.id, { delivery: "gitea", prBlocked: error });
      return { ok: false, error };
    };
    /** Delivery itself failed: Needs Attention, never a merge instead. */
    const failed = (reason: string) => {
      invalidateConnectionCheck(connectionId);
      const error = scrubSecret(reason, token);
      this.hooks.moveCard(card.id, "reviewing", "needs_attention", error);
      this.hooks.decided(card.id, run.id, { delivery: "gitea", prFailed: error });
      return { ok: false, error };
    };

    let auth: GiteaAuth;
    let target: ReturnType<typeof forgeTarget>;
    try {
      auth = connectionAuth(connectionId);
      token = auth.token;
      const checked = await checkConnection(connectionId, { refresh: true });
      if (checked.checkError) return unmet(`cannot sign in to ${host}: ${checked.checkError}`);
      target = forgeTarget(forge);
    } catch (e) {
      return unmet(`cannot use the connection to ${host}: ${errorMessage(e)}`);
    }

    let headSha: string;
    let existing: GiteaPull | null;
    let pull: GiteaPull;
    try {
      const fetched = await fetchBranchHead(run.worktreePath, target, baseBranch);
      if (!fetched.ok) {
        return failed(
          fetched.missing
            ? `\`${baseBranch}\` does not exist on ${forge.owner}/${forge.repo} at ${host}; it may have been renamed or deleted there`
            : `cannot fetch \`${baseBranch}\` from ${host}: ${fetched.error}`,
        );
      }

      const merged = await mergeBaseIntoWorktree(run.worktreePath, fetched.sha);
      if (merged.conflicted) {
        const out = scrubSecret(merged.out, token);
        const error = `merge conflict with ${baseBranch}: ${out}`;
        if (await this.hooks.reloopForConflict(card, run, baseBranch, error, merged)) {
          this.hooks.decided(card.id, run.id, { delivery: "gitea", mergeConflict: error, reloop: true });
          return { ok: false, error: `merge conflict, handed back to the loop to resolve: ${out}` };
        }
        return failed(error);
      }
      if (!merged.ok) return failed(`cannot merge ${baseBranch} into the branch: ${merged.out}`);

      // The remote base is in now, but the local one may have put commits in
      // the branch the remote has never seen (spec 29's sync, or the branch
      // point): the PR would merge them, unreviewed. Nothing is pushed.
      const localOnly = await localOnlyCommits(run.worktreePath, baseBranch, fetched.sha);
      if (localOnly.length > 0) {
        const listed = localOnly.slice(0, LOCAL_ONLY_LISTED).join("; ");
        const rest = localOnly.length - LOCAL_ONLY_LISTED;
        return failed(
          `the branch carries commits from the local \`${baseBranch}\` that ${host} does not have, so the pull request would merge them unreviewed: ${listed}${rest > 0 ? ` and ${rest} more` : ""}. Push them to ${host} first, then press Retry merge.`,
        );
      }

      const stripped = await stripRalphForDelivery(
        run.worktreePath,
        `ralph: drop .ralph before delivery (card ${card.id})`,
      );
      if (!stripped.ok) return failed(`cannot drop .ralph before pushing: ${stripped.out}`);
      headSha = await git(run.worktreePath, "rev-parse", "HEAD");

      const pushed = await pushRef(run.worktreePath, target, `HEAD:refs/heads/${run.branch}`);
      if (!pushed.ok) return failed(`git push failed: ${pushed.error}`);
    } catch (e) {
      return failed(`delivery to ${host} failed: ${errorMessage(e)}`);
    }

    // An earlier attempt may have opened the PR and died before recording
    // it; a retry adopts that PR rather than asking Gitea for a second one.
    try {
      existing = await findOpenPull(auth, forge.owner, forge.repo, run.branch, baseBranch);
      pull =
        existing ??
        (await createPull(auth, forge.owner, forge.repo, {
          head: run.branch,
          base: baseBranch,
          title: card.title,
          body: giteaPullRequestBody(card, approvedBy),
        }));
    } catch (e) {
      return failed(`cannot open the pull request on ${host}: ${errorMessage(e)}`);
    }

    const stamp = now();
    // One transaction, so a process that dies between the two statements
    // cannot leave a `waiting` row behind a card that never reached
    // `awaiting_ci`. A lost claim throws, which rolls the insert back.
    db.transaction((tx) => {
      tx.insert(prWaits)
        .values({
          id: nanoid(),
          cardId: card.id,
          runId: run.id,
          repoId: repo.id,
          connectionId,
          owner: forge.owner,
          repo: forge.repo,
          branch: run.branch,
          baseBranch,
          prNumber: pull.number,
          prUrl: pull.url,
          headSha,
          status: "waiting",
          pushedAt: stamp,
          createdAt: stamp,
        })
        .run();
      if (!this.hooks.moveCard(card.id, "reviewing", "awaiting_ci", `waiting for CI on ${pull.url}`)) {
        throw new ClientError("review claim was lost before the card could wait for CI");
      }
    });
    emitEvent("review.pr_opened", {
      cardId: card.id,
      runId: run.id,
      payload: {
        delivery: "gitea",
        prUrl: pull.url,
        grantedBy: card.openPr ? "card" : "global",
        reusedOpenPr: existing !== null,
      },
    });
    return { ok: true };
  }

  /** True while a merge or a CI hand-off holds a card in `reviewing`. */
  inFlight(): boolean {
    return this.claims > 0;
  }

  /**
   * Worker tick (spec 33 steps 5 and 6): take every `waiting` row one step.
   * The wait lives in the database, so a restarted or second worker picks up
   * where the last one stopped. A pass still running when the next tick
   * fires is left to finish.
   */
  async pollWaits(nowMs = Date.now()): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const waiting = db
        .select()
        .from(prWaits)
        .where(eq(prWaits.status, "waiting"))
        .orderBy(desc(prWaits.createdAt))
        .all();
      const seen = new Set<string>();
      for (const wait of waiting) {
        // A card has one pull request in flight. An older row is left over
        // from an attempt that died before it could end it.
        if (seen.has(wait.cardId)) {
          this.endWait(wait.id, "failed", "a newer wait for this card replaced it");
          continue;
        }
        seen.add(wait.cardId);
        const card = db.select().from(cards).where(eq(cards.id, wait.cardId)).get();
        // `reviewing` is a merge in flight under the repo lease, in this
        // worker or another; that merge ends the wait.
        if (card?.status === "reviewing") continue;
        if (card?.status !== "awaiting_ci") {
          const status = card?.status ?? "deleted";
          this.endWait(wait.id, "failed", `the card left Waiting for CI (now ${status}) without ending its wait`);
          continue;
        }
        const last = this.lastPolled.get(wait.id);
        if (last !== undefined && nowMs - last < POLL_INTERVAL_MS) continue;
        this.lastPolled.set(wait.id, nowMs);
        try {
          await this.pollWait(wait, card, nowMs);
        } catch (e) {
          console.error(`[radulf] polling ${wait.prUrl} failed: ${errorMessage(e)}`);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollWait(wait: Wait, card: Card, nowMs: number): Promise<void> {
    const run = db.select().from(runs).where(eq(runs.id, wait.runId)).get();
    const repo = getRepo(wait.repoId);
    if (!run || !repo) {
      return this.park(wait, "awaiting_ci", "failed", `the run or repository behind ${wait.prUrl} is gone`);
    }
    let auth: GiteaAuth;
    try {
      auth = connectionAuth(wait.connectionId);
    } catch (e) {
      const reason = `cannot use the connection to check ${wait.prUrl}: ${errorMessage(e)}`;
      return this.park(wait, "awaiting_ci", "failed", reason);
    }
    const sincePush = nowMs - Date.parse(wait.pushedAt);
    const timedOut = `CI did not finish within 2 hours: ${wait.prUrl}`;
    /** Unreachable waits for a later tick until the CI timeout ends it; any
     * other error (a revoked token, a deleted pull request) parks the card. */
    const readFailed = (e: unknown) => {
      const error = scrubSecret(errorMessage(e), auth.token);
      if (!unreachable(e)) return this.park(wait, "awaiting_ci", "failed", `cannot read ${wait.prUrl}: ${error}`);
      if (sincePush >= CI_TIMEOUT_MS) {
        return this.park(wait, "awaiting_ci", "timed_out", `${timedOut} (Gitea could not be reached: ${error})`);
      }
    };

    let pull: GiteaPull;
    try {
      pull = await getPull(auth, wait.owner, wait.repo, wait.prNumber);
    } catch (e) {
      return readFailed(e);
    }
    if (pull.merged) {
      return this.underMergeClaim(wait, card, repo, auth.token, `merging ${wait.prUrl}`, () =>
        this.finish(wait, card, run, repo, auth.token, pull.mergeCommitSha),
      );
    }
    if (pull.state === "closed") {
      const reason = `the pull request was closed on Gitea without merging: ${wait.prUrl}`;
      return this.park(wait, "awaiting_ci", "closed", reason);
    }

    let ci: GiteaCombinedStatus;
    try {
      ci = await getCombinedStatus(auth, wait.owner, wait.repo, wait.headSha);
    } catch (e) {
      return readFailed(e);
    }
    if (ci.state === "failure" || ci.state === "error") return this.handleCiFailure(wait, card, repo, ci.statuses, auth);
    if (ci.state === "pending") {
      if (sincePush >= CI_TIMEOUT_MS) this.park(wait, "awaiting_ci", "timed_out", timedOut);
      return;
    }
    // No status yet: CI gets the grace window to report one before the
    // repository is treated as having none.
    if (ci.state === null && sincePush < CI_GRACE_MS) return;
    // Radulf merges exactly the commit CI verified: commits pushed onto the
    // branch since are ones nobody here has seen.
    if (pull.headSha !== wait.headSha) {
      const reason = `the pull request's branch moved after CI ran (someone else pushed to it): ${wait.prUrl}`;
      return this.park(wait, "awaiting_ci", "failed", reason);
    }
    return this.underMergeClaim(wait, card, repo, auth.token, `merging ${wait.prUrl}`, () =>
      this.merge(wait, card, run, repo, auth, nowMs),
    );
  }

  /**
   * Spec 33 decision 6: a red CI run goes back to the loop the way a merge
   * conflict does, with feedback that names and links each failing check and
   * carries its log tail where Gitea Actions has one. The `ci_failed` rows
   * this card already has are its round-trips so far; one more than
   * `MAX_CI_ROUNDS` parks it instead. The card is held in `reviewing`, under
   * the repo lease, while the logs are read, so Abandon, other workers and
   * boot recovery leave it alone, as they do during a merge.
   */
  private async handleCiFailure(
    wait: Wait,
    card: Card,
    repo: Repo,
    statuses: GiteaCombinedStatus["statuses"],
    auth: GiteaAuth,
  ) {
    const rounds = db
      .select({ id: prWaits.id })
      .from(prWaits)
      .where(and(eq(prWaits.cardId, wait.cardId), eq(prWaits.status, "ci_failed")))
      .all().length;
    if (rounds >= MAX_CI_ROUNDS) {
      const reason = `CI failed ${rounds + 1} times on ${wait.prUrl}; stopping so it does not loop forever`;
      return this.park(wait, "awaiting_ci", "ci_failed", reason);
    }
    const headline = `CI failed on ${wait.prUrl}`;
    const failing = statuses.filter((s) => s.state === "failure" || s.state === "error");
    const lines = [headline, ...failing.map((s) => (s.targetUrl ? `- ${s.context}: ${s.targetUrl}` : `- ${s.context}`))];
    const verdict = scrubSecret(lines.join("\n"), auth.token);
    return this.underMergeClaim(wait, card, repo, auth.token, `sending the CI failure on ${wait.prUrl} back to the loop`, async () => {
      try {
        for (const job of await failedJobLogs(auth, wait.owner, wait.repo, wait.headSha)) {
          lines.push("", `${job.name}${job.url ? ` (${job.url})` : ""}:`, "```", job.logTail, "```");
        }
        await this.hooks.reloopForCi({ ...card, status: "reviewing" }, scrubSecret(lines.join("\n"), auth.token));
      } catch (e) {
        const reason = `cannot send the CI failure on ${wait.prUrl} back to the loop: ${errorMessage(e)}`;
        return this.park(wait, "reviewing", "ci_failed", scrubSecret(reason, auth.token));
      }
      // Ended only now: a restart before this leaves the wait `waiting`
      // behind a `reviewing` card, which boot recovery sends back to wait.
      this.endWait(wait.id, "ci_failed", verdict);
    });
  }

  /**
   * Step 6, and the CI hand-off, retake the repo lease, as any write to the
   * repository's refs does, and move the card `awaiting_ci` to `reviewing`
   * so Abandon and other workers leave it alone meanwhile. Either one held
   * elsewhere skips this tick. The lease is released however `step` ends.
   * A held lease is also what tells boot recovery the card is being worked.
   */
  private async underMergeClaim(
    wait: Wait,
    card: Card,
    repo: Repo,
    token: string,
    doing: string,
    step: () => Promise<void>,
  ) {
    const workerId = this.hooks.workerId();
    const leased = db.transaction(
      (tx) => acquireRepoLease(repo.path, workerId, getSettings().workerStaleSeconds, tx),
      { behavior: "immediate" },
    );
    if (!leased) return;
    try {
      if (!this.hooks.moveCard(card.id, "awaiting_ci", "reviewing", doing)) return;
      this.claims++;
      try {
        await step();
      } catch (e) {
        this.park(wait, "reviewing", "failed", scrubSecret(`${doing} failed: ${errorMessage(e)}`, token));
      } finally {
        this.claims--;
      }
    } finally {
      releaseRepoLease(repo.path, workerId);
    }
  }

  private async merge(wait: Wait, card: Card, run: Run, repo: Repo, auth: GiteaAuth, nowMs: number) {
    let merged: Awaited<ReturnType<typeof mergePull>>;
    try {
      const title = `ralph: merge "${card.title}" (card ${card.id})`;
      merged = await mergePull(auth, wait.owner, wait.repo, wait.prNumber, title, wait.headSha);
    } catch {
      // No answer: the merge may or may not have landed, and the next
      // tick's read of the pull request says which.
      this.hooks.moveCard(card.id, "reviewing", "awaiting_ci", `Gitea did not answer the merge of ${wait.prUrl}`);
      return;
    }
    if (merged.ok) {
      let mergeCommit: string | null = null;
      try {
        mergeCommit = (await getPull(auth, wait.owner, wait.repo, wait.prNumber)).mergeCommitSha;
      } catch {
        // The merge landed; only its commit id is unknown.
      }
      return this.finish(wait, card, run, repo, auth.token, mergeCommit);
    }
    const refusal = scrubSecret(merged.message, auth.token);
    if (merged.notMergeable) return this.resync(wait, card, run, repo, auth.token, refusal, nowMs);
    this.park(wait, "reviewing", "failed", `Gitea refused to merge ${wait.prUrl}: ${refusal}`);
  }

  /**
   * Not mergeable because the base moved while CI ran: merge the remote base
   * into the branch again, push, and wait for CI on the new head. When the
   * base was already in the branch, the base is not why Gitea refused, and
   * it is a refusal like any other rather than a push that changes nothing.
   */
  private async resync(wait: Wait, card: Card, run: Run, repo: Repo, token: string, refusal: string, nowMs: number) {
    const fail = (reason: string) => this.park(wait, "reviewing", "failed", scrubSecret(reason, token));
    const base = wait.baseBranch;
    try {
      const target = await this.targetFor(repo);
      const fetched = await fetchBranchHead(run.worktreePath, target, base);
      if (!fetched.ok) {
        return fail(
          fetched.missing
            ? `\`${base}\` does not exist on ${wait.owner}/${wait.repo}; it may have been renamed or deleted there`
            : `cannot fetch \`${base}\`: ${fetched.error}`,
        );
      }
      const merged = await mergeBaseIntoWorktree(run.worktreePath, fetched.sha);
      if (merged.conflicted) {
        const error = scrubSecret(`merge conflict with ${base}: ${merged.out}`, token);
        this.endWait(wait.id, "failed", error);
        if (await this.hooks.reloopForConflict({ ...card, status: "reviewing" }, run, base, error, merged)) return;
        return fail(error);
      }
      if (!merged.ok) return fail(`cannot merge ${base} into the branch: ${merged.out}`);
      const headSha = await git(run.worktreePath, "rev-parse", "HEAD");
      if (headSha === wait.headSha) return fail(`Gitea refused to merge ${wait.prUrl}: ${refusal}`);
      const pushed = await pushRef(run.worktreePath, target, `HEAD:refs/heads/${wait.branch}`);
      if (!pushed.ok) return fail(`git push failed: ${pushed.error}`);
      db.update(prWaits)
        .set({ headSha, pushedAt: new Date(nowMs).toISOString() })
        .where(eq(prWaits.id, wait.id))
        .run();
      this.hooks.moveCard(card.id, "reviewing", "awaiting_ci", `${base} moved; waiting for CI again on ${wait.prUrl}`);
    } catch (e) {
      fail(`cannot bring ${wait.branch} up to date with ${base}: ${errorMessage(e)}`);
    }
  }

  /**
   * Merged on Gitea, by Radulf or by someone else. Done means merged on the
   * remote, so the local base is brought level with it for the next card,
   * and a reconcile that fails is recorded rather than holding the card back.
   */
  private async finish(wait: Wait, card: Card, run: Run, repo: Repo, token: string, mergeCommit: string | null) {
    const base = wait.baseBranch;
    let reconciled: ReconcileResult;
    try {
      reconciled = await reconcileBase(repo.path, base, await this.targetFor(repo), (sha) =>
        recordRefWrite(repo.path, `refs/heads/${base}`, sha, this.hooks.workerId()),
      );
    } catch (e) {
      reconciled = { ok: false, error: errorMessage(e) };
    }
    if (!reconciled.ok) {
      emitEvent("repo.base_reconcile_failed", {
        cardId: card.id,
        runId: run.id,
        payload: { baseBranch: base, error: scrubSecret(reconciled.error, token) },
      });
    }
    const outcome: DoneOutcome = mergeCommit
      ? { kind: "merge", baseBranch: base, mergeCommit }
      : { kind: "pr", prUrl: wait.prUrl };
    // Ended only now, after the reconcile: a restart during it leaves the
    // wait `waiting`, so boot recovery resumes it and the next poll finishes
    // the card. Nothing awaits between this and the move to `done`.
    this.endWait(wait.id, "merged", null);
    await this.hooks.completeApproval(
      { ...card, status: "reviewing" },
      run,
      repo,
      { delivery: "gitea", prUrl: wait.prUrl, merged: true },
      outcome,
      mergeCommit ?? undefined,
    );
    this.hooks.pump();
  }

  /** Where git fetches and pushes for this repository. Throws when it no
   * longer matches a connection, or the connection was deleted since. */
  private async targetFor(repo: Repo) {
    const forge = await matchRepo(repo.path);
    if (!forge) throw new Error(`${repo.name} no longer matches a Gitea connection`);
    return forgeTarget(forge);
  }

  /** End a wait that is still `waiting`; one another path already ended
   * keeps its outcome. */
  private endWait(id: string, status: Exclude<WaitStatus, "waiting">, detail: string | null) {
    db.update(prWaits)
      .set({ status, detail, endedAt: now() })
      .where(and(eq(prWaits.id, id), eq(prWaits.status, "waiting")))
      .run();
    this.lastPolled.delete(id);
  }

  /** End the wait and send its card to Needs Attention with `reason`, which
   * the caller has already scrubbed of the token. */
  private park(
    wait: Wait,
    from: "awaiting_ci" | "reviewing",
    status: Exclude<WaitStatus, "waiting" | "merged">,
    reason: string,
  ) {
    this.endWait(wait.id, status, reason);
    this.hooks.moveCard(wait.cardId, from, "needs_attention", reason);
  }
}

/** Statuses after which Radulf has nothing left open on Gitea. */
const SETTLED: WaitStatus[] = ["merged", "closed", "abandoned"];

/**
 * The wait whose pull request a card may still have open on Gitea: the
 * card's newest wait, unless that one merged, closed or was abandoned.
 * Any other ending (timed out, refused, red CI too often, waiting) can leave
 * the pull request open. An older wait behind a settled one is never it.
 */
export function openPullRequestWait(cardId: string): Wait | undefined {
  const newest = db
    .select()
    .from(prWaits)
    .where(eq(prWaits.cardId, cardId))
    .orderBy(desc(prWaits.createdAt))
    .limit(1)
    .get();
  return newest && !SETTLED.includes(newest.status) ? newest : undefined;
}

/**
 * Abandon, Reset and Delete (spec 33): close the card's pull request and
 * delete its branch, so nobody merges on Gitea work Radulf has stopped
 * watching. Gitea is asked first, so a pull request someone already merged
 * or closed there is left as it is. The wait is marked `abandoned` either
 * way. A Gitea failure is recorded as `review.pr_close_failed` and does not
 * stop the action. The caller claims the card first, so the poller cannot
 * start a merge meanwhile.
 */
export async function closeOpenPullRequest(cardId: string): Promise<void> {
  const wait = openPullRequestWait(cardId);
  if (!wait) return;
  let token = "";
  let error: string | null = null;
  try {
    const auth = connectionAuth(wait.connectionId);
    token = auth.token;
    const pull = await getPull(auth, wait.owner, wait.repo, wait.prNumber);
    if (pull.state === "open") {
      await closePull(auth, wait.owner, wait.repo, wait.prNumber);
      await deleteBranch(auth, wait.owner, wait.repo, wait.branch);
    }
  } catch (e) {
    error = scrubSecret(errorMessage(e), token);
    emitEvent("review.pr_close_failed", {
      cardId,
      runId: wait.runId,
      payload: { delivery: "gitea", prUrl: wait.prUrl, error },
    });
  }
  db.update(prWaits)
    .set({ status: "abandoned", detail: error ?? wait.detail, endedAt: wait.endedAt ?? now() })
    .where(and(eq(prWaits.id, wait.id), notInArray(prWaits.status, SETTLED)))
    .run();
}
