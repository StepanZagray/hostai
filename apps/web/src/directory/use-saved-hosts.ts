import { useCallback, useEffect, useState } from "react";
import {
  readSavedHosts,
  removeSavedHost,
  saveHost,
  savedHostPrefix,
  directoryOrigin,
  type SavedHost,
} from "./saved-hosts";

export function useSavedHosts(registry: string) {
  const [entries, setEntries] = useState<SavedHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [notice, setNotice] = useState("");
  const [removed, setRemoved] = useState<SavedHost | null>(null);
  const refresh = useCallback(() => {
    try {
      directoryOrigin(registry);
    } catch {
      setBlocked(true);
      setLoading(false);
      setError("Saving requires an HTTPS directory, or http://127.0.0.1 for local development.");
      return;
    }
    try {
      setEntries(readSavedHosts(window.localStorage, registry));
      setError("");
      setBlocked(false);
    } catch {
      setBlocked(true);
      setError(
        "Saved hosts could not be read. Browser storage may be blocked or damaged. Existing saves have not been changed.",
      );
    } finally {
      setLoading(false);
    }
  }, [registry]);
  useEffect(() => {
    refresh();
    let scope: string;
    try {
      scope = savedHostPrefix(registry);
    } catch {
      return;
    }
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(scope)) refresh();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [registry, refresh]);
  const change = (host: SavedHost, mode: "save" | "remove" | "update" | "restore") => {
    if (loading || blocked) return;
    let written = false;
    try {
      const storage = window.localStorage;
      const current = readSavedHosts(storage, registry);
      const existing = current.find((item) => item.id === host.id);
      if (mode === "remove") {
        removeSavedHost(storage, registry, host.id);
        written = true;
        setRemoved(existing ?? host);
        setNotice("Saved host removed.");
      } else {
        if (mode === "update" || !existing) saveHost(storage, registry, host);
        written = true;
        setNotice(
          mode === "update"
            ? "Saved model updated. Open guest chat when you are ready."
            : "Host saved in this browser.",
        );
        if (mode === "restore") setRemoved(null);
      }
      setEntries(readSavedHosts(storage, registry));
      setError("");
    } catch (cause) {
      setBlocked(!(cause instanceof Error && cause.message.startsWith("Save up to 50")));
      setNotice("");
      setError(
        cause instanceof Error && cause.message.startsWith("Save up to 50")
          ? cause.message
          : written
            ? "The change reached browser storage, but the saved list could not be checked. Check saved hosts before trying again."
            : "This change could not be saved. Browser storage may be unavailable or full. Check saved hosts before trying again.",
      );
    }
  };
  return {
    entries,
    loading,
    error,
    blocked,
    notice,
    removed,
    refresh,
    // Preserve the action shown to the user even if another tab changes storage before its event arrives.
    toggle: (host: SavedHost) =>
      change(host, entries.some((item) => item.id === host.id) ? "remove" : "save"),
    update: (host: SavedHost) => change(host, "update"),
    undo: () => {
      if (removed) change(removed, "restore");
    },
  };
}
