import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardStatus } from "@/db";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// Spec 33 decision 4: an approved local merge on a repository that pushes
// after merging is reconciled with the remote first and pushed after. The git
// and remote boundaries are mocked; what is under test is the decision, the
// order, and where each failure leaves the card.

const mocks = vi.hoisted(() => ({
  mergeBranch: vi.fn(),
  hasRemote: vi.fn(),
  removeWorktree: vi.fn(),
  reconcileBase: vi.fn(),
  pushBase: vi.fn(),
  resolveRemoteTarget: vi.fn(),
  settings: {
    openPr: false,
    autoApprove: false,
    jiraCommentOnDone: false,
    jiraBaseUrl: "",
    jiraEmail: "",
    jiraApiToken: "",
  },
}));

vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  mergeBranch: mocks.mergeBranch,
  hasRemote: mocks.hasRemote,
  removeWorktree: mocks.removeWorktree,
}));
vi.mock("./baseReconcile", () => ({ reconcileBase: mocks.reconcileBase, pushBase: mocks.pushBase }));
vi.mock("./remoteTarget", () => ({ resolveRemoteTarget: mocks.resolveRemoteTarget }));
vi.mock("./settings", () => ({ getSettings: () => mocks.settings }));

const testDataDir = setupTestDataDir("radulf-reviewService-push-");

const { db, cards, improvementRuns, plans, runs, repos, reviews, reviewDeliveries, repoLeases, events, now, CLONES_DIR } =
  await import("@/db");
const { ReviewService } = await import("./reviewService");
const { pushAfterMergeFor } = await import("./repos");

const ORIGIN = { kind: "origin" } as const;

function seedRepo(values: { path?: string; pushAfterMerge?: number | null } = {}) {
  db.insert(repos)
    .values({
      id: "repo-1",
      name: "Repo",
      path: values.path ?? path.join(CLONES_DIR, "repo"),
      defaultBranch: "main",
      pushAfterMerge: values.pushAfterMerge ?? null,
      createdAt: now(),
    })
    .run();
}

function seedCard(id: string) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "Push after merge test card",
      status: "review",
      position: 1,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function seedRun(cardId: string, baseBranch = "main") {
  const planId = `plan-${cardId}`;
  db.insert(plans)
    .values({
      id: planId,
      cardId,
      version: 1,
      planMd: "## Tasks\n- [ ] implement the thing\n",
      promptMd: "Implement the thing.",
      acceptanceCriteria: "The thing is implemented.",
      createdAt: now(),
    })
    .run();
  const worktreePath = fs.mkdtempSync(path.join(testDataDir, "worktree-"));
  const id = `loop-${cardId}`;
  db.insert(runs)
    .values({
      id,
      cardId,
      planId,
      kind: "loop",
      status: "completed",
      worktreePath,
      branch: `ralph/${id}`,
      baseBranch,
      startedAt: now(),
      endedAt: now(),
    })
    .run();
  return { id, worktreePath };
}

/** Deps whose `moveCard` really moves the row, so retry and the final status
 * read back the way the orchestrator's would. */
function makeDeps() {
  return {
    getCard: (id: string) => db.select().from(cards).where(eq(cards.id, id)).get(),
    latestPlan: (id: string) =>
      db.select().from(plans).where(eq(plans.cardId, id)).orderBy(desc(plans.version)).limit(1).get(),
    latestWorktreeRun: (id: string) =>
      db.select().from(runs).where(eq(runs.cardId, id)).orderBy(desc(runs.startedAt)).limit(1).get(),
    moveCard: vi.fn<(cardId: string, from: CardStatus, to: CardStatus, reason?: string) => boolean>((cardId, from, to) => {
      const { changes } = db
        .update(cards)
        .set({ status: to, updatedAt: now() })
        .where(and(eq(cards.id, cardId), eq(cards.status, from)))
        .run();
      return changes === 1;
    }),
    pump: vi.fn(),
    workerId: () => "worker-test",
  };
}

function statusOf(cardId: string) {
  return db.select().from(cards).where(eq(cards.id, cardId)).get()?.status;
}

function lastReason(deps: ReturnType<typeof makeDeps>) {
  return deps.moveCard.mock.calls.at(-1)?.[3];
}

function approvedReviews() {
  return db.select().from(reviews).where(eq(reviews.decision, "approved")).all();
}

