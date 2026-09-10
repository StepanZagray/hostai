import { useCallback, useEffect, useRef, useState } from "react";
import { DirectorySourceError, readDirectory, type DirectorySnapshot } from "./registry";

export function useDirectory(
  endpoint: "/registry/v1/listings" | "/api/directory/listings",
  registryOrigin: string,
) {
  const [snapshot, setSnapshot] = useState<DirectorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sourceMismatch, setSourceMismatch] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const active = useRef<AbortController | null>(null);
  const received = useRef(0);
  const receivedWall = useRef(0);
  // Elapsed wall time also covers platforms whose performance clock pauses
  // during sleep. A forward clock adjustment only expires a link earlier.
  const currentElapsed = useCallback(
    () => Math.max(0, performance.now() - received.current, Date.now() - receivedWall.current),
    [],
  );
  const refresh = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const started = performance.now();
    const startedWall = Date.now();
    const timer = setTimeout(() => controller.abort(), 10_000);
    setLoading(true);
    try {
      const next = await readDirectory(controller.signal, endpoint, registryOrigin);
      if (active.current !== controller || controller.signal.aborted) return;
      received.current = started;
      receivedWall.current = startedWall;
      setElapsed(currentElapsed());
      setSnapshot(next);
      setError(false);
      setSourceMismatch(false);
    } catch (cause) {
      if (active.current === controller) {
        setError(true);
        setSourceMismatch(cause instanceof DirectorySourceError);
      }
    } finally {
      clearTimeout(timer);
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  }, [endpoint, currentElapsed, registryOrigin]);
  useEffect(() => {
    void refresh();
    const tick = setInterval(() => {
      if (document.visibilityState !== "hidden") setElapsed(currentElapsed());
    }, 1000);
    const poll = setInterval(() => {
      if (document.visibilityState !== "hidden" && !active.current) void refresh();
    }, 15_000);
    const visible = () => {
      if (document.visibilityState !== "hidden") {
        setElapsed(currentElapsed());
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      const previous = active.current;
      active.current = null;
      previous?.abort();
      clearInterval(tick);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, currentElapsed]);
  return {
    snapshot,
    loading,
    error,
    sourceMismatch,
    elapsed,
    refresh,
    currentElapsed,
  };
}
