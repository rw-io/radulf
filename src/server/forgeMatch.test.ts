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
