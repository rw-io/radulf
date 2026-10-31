/**
 * Decide which Gitea/Forgejo connection a repository's `origin` belongs to
 * (spec 33). A remote on the connection's own host matches directly; an SSH
 * remote on a different host (an SSH-only hostname in front of the same
 * instance) is matched by asking the instance for the repository's ssh url.
 *
 * Only a definite answer is cached: a match, or every connection saying no.
 * A lookup that throws (Gitea down, a revoked token) says nothing, so it falls
 * back to the last match this remote had, and with none it throws rather than
 * report "no match" and send a Gitea repository down another delivery path.
 */
import { errorMessage } from "@/shared/errorMessage";
import { connectionAuth, listConnections, scrubSecret, type ForgeConnection } from "./forgeConnections";
import { getRepository } from "./gitea";
import { tryGit } from "./git";

export type ParsedRemote = { host: string; owner: string; repo: string; ssh: boolean };

export type ForgeRepoRef = {
  connection: ForgeConnection;
  owner: string;
  repo: string;
  cloneUrl: string;
};

function fromPath(host: string, path: string, ssh: boolean): ParsedRemote | null {
  const parts = path.replace(/\.git$/, "").split("/").filter(Boolean);
  if (!host || parts.length < 2) return null;
  return { host: host.toLowerCase(), owner: parts[parts.length - 2], repo: parts[parts.length - 1], ssh };
}

export function parseRemote(url: string): ParsedRemote | null {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:"].includes(u.protocol)) return null;
    return fromPath(u.host, decodeURIComponent(u.pathname), u.protocol === "ssh:");
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  return scp ? fromPath(scp[1], scp[2], true) : null;
}

const cache = new Map<string, ForgeRepoRef | null>();
/** The last match each remote url resolved to, kept across connection
 * changes: what a lookup that throws falls back to. */
const lastMatch = new Map<string, ForgeRepoRef>();

/** A match, or null; `failed` maps each connection whose lookup threw to why. */
async function resolve(
  parsed: ParsedRemote,
  connections: ForgeConnection[],
): Promise<{ ref: ForgeRepoRef | null; failed: Map<string, string> }> {
  const failed = new Map<string, string>();
  for (const connection of connections) {
    const base = connection.baseUrl;
    const host = new URL(base).host;
    if (parsed.host === host.toLowerCase()) {
      return {
        ref: { connection, owner: parsed.owner, repo: parsed.repo, cloneUrl: `${base}/${parsed.owner}/${parsed.repo}.git` },
        failed,
      };
    }
    if (!parsed.ssh) continue;
    let token = "";
    try {
      const auth = connectionAuth(connection.id);
      token = auth.token;
      const found = await getRepository(auth, parsed.owner, parsed.repo);
      const theirs = found && parseRemote(found.sshUrl);
      if (found && theirs && theirs.host === parsed.host && theirs.owner === parsed.owner && theirs.repo === parsed.repo) {
        return { ref: { connection, owner: parsed.owner, repo: parsed.repo, cloneUrl: found.cloneUrl }, failed };
      }
    } catch (e) {
      const why = scrubSecret(errorMessage(e), token);
      failed.set(connection.id, `could not look up ${parsed.owner}/${parsed.repo} on ${host}: ${why}`);
    }
  }
  return { ref: null, failed };
}

/** Throws when a connection's lookup failed and nothing settles the answer:
 * the message names the host and the failure, scrubbed of the token. */
export async function matchRemoteUrl(url: string): Promise<ForgeRepoRef | null> {
  const parsed = parseRemote(url);
  if (!parsed) return null;
  const connections = listConnections();
  const fingerprint = connections.map((c) => `${c.id}:${c.updatedAt}`).join(",");
  const key = `${url}|${fingerprint}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const { ref, failed } = await resolve(parsed, connections);
  if (ref || failed.size === 0) {
    cache.set(key, ref);
    if (ref) lastMatch.set(url, ref);
    else lastMatch.delete(url);
    return ref;
  }
  // Only a connection that could not answer may still be the match.
  const last = lastMatch.get(url);
  const connection = last && failed.has(last.connection.id) && connections.find((c) => c.id === last.connection.id);
  if (last && connection) return { ...last, connection };
  throw new Error(`cannot match the repository to a connection: ${[...failed.values()].join("; ")}`);
}

export async function matchRepo(repoPath: string): Promise<ForgeRepoRef | null> {
  const origin = await tryGit(repoPath, "remote", "get-url", "origin");
  if (!origin.ok || !origin.out) return null;
  return matchRemoteUrl(origin.out);
}
