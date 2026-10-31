import { hasRemote } from "@/server/git";
import { getRepo } from "@/server/repos";
import { githubStatus } from "@/server/github";
import { matchRepo } from "@/server/forgeMatch";
import { checkConnection } from "@/server/forgeConnections";
import { errorMessage } from "@/shared/errorMessage";
import { json, handle } from "../../_lib";

/**
 * Spec 15: can this workspace (and optionally this repo) deliver a pull
 * request right now? The two `gh` failures are reported separately because the
 * operator's next action differs — install a tool, or run a login — and
 * `hasRemote` is per repo because most registered repos are local-only.
 *
 * Read-only, and deliberately so: nothing here can push, open a PR, or change
 * a setting. It exists to gate a checkbox honestly rather than let an operator
 * discover at approval time that delivery was never possible.
 */
export async function GET(req: Request) {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const repoId = params.get("repoId");
    // `refresh=1` bypasses the 30s cache: the operator fixes auth in a terminal
    // and comes straight back, and being told "still logged out" for another
    // half a minute would make the indicator look broken.
    // Spec 33: a repo whose origin belongs to a saved Gitea/Forgejo connection
    // delivers through that connection, so gh's state is beside the point.
    // A lookup that cannot say whether it does is a forge problem too.
    const repo = repoId ? getRepo(repoId) : undefined;
    let matched: Awaited<ReturnType<typeof matchRepo>> = null;
    try {
      matched = repo ? await matchRepo(repo.path) : null;
    } catch (e) {
      return json({ ok: false, account: null, reason: "forge", detail: errorMessage(e), hasRemote: true, forge: "gitea" });
    }
    if (repo && matched) {
      const connection = await checkConnection(matched.connection.id, { refresh: params.get("refresh") === "1" });
      const ok = connection.checkError === null;
      return json({
        ok,
        account: connection.account,
        reason: ok ? null : "forge",
        detail: ok ? null : `${new URL(connection.baseUrl).host}: ${connection.checkError}`,
        hasRemote: true,
        forge: "gitea",
      });
    }
    const gh = await githubStatus({ refresh: params.get("refresh") === "1" });
    let remote: boolean | null = null;
    if (repoId) {
      remote = repo ? await hasRemote(repo.path) : false;
    }
    return json({
      ok: gh.ok,
      account: gh.ok ? gh.account ?? null : null,
      reason: gh.ok ? null : gh.reason,
      detail: gh.ok ? null : gh.detail,
      hasRemote: remote,
      forge: "github",
    });
  });
}
