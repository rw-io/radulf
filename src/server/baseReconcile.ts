/**
 * Spec 33 decision 4: bring a repository's local base branch level with its
 * remote before Radulf merges an approved card into it, and push it after.
 *
 * Host-side only, from the review path, under the repo lease the delivery
 * already holds (the same rule as `mergeBranch`). Nothing here forces, resets
 * or rewrites: the local base only ever moves forward, by a fast-forward or by
 * a merge commit that keeps both tips as parents, and the push is a plain one
 * the remote rejects when it moved, which sends it through the reconcile once
 * more. Every ref move is reported through `onRefWrite`, so open runs on the
 * repository see Radulf's own write rather than tampering (spec 20).
 */
import { errorMessage } from "@/shared/errorMessage";
import { scrubSecret } from "./forgeConnections";
import { fastForwardBranch, fetchBranchHead, mergeBranch, pushRef, tryGit, type RemoteTarget } from "./git";

export type ReconcileResult = { ok: true; remoteSha: string } | { ok: false; error: string };

type Failure = { ok: false; error: string };

/** `step`'s result, or what it threw as a failure scrubbed of the token: a
 * throw (a malformed forge URL, a local git call failing) has to park the card
 * like any other failure, not escape the delivery. */
async function settle<T>(target: RemoteTarget, step: () => Promise<T>): Promise<T | Failure> {
  try {
    return await step();
  } catch (e) {
    return { ok: false, error: scrubSecret(errorMessage(e), target.kind === "forge" ? target.token : "") };
  }
}

async function isAncestor(repoPath: string, commit: string, of: string): Promise<boolean> {
  return (await tryGit(repoPath, "merge-base", "--is-ancestor", commit, of)).ok;
}

/**
 * Fetch the remote's `baseBranch` and fold it into the local one: nothing to
 * do when the local base already contains it, a fast-forward when the local
 * base is behind, and a merge commit when both moved. A conflict leaves the
 * local base exactly where it was.
 */
export function reconcileBase(
  repoPath: string,
  baseBranch: string,
  target: RemoteTarget,
  onRefWrite: (sha: string) => void,
): Promise<ReconcileResult> {
  return settle(target, async (): Promise<ReconcileResult> => {
    const fetched = await fetchBranchHead(repoPath, target, baseBranch);
    if (!fetched.ok) {
      return {
        ok: false,
        error: fetched.missing
          ? `\`${baseBranch}\` does not exist on the remote; it may have been renamed or deleted there`
          : `cannot fetch \`${baseBranch}\` from the remote: ${fetched.error}`,
      };
    }
    const remoteSha = fetched.sha;
    const local = `refs/heads/${baseBranch}`;
    if (await isAncestor(repoPath, remoteSha, local)) return { ok: true, remoteSha };
    if (await isAncestor(repoPath, local, remoteSha)) {
      const forwarded = await fastForwardBranch(repoPath, baseBranch, remoteSha);
      if (!forwarded.ok) return { ok: false, error: forwarded.error! };
      onRefWrite(remoteSha);
      return { ok: true, remoteSha };
    }
    const merged = await mergeBranch(
      repoPath,
      baseBranch,
      remoteSha,
      `ralph: merge remote ${baseBranch} into ${baseBranch}`,
      onRefWrite,
    );
    if (merged.ok) return { ok: true, remoteSha };
    return {
      ok: false,
      error: merged.conflict
        ? `local \`${baseBranch}\` and the remote's have diverged and conflict: ${merged.out}`
        : merged.error!,
    };
  });
}

/**
 * Push the local base branch to the same branch on the remote. A rejection
 * means the remote moved since the reconcile, so it reconciles once more and
 * pushes once more; any other failure, or a second rejection, is returned.
 */
export function pushBase(
  repoPath: string,
  baseBranch: string,
  target: RemoteTarget,
  onRefWrite: (sha: string) => void,
): Promise<{ ok: true } | Failure> {
  const refspec = `refs/heads/${baseBranch}:refs/heads/${baseBranch}`;
  return settle(target, async (): Promise<{ ok: true } | Failure> => {
    let pushed = await pushRef(repoPath, target, refspec);
    if (!pushed.ok && pushed.rejected) {
      const reconciled = await reconcileBase(repoPath, baseBranch, target, onRefWrite);
      if (!reconciled.ok) return reconciled;
      pushed = await pushRef(repoPath, target, refspec);
    }
    return pushed.ok ? { ok: true } : { ok: false, error: pushed.error };
  });
}
