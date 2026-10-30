import path from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, repos, now, CLONES_DIR } from "@/db";
import { ClientError } from "./clientError";
import { emitEvent } from "./events";

export type Repo = typeof repos.$inferSelect;

/** Spec 27: a repository's gate command from a request body. Absent or blank
 * means none; anything but a string is a client error. */
export function parseGateCommand(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ClientError("gateCommand must be a string");
  return value.trim() || null;
}

/** Spec 33: the push-after-merge toggle from a request body, stored as 1 or
 * 0. Anything but a boolean is a client error. */
export function parsePushAfterMerge(value: unknown): 0 | 1 {
  if (typeof value !== "boolean") throw new ClientError("pushAfterMerge must be a boolean");
  return value ? 1 : 0;
}

/** Spec 33 decision 4: does an approved local merge on this repository push
 * its base branch? An explicit setting wins. Unset, it is on for a clone
 * Radulf made in its repos directory and off for a checkout registered by
 * local path, which may hold the operator's own unpushed commits. */
export function pushAfterMergeFor(repo: Repo): boolean {
  if (repo.pushAfterMerge !== null) return repo.pushAfterMerge === 1;
  const relative = path.relative(CLONES_DIR, repo.path);
  return relative !== "" && !path.isAbsolute(relative) && !relative.startsWith("..");
}

export function getRepo(repoId: string): Repo | undefined {
  return db.select().from(repos).where(eq(repos.id, repoId)).get();
}

/** The repo row, or the 404 the API layer returns verbatim. */
export function requireRepo(repoId: string): Repo {
  const repo = getRepo(repoId);
  if (!repo) throw new ClientError("repo not found", 404);
  return repo;
}

/** Insert the repo row and announce it. Shared by registering an existing
 * checkout (POST /api/repos) and creating a fresh one (POST /api/repos/init). */
export function registerRepo(name: string, path: string, defaultBranch: string, gateCommand: string | null = null) {
  if (db.select().from(repos).where(eq(repos.path, path)).get()) {
    throw new ClientError("repo path already registered");
  }
  const row = db
    .insert(repos)
    .values({ id: nanoid(), name, path, defaultBranch, gateCommand, createdAt: now() })
    .returning()
    .get();
  emitEvent("repo.created", { payload: { repoId: row.id, name } });
  return row;
}
