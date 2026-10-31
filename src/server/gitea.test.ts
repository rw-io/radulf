import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GiteaError,
  closePull,
  createPull,
  deleteBranch,
  failedJobLogs,
  findOpenPull,
  getCombinedStatus,
  getPull,
  giteaRequest,
  mergePull,
} from "./gitea";

afterEach(() => vi.unstubAllGlobals());

describe("giteaRequest", () => {
  it("builds the api url under a sub-path", async () => {
    const fetchMock = vi.fn(async () => new Response('{"login":"a"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await giteaRequest({ baseUrl: "https://host/gitea", token: "t" }, "GET", "/user");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://host/gitea/api/v1/user");
    expect((init.headers as Record<string, string>).Authorization).toBe("token t");
  });

  it("surfaces the server message", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"message":"not found"}', { status: 404 }));
    const err = (await giteaRequest({ baseUrl: "https://h", token: "t" }, "GET", "/x").catch((e: unknown) => e)) as GiteaError;
    expect(err).toBeInstanceOf(GiteaError);
    expect(err.status).toBe(404);
    expect(err.message).toContain("not found");
  });

  it("maps a network failure to status null", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const err = (await giteaRequest({ baseUrl: "https://h", token: "t" }, "GET", "/x").catch((e: unknown) => e)) as GiteaError;
    expect(err).toBeInstanceOf(GiteaError);
    expect(err.status).toBeNull();
  });

  it("returns undefined on 204", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    expect(await giteaRequest({ baseUrl: "https://h", token: "t" }, "DELETE", "/x")).toBeUndefined();
  });
});

describe("pull requests", () => {
  function pull(number: number, head: string, base = "main") {
    return {
      number,
      html_url: `https://h/o/r/pulls/${number}`,
      state: "open",
      merged: false,
      mergeable: true,
      head: { ref: head, sha: `sha-${number}` },
      base: { ref: base },
      merge_commit_sha: null,
    };
  }

  it("findOpenPull pages until it finds the branch", async () => {
    const first = Array.from({ length: 50 }, (_, i) => pull(i + 1, `other/${i}`));
    const second = [pull(51, "ralph/fix-x-1", "dev"), pull(52, "ralph/fix-x-1")];
    const fetchMock = vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.endsWith("page=1") ? first : second), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const found = await findOpenPull({ baseUrl: "https://h", token: "t" }, "o", "r", "ralph/fix-x-1", "main");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://h/api/v1/repos/o/r/pulls?state=open&limit=50&page=1",
      "https://h/api/v1/repos/o/r/pulls?state=open&limit=50&page=2",
    ]);
    expect(found).toEqual({
      number: 52,
      url: "https://h/o/r/pulls/52",
      state: "open",
      merged: false,
      mergeable: true,
      headSha: "sha-52",
      mergeCommitSha: null,
    });
  });

  it("createPull posts the branch pair and maps the reply", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(pull(9, "ralph/fix-x-1")), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { head: "ralph/fix-x-1", base: "main", title: "Fix x", body: "Body" };

    const created = await createPull({ baseUrl: "https://h/gitea", token: "t" }, "o", "r", input);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://h/gitea/api/v1/repos/o/r/pulls");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(input);
    expect(created).toMatchObject({ number: 9, url: "https://h/o/r/pulls/9", headSha: "sha-9" });
  });

  it("getPull reads one pull request by number", async () => {
    const merged = { ...pull(4, "ralph/fix-x-1"), state: "closed", merged: true, merge_commit_sha: "m1" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(merged), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const got = await getPull({ baseUrl: "https://h", token: "t" }, "o", "r", 4);

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://h/api/v1/repos/o/r/pulls/4");
    expect(got).toMatchObject({ number: 4, state: "closed", merged: true, mergeCommitSha: "m1" });
  });
});

