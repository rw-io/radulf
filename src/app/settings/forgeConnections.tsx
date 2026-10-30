"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "../ui/api";
import { errorMessage } from "@/shared/errorMessage";
import type { ForgeConnection, ForgeKind } from "@/server/forgeConnections";
import { inputCls, secondaryButtonCls, sectionCls } from "./settingsUI";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Gitea and Forgejo connections (spec 33). The token is write-only: it is sent once and never shown again. */
export function ForgeConnectionsSection() {
  const [connections, setConnections] = useState<ForgeConnection[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [kind, setKind] = useState<ForgeKind>("gitea");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<ForgeConnection[]>("/api/forge/connections")
      .then((next) => { if (live) setConnections(next); })
      .catch(() => { if (live) setConnections([]); });
    return () => { live = false; };
  }, []);

  const recheck = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const next = await api<ForgeConnection>(`/api/forge/connections/${id}?refresh=1`);
      setConnections((all) => all.map((c) => (c.id === id ? next : c)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await api(`/api/forge/connections/${id}`, { method: "DELETE" });
      setConnections((all) => all.filter((c) => c.id !== id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await api<ForgeConnection>("/api/forge/connections", {
        json: { kind, baseUrl, token },
      });
      setConnections((all) => [...all.filter((c) => c.id !== saved.id), saved]);
      setBaseUrl("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setToken("");
      setSaving(false);
    }
  }

  return (
    <section id="forge" className={sectionCls}>
      <div>
        <h3 className="font-medium">Gitea and Forgejo connections</h3>
        <p className="mt-1 text-sm leading-relaxed text-foreground/55">
          Clone, push, and deliver pull requests that Radulf merges once CI passes, with a token instead of credentials on this machine.
        </p>
      </div>
      {connections.map((c) => (
        <div
          key={c.id}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-foreground/[0.07] bg-foreground/[0.025] px-3 py-2 text-sm"
        >
          <span
            className={`size-2 shrink-0 rounded-full ${c.checkError ? "bg-amber-400" : "bg-green-400"}`}
            aria-hidden="true"
          />
          <span className="min-w-0 break-words text-foreground/70">
            {c.checkError ?? (
              <>Signed in to {hostOf(c.baseUrl)} as <strong className="font-medium text-foreground/90">{c.account}</strong></>
            )}
          </span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => void recheck(c.id)}
              disabled={busyId === c.id}
              className="touch-target rounded-md bg-foreground/10 px-3 text-sm font-medium hover:bg-foreground/15 disabled:opacity-40"
            >
              {busyId === c.id ? "Checking…" : "Re-check"}
            </button>
            <button
              type="button"
              onClick={() => void remove(c.id)}
              disabled={busyId === c.id}
              className="touch-target rounded-md bg-foreground/10 px-3 text-sm font-medium hover:bg-foreground/15 disabled:opacity-40"
            >
              Remove
            </button>
          </span>
        </div>
      ))}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => { e.preventDefault(); void save(); }}
      >
        <label className="text-sm">
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as ForgeKind)} className={inputCls}>
            <option value="gitea">Gitea</option>
            <option value="forgejo">Forgejo</option>
          </select>
        </label>
        <label className="text-sm">
          Base URL
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://gitea.example"
            className={inputCls}
          />
        </label>
        <label className="text-sm">
          Token
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={inputCls}
          />
          <span className="mt-1 block text-xs text-foreground/45">
            Needs repository read and write and user read access. A token for a dedicated account, or one limited to the repositories Radulf works on, limits what a leaked token can reach.
          </span>
        </label>
        {error && <p className="text-sm text-amber-400" role="alert">{error}</p>}
        <div>
          <button type="submit" disabled={saving || !baseUrl.trim() || !token.trim()} className={secondaryButtonCls}>
            {saving ? "Saving…" : "Save connection"}
          </button>
        </div>
      </form>
    </section>
  );
}
