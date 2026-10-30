import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupTestStateDir } from "@/testUtils/testDataDir";

setupTestStateDir("radulf-repo-route-");

const { db, repos, now, upsertSettingJson } = await import("@/db");
const { PATCH } = await import("./route");

const browserRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-repo-patch-root-"));
upsertSettingJson("folderBrowserRoot", browserRoot);
afterAll(() => fs.rmSync(browserRoot, { recursive: true, force: true }));

db.insert(repos).values({ id: "repo-1", name: "Repo", path: "/tmp/repo-route", defaultBranch: "main", createdAt: now() }).run();

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/repos/repo-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "repo-1" }) },
  );
}

describe("PATCH /api/repos/[id] gate command (spec 27)", () => {
  it("sets a trimmed gate command", async () => {
    const response = await patch({ gateCommand: "  make check " });
    expect(response.status).toBe(200);
    expect((await response.json()).gateCommand).toBe("make check");
    expect(db.select().from(repos).get()!.gateCommand).toBe("make check");
  });

  it("clears it with a blank string or null", async () => {
    expect((await (await patch({ gateCommand: "   " })).json()).gateCommand).toBeNull();
    await patch({ gateCommand: "make test" });
    expect((await (await patch({ gateCommand: null })).json()).gateCommand).toBeNull();
  });

  it("rejects a gate command that is not a string", async () => {
    const response = await patch({ gateCommand: 5 });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/gateCommand must be a string/);
  });

  it("still reports nothing to update when no known field is given", async () => {
    const response = await patch({ colour: "blue" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/nothing to update/);
  });

  it("rejects a replacement path outside the browsable root", async () => {
    const response = await patch({ path: path.dirname(browserRoot) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/outside the browsable root/);
    expect(db.select().from(repos).get()!.path).toBe("/tmp/repo-route");
  });
});

describe("PATCH /api/repos/[id] push after merge (spec 33)", () => {
  it("stores true as 1 and false as 0", async () => {
    const on = await patch({ pushAfterMerge: true });
    expect(on.status).toBe(200);
    expect(db.select().from(repos).get()!.pushAfterMerge).toBe(1);

    const off = await patch({ pushAfterMerge: false });
    expect(off.status).toBe(200);
    expect(db.select().from(repos).get()!.pushAfterMerge).toBe(0);
  });

  it("rejects a push after merge that is not a boolean", async () => {
    const response = await patch({ pushAfterMerge: "yes" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/pushAfterMerge must be a boolean/);
    expect(db.select().from(repos).get()!.pushAfterMerge).toBe(0);
  });
});
