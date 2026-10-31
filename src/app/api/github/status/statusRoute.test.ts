import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  githubStatus: vi.fn(),
  matchRepo: vi.fn(),
  checkConnection: vi.fn(),
}));

vi.mock("@/server/github", () => ({ githubStatus: mocks.githubStatus }));
vi.mock("@/server/forgeMatch", () => ({ matchRepo: mocks.matchRepo }));
vi.mock("@/server/forgeConnections", () => ({ checkConnection: mocks.checkConnection }));
vi.mock("@/server/repos", () => ({ getRepo: () => ({ id: "repo-1", path: "/tmp/repo" }) }));
vi.mock("@/server/git", () => ({ hasRemote: async () => true }));

const { GET } = await import("./route");

const connection = {
  id: "conn-1",
  kind: "gitea",
  baseUrl: "https://gitea.example",
  account: "ralph",
  checkError: null,
  checkedAt: null,
  updatedAt: "2026-10-30T00:00:00.000Z",
};

function get(query = "repoId=repo-1") {
  return GET(new Request(`http://localhost/api/github/status?${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.githubStatus.mockResolvedValue({ ok: false, reason: "not_logged_in", detail: "gh: not logged in" });
});

describe("GET /api/github/status", () => {
  it("status route uses the connection for a matched repo", async () => {
    mocks.matchRepo.mockResolvedValue({ connection, owner: "o", repo: "r", cloneUrl: "x" });
    mocks.checkConnection.mockResolvedValue(connection);

    expect(await (await get()).json()).toEqual({
      ok: true,
      account: "ralph",
      reason: null,
      detail: null,
      hasRemote: true,
      forge: "gitea",
    });
  });

  it("status route reports a broken connection", async () => {
    mocks.matchRepo.mockResolvedValue({ connection, owner: "o", repo: "r", cloneUrl: "x" });
    mocks.checkConnection.mockResolvedValue({ ...connection, checkError: "401 Unauthorized" });

    const body = await (await get()).json();

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("forge");
    expect(body.forge).toBe("gitea");
    expect(body.detail).toContain("gitea.example");
    expect(body.detail).toContain("401");
  });

  it("falls back to the gh status for an unmatched repo and for no repo", async () => {
    mocks.matchRepo.mockResolvedValue(null);

    const unmatched = await (await get()).json();
    expect(unmatched).toMatchObject({ ok: false, reason: "not_logged_in", hasRemote: true, forge: "github" });

    const none = await (await get("")).json();
    expect(none).toMatchObject({ hasRemote: null, forge: "github" });
    expect(mocks.matchRepo).toHaveBeenCalledTimes(1);
  });
});