describe("ci wait and merge", () => {
  const auth = { baseUrl: "https://h", token: "t" };

  it("deleteBranch keeps slashes as separators", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteBranch(auth, "o", "r", "ralph/fix x-1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://h/api/v1/repos/o/r/branches/ralph/fix%20x-1");
    expect(init.method).toBe("DELETE");
  });

  it("closePull patches the state to closed", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await closePull(auth, "o", "r", 7);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://h/api/v1/repos/o/r/pulls/7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ state: "closed" });
  });

  it("getCombinedStatus maps an empty status to null", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ state: "", total_count: 0, statuses: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const status = await getCombinedStatus(auth, "o", "r", "sha-1");

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://h/api/v1/repos/o/r/commits/sha-1/status");
    expect(status).toEqual({ state: null, statuses: [] });
  });

  it("getCombinedStatus maps each status and keeps an unknown state waiting", async () => {
    const statuses = [
      { context: "ci/build", status: "failure", target_url: "https://ci/1" },
      { context: "ci/lint", status: "warning", target_url: "" },
    ];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ state: "failure", total_count: 2, statuses }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ state: "warning", total_count: 2, statuses }), { status: 200 })),
    );

    expect(await getCombinedStatus(auth, "o", "r", "sha-1")).toEqual({
      state: "failure",
      statuses: [
        { context: "ci/build", state: "failure", targetUrl: "https://ci/1" },
        { context: "ci/lint", state: "warning", targetUrl: null },
      ],
    });
    // Gitea ranks a warning below pending, so a combined warning can hide a
    // job that is still running: it waits rather than merges.
    expect((await getCombinedStatus(auth, "o", "r", "sha-1")).state).toBe("pending");
  });

  it("mergePull maps 405 to notMergeable", async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":"Please try again later"}', { status: 405 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mergePull(auth, "o", "r", 7, 'ralph: merge "Fix x" (card c1)', "head-1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://h/api/v1/repos/o/r/pulls/7/merge");
    expect(init.method).toBe("POST");
    expect(result).toEqual({ ok: false, notMergeable: true, message: "Please try again later" });
  });

  it("mergePull pins the merge to the head CI verified", async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":"head out of date"}', { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mergePull(auth, "o", "r", 7, 'ralph: merge "Fix x" (card c1)', "head-1");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      Do: "merge",
      MergeTitleField: 'ralph: merge "Fix x" (card c1)',
      delete_branch_after_merge: true,
      head_commit_id: "head-1",
    });
    // The branch moved under the merge: a refusal like any other, not a
    // base to re-sync with.
    expect(result).toEqual({ ok: false, notMergeable: false, message: "head out of date" });
  });

  it("mergePull still treats any other 409 as not mergeable", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"message":"merge push out of date"}', { status: 409 }));

    expect(await mergePull(auth, "o", "r", 7, "t", "head-1")).toEqual({
      ok: false,
      notMergeable: true,
      message: "merge push out of date",
    });
  });

  it("mergePull reports any other refusal and rethrows an unreachable gitea", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 200 }))
        .mockResolvedValueOnce(new Response('{"message":"not enough approvals"}', { status: 403 }))
        .mockResolvedValueOnce(new Response("bad gateway", { status: 502 })),
    );

    expect(await mergePull(auth, "o", "r", 7, "t", "head-1")).toEqual({ ok: true });
    expect(await mergePull(auth, "o", "r", 7, "t", "head-1")).toEqual({
      ok: false,
      notMergeable: false,
      message: "not enough approvals",
    });
    const err = (await mergePull(auth, "o", "r", 7, "t", "head-1").catch((e: unknown) => e)) as GiteaError;
    expect(err).toBeInstanceOf(GiteaError);
    expect(err.status).toBe(502);
  });
});

describe("failed job logs", () => {
  const auth = { baseUrl: "https://h", token: "t" };
  const lines = (n: number, width = 0) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`.padEnd(width, "x"));

  /** Answers each Actions path from `routes`, and 404 for anything else. */
  function stubRoutes(routes: Record<string, () => Response>) {
    const fetchMock = vi.fn(async (url: string) => {
      const route = routes[url.replace("https://h/api/v1/repos/o/r", "")];
      return route ? route() : new Response('{"message":"not found"}', { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

  it("failedJobLogs keeps only the failed jobs of the head commit", async () => {
    const fetchMock = stubRoutes({
      "/actions/runs?limit=20": json({
        workflow_runs: [
          { id: 1, head_sha: "head-1" },
          { id: 2, head_sha: "other" },
          // Its job list cannot be read: no jobs from it, and no error.
          { id: 3, head_sha: "head-1" },
        ],
      }),
      "/actions/runs/1/jobs": json({
        jobs: [
          { id: 11, name: "build", conclusion: "failure", html_url: "https://h/o/r/actions/runs/1/jobs/0" },
          { id: 12, name: "lint", conclusion: "success", html_url: "https://h/o/r/actions/runs/1/jobs/1" },
          { id: 13, name: "test", conclusion: "failure", html_url: "" },
        ],
      }),
      "/actions/runs/2/jobs": json({
        jobs: [{ id: 21, name: "build", conclusion: "failure", html_url: "https://h/o/r/actions/runs/2/jobs/0" }],
      }),
      "/actions/jobs/11/logs": () => new Response(`${lines(100).join("\n")}\n`, { status: 200 }),
      "/actions/jobs/13/logs": () => new Response("bad gateway", { status: 502 }),
    });

    const jobs = await failedJobLogs(auth, "o", "r", "head-1");

    expect(jobs).toEqual([
      { name: "build", url: "https://h/o/r/actions/runs/1/jobs/0", logTail: lines(100).slice(-60).join("\n") },
      { name: "test", url: null, logTail: "" },
    ]);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).not.toContain("https://h/api/v1/repos/o/r/actions/runs/2/jobs");
    expect(urls).not.toContain("https://h/api/v1/repos/o/r/actions/jobs/12/logs");
  });

  it("failedJobLogs caps a tail at 4000 characters and gives nothing when the run list fails", async () => {
    const long = lines(60, 100);
    stubRoutes({
      "/actions/runs?limit=20": json({ workflow_runs: [{ id: 1, head_sha: "head-1" }] }),
      "/actions/runs/1/jobs": json({ jobs: [{ id: 11, name: "build", conclusion: "failure", html_url: null }] }),
      "/actions/jobs/11/logs": () => new Response(long.join("\n"), { status: 200 }),
    });

    const [job] = await failedJobLogs(auth, "o", "r", "head-1");

    expect(job.logTail).toHaveLength(4000);
    expect(job.logTail.endsWith(long.at(-1)!)).toBe(true);

    stubRoutes({ "/actions/runs?limit=20": () => new Response("bad gateway", { status: 502 }) });
    expect(await failedJobLogs(auth, "o", "r", "head-1")).toEqual([]);
  });
});
