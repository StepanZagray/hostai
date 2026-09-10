import { useCallback, useEffect, useRef, useState } from "react";
import { mergeDownload, reconcileDownloads, type DownloadHistory } from "./download-history";
import {
  cancelDownload,
  DownloadRequestError,
  listDownloads,
  startDownload,
  type DownloadRequest,
  type ModelDownload,
} from "./model-downloads";

export function useModelDownloads(refreshLibrary: () => Promise<void>) {
  const [history, setHistory] = useState<DownloadHistory>({ downloads: [], unreported: [] });
  const { downloads, unreported } = history;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState<DownloadRequest | null>(null);
  const unresolved = useRef<DownloadRequest | null>(null);
  const read = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const completed = useRef(new Set<string>());
  const checkedUnreported = useRef(new Set<string>());
  const refresh = useCallback(async (interactive = false) => {
    if (read.current) {
      // A manual check joins the in-flight poll and gets visible feedback.
      if (interactive) setRefreshing(true);
      return;
    }
    const controller = new AbortController();
    read.current = controller;
    setRefreshing(interactive);
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const jobs = await listDownloads(controller.signal);
      if (read.current !== controller || controller.signal.aborted) return;
      setHistory((previous) => reconcileDownloads(previous, jobs));
      setStatusError("");
      if (unresolved.current && jobs.some((job) => job.id === unresolved.current!.requestId)) {
        unresolved.current = null;
        setUncertain(null);
        setActionError("");
      }
    } catch (error) {
      if (read.current === controller)
        setStatusError(
          controller.signal.aborted
            ? "Download status timed out. Check again."
            : error instanceof Error
              ? error.message
              : "Download status is unavailable.",
        );
    } finally {
      clearTimeout(timer);
      if (read.current === controller) {
        setLoading(false);
        setRefreshing(false);
        read.current = null;
      }
    }
  }, []);
  const needsFrequentRefresh = useRef(false);
  needsFrequentRefresh.current = !!uncertain || downloads.some((job) => job.state === "running");
  useEffect(() => {
    void refresh();
    let ticks = 0;
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    const interval = setInterval(() => {
      ticks += 1;
      if (needsFrequentRefresh.current || ticks % 8 === 0) visible();
    }, 2_000);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      const previous = read.current;
      read.current = null;
      previous?.abort();
      const mutation = action.current;
      action.current = null;
      mutation?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    let changed = false;
    for (const job of downloads) {
      if (job.state === "completed" && !completed.current.has(job.id)) {
        completed.current.add(job.id);
        changed = true;
      }
    }
    for (const job of unreported) {
      if (!checkedUnreported.current.has(job.id)) changed = true;
    }
    checkedUnreported.current = new Set(unreported.map((job) => job.id));
    if (changed) void refreshLibrary();
  }, [downloads, unreported, refreshLibrary]);
  const merge = (job: ModelDownload) => setHistory((previous) => mergeDownload(previous, job));
  async function mutate(request: DownloadRequest | null, id?: string) {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setPending(true);
    setActionError("");
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const job = request
        ? await startDownload(request, controller.signal)
        : await cancelDownload(id!, controller.signal);
      if (action.current !== controller) return;
      // A GET started before this mutation must not restore stale running state.
      const previous = read.current;
      read.current = null;
      previous?.abort();
      setRefreshing(false);
      merge(job);
      if (request) {
        unresolved.current = null;
        setUncertain(null);
      }
    } catch (error) {
      if (action.current !== controller) return;
      const definitive =
        error instanceof DownloadRequestError && error.status >= 400 && error.status < 500;
      if (request) {
        unresolved.current = definitive ? null : request;
        setUncertain(unresolved.current);
      }
      setActionError(
        request && !definitive
          ? "The start could not be confirmed. Check status before retrying. Retrying reuses this request ID."
          : error instanceof Error
            ? error.message
            : "The download action failed. Check status and retry.",
      );
      void refresh();
    } finally {
      clearTimeout(timer);
      if (action.current === controller) {
        action.current = null;
        setPending(false);
      }
    }
  }
  return {
    downloads,
    unreported,
    dismissUnreported: (id: string) =>
      setHistory((previous) => ({
        ...previous,
        unreported: previous.unreported.filter((job) => job.id !== id),
      })),
    loading,
    refreshing,
    statusError,
    actionError,
    pending,
    uncertain,
    refresh: () => refresh(true),
    dismissUncertain: () => {
      unresolved.current = null;
      setUncertain(null);
      setActionError("");
    },
    start: (model: string) => mutate(uncertain ?? { requestId: crypto.randomUUID(), model }),
    cancel: (id: string) => mutate(null, id),
  };
}
