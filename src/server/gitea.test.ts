import { afterEach, describe, expect, it, vi } from "vitest";
import { GiteaError, giteaRequest } from "./gitea";

afterEach(() => vi.unstubAllGlobals());

describe("giteaRequest", () => {
  it("builds the api url under a sub-path", async () => {
    const fetchMock = vi.fn(async () => new Response('{"login":"a"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await giteaRequest({ baseUrl: "https://host/gitea", token: "t" }, "GET", "/user");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://host/gitea/api/v1/user");
    expect((init.headers as Record<string, string>).Authorization).toBe("token t");
  });

  it("surfaces the server message", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"message":"not found"}', { status: 404 }));
    const err = (await giteaRequest({ baseUrl: "https://h", token: "t" }, "GET", "/x").catch((e: unknown) => e)) as GiteaError;
    expect(err).toBeInstanceOf(GiteaError);
    expect(err.status).toBe(404);
    expect(err.message).toContain("not found");
  });

  it("maps a network failure to status null", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const err = (await giteaRequest({ baseUrl: "https://h", token: "t" }, "GET", "/x").catch((e: unknown) => e)) as GiteaError;
    expect(err).toBeInstanceOf(GiteaError);
    expect(err.status).toBeNull();
  });

  it("returns undefined on 204", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    expect(await giteaRequest({ baseUrl: "https://h", token: "t" }, "DELETE", "/x")).toBeUndefined();
  });
});
