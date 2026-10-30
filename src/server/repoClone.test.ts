import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { git, initScratchRepo } from "@/testUtils/gitRepo";
import { setupTestStateDir } from "@/testUtils/testDataDir";

// No URL matches a forge connection unless a test says so, and every clone
// still runs for real; the spy only records how cloneRemote was called.
vi.mock("./forgeMatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./forgeMatch")>()),
  matchRemoteUrl: vi.fn(async () => null),
}));
vi.mock("./git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git")>();
  return { ...actual, cloneRemote: vi.fn(actual.cloneRemote) };
});

const root = setupTestStateDir("radulf-clone-");

const { CLONES_DIR } = await import("@/db");
const { cloneRepository } = await import("./repoClone");
const { matchRemoteUrl } = await import("./forgeMatch");
const { cloneRemote } = await import("./git");
const { saveConnection } = await import("./forgeConnections");

// The scratch repos live under the OS temp dir, so that is the browsable root.
const ROOT = os.tmpdir();
let source: string;
let empty: string;

beforeAll(() => {
  source = initScratchRepo("radulf-clone-src-", { branch: "trunk" });
  empty = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-clone-empty-"));
  git(empty, "init", "-b", "main");
});

afterAll(() => {
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

afterEach(() => {
  vi.mocked(cloneRemote).mockClear();
  vi.unstubAllGlobals();
});

describe("cloneRepository", () => {
  it("clones into repos/ beside data/, names it after the URL, and reads the remote's default branch", async () => {
    const cloned = await cloneRepository(`file://${source}`, "", ROOT);

    expect(CLONES_DIR).toBe(path.join(root, "repos"));
    expect(fs.statSync(CLONES_DIR).mode & 0o777).toBe(0o700);
    const name = path.basename(source);
    expect(cloned).toEqual({ name, path: path.join(CLONES_DIR, name), defaultBranch: "trunk" });
    expect(git(cloned.path, "remote", "get-url", "origin")).toBe(`file://${source}`);
    expect(git(cloned.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("trunk");
    expect(git(cloned.path, "log", "--format=%s")).toBe("initial");
  });

  it("uses the requested name and refuses a second clone into the same folder", async () => {
    const cloned = await cloneRepository(`file://${source}`, "named", ROOT);

    expect(cloned.path).toBe(path.join(CLONES_DIR, "named"));
    await expect(cloneRepository(`file://${source}`, "named", ROOT)).rejects.toThrow(/already exists/);
  });

  it.each(["/tmp/somewhere", "ext::sh -c id", "owner/repo", "https://example.com/has space"])(
    'rejects the URL "%s"',
    async (url) => {
      await expect(cloneRepository(url, "", ROOT)).rejects.toThrow(/clone URL must start with/);
    },
  );

  it("refuses a file:// URL outside the browsable root", async () => {
    await expect(cloneRepository(`file://${source}`, "outside", path.join(ROOT, "elsewhere"))).rejects.toThrow(
      /outside the browsable root/,
    );
    expect(fs.existsSync(path.join(CLONES_DIR, "outside"))).toBe(false);
  });

  it("applies the repository name rule to derived and requested names", async () => {
    await expect(cloneRepository("https://example.com/acme/.hidden", "", ROOT)).rejects.toThrow(/repository name/);
    await expect(cloneRepository(`file://${source}`, "-flag", ROOT)).rejects.toThrow(/repository name/);
  });

  it("removes the folder when the clone fails or the remote has no commits", async () => {
    await expect(cloneRepository(`file://${source}-missing`, "gone", ROOT)).rejects.toThrow(/git clone failed/);
    expect(fs.existsSync(path.join(CLONES_DIR, "gone"))).toBe(false);

    await expect(cloneRepository(`file://${empty}`, "empty", ROOT)).rejects.toThrow(/no commits/);
    expect(fs.existsSync(path.join(CLONES_DIR, "empty"))).toBe(false);
  });

  it("cloneRepository clones through the token when the url matches a connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ login: "bot" }))));
    const connection = await saveConnection({ kind: "gitea", baseUrl: "https://gitea.example", token: "tok-xyz" });
    // A local repository stands in for the forge's HTTPS URL, so the clone is real.
    const ref = { connection, owner: "o", repo: "r", cloneUrl: `file://${source}` };
    vi.mocked(matchRemoteUrl).mockResolvedValueOnce(ref);
    const typed = "https://gitea.example/o/r.git";

    const cloned = await cloneRepository(typed, "", ROOT);

    expect(vi.mocked(cloneRemote).mock.calls[0][3]).toEqual({ httpsUrl: ref.cloneUrl, username: "bot", token: "tok-xyz" });
    expect(cloned).toEqual({ name: "r", path: path.join(CLONES_DIR, "r"), defaultBranch: "trunk" });
    expect(git(cloned.path, "remote", "get-url", "origin")).toBe(typed);

    await cloneRepository(`file://${source}`, "unmatched", ROOT);
    expect(vi.mocked(cloneRemote).mock.calls[1][3]).toBeUndefined();
  });
});
