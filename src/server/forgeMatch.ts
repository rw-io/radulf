/**
 * Decide which Gitea/Forgejo connection a repository's `origin` belongs to
 * (spec 33). A remote on the connection's own host matches directly; an SSH
 * remote on a different host (an SSH-only hostname in front of the same
 * instance) is matched by asking the instance for the repository's ssh url.
 */
import { connectionAuth, listConnections, type ForgeConnection } from "./forgeConnections";
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

async function resolve(parsed: ParsedRemote): Promise<ForgeRepoRef | null> {
  for (const connection of listConnections()) {
    const base = connection.baseUrl;
    if (parsed.host === new URL(base).host.toLowerCase()) {
      return {
        connection,
        owner: parsed.owner,
        repo: parsed.repo,
        cloneUrl: `${base}/${parsed.owner}/${parsed.repo}.git`,
      };
    }
    if (!parsed.ssh) continue;
    try {
      const found = await getRepository(connectionAuth(connection.id), parsed.owner, parsed.repo);
      const theirs = found && parseRemote(found.sshUrl);
      if (found && theirs && theirs.host === parsed.host && theirs.owner === parsed.owner && theirs.repo === parsed.repo) {
        return { connection, owner: parsed.owner, repo: parsed.repo, cloneUrl: found.cloneUrl };
      }
    } catch {
      // a lookup failure means this connection is not a match
    }
  }
  return null;
}

export async function matchRemoteUrl(url: string): Promise<ForgeRepoRef | null> {
  const parsed = parseRemote(url);
  if (!parsed) return null;
  const fingerprint = listConnections()
    .map((c) => `${c.id}:${c.updatedAt}`)
    .join(",");
  const key = `${url}|${fingerprint}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const ref = await resolve(parsed);
  cache.set(key, ref);
  return ref;
}

export async function matchRepo(repoPath: string): Promise<ForgeRepoRef | null> {
  const origin = await tryGit(repoPath, "remote", "get-url", "origin");
  if (!origin.ok || !origin.out) return null;
  return matchRemoteUrl(origin.out);
}
