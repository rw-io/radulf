import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-forge-route-");

const { db, forgeConnections } = await import("@/db");
const { GET, POST } = await import("./route");
const item = await import("./[id]/route");

function stubFetch(status = 200, body: unknown = { login: "bot" }) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/forge/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  db.delete(forgeConnections).run();
});
afterEach(() => vi.unstubAllGlobals());

describe("/api/forge/connections", () => {
  it("POST returns the connection without the token", async () => {
    stubFetch();
    const response = await post({ kind: "gitea", baseUrl: "https://gitea.example", token: "tok-secret-1" });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain("tok-secret-1");
    const body = JSON.parse(text);
    expect(body.account).toBe("bot");
    expect(body).not.toHaveProperty("token");
  });

  it("POST with an invalid kind returns 400", async () => {
    stubFetch();
    const response = await post({ kind: "gitlab", baseUrl: "https://gitea.example", token: "t" });
    expect(response.status).toBe(400);
    expect(db.select().from(forgeConnections).all()).toHaveLength(0);
  });

  it("POST with a bad token returns 400 and stores nothing", async () => {
    stubFetch(401, { message: "bad" });
    const response = await post({ kind: "forgejo", baseUrl: "https://gitea.example", token: "nope" });
    expect(response.status).toBe(400);
    expect(db.select().from(forgeConnections).all()).toHaveLength(0);
  });

  it("GET lists without tokens", async () => {
    stubFetch();
    await post({ kind: "gitea", baseUrl: "https://gitea.example", token: "tok-secret-2" });
    const response = await GET();
    const text = await response.text();
    expect(text).not.toContain("tok-secret-2");
    expect(JSON.parse(text)).toHaveLength(1);
  });

  it("GET one re-checks with refresh=1 and DELETE removes the row", async () => {
    stubFetch();
    const saved = await (await post({ kind: "gitea", baseUrl: "https://gitea.example", token: "t3" })).json();
    const ctx = { params: Promise.resolve({ id: saved.id as string }) };
    stubFetch(200, { login: "renamed" });
    const checked = await item.GET(new Request(`http://localhost/api/forge/connections/${saved.id}?refresh=1`), ctx);
    expect((await checked.json()).account).toBe("renamed");
    const removed = await item.DELETE(new Request("http://localhost/x", { method: "DELETE" }), ctx);
    expect(await removed.json()).toEqual({ ok: true });
    expect(db.select().from(forgeConnections).all()).toHaveLength(0);
  });
});
