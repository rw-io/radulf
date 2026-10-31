import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const mocks = vi.hoisted(() => ({
  staleSeconds: 120,
  getPull: vi.fn(),
  getCombinedStatus: vi.fn(),
  mergePull: vi.fn(),
  failedJobLogs: vi.fn(),
}));

// Spec 33: the pull request poller's Gitea calls, held mid-flight by the
// tests that need a merge or a CI hand-off in progress.
vi.mock("./gitea", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gitea")>()),
  getPull: mocks.getPull,
  getCombinedStatus: mocks.getCombinedStatus,
  mergePull: mocks.mergePull,
  failedJobLogs: mocks.failedJobLogs,
}));
vi.mock("./forgeConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./forgeConnections")>()),
  connectionAuth: () => ({ baseUrl: "https://gitea.example", token: "tok" }),
}));

vi.mock("./settings", async (importOriginal) => {
  // Built from the original's defaults rather than testSettings: that helper
  // loads @/server/settings, which is this very module, so importing it from
  // inside its own mock factory deadlocks. See orchestrator.roles.test.ts.
  const original = await importOriginal<typeof import("./settings")>();
  return {
    ...original,
    getSettings: () => ({
      ...original.SETTING_DEFAULTS,
      autoMode: false,
      sandboxEnabled: false,
      workerStaleSeconds: mocks.staleSeconds,
    }),
  };
});

const testDataDir = setupTestDataDir("radulf-orchestrator-shutdown-");

const { db, cards, events, iterations, plans, prWaits, repoLeases, repos, reviewDeliveries, runs, workers, now } =
  await import("@/db");
const { Orchestrator, disposeAllOrchestrators } = await import("./orchestrator");
const { runScratchRoot } = await import("./sandbox/context");
const { planStatePath } = await import("./bookkeeping");
const { HEARTBEAT_INTERVAL_MS } = await import("./workers");

type Global = { __radulfOrchestrator?: unknown };

function seedCard(id: string, overrides: Partial<typeof cards.$inferInsert> = {}) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "Rough ask",
      status: "backlog",
      position: 1,
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run();
}

function seedRun(id: string, cardId: string, overrides: Partial<typeof runs.$inferInsert> = {}) {
  db.insert(runs)
    .values({
      id,
      cardId,
      kind: "loop",
      status: "running",
      worktreePath: "/tmp/wt",
      branch: "ralph/x",
      startedAt: now(),
      ...overrides,
    })
    .run();
}

function seedWorker(id: string, heartbeatAt: string) {
  db.insert(workers)
    .values({ id, host: "test", pid: 1, roles: JSON.stringify(["worker"]), startedAt: heartbeatAt, heartbeatAt })
    .run();
}

function seedDelivery(
  id: string,
  cardId: string,
  runId: string,
  overrides: Partial<typeof reviewDeliveries.$inferInsert> = {},
) {
  db.insert(reviewDeliveries)
    .values({
      id,
      runId,
      cardId,
      repoId: "repo-1",
      fromStatus: "review",
      approvedBy: "human",
      status: "pending",
      createdAt: now(),
      ...overrides,
    })
    .run();
}

const card = (id: string) => db.select().from(cards).where(eq(cards.id, id)).get()!;
const delivery = (id: string) => db.select().from(reviewDeliveries).where(eq(reviewDeliveries.id, id)).get()!;
const lease = (repoPath: string) => db.select().from(repoLeases).where(eq(repoLeases.repoPath, repoPath)).get();
const run = (id: string) => db.select().from(runs).where(eq(runs.id, id)).get()!;
const worker = (id: string) => db.select().from(workers).where(eq(workers.id, id)).get();

beforeEach(() => {
  mocks.staleSeconds = 120;
  vi.clearAllMocks();
  db.delete(prWaits).run();
  db.delete(reviewDeliveries).run();
  db.delete(repoLeases).run();
  db.delete(workers).run();
  db.delete(iterations).run();
  db.delete(runs).run();
  db.delete(plans).run();
  db.delete(events).run();
  db.delete(cards).run();
  db.delete(repos).run();
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: "/tmp/repo-1", defaultBranch: "main", createdAt: now() })
    .run();
  fs.rmSync(runScratchRoot(), { recursive: true, force: true });
});

afterEach(() => {
  disposeAllOrchestrators();
  (globalThis as Global).__radulfOrchestrator = undefined;
  vi.useRealTimers();
});

