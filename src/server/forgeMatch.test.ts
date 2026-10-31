import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-forgeMatch-");

const { db, forgeConnections } = await import("@/db");
const fc = await import("./forgeConnections");
const fm = await import("./forgeMatch");

function stubFetch(handler: (url: string) => Response) {
  const m = vi.fn(async (url: string) => handler(url));
  vi.stubGlobal("fetch", m);
  return m;
}
const user = () => new Response(JSON.stringify({ login: "bot" }));

async function connect(baseUrl: string) {
  stubFetch(user);
  await fc.saveConnection({ kind: "gitea", baseUrl, token: "t" });
}

beforeEach(() => {
  db.delete(forgeConnections).run();
});
afterEach(() => vi.unstubAllGlobals());

describe("parseRemote", () => {
  it("parses the operator's ssh remote", () => {
    expect(fm.parseRemote("git@ssh.gitea.chilleh.ca:homelab/argo.git")).toEqual({
      host: "ssh.gitea.chilleh.ca",
      owner: "homelab",
      repo: "argo",
      ssh: true,
    });
  });

  it("parses https with a sub-path", () => {
    expect(fm.parseRemote("https://host/gitea/o/r.git")).toEqual({
      host: "host",
      owner: "o",
      repo: "r",
      ssh: false,
    });
  });

  it("parses ssh:// with a port", () => {
    expect(fm.parseRemote("ssh://git@host:2222/o/r.git")?.host).toBe("host:2222");
  });
});

describe("matchRemoteUrl", () => {
  it("matches on the same host without an api call", async () => {
    await connect("https://gitea.example");
    const m = stubFetch(user);
    const ref = await fm.matchRemoteUrl("https://gitea.example/o/r.git");
    expect(m).not.toHaveBeenCalled();
    expect(ref?.cloneUrl).toBe("https://gitea.example/o/r.git");
  });

  it("keeps the sub-path in the clone url", async () => {
    await connect("https://host/gitea");
    const ref = await fm.matchRemoteUrl("https://host/o/r");
    expect(ref?.cloneUrl).toBe("https://host/gitea/o/r.git");
  });

  it("matches an ssh remote on another host through the api", async () => {
    await connect("https://gitea.chilleh.ca");
    const m = stubFetch(() =>
      new Response(
        JSON.stringify({
          ssh_url: "git@ssh.gitea.chilleh.ca:homelab/argo.git",
          clone_url: "https://gitea.chilleh.ca/homelab/argo.git",
          html_url: "https://gitea.chilleh.ca/homelab/argo",
        }),
      ),
    );
    const ref = await fm.matchRemoteUrl("git@ssh.gitea.chilleh.ca:homelab/argo.git");
    expect((m.mock.calls[0] as unknown as [string])[0]).toBe("https://gitea.chilleh.ca/api/v1/repos/homelab/argo");
    expect(ref?.cloneUrl).toBe("https://gitea.chilleh.ca/homelab/argo.git");
  });

  it("unrelated host matches nothing", async () => {
    await connect("https://gitea.example");
    stubFetch(() => new Response(JSON.stringify({ message: "not found" }), { status: 404 }));
    expect(await fm.matchRemoteUrl("git@other.example:o/r.git")).toBeNull();
  });

  const ARGO = {
    ssh_url: "git@ssh.gitea.chilleh.ca:homelab/argo.git",
    clone_url: "https://gitea.chilleh.ca/homelab/argo.git",
    html_url: "https://gitea.chilleh.ca/homelab/argo",
  };
  const SSH_REMOTE = "git@ssh.gitea.chilleh.ca:homelab/argo.git";

  it("a lookup that throws is not cached, and the next call matches once the api answers", async () => {
    stubFetch(user);
    await fc.saveConnection({ kind: "gitea", baseUrl: "https://gitea.chilleh.ca", token: "tok-abc" });
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const failure = await fm.matchRemoteUrl(SSH_REMOTE).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("gitea.chilleh.ca");
    expect((failure as Error).message).toContain("fetch failed");
    stubFetch(() => new Response(JSON.stringify(ARGO)));
    expect((await fm.matchRemoteUrl(SSH_REMOTE))?.cloneUrl).toBe(ARGO.clone_url);
  });

  it("a revoked token is a failed lookup, never a no, and the error carries no token", async () => {
    stubFetch(user);
    await fc.saveConnection({ kind: "gitea", baseUrl: "https://gitea.chilleh.ca", token: "s3cret-tok" });
    stubFetch(() => new Response(JSON.stringify({ message: "token s3cret-tok is revoked" }), { status: 401 }));

    const failure = await fm.matchRemoteUrl(SSH_REMOTE).catch((e: unknown) => e);

    expect((failure as Error).message).toContain("gitea.chilleh.ca");
    expect((failure as Error).message).toContain("is revoked");
    expect((failure as Error).message).not.toContain("s3cret-tok");
  });

  it("the last positive match survives a later failed lookup", async () => {
    await connect("https://gitea.chilleh.ca");
    stubFetch(() => new Response(JSON.stringify(ARGO)));
    const first = await fm.matchRemoteUrl(SSH_REMOTE);
    expect(first?.cloneUrl).toBe(ARGO.clone_url);
    // A second connection changes the cache key, so the next call looks again.
    stubFetch(user);
    await fc.saveConnection({ kind: "gitea", baseUrl: "https://second.example", token: "t" });
    stubFetch((url) => {
      if (url.startsWith("https://gitea.chilleh.ca/")) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    });

    const again = await fm.matchRemoteUrl(SSH_REMOTE);

    expect(again?.cloneUrl).toBe(ARGO.clone_url);
    expect(again?.connection.id).toBe(first?.connection.id);
  });

  it("caches until connections change", async () => {
    await connect("https://gitea.example");
    const m = stubFetch(() => new Response(JSON.stringify({ message: "nope" }), { status: 404 }));
    await fm.matchRemoteUrl("git@other.example:o/r.git");
    await fm.matchRemoteUrl("git@other.example:o/r.git");
    expect(m).toHaveBeenCalledTimes(1);
    const m2 = stubFetch((url) => (url.endsWith("/user") ? user() : new Response("{}", { status: 404 })));
    await fc.saveConnection({ kind: "gitea", baseUrl: "https://second.example", token: "t" });
    const before = m2.mock.calls.length;
    await fm.matchRemoteUrl("git@other.example:o/r.git");
    expect(m2.mock.calls.length).toBeGreaterThan(before);
  });
});