function decision(cardId: string): Record<string, unknown> | undefined {
  const row = db
    .select()
    .from(events)
    .where(and(eq(events.cardId, cardId), eq(events.type, "review.decided")))
    .orderBy(desc(events.id))
    .get();
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

describe("ReviewService: spec 33 push after a local merge", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(improvementRuns).run();
    db.delete(reviews).run();
    db.delete(reviewDeliveries).run();
    db.delete(repoLeases).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.mergeBranch.mockResolvedValue({ ok: true, mergeCommit: "abc123" });
    mocks.hasRemote.mockResolvedValue(true);
    mocks.removeWorktree.mockResolvedValue(undefined);
    mocks.reconcileBase.mockResolvedValue({ ok: true, remoteSha: "def456" });
    mocks.pushBase.mockResolvedValue({ ok: true });
    mocks.resolveRemoteTarget.mockResolvedValue({ target: ORIGIN, forge: null });
  });

  it("clone with push on reconciles, merges, pushes, then completes", async () => {
    seedRepo();
    seedCard("card-push");
    const run = seedRun("card-push");
    const repoPath = path.join(CLONES_DIR, "repo");

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result).toEqual({ ok: true });
    expect(mocks.reconcileBase).toHaveBeenCalledWith(repoPath, "main", ORIGIN, expect.any(Function));
    expect(mocks.pushBase).toHaveBeenCalledWith(repoPath, "main", ORIGIN, expect.any(Function));
    const [reconciled] = mocks.reconcileBase.mock.invocationCallOrder;
    const [merged] = mocks.mergeBranch.mock.invocationCallOrder;
    const [pushed] = mocks.pushBase.mock.invocationCallOrder;
    expect(reconciled).toBeLessThan(merged);
    expect(merged).toBeLessThan(pushed);
    expect(statusOf("card-push")).toBe("done");
  });

  it("push off does nothing remote", async () => {
    seedRepo({ pushAfterMerge: 0 });
    seedCard("card-off");
    const run = seedRun("card-off");

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result).toEqual({ ok: true });
    expect(mocks.hasRemote).not.toHaveBeenCalled();
    expect(mocks.resolveRemoteTarget).not.toHaveBeenCalled();
    expect(mocks.reconcileBase).not.toHaveBeenCalled();
    expect(mocks.pushBase).not.toHaveBeenCalled();
    expect(mocks.mergeBranch).toHaveBeenCalledTimes(1);
    expect(statusOf("card-off")).toBe("done");
  });

  it("local-path repo defaults to off, clone path defaults to on", () => {
    const repo = {
      id: "r",
      name: "r",
      defaultBranch: "main",
      approvedInstallScripts: "[]",
      gateCommand: null,
      createdAt: now(),
      pushAfterMerge: null,
    };
    expect(pushAfterMergeFor({ ...repo, path: path.join(CLONES_DIR, "x") })).toBe(true);
    expect(pushAfterMergeFor({ ...repo, path: "/home/u/x" })).toBe(false);
    expect(pushAfterMergeFor({ ...repo, path: CLONES_DIR })).toBe(false);
    expect(pushAfterMergeFor({ ...repo, path: `${CLONES_DIR}-other/x` })).toBe(false);
    // An explicit setting wins over the default either way.
    expect(pushAfterMergeFor({ ...repo, path: path.join(CLONES_DIR, "x"), pushAfterMerge: 0 })).toBe(false);
    expect(pushAfterMergeFor({ ...repo, path: "/home/u/x", pushAfterMerge: 1 })).toBe(true);
  });

  it("push failure leaves the merge and parks the card", async () => {
    seedRepo();
    seedCard("card-fail");
    const run = seedRun("card-fail");
    mocks.pushBase.mockResolvedValue({ ok: false, error: "auth failed" });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(mocks.mergeBranch).toHaveBeenCalledTimes(1);
    expect(statusOf("card-fail")).toBe("needs_attention");
    expect(lastReason(deps)).toContain("Press Retry merge to push it");
    expect(lastReason(deps)).toBe(
      "merged into `main` locally, but the push failed: auth failed. Press Retry merge to push it.",
    );
    expect(decision("card-fail")).toMatchObject({ pushFailed: expect.stringContaining("auth failed") });
    expect(approvedReviews()).toHaveLength(0);
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("retry pushes the already-merged base", async () => {
    seedRepo();
    seedCard("card-retry");
    const run = seedRun("card-retry");
    mocks.pushBase.mockResolvedValueOnce({ ok: false, error: "auth failed" });
    const service = new ReviewService(makeDeps());
    await service.approve(run.id);
    expect(statusOf("card-retry")).toBe("needs_attention");

    mocks.mergeBranch.mockResolvedValue({ ok: true, mergeCommit: "abc123", alreadyMerged: true });
    const result = await service.retryMerge("card-retry");

    expect(result).toEqual({ ok: true });
    expect(mocks.pushBase).toHaveBeenCalledTimes(2);
    expect(statusOf("card-retry")).toBe("done");
    expect(approvedReviews()).toHaveLength(1);
    expect(mocks.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("reconcile conflict merges nothing", async () => {
    seedRepo();
    seedCard("card-conflict");
    const run = seedRun("card-conflict");
    const error = "local `main` and the remote's have diverged and conflict: CONFLICT (content)";
    mocks.reconcileBase.mockResolvedValue({ ok: false, error });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result).toEqual({ ok: false, error });
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(mocks.pushBase).not.toHaveBeenCalled();
    expect(statusOf("card-conflict")).toBe("needs_attention");
    expect(lastReason(deps)).toBe(error);
    expect(decision("card-conflict")).toMatchObject({ reconcileFailed: error });
  });

  it("a remote that cannot be resolved parks the card instead of throwing", async () => {
    seedRepo();
    seedCard("card-gone");
    const run = seedRun("card-gone");
    mocks.resolveRemoteTarget.mockRejectedValue(new Error("That connection no longer exists."));
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(statusOf("card-gone")).toBe("needs_attention");
    expect(lastReason(deps)).toContain("That connection no longer exists.");
  });

  it("improvement-run card never pushes", async () => {
    seedRepo();
    db.insert(improvementRuns)
      .values({
        id: "run-1",
        repoId: "repo-1",
        featureBranch: "ralph/improve-123",
        baseBranch: "main",
        deadlineAt: now(),
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    seedCard("card-improve");
    const run = seedRun("card-improve", "ralph/improve-123");

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result).toEqual({ ok: true });
    expect(mocks.reconcileBase).not.toHaveBeenCalled();
    expect(mocks.pushBase).not.toHaveBeenCalled();
    expect(mocks.mergeBranch).toHaveBeenCalledWith(
      path.join(CLONES_DIR, "repo"),
      "ralph/improve-123",
      "ralph/loop-card-improve",
      expect.any(String),
      expect.any(Function),
    );
    expect(statusOf("card-improve")).toBe("done");
  });
});
