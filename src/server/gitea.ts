/**
 * Minimal Gitea/Forgejo REST client (spec 33). Both forges share the `/api/v1`
 * surface, so one helper serves either kind.
 */
import { errorMessage } from "@/shared/errorMessage";

export type GiteaAuth = { baseUrl: string; token: string };

const TIMEOUT_MS = 10_000;

/** `status` is null when the request never got a response (network failure). */
export class GiteaError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "GiteaError";
  }
}

export async function giteaRequest<T>(
  auth: GiteaAuth,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `token ${auth.token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${auth.baseUrl}/api/v1${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    throw new GiteaError(`cannot reach ${auth.baseUrl}: ${errorMessage(e)}`, null);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
    } catch {
      // not JSON: keep the raw text
    }
    throw new GiteaError(message || `HTTP ${res.status}`, res.status);
  }
  if (res.status === 204 || text === "") return undefined as T;
  return JSON.parse(text) as T;
}

export function getAuthenticatedUser(auth: GiteaAuth): Promise<{ login: string }> {
  return giteaRequest<{ login: string }>(auth, "GET", "/user");
}
