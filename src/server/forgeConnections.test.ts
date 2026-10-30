import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-forgeConnections-");

const { db, forgeConnections } = await import("@/db");
const { decryptSecret } = await import("./settingsCrypto");
const { ClientError } = await import("./clientError");
const fc = await import("./forgeConnections");

function stubFetch(status = 200, body: unknown = { login: "bot" }) {
  const m = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", m);
  return m;
}

beforeEach(() => {
  db.delete(forgeConnections).run();
});
afterEach(() => vi.unstubAllGlobals());

describe("forgeConnections", () => {
  it("stores the token encrypted", async () => {
    const m = stubFetch();
    await fc.saveConnection({ kind: "gitea", baseUrl: "https://gitea.example/", token: " tok123\n" });
    const row = db.select().from(forgeConnections).get()!;
    expect(row.token.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(row.token)).toBe("tok123");
    const init = (m.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe("token tok123");
  });

  it("never returns the token", async () => {
    stubFetch();
    await fc.saveConnection({ kind: "gitea", baseUrl: "https://gitea.example", token: "tok123" });
    expect(Object.keys(fc.listConnections()[0])).not.toContain("token");
    expect(JSON.stringify(fc.listConnections())).not.toContain("tok123");
  });

  it("rejects a bad token without storing", async () => {
    stubFetch(401, { message: "user does not exist" });
    const err = await fc
      .saveConnection({ kind: "gitea", baseUrl: "https://gitea.example", token: "bad" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect(err.message).toContain("user does not exist");
    expect(fc.listConnections()).toEqual([]);
  });

  it("upserts by base url", async () => {
    stubFetch();
    await fc.saveConnection({ kind: "gitea", baseUrl: "https://gitea.example", token: "one" });
    await fc.saveConnection({ kind: "gitea", baseUrl: "https://gitea.example/", token: "two" });
    const rows = db.select().from(forgeConnections).all();
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0].token)).toBe("two");
    expect(fc.connectionAuth(rows[0].id)).toEqual({ baseUrl: "https://gitea.example", token: "two" });
  });

  it("normalizeBaseUrl keeps a sub-path", () => {
    expect(fc.normalizeBaseUrl("https://host/gitea/")).toBe("https://host/gitea");
    expect(() => fc.normalizeBaseUrl("ftp://host")).toThrow(ClientError);
  });

  it("deleteConnection removes the row", async () => {
    stubFetch();
    const c = await fc.saveConnection({ kind: "forgejo", baseUrl: "https://f.example", token: "t" });
    fc.deleteConnection(c.id);
    expect(fc.listConnections()).toEqual([]);
    expect(() => fc.connectionAuth(c.id)).toThrow(ClientError);
  });

  it("scrubSecret", () => {
    expect(fc.scrubSecret("fatal: tok123 bad", "tok123")).toBe("fatal: *** bad");
    expect(fc.scrubSecret("keep", "")).toBe("keep");
  });

  it("checkConnection caches for 30s", async () => {
    const m = stubFetch();
    const c = await fc.saveConnection({ kind: "gitea", baseUrl: "https://gitea.example", token: "t" });
    fc.invalidateConnectionCheck(c.id);
    m.mockClear();
    await fc.checkConnection(c.id);
    await fc.checkConnection(c.id);
    expect(m).toHaveBeenCalledTimes(1);
    m.mockClear();
    await fc.checkConnection(c.id, { refresh: true });
    await fc.checkConnection(c.id, { refresh: true });
    expect(m).toHaveBeenCalledTimes(2);
  });
});
