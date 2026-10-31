import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const mocks = vi.hoisted(() => ({ latestWorktreeRun: vi.fn() }));

vi.mock("@/server/orchestrator", () => ({
  getOrchestrator: () => ({ latestWorktreeRun: mocks.latestWorktreeRun }),
}));

setupTestDataDir("radulf-card-route-");

const { db, cards, events, forgeConnections, plans, prWaits, repos, runs, now } = await import("@/db");
const { saveConnection } = await import("@/server/forgeConnections");
const { DELETE, GET } = await import("./route");

function remove(id: string) {
  return DELETE(new Request(`http://localhost/api/cards/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  db.delete(events).run();
  db.delete(prWaits).run();
  db.delete(runs).run();
  db.delete(plans).run();
  db.delete(forgeConnections).run();
  db.delete(cards).run();
  db.delete(repos).run();
  vi.clearAllMocks();
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: "/tmp/radulf-card-route-repo", defaultBranch: "main", createdAt: now() })
    .run();
});

describe("DELETE /api/cards/[id]", () => {
  it("refuses a card waiting for CI, so its pull request is not left open on Gitea", async () => {
    db.insert(cards)
      .values({
        id: "waiting-card",
        repoId: "repo-1",
        title: "Card",
        status: "awaiting_ci",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    const response = await remove("waiting-card");

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/abandon it first/);
    expect(db.select().from(cards).where(eq(cards.id, "waiting-card")).get()?.status).toBe("awaiting_ci");
    expect(mocks.latestWorktreeRun).not.toHaveBeenCalled();
  });

  /** A parked card whose pull request is still open on a stubbed Gitea;
   * returns the calls Gitea saw. `closeStatus` is the close's answer. */
  async function seedParkedCardWithOpenPr(closeStatus = 200) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "bot" }));
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              number: 7,
              html_url: "https://gitea.example/o/r/pulls/7",
              state: "open",
              merged: false,
              mergeable: true,
              head: { ref: "ralph/x-1", sha: "head-1" },
              base: { ref: "main" },
              merge_commit_sha: null,
            }),
          );
        }
        if (method === "PATCH" && closeStatus !== 200) {
          return new Response(JSON.stringify({ message: "token tok-del cannot close" }), { status: closeStatus });
        }
        return new Response(null, { status: 204 });
      }),
    );
    const connection = await saveConnection({ kind: "gitea", baseUrl: "https://gitea.example", token: "tok-del" });
    db.insert(cards)
      .values({ id: "parked", repoId: "repo-1", title: "Card", status: "needs_attention", createdAt: now(), updatedAt: now() })
      .run();
    db.insert(runs)
      .values({
        id: "run-1",
        cardId: "parked",
        kind: "loop",
        status: "completed",
        worktreePath: "/tmp/radulf-card-route-wt",
        branch: "ralph/x-1",
        startedAt: now(),
        endedAt: now(),
      })
      .run();
    db.insert(prWaits)
      .values({
        id: "wait-1",
        cardId: "parked",
        runId: "run-1",
        repoId: "repo-1",
        connectionId: connection.id,
        owner: "o",
        repo: "r",
        branch: "ralph/x-1",
        baseBranch: "main",
        prNumber: 7,
        prUrl: "https://gitea.example/o/r/pulls/7",
        headSha: "head-1",
        status: "failed",
        pushedAt: now(),
        createdAt: now(),
        endedAt: now(),
      })
      .run();
    return calls;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("closes the pull request a parked card left open before its rows cascade away", async () => {
    const calls = await seedParkedCardWithOpenPr();

    const response = await remove("parked");

    expect(response.status).toBe(200);
    expect(calls).toContain("PATCH https://gitea.example/api/v1/repos/o/r/pulls/7");
    expect(calls).toContain("DELETE https://gitea.example/api/v1/repos/o/r/branches/ralph/x-1");
    expect(db.select().from(cards).where(eq(cards.id, "parked")).get()).toBeUndefined();
    expect(db.select().from(prWaits).all()).toHaveLength(0);
  });

  it("still deletes when Gitea refuses the close, and the failure outlives the card", async () => {
    await seedParkedCardWithOpenPr(403);

    const response = await remove("parked");

    expect(response.status).toBe(200);
    expect(db.select().from(cards).where(eq(cards.id, "parked")).get()).toBeUndefined();
    const failure = db.select().from(events).where(eq(events.type, "review.pr_close_failed")).get();
    expect(failure?.cardId).toBeNull();
    expect(failure?.payload).toContain("cannot close");
    expect(failure?.payload).not.toContain("tok-del");
  });

});

describe("GET /api/cards/[id] prUrl", () => {
  function waitRow(id: string, status: typeof prWaits.$inferInsert.status, createdAt: string) {
    db.insert(prWaits)
      .values({
        id,
        cardId: "card-pr",
        runId: "run-pr",
        repoId: "repo-1",
        connectionId: "conn-1",
        owner: "o",
        repo: "r",
        branch: "ralph/x-1",
        baseBranch: "main",
        prNumber: 7,
        prUrl: `https://gitea.example/o/r/pulls/${id}`,
        headSha: "head-1",
        status,
        pushedAt: createdAt,
        createdAt,
      })
      .run();
  }

  async function prUrlOf(status: typeof cards.$inferInsert.status) {
    db.update(cards).set({ status }).where(eq(cards.id, "card-pr")).run();
    const response = await GET(new Request("http://localhost/api/cards/card-pr"), { params: Promise.resolve({ id: "card-pr" }) });
    return (await response.json()).prUrl;
  }

  beforeEach(() => {
    db.insert(cards)
      .values({ id: "card-pr", repoId: "repo-1", title: "Card", status: "needs_attention", createdAt: now(), updatedAt: now() })
      .run();
    db.insert(runs)
      .values({
        id: "run-pr",
        cardId: "card-pr",
        kind: "loop",
        status: "completed",
        worktreePath: "/tmp/radulf-card-route-wt",
        branch: "ralph/x-1",
        startedAt: now(),
        endedAt: now(),
      })
      .run();
  });

  it("names the pull request a parked card still has open, so its confirms can say it closes", async () => {
    waitRow("1", "timed_out", "2026-10-30T10:00:00.000Z");

    expect(await prUrlOf("needs_attention")).toBe("https://gitea.example/o/r/pulls/1");
  });

  it("names none once the card's newest wait merged, closed or was abandoned", async () => {
    waitRow("1", "ci_failed", "2026-10-30T10:00:00.000Z");
    waitRow("2", "merged", "2026-10-30T11:00:00.000Z");

    expect(await prUrlOf("done")).toBeNull();
  });
});
