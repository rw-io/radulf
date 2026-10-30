/**
 * Gitea/Forgejo connections (spec 33). The token is stored as settingsCrypto
 * ciphertext and only `connectionAuth` ever decrypts it; every other export
 * returns a `ForgeConnection`, which has no token field.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, forgeConnections, now } from "@/db";
import { errorMessage } from "@/shared/errorMessage";
import { ClientError } from "./clientError";
import { getAuthenticatedUser, type GiteaAuth } from "./gitea";
import { decryptSecret, encryptSecret } from "./settingsCrypto";

export type ForgeKind = "gitea" | "forgejo";

export type ForgeConnection = {
  id: string;
  kind: ForgeKind;
  baseUrl: string;
  account: string | null;
  checkError: string | null;
  checkedAt: string | null;
  updatedAt: string;
};

const CHECK_TTL_MS = 30_000;
const lastCheck = new Map<string, number>();

type Row = typeof forgeConnections.$inferSelect;

function toConnection(row: Row): ForgeConnection {
  return {
    id: row.id,
    kind: row.kind,
    baseUrl: row.baseUrl,
    account: row.account,
    checkError: row.checkError,
    checkedAt: row.checkedAt,
    updatedAt: row.updatedAt,
  };
}

export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ClientError("Enter the instance address as a full URL, such as https://gitea.example.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ClientError("The instance address must start with http:// or https://.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function listConnections(): ForgeConnection[] {
  return db.select().from(forgeConnections).all().map(toConnection);
}

export function connectionAuth(id: string): GiteaAuth {
  const row = db.select().from(forgeConnections).where(eq(forgeConnections.id, id)).get();
  if (!row) throw new ClientError("That connection no longer exists.", 404);
  return { baseUrl: row.baseUrl, token: decryptSecret(row.token) };
}

export async function saveConnection(input: {
  kind: ForgeKind;
  baseUrl: string;
  token: string;
}): Promise<ForgeConnection> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const token = input.token.trim();
  let account: string;
  try {
    account = (await getAuthenticatedUser({ baseUrl, token })).login;
  } catch (e) {
    throw new ClientError(scrubSecret(errorMessage(e), token), 400);
  }
  const stamp = now();
  const values = {
    kind: input.kind,
    token: encryptSecret(token),
    account,
    checkError: null,
    checkedAt: stamp,
    updatedAt: stamp,
  };
  const row = db
    .insert(forgeConnections)
    .values({ id: randomUUID(), baseUrl, createdAt: stamp, ...values })
    .onConflictDoUpdate({ target: forgeConnections.baseUrl, set: values })
    .returning()
    .get();
  lastCheck.set(row.id, Date.now());
  return toConnection(row);
}

export function deleteConnection(id: string): void {
  db.delete(forgeConnections).where(eq(forgeConnections.id, id)).run();
  lastCheck.delete(id);
}

export function invalidateConnectionCheck(id: string): void {
  lastCheck.delete(id);
}

export async function checkConnection(
  id: string,
  options: { refresh?: boolean } = {},
): Promise<ForgeConnection> {
  const auth = connectionAuth(id);
  const current = db.select().from(forgeConnections).where(eq(forgeConnections.id, id)).get()!;
  const last = lastCheck.get(id);
  if (!options.refresh && last !== undefined && Date.now() - last < CHECK_TTL_MS) {
    return toConnection(current);
  }
  lastCheck.set(id, Date.now());
  let patch: { account: string | null; checkError: string | null };
  try {
    patch = { account: (await getAuthenticatedUser(auth)).login, checkError: null };
  } catch (e) {
    patch = { account: current.account, checkError: scrubSecret(errorMessage(e), auth.token) };
  }
  const stamp = now();
  const row = db
    .update(forgeConnections)
    .set({ ...patch, checkedAt: stamp, updatedAt: stamp })
    .where(eq(forgeConnections.id, id))
    .returning()
    .get();
  return toConnection(row);
}

export function scrubSecret(text: string, secret: string): string {
  return secret === "" ? text : text.split(secret).join("***");
}
