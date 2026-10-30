/**
 * Minimal Gitea/Forgejo REST client (spec 33). Both forges share the `/api/v1`
 * surface, so one helper serves either kind.
 */
import { errorMessage } from "@/shared/errorMessage";

export type GiteaAuth = { baseUrl: string; token: string };

const TIMEOUT_MS = 10_000;

/** `status` is null when the request never got a response (network failure). */
export class GiteaError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "GiteaError";
  }
}

export async function giteaRequest<T>(
  auth: GiteaAuth,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `token ${auth.token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${auth.baseUrl}/api/v1${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    throw new GiteaError(`cannot reach ${auth.baseUrl}: ${errorMessage(e)}`, null);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
    } catch {
      // not JSON: keep the raw text
    }
    throw new GiteaError(message || `HTTP ${res.status}`, res.status);
  }
  if (res.status === 204 || text === "") return undefined as T;
  return JSON.parse(text) as T;
}

export function getAuthenticatedUser(auth: GiteaAuth): Promise<{ login: string }> {
  return giteaRequest<{ login: string }>(auth, "GET", "/user");
}

export type GiteaRepository = { sshUrl: string; cloneUrl: string; htmlUrl: string };

/** Returns null when the repository does not exist or the token cannot see it. */
export async function getRepository(
  auth: GiteaAuth,
  owner: string,
  repo: string,
): Promise<GiteaRepository | null> {
  try {
    const r = await giteaRequest<{ ssh_url: string; clone_url: string; html_url: string }>(
      auth,
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
    return { sshUrl: r.ssh_url, cloneUrl: r.clone_url, htmlUrl: r.html_url };
  } catch (e) {
    if (e instanceof GiteaError && e.status === 404) return null;
    throw e;
  }
}

export type GiteaPull = {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean;
  headSha: string;
  mergeCommitSha: string | null;
};

type PullJson = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  merge_commit_sha: string | null;
};

function toPull(p: PullJson): GiteaPull {
  return {
    number: p.number,
    url: p.html_url,
    state: p.state,
    merged: p.merged,
    mergeable: p.mergeable,
    headSha: p.head.sha,
    mergeCommitSha: p.merge_commit_sha ?? null,
  };
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function pullsPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
}

const PULLS_PAGE = 50;

/** The open pull request from branch `head` into `base`, or null. */
export async function findOpenPull(
  auth: GiteaAuth,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<GiteaPull | null> {
  for (let page = 1; ; page++) {
    const pulls = await giteaRequest<PullJson[]>(
      auth,
      "GET",
      `${pullsPath(owner, repo)}?state=open&limit=${PULLS_PAGE}&page=${page}`,
    );
    const match = pulls.find((p) => p.head.ref === head && p.base.ref === base);
    if (match) return toPull(match);
    if (pulls.length < PULLS_PAGE) return null;
  }
}

export async function createPull(
  auth: GiteaAuth,
  owner: string,
  repo: string,
  input: { head: string; base: string; title: string; body: string },
): Promise<GiteaPull> {
  return toPull(await giteaRequest<PullJson>(auth, "POST", pullsPath(owner, repo), input));
}

export async function getPull(auth: GiteaAuth, owner: string, repo: string, index: number): Promise<GiteaPull> {
  return toPull(await giteaRequest<PullJson>(auth, "GET", `${pullsPath(owner, repo)}/${index}`));
}

export type GiteaCombinedStatus = {
  /** null while the commit has no status at all. */
  state: "pending" | "success" | "failure" | "error" | null;
  statuses: Array<{ context: string; state: string; targetUrl: string | null }>;
};

const COMBINED_STATES = ["pending", "success", "failure", "error"] as const;

/** The combined commit status of `sha`. Any other state Gitea reports (a
 * `warning`, which it ranks below `pending`, so one can hide a job still
 * running) reads as `pending`: never a reason to merge. */
export async function getCombinedStatus(
  auth: GiteaAuth,
  owner: string,
  repo: string,
  sha: string,
): Promise<GiteaCombinedStatus> {
  const r = await giteaRequest<{
    state: string;
    total_count: number;
    statuses: Array<{ context: string; status: string; target_url: string | null }> | null;
  }>(auth, "GET", `${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/status`);
  const state = COMBINED_STATES.find((s) => s === r.state) ?? "pending";
  return {
    state: r.total_count === 0 ? null : state,
    statuses: (r.statuses ?? []).map((s) => ({ context: s.context, state: s.status, targetUrl: s.target_url || null })),
  };
}

/**
 * Merge pull request `index` with a merge commit titled `title`, deleting its
 * branch afterwards. A refusal comes back as a result: 405 and 409 are the
 * pull request not being mergeable as it stands (the base moved, Gitea still
 * checking it, or a rule such as required approvals). A Gitea that did not
 * answer (no response, or a 5xx) throws, since the merge may or may not have
 * landed.
 */
export async function mergePull(
  auth: GiteaAuth,
  owner: string,
  repo: string,
  index: number,
  title: string,
): Promise<{ ok: true } | { ok: false; notMergeable: boolean; message: string }> {
  try {
    await giteaRequest(auth, "POST", `${pullsPath(owner, repo)}/${index}/merge`, {
      Do: "merge",
      MergeTitleField: title,
      delete_branch_after_merge: true,
    });
    return { ok: true };
  } catch (e) {
    if (!(e instanceof GiteaError) || e.status === null || e.status >= 500) throw e;
    return { ok: false, notMergeable: e.status === 405 || e.status === 409, message: e.message };
  }
}

export async function closePull(auth: GiteaAuth, owner: string, repo: string, index: number): Promise<void> {
  await giteaRequest(auth, "PATCH", `${pullsPath(owner, repo)}/${index}`, { state: "closed" });
}

/** Each `/`-separated segment of `branch` is encoded on its own, so a
 * `ralph/...` branch keeps its slashes as path separators. */
export async function deleteBranch(auth: GiteaAuth, owner: string, repo: string, branch: string): Promise<void> {
  const segments = branch.split("/").map(encodeURIComponent).join("/");
  await giteaRequest(auth, "DELETE", `${repoPath(owner, repo)}/branches/${segments}`);
}
