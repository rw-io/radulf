import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { git, initScratchRepo } from "@/testUtils/gitRepo";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// Spec 33 decision 4, against real git: a bare repository stands in for the
// remote and a clone of it for the registered repository. Every git call runs
// for real; `pushRef` is only wrapped so a test can move the remote between
// the reconcile and the push.
vi.mock("./git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git")>();
  return { ...actual, pushRef: vi.fn(actual.pushRef) };
});

setupTestDataDir("radulf-base-reconcile-");

const actualGit = await vi.importActual<typeof import("./git")>("./git");
const { pushRef } = await import("./git");
const { pushBase, reconcileBase } = await import("./baseReconcile");

const ORIGIN = { kind: "origin" } as const;
const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function cloneOf(bare: string): string {
  const dir = path.join(tmp("radulf-reconcile-clone-"), "clone");
  execFileSync("git", ["clone", "-q", bare, dir]);
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  return dir;
}

function commit(dir: string, file: string, content = file): string {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", file);
  return git(dir, "rev-parse", "HEAD");
}

/** A bare repository with one commit on `main`, and a clone of it. */
function remoteAndClone(): { bare: string; clone: string } {
  const seed = initScratchRepo("radulf-reconcile-seed-");
  dirs.push(seed);
  const bare = path.join(tmp("radulf-reconcile-bare-"), "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  return { bare, clone: cloneOf(bare) };
}

/** Someone else pushes a commit to the remote's `main`. */
function advanceRemote(bare: string, file: string, content = file): string {
  const other = cloneOf(bare);
  commit(other, file, content);
  git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
  return git(bare, "rev-parse", "main");
}

/** Ignore `pattern` in `dir` alone, the way an operator's own excludes do. */
function ignoreLocally(dir: string, pattern: string): void {
  const info = path.join(dir, ".git", "info");
  fs.mkdirSync(info, { recursive: true });
  fs.appendFileSync(path.join(info, "exclude"), `${pattern}\n`);
}

function isAncestor(dir: string, commitish: string, of: string): boolean {
  try {
    git(dir, "merge-base", "--is-ancestor", commitish, of);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("reconcileBase", () => {
  it("fast-forwards a local base that is behind", async () => {
    const { bare, clone } = remoteAndClone();
    const tip = advanceRemote(bare, "ahead.txt");
    const writes: string[] = [];

    expect(await reconcileBase(clone, "main", ORIGIN, (sha) => writes.push(sha))).toEqual({ ok: true, remoteSha: tip });

    expect(git(clone, "rev-parse", "main")).toBe(tip);
    expect(git(clone, "rev-list", "--merges", "main")).toBe("");
    expect(fs.readFileSync(path.join(clone, "ahead.txt"), "utf8")).toBe("ahead.txt");
    expect(writes).toEqual([tip]);
  });

  it("fast-forwards a base that is not checked out without touching the checkout", async () => {
    const { bare, clone } = remoteAndClone();
    git(clone, "checkout", "-qb", "feature");
    const tip = advanceRemote(bare, "ahead.txt");
    const writes: string[] = [];

    expect(await reconcileBase(clone, "main", ORIGIN, (sha) => writes.push(sha))).toEqual({ ok: true, remoteSha: tip });

    expect(git(clone, "rev-parse", "main")).toBe(tip);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(fs.existsSync(path.join(clone, "ahead.txt"))).toBe(false);
    expect(writes).toEqual([tip]);
  });

  it("refuses to fast-forward a checkout with uncommitted changes", async () => {
    const { bare, clone } = remoteAndClone();
    const before = git(clone, "rev-parse", "main");
    advanceRemote(bare, "ahead.txt");
    fs.writeFileSync(path.join(clone, "README.md"), "operator's edit");
    const writes: string[] = [];

    const result = await reconcileBase(clone, "main", ORIGIN, (sha) => writes.push(sha));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("has uncommitted changes");
    expect(git(clone, "rev-parse", "main")).toBe(before);
    expect(fs.readFileSync(path.join(clone, "README.md"), "utf8")).toBe("operator's edit");
    expect(writes).toEqual([]);
  });

  it("refuses to fast-forward over an ignored file the remote starts tracking", async () => {
    const { bare, clone } = remoteAndClone();
    const before = git(clone, "rev-parse", "main");
    ignoreLocally(clone, ".env");
    fs.writeFileSync(path.join(clone, ".env"), "OPERATOR_VALUE=1\n");
    expect(git(clone, "status", "--porcelain")).toBe("");
    advanceRemote(bare, ".env", "UPSTREAM_VALUE=1\n");
    const writes: string[] = [];

    const result = await reconcileBase(clone, "main", ORIGIN, (sha) => writes.push(sha));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("would overwrite ignored files");
    expect(!result.ok && result.error).toContain(".env");
    expect(fs.readFileSync(path.join(clone, ".env"), "utf8")).toBe("OPERATOR_VALUE=1\n");
    expect(git(clone, "rev-parse", "main")).toBe(before);
    expect(writes).toEqual([]);
  });

  it("refuses to fast-forward when the remote adds a directory where an ignored file stands", async () => {
    const { bare, clone } = remoteAndClone();
    const before = git(clone, "rev-parse", "main");
    ignoreLocally(clone, "cfg");
    fs.writeFileSync(path.join(clone, "cfg"), "operator settings");
    const other = cloneOf(bare);
    fs.mkdirSync(path.join(other, "cfg"));
    commit(other, "cfg/settings", "upstream settings");
    git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
    const writes: string[] = [];

    const result = await reconcileBase(clone, "main", ORIGIN, (sha) => writes.push(sha));

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(clone, "cfg"), "utf8")).toBe("operator settings");
    expect(git(clone, "rev-parse", "main")).toBe(before);
    expect(writes).toEqual([]);
  });

  it("merges when both moved", async () => {
    const { bare, clone } = remoteAndClone();
    const remoteTip = advanceRemote(bare, "remote.txt");
    const localTip = commit(clone, "local.txt");
    const writes: string[] = [];

    expect(await reconcileBase(clone, "main", ORIGIN, (sha) => writes.push(sha))).toEqual({
      ok: true,
      remoteSha: remoteTip,
    });

    const merge = git(clone, "rev-parse", "main");
    expect(git(clone, "rev-list", "--parents", "-n", "1", "main").split(" ").slice(1)).toEqual([localTip, remoteTip]);
    expect(git(clone, "log", "-1", "--format=%s", "main")).toBe("ralph: merge remote main into main");
    expect(writes).toEqual([merge]);
  });

  it("stops on a conflict without moving the base", async () => {
    const { bare, clone } = remoteAndClone();
    advanceRemote(bare, "README.md", "remote edit");
    const localTip = commit(clone, "README.md", "local edit");
    const writes: string[] = [];

    const result = await reconcileBase(clone, "main", ORIGIN, (sha) => writes.push(sha));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("diverged and conflict");
    expect(git(clone, "rev-parse", "main")).toBe(localTip);
    expect(fs.existsSync(path.join(clone, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(writes).toEqual([]);
  });

  it("is a no-op when local is ahead", async () => {
    const { bare, clone } = remoteAndClone();
    const remoteTip = git(bare, "rev-parse", "main");
    const localTip = commit(clone, "local.txt");
    const writes: string[] = [];

    expect(await reconcileBase(clone, "main", ORIGIN, (sha) => writes.push(sha))).toEqual({
      ok: true,
      remoteSha: remoteTip,
    });

    expect(git(clone, "rev-parse", "main")).toBe(localTip);
    expect(writes).toEqual([]);
  });

  it("names a missing remote branch", async () => {
    const { clone } = remoteAndClone();
    git(clone, "branch", "trunk");

    const result = await reconcileBase(clone, "trunk", ORIGIN, () => {});

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("`trunk` does not exist on the remote");
  });
});

describe("pushBase", () => {
  it("pushBase retries once after a rejection", async () => {
    const { bare, clone } = remoteAndClone();
    const local = commit(clone, "local.txt");
    expect(await reconcileBase(clone, "main", ORIGIN, () => {})).toMatchObject({ ok: true });
    let racing = "";
    vi.mocked(pushRef).mockImplementationOnce(async (...args) => {
      racing = advanceRemote(bare, "racing.txt");
      return actualGit.pushRef(...args);
    });
    const writes: string[] = [];

    expect(await pushBase(clone, "main", ORIGIN, (sha) => writes.push(sha))).toEqual({ ok: true });

    expect(pushRef).toHaveBeenCalledTimes(2);
    expect(pushRef).toHaveBeenCalledWith(clone, ORIGIN, "refs/heads/main:refs/heads/main");
    expect(isAncestor(bare, local, "main")).toBe(true);
    expect(isAncestor(bare, racing, "main")).toBe(true);
    expect(git(bare, "rev-parse", "main")).toBe(git(clone, "rev-parse", "main"));
    expect(writes).toEqual([git(clone, "rev-parse", "main")]);
  });
});
