import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardStatus } from "@/db";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// Spec 33 decision 5, up to an open pull request: an approved card on a
// repository that matches a Gitea connection is pushed with the connection's
// token and opened as a PR there, then parked in `awaiting_ci`. The git, Gitea
// and gh boundaries are mocked; what is under test is the decision, the order
// and where each failure leaves the card.

const mocks = vi.hoisted(() => ({
  mergeBranch: vi.fn(),
  mergeBaseIntoWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  hasRemote: vi.fn(),
  pushBranch: vi.fn(),
  stripRalphForDelivery: vi.fn(),
  fetchBranchHead: vi.fn(),
  pushRef: vi.fn(),
  git: vi.fn(),
  localOnlyCommits: vi.fn(),
  findOpenPull: vi.fn(),
  createPull: vi.fn(),
  matchRepo: vi.fn(),
  checkConnection: vi.fn(),
  invalidateConnectionCheck: vi.fn(),
  connectionAuth: vi.fn(),
  githubStatus: vi.fn(),
  createPullRequest: vi.fn(),
  findOpenPullRequest: vi.fn(),
  invalidateGithubStatus: vi.fn(),
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
  mergeBaseIntoWorktree: mocks.mergeBaseIntoWorktree,
  removeWorktree: mocks.removeWorktree,
  hasRemote: mocks.hasRemote,
  pushBranch: mocks.pushBranch,
  stripRalphForDelivery: mocks.stripRalphForDelivery,
  fetchBranchHead: mocks.fetchBranchHead,
  pushRef: mocks.pushRef,
  git: mocks.git,
  localOnlyCommits: mocks.localOnlyCommits,
}));
vi.mock("./gitea", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gitea")>()),
  findOpenPull: mocks.findOpenPull,
  createPull: mocks.createPull,
}));
vi.mock("./forgeMatch", () => ({ matchRepo: mocks.matchRepo }));
vi.mock("./forgeConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./forgeConnections")>()),
  checkConnection: mocks.checkConnection,
  invalidateConnectionCheck: mocks.invalidateConnectionCheck,
  connectionAuth: mocks.connectionAuth,
}));
vi.mock("./github", () => ({
  githubStatus: mocks.githubStatus,
  createPullRequest: mocks.createPullRequest,
  findOpenPullRequest: mocks.findOpenPullRequest,
  invalidateGithubStatus: mocks.invalidateGithubStatus,
}));
vi.mock("./settings", () => ({ getSettings: () => mocks.settings }));

const testDataDir = setupTestDataDir("radulf-reviewService-gitea-");

const { db, cards, events, improvementRuns, plans, prWaits, repoLeases, repos, reviewDeliveries, reviews, runs, now } =
  await import("@/db");
const { ReviewService } = await import("./reviewService");
const { giteaPullRequestBody } = await import("./giteaDelivery");

const TOKEN = "gta_5ecret_t0ken_value";
const CONNECTION = {
  id: "conn-1",
  kind: "gitea" as const,
  baseUrl: "https://gitea.example",
  account: "radulf-bot",
  checkError: null as string | null,
  checkedAt: null,
  updatedAt: "2026-10-30T00:00:00.000Z",
};
const FORGE = { connection: CONNECTION, owner: "o", repo: "r", cloneUrl: "https://gitea.example/o/r.git" };
const AUTH = { baseUrl: "https://gitea.example", token: TOKEN };
const TARGET = { kind: "forge", url: FORGE.cloneUrl, username: "radulf-bot", token: TOKEN };
const PR_URL = "https://gitea.example/o/r/pulls/7";
const PULL = {
  number: 7,
  url: PR_URL,
  state: "open" as const,
  merged: false,
  mergeable: true,
  headSha: "pr-head",
  mergeCommitSha: null,
};

function seedRepo() {
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: path.join(testDataDir, "repo"), defaultBranch: "main", createdAt: now() })
    .run();
}

function seedCard(id: string, openPr: 0 | 1 = 1) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "Gitea delivery test card",
      status: "review",
      position: 1,
      openPr,
      summary: "The evaluator's summary of the change.",
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
  return { id, worktreePath, branch: `ralph/${id}` };
}

/** Deps whose `moveCard` really moves the row, so statuses read back the way
 * the orchestrator's would. */
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

