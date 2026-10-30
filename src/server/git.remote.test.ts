import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { git, initScratchRepo } from "@/testUtils/gitRepo";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// Every git call still runs for real; the spy only records what each one was
// handed, so a test can read the argv and env a push actually spawned with.
vi.mock("./exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exec")>();
  return { ...actual, execBounded: vi.fn(actual.execBounded) };
});

setupTestDataDir("radulf-git-remote-");

const { execBounded } = await import("./exec");
const { cloneRemote, fetchBranchHead, forgeGitEnv, pushRef } = await import("./git");

const TOKEN = "tok-xyz";
const FORGE_URL = "https://gitea.example/o/r.git";
const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function cloneOf(bare: string): string {
  const dir = path.join(tmp("radulf-remote-clone-"), "clone");
  execFileSync("git", ["clone", "-q", bare, dir]);
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  return dir;
}

function commit(dir: string, file: string): string {
  fs.writeFileSync(path.join(dir, file), file);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", file);
  return git(dir, "rev-parse", "HEAD");
}

/** A bare repository with one commit on `main`, standing in for the forge,
 * and a clone of it, standing in for a registered repository. */
function remoteAndClone(): { bare: string; clone: string } {
  const seed = initScratchRepo("radulf-remote-seed-");
  dirs.push(seed);
  const bare = path.join(tmp("radulf-remote-bare-"), "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  return { bare, clone: cloneOf(bare) };
}

/** Someone else pushes a commit to the remote's `main`. */
function advanceRemote(bare: string, file: string): string {
  const other = cloneOf(bare);
  commit(other, file);
  git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
  return git(bare, "rev-parse", "main");
}

/** `git credential fill` for an https `host`: what git would send there. */
function fill(env: NodeJS.ProcessEnv, host: string): { status: number | null; out: string } {
  const res = spawnSync("git", ["credential", "fill"], { input: `protocol=https\nhost=${host}\n\n`, env, encoding: "utf8" });
  return { status: res.status, out: res.stdout + res.stderr };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("fetchBranchHead", () => {
  it("fetchBranchHead returns the remote tip and writes no remote-tracking ref", async () => {
    const { bare, clone } = remoteAndClone();
    const tip = advanceRemote(bare, "ahead.txt");
    const before = git(clone, "for-each-ref", "refs/remotes");
    expect(git(clone, "rev-parse", "origin/main")).not.toBe(tip);

    expect(await fetchBranchHead(clone, { kind: "origin" }, "main")).toEqual({ ok: true, sha: tip });
    expect(git(clone, "for-each-ref", "refs/remotes")).toBe(before);
  });

  it("fetchBranchHead reports a missing branch", async () => {
    const { clone } = remoteAndClone();

    expect(await fetchBranchHead(clone, { kind: "origin" }, "nope")).toEqual({
      ok: false,
      missing: true,
      error: expect.stringContaining("nope"),
    });
  });
});

describe("pushRef", () => {
  it("pushRef pushes and reports a rejection", async () => {
    const { bare, clone } = remoteAndClone();
    const ours = commit(clone, "ours.txt");

    expect(await pushRef(clone, { kind: "origin" }, "main:refs/heads/main")).toEqual({ ok: true });
    expect(git(bare, "rev-parse", "main")).toBe(ours);

    const theirs = advanceRemote(bare, "theirs.txt");
    commit(clone, "ours-again.txt");
    expect(await pushRef(clone, { kind: "origin" }, "main:refs/heads/main")).toEqual({
      ok: false,
      rejected: true,
      error: expect.stringContaining("rejected"),
    });
    expect(git(bare, "rev-parse", "main")).toBe(theirs);
  });

  it("pushRef pushes no tags, even with push.followTags on", async () => {
    const { bare, clone } = remoteAndClone();
    const tagged = commit(clone, "tagged.txt");
    git(clone, "tag", "-a", "v1", "-m", "v1");
    git(clone, "config", "push.followTags", "true");

    expect(await pushRef(clone, { kind: "origin" }, "refs/heads/main:refs/heads/main")).toEqual({ ok: true });

    expect(git(bare, "rev-parse", "main")).toBe(tagged);
    expect(git(bare, "tag", "--list")).toBe("");
  });

  it("pushRef refuses a forcing refspec", async () => {
    const { bare, clone } = remoteAndClone();
    const theirs = advanceRemote(bare, "theirs.txt");
    commit(clone, "ours.txt");

    await expect(pushRef(clone, { kind: "origin" }, "+main:refs/heads/main")).rejects.toThrow(/never forces/);
    expect(git(bare, "rev-parse", "main")).toBe(theirs);
  });
});

describe("forge credentials", () => {
  it("the credential helper serves the token from the environment", async () => {
    const filled = fill(forgeGitEnv("bot", TOKEN, FORGE_URL), "gitea.example");
    expect(filled.status).toBe(0);
    expect(filled.out).toContain("username=bot");
    expect(filled.out).toContain(`password=${TOKEN}`);

    const { bare, clone } = remoteAndClone();
    const ours = commit(clone, "ours.txt");
    vi.mocked(execBounded).mockClear();
    const target = { kind: "forge" as const, url: `file://${bare}`, username: "bot", token: TOKEN };

    expect(await pushRef(clone, target, "main:refs/heads/main")).toEqual({ ok: true });
    expect(git(bare, "rev-parse", "main")).toBe(ours);
    const calls = vi.mocked(execBounded).mock.calls;
    expect(calls).toHaveLength(1);
    const [, argv, options] = calls[0];
    expect(argv.filter((arg) => arg.includes(TOKEN))).toEqual([]);
    // The token rides in exactly one variable; the helper only names it.
    const holders = Object.entries(options.env ?? {}).filter(([, value]) => value?.includes(TOKEN));
    expect(holders).toEqual([["RADULF_FORGE_TOKEN", TOKEN]]);
  });

  it("forgeGitEnv keeps the operator's GIT_CONFIG entries but not their credential helper", () => {
    vi.stubEnv("GIT_CONFIG_COUNT", "2");
    vi.stubEnv("GIT_CONFIG_KEY_0", "radulf.kept");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "yes");
    vi.stubEnv("GIT_CONFIG_KEY_1", "credential.helper");
    vi.stubEnv("GIT_CONFIG_VALUE_1", "!f() { echo username=operator; echo password=theirs; }; f");
    const env = forgeGitEnv("bot", TOKEN, FORGE_URL);

    expect(execFileSync("git", ["config", "--get", "radulf.kept"], { env, encoding: "utf8" }).trim()).toBe("yes");
    const filled = fill(env, "gitea.example");
    expect(filled.out).toContain(`password=${TOKEN}`);
    expect(filled.out).not.toContain("theirs");
  });

  it("the credential helper offers the token to no other host", () => {
    // Prompts are off and so is askpass, so a host the helper does not serve
    // has nowhere left to get a password: what a redirect to it would see.
    const env: NodeJS.ProcessEnv = { ...forgeGitEnv("bot", TOKEN, FORGE_URL), GIT_ASKPASS: "" };
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(fill(env, "gitea.example").out).toContain(`password=${TOKEN}`);

    for (const host of ["elsewhere.example", "gitea.example:8443"]) {
      const other = fill(env, host);
      expect(other.status).not.toBe(0);
      expect(other.out).not.toContain("password=");
      expect(other.out).not.toContain(TOKEN);
    }
  });

  it("the token never lands in .git/config", async () => {
    const { bare } = remoteAndClone();
    const parent = tmp("radulf-remote-dest-");
    const dest = path.join(parent, "repo");
    const typed = "git@ssh.gitea.example:o/r.git";

    const result = await cloneRemote(typed, dest, parent, { httpsUrl: `file://${bare}`, username: "bot", token: TOKEN });

    expect(result).toEqual({ ok: true });
    expect(git(dest, "log", "--format=%s")).toBe("initial");
    expect(git(dest, "config", "--get", "remote.origin.url")).toBe(typed);
    expect(fs.readFileSync(path.join(dest, ".git", "config"), "utf8")).not.toContain(TOKEN);
  });

  it("scrubs the token from git's error text", async () => {
    const { clone } = remoteAndClone();
    // Contrived so that git's own error quotes the token back.
    const target = { kind: "forge" as const, url: `file:///nonexistent-radulf/${TOKEN}.git`, username: "bot", token: TOKEN };

    const pushed = await pushRef(clone, target, "main:refs/heads/main");
    const fetched = await fetchBranchHead(clone, target, "main");
    const cloned = await cloneRemote("https://gitea.example/o/r.git", path.join(tmp("radulf-remote-dest-"), "repo"), clone, {
      httpsUrl: target.url,
      username: "bot",
      token: TOKEN,
    });

    for (const result of [pushed, fetched, cloned]) {
      expect(result.ok).toBe(false);
      const error = "error" in result ? (result.error ?? "") : "";
      expect(error).toContain("***");
      expect(error).not.toContain(TOKEN);
    }
  });
});
