import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const mocks = vi.hoisted(() => ({ latestWorktreeRun: vi.fn() }));

vi.mock("@/server/orchestrator", () => ({
  getOrchestrator: () => ({ latestWorktreeRun: mocks.latestWorktreeRun }),
}));

setupTestDataDir("radulf-card-route-");

const { db, cards, repos, now } = await import("@/db");
const { DELETE } = await import("./route");

function remove(id: string) {
  return DELETE(new Request(`http://localhost/api/cards/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
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
});
