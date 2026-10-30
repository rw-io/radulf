import { afterEach, describe, expect, it, vi } from "vitest";
import { GiteaError, createPull, findOpenPull, getPull, giteaRequest } from "./gitea";

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
