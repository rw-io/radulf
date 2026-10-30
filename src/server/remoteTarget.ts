/**
 * Pick where a repository's remote git operations go (spec 33): a repository
 * whose `origin` matches a Gitea/Forgejo connection talks to the forge's
 * HTTPS URL with the connection's token; any other keeps using `origin` with
 * the operator's host credentials, exactly as before.
 */
import { connectionAuth } from "./forgeConnections";
import { matchRepo, type ForgeRepoRef } from "./forgeMatch";
import type { RemoteTarget } from "./git";

export function forgeTarget(ref: ForgeRepoRef): Extract<RemoteTarget, { kind: "forge" }> {
  return {
    kind: "forge",
    url: ref.cloneUrl,
    username: ref.connection.account ?? "radulf",
    token: connectionAuth(ref.connection.id).token,
  };
}

export async function resolveRemoteTarget(
  repoPath: string,
): Promise<{ target: RemoteTarget; forge: ForgeRepoRef | null }> {
  const forge = await matchRepo(repoPath);
  return { target: forge ? forgeTarget(forge) : { kind: "origin" }, forge };
}