function eventPayload(cardId: string, type: string): Record<string, unknown> | undefined {
  const row = db
    .select()
    .from(events)
    .where(and(eq(events.cardId, cardId), eq(events.type, type)))
    .orderBy(desc(events.id))
    .get();
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

describe("ReviewService: spec 33 Gitea pull request delivery", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(improvementRuns).run();
    db.delete(reviews).run();
    db.delete(reviewDeliveries).run();
    db.delete(repoLeases).run();
    db.delete(prWaits).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.settings.openPr = false;
    mocks.mergeBranch.mockResolvedValue({ ok: true, mergeCommit: "abc123" });
    mocks.mergeBaseIntoWorktree.mockResolvedValue({ ok: true, conflicted: false, out: "" });
    mocks.removeWorktree.mockResolvedValue(undefined);
    mocks.hasRemote.mockResolvedValue(true);
    mocks.pushBranch.mockResolvedValue({ ok: true });
    mocks.stripRalphForDelivery.mockResolvedValue({ ok: true, out: "" });
    mocks.fetchBranchHead.mockResolvedValue({ ok: true, sha: "remote-base-sha" });
    mocks.pushRef.mockResolvedValue({ ok: true });
    mocks.git.mockResolvedValue("local-head-sha");
    mocks.localOnlyCommits.mockResolvedValue([]);
    mocks.findOpenPull.mockResolvedValue(null);
    mocks.createPull.mockResolvedValue(PULL);
    mocks.matchRepo.mockResolvedValue(FORGE);
    mocks.checkConnection.mockResolvedValue({ ...CONNECTION, checkError: null });
    mocks.connectionAuth.mockReturnValue(AUTH);
    mocks.githubStatus.mockResolvedValue({ ok: true });
    mocks.createPullRequest.mockResolvedValue({ ok: true, url: "https://github.com/o/r/pull/7" });
    mocks.findOpenPullRequest.mockResolvedValue({ ok: true, pr: null });
    seedRepo();
  });

  it("matched repo delivers through gitea, never gh", async () => {
    seedCard("card-gitea");
    const run = seedRun("card-gitea");
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result).toEqual({ ok: true });
    expect(mocks.githubStatus).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(mocks.checkConnection).toHaveBeenCalledWith("conn-1", { refresh: true });
    expect(mocks.pushRef).toHaveBeenCalledWith(run.worktreePath, TARGET, `HEAD:refs/heads/${run.branch}`);
    expect(mocks.createPull).toHaveBeenCalledWith(
      AUTH,
      "o",
      "r",
      expect.objectContaining({ head: run.branch, base: "main", title: "Card card-gitea" }),
    );
    expect(statusOf("card-gitea")).toBe("awaiting_ci");
    expect(lastReason(deps)).toBe(`waiting for CI on ${PR_URL}`);
    const waits = db.select().from(prWaits).all();
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      cardId: "card-gitea",
      runId: run.id,
      repoId: "repo-1",
      connectionId: "conn-1",
      owner: "o",
      repo: "r",
      branch: run.branch,
      baseBranch: "main",
      prNumber: 7,
      prUrl: PR_URL,
      headSha: "local-head-sha",
      status: "waiting",
      endedAt: null,
    });
    expect(mocks.git).toHaveBeenCalledWith(run.worktreePath, "rev-parse", "HEAD");
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(db.select().from(reviews).where(eq(reviews.decision, "approved")).all()).toHaveLength(0);
    expect(eventPayload("card-gitea", "review.pr_opened")).toEqual({
      delivery: "gitea",
      prUrl: PR_URL,
      grantedBy: "card",
      reusedOpenPr: false,
    });
  });

  it("syncs from the remote base, not the local one", async () => {
    seedCard("card-remote-base");
    const run = seedRun("card-remote-base");

    await new ReviewService(makeDeps()).approve(run.id);

    expect(mocks.fetchBranchHead).toHaveBeenCalledWith(run.worktreePath, TARGET, "main");
    expect(mocks.mergeBaseIntoWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.mergeBaseIntoWorktree).toHaveBeenCalledWith(run.worktreePath, "remote-base-sha");
    const order = [
      mocks.fetchBranchHead.mock.invocationCallOrder[0],
      mocks.mergeBaseIntoWorktree.mock.invocationCallOrder[0],
      mocks.stripRalphForDelivery.mock.invocationCallOrder[0],
      mocks.pushRef.mock.invocationCallOrder[0],
      mocks.createPull.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("a local-only commit on the local base that reached the branch blocks delivery", async () => {
    seedCard("card-local-only");
    const run = seedRun("card-local-only");
    mocks.localOnlyCommits.mockResolvedValue([
      "abc1234 operator's unpushed fix",
      "def5678 sibling card merge whose push failed",
    ]);
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(mocks.localOnlyCommits).toHaveBeenCalledWith(run.worktreePath, "main", "remote-base-sha");
    expect(statusOf("card-local-only")).toBe("needs_attention");
    const reason = lastReason(deps)!;
    expect(reason).toContain("`main`");
    expect(reason).toContain("gitea.example");
    expect(reason).toContain("abc1234 operator's unpushed fix; def5678 sibling card merge whose push failed");
    expect(mocks.stripRalphForDelivery).not.toHaveBeenCalled();
    expect(mocks.pushRef).not.toHaveBeenCalled();
    expect(mocks.createPull).not.toHaveBeenCalled();
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(db.select().from(prWaits).all()).toHaveLength(0);
  });

  it("lists at most five local-only commits and counts the rest", async () => {
    seedCard("card-many-local");
    const run = seedRun("card-many-local");
    mocks.localOnlyCommits.mockResolvedValue(["c1 one", "c2 two", "c3 three", "c4 four", "c5 five", "c6 six", "c7 seven"]);
    const deps = makeDeps();

    await new ReviewService(deps).approve(run.id);

    const reason = lastReason(deps)!;
    expect(reason).toContain("c1 one; c2 two; c3 three; c4 four; c5 five and 2 more");
    expect(reason).not.toContain("c6 six");
    expect(mocks.pushRef).not.toHaveBeenCalled();
  });

  it("reuses an open pr", async () => {
    mocks.settings.openPr = true;
    seedCard("card-reuse", 0);
    const run = seedRun("card-reuse");
    mocks.findOpenPull.mockResolvedValue({ ...PULL, number: 3, url: "https://gitea.example/o/r/pulls/3" });

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result).toEqual({ ok: true });
    expect(mocks.findOpenPull).toHaveBeenCalledWith(AUTH, "o", "r", run.branch, "main");
    expect(mocks.createPull).not.toHaveBeenCalled();
    expect(statusOf("card-reuse")).toBe("awaiting_ci");
    expect(db.select().from(prWaits).get()).toMatchObject({ prNumber: 3, prUrl: "https://gitea.example/o/r/pulls/3" });
    expect(eventPayload("card-reuse", "review.pr_opened")).toMatchObject({
      delivery: "gitea",
      grantedBy: "global",
      reusedOpenPr: true,
    });
  });

  it("losing the claim before the wait starts leaves no wait behind", async () => {
    seedCard("card-claim-lost");
    const run = seedRun("card-claim-lost");
    const deps = makeDeps();
    const move = deps.moveCard.getMockImplementation()!;
    deps.moveCard.mockImplementation((cardId, from, to, reason) => to !== "awaiting_ci" && move(cardId, from, to, reason));

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("review claim was lost");
    expect(db.select().from(prWaits).all()).toHaveLength(0);
  });

  it("bad token is an unmet precondition", async () => {
    seedCard("card-bad-token");
    const run = seedRun("card-bad-token");
    mocks.checkConnection.mockResolvedValue({ ...CONNECTION, checkError: "401" });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
    expect(result.error).toContain("gitea.example");
    // Back to review, so the Approve button is still there once the token is
    // fixed in Settings.
    expect(statusOf("card-bad-token")).toBe("review");
    expect(mocks.fetchBranchHead).not.toHaveBeenCalled();
    expect(mocks.pushRef).not.toHaveBeenCalled();
    expect(mocks.createPull).not.toHaveBeenCalled();
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(db.select().from(prWaits).all()).toHaveLength(0);
    expect(eventPayload("card-bad-token", "review.decided")).toMatchObject({
      delivery: "gitea",
      prBlocked: expect.stringContaining("401"),
    });
  });

  it("base conflict hands back to the loop", async () => {
    seedCard("card-conflict");
    const run = seedRun("card-conflict");
    mocks.mergeBaseIntoWorktree.mockResolvedValue({
      ok: false,
      conflicted: true,
      out: "CONFLICT (content): both modified src/a.ts",
    });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("handed back to the loop");
    expect(mocks.pushRef).not.toHaveBeenCalled();
    expect(mocks.createPull).not.toHaveBeenCalled();
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    // reloopForConflict took the merge result as given: no second merge on a
    // worktree that already holds conflict markers.
    expect(mocks.mergeBaseIntoWorktree).toHaveBeenCalledTimes(1);
    expect(statusOf("card-conflict")).toBe("ready");
    const plan = deps.latestPlan("card-conflict");
    expect(plan?.version).toBe(2);
    expect(plan?.feedback).toContain("merge conflict with main");
    expect(eventPayload("card-conflict", "review.decided")).toMatchObject({ delivery: "gitea", reloop: true });
  });

  it("push failure parks the card and scrubs the token", async () => {
    seedCard("card-push-fail");
    const run = seedRun("card-push-fail");
    mocks.pushRef.mockResolvedValue({
      ok: false,
      error: `remote: invalid credentials for radulf-bot:${TOKEN}\nfatal: Authentication failed`,
      rejected: false,
    });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(statusOf("card-push-fail")).toBe("needs_attention");
    expect(lastReason(deps)).toContain("Authentication failed");
    expect(lastReason(deps)).not.toContain(TOKEN);
    expect(result.error).not.toContain(TOKEN);
    const delivery = db.select().from(reviewDeliveries).get();
    expect(delivery?.error).toContain("Authentication failed");
    expect(delivery?.error).not.toContain(TOKEN);
    for (const row of db.select().from(events).all()) expect(row.payload).not.toContain(TOKEN);
    expect(mocks.invalidateConnectionCheck).toHaveBeenCalledWith("conn-1");
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(mocks.createPull).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(db.select().from(prWaits).all()).toHaveLength(0);
  });

  it("a gitea api failure parks the card and never merges", async () => {
    seedCard("card-api-fail");
    const run = seedRun("card-api-fail");
    mocks.createPull.mockRejectedValue(new Error(`token ${TOKEN} lacks the write:repository scope`));
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(statusOf("card-api-fail")).toBe("needs_attention");
    expect(lastReason(deps)).toContain("write:repository");
    expect(lastReason(deps)).not.toContain(TOKEN);
    expect(mocks.invalidateConnectionCheck).toHaveBeenCalledWith("conn-1");
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(db.select().from(prWaits).all()).toHaveLength(0);
  });

  it("a match that cannot be decided parks the card and never takes the gh path", async () => {
    seedCard("card-lookup-failed");
    const run = seedRun("card-lookup-failed");
    mocks.matchRepo.mockRejectedValue(
      new Error("cannot match the repository to a connection: could not look up o/r on gitea.example: fetch failed"),
    );
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("gitea.example");
    expect(statusOf("card-lookup-failed")).toBe("needs_attention");
    expect(lastReason(deps)).toContain("could not look up o/r on gitea.example");
    expect(mocks.githubStatus).not.toHaveBeenCalled();
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
    expect(mocks.findOpenPullRequest).not.toHaveBeenCalled();
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(mocks.pushRef).not.toHaveBeenCalled();
    expect(eventPayload("card-lookup-failed", "review.decided")).toMatchObject({
      prFailed: expect.stringContaining("gitea.example"),
    });
  });

  it("unmatched repo keeps the gh path", async () => {
    seedCard("card-github");
    const run = seedRun("card-github");
    mocks.matchRepo.mockResolvedValue(null);

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result).toEqual({ ok: true });
    expect(mocks.pushBranch).toHaveBeenCalledWith(run.worktreePath, run.branch);
    expect(mocks.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "main", branch: run.branch }),
    );
    expect(mocks.checkConnection).not.toHaveBeenCalled();
    expect(mocks.pushRef).not.toHaveBeenCalled();
    expect(mocks.createPull).not.toHaveBeenCalled();
    expect(statusOf("card-github")).toBe("done");
  });

  it("an improvement run card never opens a gitea pr", async () => {
    mocks.settings.openPr = true;
    db.insert(improvementRuns)
      .values({
        id: "improve-1",
        repoId: "repo-1",
        featureBranch: "ralph/improve-123",
        baseBranch: "main",
        deadlineAt: now(),
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    seedCard("card-improve", 0);
    const run = seedRun("card-improve", "ralph/improve-123");

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result).toEqual({ ok: true });
    expect(mocks.mergeBranch).toHaveBeenCalledTimes(1);
    expect(mocks.matchRepo).not.toHaveBeenCalled();
    expect(mocks.pushRef).not.toHaveBeenCalled();
    expect(mocks.createPull).not.toHaveBeenCalled();
  });

  it("auto-approved body says so", () => {
    seedCard("card-body");
    const card = db.select().from(cards).where(eq(cards.id, "card-body")).get()!;

    const auto = giteaPullRequestBody(card, "auto");
    const human = giteaPullRequestBody(card, "human");

    expect(auto).toContain("Gitea delivery test card");
    expect(auto).toContain("## Summary\n\nThe evaluator's summary of the change.");
    expect(auto).toContain(
      "Opened by Radulf from card `card-body`, approved by Radulf's evaluator under auto-approve. Radulf merges it once CI passes.",
    );
    expect(human).toContain(
      "Opened by Radulf from card `card-body`, approved by a human. Radulf merges it once CI passes.",
    );
  });

  it("waiting holds no lease", async () => {
    seedCard("card-first");
    const first = seedRun("card-first");
    const service = new ReviewService(makeDeps());

    await service.approve(first.id);

    expect(statusOf("card-first")).toBe("awaiting_ci");
    expect(db.select().from(repoLeases).all()).toEqual([]);

    seedCard("card-second");
    const second = seedRun("card-second");
    const result = await service.approve(second.id);

    expect(result).toEqual({ ok: true });
    const delivery = db.select().from(reviewDeliveries).where(eq(reviewDeliveries.runId, second.id)).get();
    expect(delivery).toMatchObject({ status: "finished", ok: 1, workerId: "worker-test" });
    expect(delivery?.claimedAt).not.toBeNull();
    expect(statusOf("card-second")).toBe("awaiting_ci");
    expect(db.select().from(repoLeases).all()).toEqual([]);
  });
});
