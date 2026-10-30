import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardStatus } from "@/db";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// Spec 33 decision 5, from an open pull request to Done: the worker polls each
// `pr_waits` row, merges on green CI (or no CI after the grace window), and
// finishes the card; Abandon closes the PR. Gitea, git and the reconcile are
// mocked; what is under test is the decision each tick makes and where it
// leaves the card and the wait. Every time-based case passes `nowMs`.

const mocks = vi.hoisted(() => ({
  getPull: vi.fn(),
  getCombinedStatus: vi.fn(),
  mergePull: vi.fn(),
  closePull: vi.fn(),
  deleteBranch: vi.fn(),
  mergeBaseIntoWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  fetchBranchHead: vi.fn(),
  pushRef: vi.fn(),
  git: vi.fn(),
  reconcileBase: vi.fn(),
  connectionAuth: vi.fn(),
  matchRepo: vi.fn(),
  settings: {
    openPr: false,
    workerStaleSeconds: 60,
    jiraCommentOnDone: false,
    jiraBaseUrl: "",
    jiraEmail: "",
    jiraApiToken: "",
  },
}));

vi.mock("./gitea", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gitea")>()),
  getPull: mocks.getPull,
  getCombinedStatus: mocks.getCombinedStatus,
  mergePull: mocks.mergePull,
  closePull: mocks.closePull,
  deleteBranch: mocks.deleteBranch,
}));
vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  mergeBaseIntoWorktree: mocks.mergeBaseIntoWorktree,
  removeWorktree: mocks.removeWorktree,
  fetchBranchHead: mocks.fetchBranchHead,
  pushRef: mocks.pushRef,
  git: mocks.git,
}));
vi.mock("./baseReconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./baseReconcile")>()),
  reconcileBase: mocks.reconcileBase,
}));
vi.mock("./forgeConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./forgeConnections")>()),
  connectionAuth: mocks.connectionAuth,
}));
vi.mock("./forgeMatch", () => ({ matchRepo: mocks.matchRepo }));
vi.mock("./settings", () => ({ getSettings: () => mocks.settings }));

const testDataDir = setupTestDataDir("radulf-giteaDelivery-wait-");

const { db, cards, events, plans, prWaits, refWrites, repoLeases, repos, reviews, runs, workers, now } =
  await import("@/db");
const { ReviewService } = await import("./reviewService");
const { GiteaError } = await import("./gitea");

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const TOKEN = "gta_5ecret_t0ken_value";
const CONNECTION = {
  id: "conn-1",
  kind: "gitea" as const,
  baseUrl: "https://gitea.example",
  account: "radulf-bot",
  checkError: null,
  checkedAt: null,
  updatedAt: "2026-10-30T00:00:00.000Z",
};
const FORGE = { connection: CONNECTION, owner: "o", repo: "r", cloneUrl: "https://gitea.example/o/r.git" };
const AUTH = { baseUrl: "https://gitea.example", token: TOKEN };
const TARGET = { kind: "forge", url: FORGE.cloneUrl, username: "radulf-bot", token: TOKEN };
const PR_URL = "https://gitea.example/o/r/pulls/7";
const BRANCH = "ralph/x-1";
const OPEN = {
  number: 7,
  url: PR_URL,
  state: "open" as const,
  merged: false,
  mergeable: true,
  headSha: "head-1",
  mergeCommitSha: null,
};
const MERGED = { ...OPEN, state: "closed" as const, merged: true, mergeCommitSha: "merge-sha" };
const REPO_PATH = path.join(testDataDir, "repo");

let worktreePath: string;