describe("releaseOwnedWork", () => {
  it("interrupts its own resumable loop run and puts the card back in ready", () => {
    const o = new Orchestrator({ autoStart: false });
    seedCard("c1", { status: "looping" });
    db.insert(plans)
      .values({
        id: "p1",
        cardId: "c1",
        version: 1,
        planMd: "## Tasks\n- [x] a\n- [ ] b\n",
        promptMd: "",
        acceptanceCriteria: "",
        createdAt: now(),
      })
      .run();
    const planPath = planStatePath("c1");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "## Tasks\n- [x] a\n- [ ] b\n");
    const worktreePath = path.join(testDataDir, "worktrees", "c1-run");
    fs.mkdirSync(worktreePath, { recursive: true });
    seedRun("r1", "c1", { workerId: o.workerId, worktreePath });

    expect(o.releaseOwnedWork()).toEqual({ runs: 1, deliveries: 0 });

    expect(run("r1").status).toBe("interrupted");
    expect(run("r1").exitReason).toBe("worker shut down before this stage finished");
    expect(card("c1").status).toBe("ready");
    expect(worker(o.workerId)).toBeUndefined();
  });

  it("parks a planning run's card in needs_attention", () => {
    const o = new Orchestrator({ autoStart: false });
    seedCard("c1", { status: "planning" });
    seedRun("r1", "c1", { kind: "plan", workerId: o.workerId });

    expect(o.releaseOwnedWork()).toEqual({ runs: 1, deliveries: 0 });

    expect(run("r1").status).toBe("interrupted");
    expect(run("r1").exitReason).toBe("worker shut down before this stage finished");
    expect(card("c1").status).toBe("needs_attention");
  });

  it("never touches a peer's running run, lease or worker row", () => {
    const o = new Orchestrator({ autoStart: false });
    seedWorker("peer", now());
    seedCard("c2", { status: "looping" });
    seedRun("r2", "c2", { workerId: "peer" });
    db.insert(repoLeases).values({ repoPath: "/tmp/repo-1", workerId: "peer", acquiredAt: now() }).run();

    expect(o.releaseOwnedWork()).toEqual({ runs: 0, deliveries: 0 });

    expect(run("r2").status).toBe("running");
    expect(card("c2").status).toBe("looping");
    expect(lease("/tmp/repo-1")?.workerId).toBe("peer");
    expect(worker("peer")).toBeDefined();
  });

  it("deletes its own workers row and the heartbeat timer never re-inserts it", () => {
    vi.useFakeTimers();
    const o = new Orchestrator({ autoStart: false });
    expect(worker(o.workerId)).toBeDefined();

    o.releaseOwnedWork();

    expect(worker(o.workerId)).toBeUndefined();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(worker(o.workerId)).toBeUndefined();
  });

  it("fails its own running review delivery, frees its lease and parks the card", () => {
    const o = new Orchestrator({ autoStart: false });
    seedCard("c1", { status: "reviewing" });
    seedRun("r1", "c1", { status: "completed", endedAt: now() });
    seedDelivery("d1", "c1", "r1", { status: "running", workerId: o.workerId, claimedAt: now() });
    db.insert(repoLeases).values({ repoPath: "/tmp/repo-1", workerId: o.workerId, acquiredAt: now() }).run();

    expect(o.releaseOwnedWork()).toEqual({ runs: 0, deliveries: 1 });

    expect(delivery("d1").status).toBe("finished");
    expect(delivery("d1").ok).toBe(0);
    expect(delivery("d1").error).toContain("press Retry merge");
    expect(delivery("d1").error).toContain("/tmp/repo-1");
    expect(lease("/tmp/repo-1")).toBeUndefined();
    expect(card("c1").status).toBe("needs_attention");
  });

  it("a fresh orchestrator pumps the released card at boot without waiting for the stale window", () => {
    const o = new Orchestrator({ autoStart: false });
    seedCard("c1", { status: "looping" });
    db.insert(plans)
      .values({
        id: "p1",
        cardId: "c1",
        version: 1,
        planMd: "## Tasks\n- [x] a\n- [ ] b\n",
        promptMd: "",
        acceptanceCriteria: "",
        createdAt: now(),
      })
      .run();
    const planPath = planStatePath("c1");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "## Tasks\n- [x] a\n- [ ] b\n");
    const worktreePath = path.join(testDataDir, "worktrees", "c1-run");
    fs.mkdirSync(worktreePath, { recursive: true });
    seedRun("r1", "c1", { workerId: o.workerId, worktreePath });

    expect(o.releaseOwnedWork()).toEqual({ runs: 1, deliveries: 0 });
    expect(card("c1").status).toBe("ready");

    // Spying on the claim lets the boot pump reach the card without starting a
    // real loop harness: the point is that a replacement worker sees the card
    // as claimable the moment it boots, not `workerStaleSeconds` later.
    const claim = vi.spyOn(Orchestrator.prototype, "claimLoopRun").mockReturnValue(null);
    const fresh = new Orchestrator();

    expect(claim).toHaveBeenCalledWith("c1");
    expect(card("c1").status).toBe("ready");
    expect(run("r1").status).toBe("interrupted");
    expect(worker(o.workerId)).toBeUndefined();

    claim.mockRestore();
    fresh.startDraining();
  });
});

