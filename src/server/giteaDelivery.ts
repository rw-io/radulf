/**
 * Spec 33 decision 5: deliver an approved card on a Gitea or Forgejo
 * repository as a pull request there. This module takes the delivery as far
 * as an open pull request and a durable `pr_waits` row, and parks the card in
 * `awaiting_ci`. The card then holds no repo lease: `executeDelivery` releases
 * it once `deliver` returns, so one slow CI run does not block every other
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
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, now, prWaits, type cards, type repos, type runs } from "@/db";
import { errorMessage } from "@/shared/errorMessage";
import { ClientError } from "./clientError";
import { emitEvent } from "./events";
import { checkConnection, connectionAuth, invalidateConnectionCheck, scrubSecret } from "./forgeConnections";
import type { ForgeRepoRef } from "./forgeMatch";
import { createPull, findOpenPull, type GiteaAuth, type GiteaPull } from "./gitea";
import { fetchBranchHead, git, mergeBaseIntoWorktree, pushRef, stripRalphForDelivery } from "./git";
import { forgeTarget } from "./remoteTarget";
import type { ApprovedBy, ReviewServiceDependencies } from "./reviewService";

type Card = typeof cards.$inferSelect;
type Run = typeof runs.$inferSelect;
type Repo = typeof repos.$inferSelect;

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
    const waitId = nanoid();
    db.insert(prWaits)
      .values({
        id: waitId,
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
      db.delete(prWaits).where(eq(prWaits.id, waitId)).run();
      throw new ClientError("review claim was lost before the card could wait for CI");
    }
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
}