function seedCard(status: CardStatus = "awaiting_ci") {
  db.insert(cards)
    .values({
      id: "card-1",
      repoId: "repo-1",
      title: "Fix the thing",
      description: "Wait test card",
      status,
      position: 1,
      openPr: 1,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  db.insert(plans)
    .values({
      id: "plan-1",
      cardId: "card-1",
      version: 1,
      planMd: "## Tasks\n- [x] implement the thing\n",
      promptMd: "Implement the thing.",
      acceptanceCriteria: "The thing is implemented.",
      createdAt: now(),
    })
    .run();
  worktreePath = fs.mkdtempSync(path.join(testDataDir, "worktree-"));
  db.insert(runs)
    .values({
      id: "loop-1",
      cardId: "card-1",
      planId: "plan-1",
      kind: "loop",
      status: "completed",
      worktreePath,
      branch: BRANCH,
      baseBranch: "main",
      startedAt: now(),
      endedAt: now(),
    })
    .run();
}

function seedWait(minutesAgo: number, overrides: Partial<typeof prWaits.$inferInsert> = {}) {
  const pushedAt = new Date(NOW - minutesAgo * 60_000).toISOString();
  db.insert(prWaits)
    .values({
      id: "wait-1",
      cardId: "card-1",
      runId: "loop-1",
      repoId: "repo-1",
      connectionId: "conn-1",
      owner: "o",
      repo: "r",
      branch: BRANCH,
      baseBranch: "main",
      prNumber: 7,
      prUrl: PR_URL,
      headSha: "head-1",
      status: "waiting",
      pushedAt,
      createdAt: pushedAt,
      ...overrides,
    })
    .run();
}

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

function statusOf() {
  return db.select().from(cards).where(eq(cards.id, "card-1")).get()?.status;
}

function wait(id = "wait-1") {
  return db.select().from(prWaits).where(eq(prWaits.id, id)).get();
}

function lastReason(deps: ReturnType<typeof makeDeps>) {
  return deps.moveCard.mock.calls.at(-1)?.[3];
}

function eventPayload(type: string): Record<string, unknown> | undefined {
  const row = db.select().from(events).where(eq(events.type, type)).orderBy(desc(events.id)).get();
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

describe("GiteaDelivery: spec 33 CI wait and merge", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(reviews).run();
    db.delete(repoLeases).run();
    db.delete(refWrites).run();
    db.delete(workers).run();
    db.delete(prWaits).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.getPull.mockResolvedValue(OPEN);
    mocks.getCombinedStatus.mockResolvedValue({ state: "success", statuses: [] });
    mocks.mergePull.mockResolvedValue({ ok: true });
    mocks.closePull.mockResolvedValue(undefined);
    mocks.deleteBranch.mockResolvedValue(undefined);
    mocks.mergeBaseIntoWorktree.mockResolvedValue({ ok: true, conflicted: false, out: "" });
    mocks.removeWorktree.mockResolvedValue(undefined);
    mocks.fetchBranchHead.mockResolvedValue({ ok: true, sha: "remote-base-2" });
    mocks.pushRef.mockResolvedValue({ ok: true });
    mocks.git.mockResolvedValue("head-2");
    mocks.reconcileBase.mockResolvedValue({ ok: true, remoteSha: "merge-sha" });
    mocks.connectionAuth.mockReturnValue(AUTH);
    mocks.matchRepo.mockResolvedValue(FORGE);
    db.insert(repos)
      .values({ id: "repo-1", name: "Repo", path: REPO_PATH, defaultBranch: "main", createdAt: now() })
      .run();
  });

  /** Gitea reports the merge commit once Radulf's merge has landed. */
  function mergesCleanly() {
    mocks.getPull.mockResolvedValueOnce(OPEN).mockResolvedValueOnce(MERGED);
  }

  function expectDone() {
    expect(statusOf()).toBe("done");
    expect(wait()?.status).toBe("merged");
    expect(wait()?.endedAt).not.toBeNull();
    expect(db.select().from(repoLeases).all()).toEqual([]);
  }

  it("no status inside the grace window keeps waiting", async () => {
    seedCard();
    seedWait(1);
    mocks.getCombinedStatus.mockResolvedValue({ state: null, statuses: [] });

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(mocks.getCombinedStatus).toHaveBeenCalledWith(AUTH, "o", "r", "head-1");
    expect(mocks.mergePull).not.toHaveBeenCalled();
    expect(statusOf()).toBe("awaiting_ci");
    expect(wait()?.status).toBe("waiting");
  });

  it("no status after the grace window merges", async () => {
    seedCard();
    seedWait(3);
    mocks.getCombinedStatus.mockResolvedValue({ state: null, statuses: [] });
    mergesCleanly();
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(mocks.mergePull).toHaveBeenCalledWith(
      AUTH,
      "o",
      "r",
      7,
      'ralph: merge "Fix the thing" (card card-1)',
      "head-1",
    );
    expectDone();
    expect(deps.moveCard).toHaveBeenCalledWith("card-1", "awaiting_ci", "reviewing", expect.any(String));
    expect(mocks.reconcileBase).toHaveBeenCalledWith(REPO_PATH, "main", TARGET, expect.any(Function));
    expect(mocks.removeWorktree).toHaveBeenCalledWith(REPO_PATH, worktreePath, BRANCH);
    expect(db.select().from(reviews).get()).toMatchObject({ runId: "loop-1", decision: "approved", mergeCommit: "merge-sha" });
    expect(eventPayload("review.decided")).toEqual({
      decision: "approved",
      delivery: "gitea",
      prUrl: PR_URL,
      merged: true,
    });
    expect(deps.pump).toHaveBeenCalled();
  });

  it("green ci merges", async () => {
    seedCard();
    seedWait(10);
    mergesCleanly();

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(mocks.mergePull).toHaveBeenCalledTimes(1);
    expectDone();
  });

  it("records the reconcile's ref write against the base branch", async () => {
    seedCard();
    seedWait(10);
    mergesCleanly();
    mocks.reconcileBase.mockImplementation(async (_repo, _base, _target, onRefWrite: (sha: string) => void) => {
      onRefWrite("merge-sha");
      return { ok: true, remoteSha: "merge-sha" };
    });

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(db.select().from(refWrites).get()).toMatchObject({
      repoPath: REPO_PATH,
      ref: "refs/heads/main",
      sha: "merge-sha",
      workerId: "worker-test",
    });
  });

  it("head moved after ci ran parks the card instead of merging", async () => {
    seedCard();
    seedWait(10);
    mocks.getPull.mockResolvedValue({ ...OPEN, headSha: "someone-elses-commit" });
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    const reason = `the pull request's branch moved after CI ran (someone else pushed to it): ${PR_URL}`;
    expect(mocks.mergePull).not.toHaveBeenCalled();
    expect(statusOf()).toBe("needs_attention");
    expect(lastReason(deps)).toBe(reason);
    expect(wait()).toMatchObject({ status: "failed", detail: reason });
    expect(db.select().from(repoLeases).all()).toEqual([]);
  });

  it("a push racing the merge call is a refusal, not a re-sync", async () => {
    seedCard();
    seedWait(10);
    mocks.mergePull.mockResolvedValue({ ok: false, notMergeable: false, message: "head out of date" });
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(mocks.fetchBranchHead).not.toHaveBeenCalled();
    expect(mocks.pushRef).not.toHaveBeenCalled();
    expect(statusOf()).toBe("needs_attention");
    expect(lastReason(deps)).toBe(`Gitea refused to merge ${PR_URL}: head out of date`);
    expect(wait()?.status).toBe("failed");
  });

  it("pending past two hours times out", async () => {
    seedCard();
    seedWait(121);
    mocks.getCombinedStatus.mockResolvedValue({ state: "pending", statuses: [] });
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(mocks.mergePull).not.toHaveBeenCalled();
    expect(statusOf()).toBe("needs_attention");
    expect(lastReason(deps)).toBe(`CI did not finish within 2 hours: ${PR_URL}`);
    expect(wait()).toMatchObject({ status: "timed_out", detail: `CI did not finish within 2 hours: ${PR_URL}` });
  });

  it("pending inside two hours keeps waiting", async () => {
    seedCard();
    seedWait(119);
    mocks.getCombinedStatus.mockResolvedValue({ state: "pending", statuses: [] });

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(mocks.mergePull).not.toHaveBeenCalled();
    expect(statusOf()).toBe("awaiting_ci");
    expect(wait()?.status).toBe("waiting");
  });

  it("gitea unreachable keeps waiting", async () => {
    seedCard();
    seedWait(10);
    mocks.getPull.mockRejectedValue(new GiteaError("cannot reach https://gitea.example: fetch failed", null));

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(wait()?.status).toBe("waiting");
    expect(statusOf()).toBe("awaiting_ci");
    expect(mocks.mergePull).not.toHaveBeenCalled();
  });

  it("gitea restarting during the status read keeps waiting", async () => {
    seedCard();
    seedWait(10);
    mocks.getCombinedStatus.mockRejectedValue(new GiteaError("bad gateway", 502));

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(wait()?.status).toBe("waiting");
    expect(statusOf()).toBe("awaiting_ci");
  });

  it("gitea unreachable past two hours times out", async () => {
    seedCard();
    seedWait(121);
    mocks.getPull.mockRejectedValue(new GiteaError(`cannot reach https://gitea.example?t=${TOKEN}`, null));
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(statusOf()).toBe("needs_attention");
    expect(lastReason(deps)).toContain(`CI did not finish within 2 hours: ${PR_URL}`);
    expect(lastReason(deps)).not.toContain(TOKEN);
    expect(wait()?.status).toBe("timed_out");
  });

  it("a gitea refusal to read the pull request parks the card with the scrubbed message", async () => {
    seedCard();
    seedWait(10);
    mocks.getPull.mockRejectedValue(new GiteaError(`token ${TOKEN} was revoked`, 401));
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(statusOf()).toBe("needs_attention");
    expect(lastReason(deps)).toContain("was revoked");
    expect(lastReason(deps)).not.toContain(TOKEN);
    expect(wait()?.status).toBe("failed");
    expect(wait()?.detail).not.toContain(TOKEN);
  });

  it("merged on gitea finishes the card", async () => {
    seedCard();
    seedWait(10);
    mocks.getPull.mockResolvedValue(MERGED);
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(mocks.mergePull).not.toHaveBeenCalled();
    expect(mocks.getCombinedStatus).not.toHaveBeenCalled();
    expectDone();
    expect(deps.moveCard).toHaveBeenCalledWith("card-1", "awaiting_ci", "reviewing", expect.any(String));
    expect(mocks.reconcileBase).toHaveBeenCalledWith(REPO_PATH, "main", TARGET, expect.any(Function));
    expect(db.select().from(reviews).get()?.mergeCommit).toBe("merge-sha");
  });

  it("merged on gitea without a merge commit finishes as a pull request", async () => {
    seedCard();
    seedWait(10);
    mocks.getPull.mockResolvedValue({ ...MERGED, mergeCommitSha: null });

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expectDone();
    expect(db.select().from(reviews).get()?.mergeCommit).toBeNull();
  });

  it("merged on gitea waits for the lease like radulf's own merge", async () => {
    seedCard();
    seedWait(10);
    mocks.getPull.mockResolvedValue(MERGED);
    db.insert(workers)
      .values({ id: "worker-other", host: "h", pid: 1, roles: '["worker"]', startedAt: now(), heartbeatAt: now() })
      .run();
    db.insert(repoLeases).values({ repoPath: REPO_PATH, workerId: "worker-other", acquiredAt: now() }).run();

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(statusOf()).toBe("awaiting_ci");
    expect(wait()?.status).toBe("waiting");
    expect(mocks.reconcileBase).not.toHaveBeenCalled();
  });

  it("closed on gitea parks the card", async () => {
    seedCard();
    seedWait(10);
    mocks.getPull.mockResolvedValue({ ...OPEN, state: "closed" });
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(statusOf()).toBe("needs_attention");
    expect(lastReason(deps)).toBe(`the pull request was closed on Gitea without merging: ${PR_URL}`);
    expect(wait()?.status).toBe("closed");
    expect(mocks.mergePull).not.toHaveBeenCalled();
  });

  it("not mergeable re-syncs and pushes", async () => {
    seedCard();
    seedWait(10);
    mocks.mergePull.mockResolvedValue({ ok: false, notMergeable: true, message: "Please try again later" });

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(mocks.fetchBranchHead).toHaveBeenCalledWith(worktreePath, TARGET, "main");
    expect(mocks.mergeBaseIntoWorktree).toHaveBeenCalledWith(worktreePath, "remote-base-2");
    expect(mocks.pushRef).toHaveBeenCalledWith(worktreePath, TARGET, `HEAD:refs/heads/${BRANCH}`);
    expect(wait()).toMatchObject({ status: "waiting", headSha: "head-2", pushedAt: new Date(NOW).toISOString() });
    expect(statusOf()).toBe("awaiting_ci");
    expect(db.select().from(repoLeases).all()).toEqual([]);
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("not mergeable with the base already in the branch is a refusal like any other", async () => {
    seedCard();
    seedWait(10);
    mocks.mergePull.mockResolvedValue({ ok: false, notMergeable: true, message: "PR is not ready to be merged" });
    mocks.git.mockResolvedValue("head-1");
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(mocks.pushRef).not.toHaveBeenCalled();
    expect(statusOf()).toBe("needs_attention");
    expect(lastReason(deps)).toContain("PR is not ready to be merged");
    expect(wait()?.status).toBe("failed");
  });

  it("not mergeable with a conflict hands back to the loop", async () => {
    seedCard();
    seedWait(10);
    mocks.mergePull.mockResolvedValue({ ok: false, notMergeable: true, message: "merge conflict" });
    mocks.mergeBaseIntoWorktree.mockResolvedValue({
      ok: false,
      conflicted: true,
      out: "CONFLICT (content): both modified src/a.ts",
    });
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(mocks.pushRef).not.toHaveBeenCalled();
    expect(statusOf()).toBe("ready");
    expect(deps.latestPlan("card-1")?.version).toBe(2);
    expect(deps.latestPlan("card-1")?.feedback).toContain("merge conflict with main");
    expect(wait()?.status).toBe("failed");
    expect(db.select().from(repoLeases).all()).toEqual([]);
  });

  it("a refused merge parks the card with the scrubbed server message", async () => {
    seedCard();
    seedWait(10);
    mocks.mergePull.mockResolvedValue({
      ok: false,
      notMergeable: false,
      message: `token ${TOKEN} does not have at least write access`,
    });
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(statusOf()).toBe("needs_attention");
    expect(lastReason(deps)).toContain("does not have at least write access");
    expect(lastReason(deps)).not.toContain(TOKEN);
    expect(wait()?.status).toBe("failed");
    expect(wait()?.detail).not.toContain(TOKEN);
    expect(mocks.fetchBranchHead).not.toHaveBeenCalled();
    expect(db.select().from(repoLeases).all()).toEqual([]);
  });

  it("an unanswered merge goes back to waiting", async () => {
    seedCard();
    seedWait(10);
    mocks.mergePull.mockRejectedValue(new GiteaError("bad gateway", 502));

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(statusOf()).toBe("awaiting_ci");
    expect(wait()?.status).toBe("waiting");
    expect(db.select().from(repoLeases).all()).toEqual([]);
  });

  it("a failed ci run parks the card for now", async () => {
    seedCard();
    seedWait(10);
    mocks.getCombinedStatus.mockResolvedValue({
      state: "failure",
      statuses: [{ context: "ci/build", state: "failure", targetUrl: "https://ci/1" }],
    });
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(mocks.mergePull).not.toHaveBeenCalled();
    expect(statusOf()).toBe("needs_attention");
    expect(lastReason(deps)).toContain(PR_URL);
    expect(lastReason(deps)).toContain("ci/build");
    expect(wait()?.status).toBe("failed");
  });

  it("lease held elsewhere skips the tick", async () => {
    seedCard();
    seedWait(10);
    db.insert(workers)
      .values({ id: "worker-other", host: "h", pid: 1, roles: '["worker"]', startedAt: now(), heartbeatAt: now() })
      .run();
    db.insert(repoLeases).values({ repoPath: REPO_PATH, workerId: "worker-other", acquiredAt: now() }).run();

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(mocks.mergePull).not.toHaveBeenCalled();
    expect(statusOf()).toBe("awaiting_ci");
    expect(wait()?.status).toBe("waiting");
    expect(db.select().from(repoLeases).get()?.workerId).toBe("worker-other");
  });

  it("a restarted service resumes the wait", async () => {
    seedCard();
    seedWait(10);
    mocks.getCombinedStatus.mockResolvedValueOnce({ state: "pending", statuses: [] });
    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);
    expect(statusOf()).toBe("awaiting_ci");

    mergesCleanly();
    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW + 1_000);

    expect(mocks.mergePull).toHaveBeenCalledTimes(1);
    expectDone();
  });

  it("local reconcile failure still finishes the card", async () => {
    seedCard();
    seedWait(10);
    mergesCleanly();
    mocks.reconcileBase.mockResolvedValue({ ok: false, error: `local main and the remote's conflict near ${TOKEN}` });

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expectDone();
    const payload = eventPayload("repo.base_reconcile_failed");
    expect(payload).toMatchObject({ baseBranch: "main", error: expect.stringContaining("conflict") });
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
  });

  it("a repository that no longer matches a connection still finishes the card", async () => {
    seedCard();
    seedWait(10);
    mergesCleanly();
    mocks.matchRepo.mockResolvedValue(null);

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expectDone();
    expect(mocks.reconcileBase).not.toHaveBeenCalled();
    expect(eventPayload("repo.base_reconcile_failed")).toBeDefined();
  });

  it("polls each wait at most every 15 seconds", async () => {
    seedCard();
    seedWait(10);
    mocks.getCombinedStatus.mockResolvedValue({ state: "pending", statuses: [] });
    const service = new ReviewService(makeDeps());

    await service.pollPullRequestWaits(NOW);
    await service.pollPullRequestWaits(NOW + 5_000);
    expect(mocks.getPull).toHaveBeenCalledTimes(1);

    await service.pollPullRequestWaits(NOW + 15_000);
    expect(mocks.getPull).toHaveBeenCalledTimes(2);
  });

  it("a wait whose card left awaiting_ci is marked failed and the card stays put", async () => {
    seedCard("needs_attention");
    seedWait(10);
    const deps = makeDeps();

    await new ReviewService(deps).pollPullRequestWaits(NOW);

    expect(mocks.getPull).not.toHaveBeenCalled();
    expect(deps.moveCard).not.toHaveBeenCalled();
    expect(statusOf()).toBe("needs_attention");
    expect(wait()?.status).toBe("failed");
    expect(wait()?.detail).toContain("needs_attention");
  });

  it("a card mid-merge is left to the merge", async () => {
    seedCard("reviewing");
    seedWait(10);

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(mocks.getPull).not.toHaveBeenCalled();
    expect(wait()?.status).toBe("waiting");
    expect(statusOf()).toBe("reviewing");
  });

  it("only the newest wait for a card is polled", async () => {
    seedCard();
    seedWait(30, { id: "wait-old", prNumber: 6, createdAt: new Date(NOW - 30 * 60_000).toISOString() });
    seedWait(10, { id: "wait-new", prNumber: 7, createdAt: new Date(NOW - 10 * 60_000).toISOString() });
    mocks.getCombinedStatus.mockResolvedValue({ state: "pending", statuses: [] });

    await new ReviewService(makeDeps()).pollPullRequestWaits(NOW);

    expect(mocks.getPull).toHaveBeenCalledTimes(1);
    expect(mocks.getPull).toHaveBeenCalledWith(AUTH, "o", "r", 7);
    expect(wait("wait-old")?.status).toBe("failed");
    expect(wait("wait-new")?.status).toBe("waiting");
    expect(statusOf()).toBe("awaiting_ci");
  });

  it("abandon closes the pr and deletes the branch", async () => {
    seedCard();
    seedWait(10);
    const deps = makeDeps();

    await new ReviewService(deps).abandon("card-1");

    expect(mocks.closePull).toHaveBeenCalledWith(AUTH, "o", "r", 7);
    expect(mocks.deleteBranch).toHaveBeenCalledWith(AUTH, "o", "r", BRANCH);
    expect(wait()?.status).toBe("abandoned");
    expect(statusOf()).toBe("abandoned");
    expect(deps.moveCard).toHaveBeenCalledWith("card-1", "awaiting_ci", "abandoned");
    expect(mocks.removeWorktree).toHaveBeenCalledWith(REPO_PATH, worktreePath, BRANCH);
    expect(mocks.mergePull).not.toHaveBeenCalled();
  });

  it("abandon still completes when gitea fails, and says so", async () => {
    seedCard();
    seedWait(10);
    mocks.closePull.mockRejectedValue(new GiteaError(`token ${TOKEN} cannot close`, 403));

    await new ReviewService(makeDeps()).abandon("card-1");

    expect(statusOf()).toBe("abandoned");
    expect(wait()?.status).toBe("abandoned");
    const payload = eventPayload("review.pr_close_failed");
    expect(payload).toMatchObject({ delivery: "gitea", prUrl: PR_URL, error: expect.stringContaining("cannot close") });
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(wait()?.detail).not.toContain(TOKEN);
  });
});