describe("spec 33: the pull request poller and a restart", () => {
  const PR = {
    number: 7,
    url: "https://gitea.example/o/r/pulls/7",
    state: "open" as const,
    merged: false,
    mergeable: true,
    headSha: "head-1",
    mergeCommitSha: null,
  };

  /** A card waiting for CI on its pull request, pushed ten minutes ago. */
  function seedWaitingCard() {
    seedCard("c1", { status: "awaiting_ci" });
    db.insert(plans)
      .values({ id: "p1", cardId: "c1", version: 1, planMd: "## Tasks\n- [x] a\n", promptMd: "", acceptanceCriteria: "", createdAt: now() })
      .run();
    seedRun("r1", "c1", { planId: "p1", status: "completed", endedAt: now() });
    const pushedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    db.insert(prWaits)
      .values({
        id: "w1",
        cardId: "c1",
        runId: "r1",
        repoId: "repo-1",
        connectionId: "conn-1",
        owner: "o",
        repo: "r",
        branch: "ralph/x",
        baseBranch: "main",
        prNumber: 7,
        prUrl: PR.url,
        headSha: "head-1",
        status: "waiting",
        pushedAt,
        createdAt: pushedAt,
      })
      .run();
  }

  function held<T>() {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => (settle = resolve));
    return { promise, settle };
  }

  const wait = () => db.select().from(prWaits).where(eq(prWaits.id, "w1")).get()!;

  it("hasInFlightWork is true while the poller merges, so the drain waits for it", async () => {
    const o = new Orchestrator({ autoStart: false });
    seedWaitingCard();
    mocks.getPull.mockResolvedValue(PR);
    mocks.getCombinedStatus.mockResolvedValue({ state: "success", statuses: [] });
    let fail!: (e: Error) => void;
    mocks.mergePull.mockReturnValue(new Promise((_, reject) => (fail = reject)));

    expect(o.hasInFlightWork()).toBe(false);
    o.pump();
    await vi.waitFor(() => expect(mocks.mergePull).toHaveBeenCalled());

    expect(card("c1").status).toBe("reviewing");
    expect(o.hasInFlightWork()).toBe(true);
    fail(new Error("bad gateway"));
    await vi.waitFor(() => expect(card("c1").status).toBe("awaiting_ci"));
    expect(o.hasInFlightWork()).toBe(false);
  });

  it("a worker that dies between the CI failure claim and the loop hand-off leaves a wait the next boot resumes", async () => {
    const dying = new Orchestrator({ autoStart: false });
    seedWaitingCard();
    mocks.getPull.mockResolvedValue(PR);
    mocks.getCombinedStatus.mockResolvedValue({
      state: "failure",
      statuses: [{ context: "ci/build", state: "failure", targetUrl: null }],
    });
    // The hand-off never gets the logs: the process "dies" while it waits.
    mocks.failedJobLogs.mockReturnValue(held<never[]>().promise);

    dying.pump();
    await vi.waitFor(() => expect(mocks.failedJobLogs).toHaveBeenCalled());
    expect(card("c1").status).toBe("reviewing");
    expect(wait().status).toBe("waiting");

    // Dead: no heartbeat (its row goes stale) and nothing it held is released.
    dying.dispose();
    db.update(workers).set({ heartbeatAt: new Date(Date.now() - 600_000).toISOString() }).where(eq(workers.id, dying.workerId)).run();
    // The new worker's first poll stops at its read of the pull request, so
    // only boot recovery acts on the card here.
    mocks.getPull.mockReturnValue(new Promise(() => {}));
    const fresh = new Orchestrator();

    expect(card("c1").status).toBe("awaiting_ci");
    expect(wait().status).toBe("waiting");
    expect(db.select().from(plans).where(eq(plans.cardId, "c1")).all()).toHaveLength(1);
    fresh.startDraining();
  });
});
