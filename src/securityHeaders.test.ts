import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

async function header(key: string): Promise<string | undefined> {
  const rules = (await nextConfig.headers?.()) ?? [];
  return rules.flatMap((rule) => rule.headers).find((h) => h.key === key)?.value;
}

describe("security headers", () => {
  // Under "no-referrer" a browser sends `Origin: null` with a plain form POST,
  // and the proxy's origin check refuses that, so the login form could never
  // sign anyone in from a non-loopback address. "same-origin" keeps the real
  // Origin on same-site requests and still sends nothing to other sites.
  it("keeps the Origin on the login form's POST", async () => {
    expect(await header("Referrer-Policy")).toBe("same-origin");
  });
});
