import { useCallback, useEffect, useRef, useState } from "react";
import { readBoundedJson } from "./registry";
export interface Publication {
  state: "off" | "publishing" | "listed" | "withdrawing" | "interrupted" | "failed";
  configured: boolean;
  registryUrl: string | null;
  enabled: boolean;
  canPublish: boolean;
  identityId: string | null;
  updatedAt: number | null;
  expiresAt: number | null;
  error: string | null;
  reportedRequestsAccepted?: boolean | null;
}
function parse(value: unknown): Publication | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Publication;
  if (
    !["off", "publishing", "listed", "withdrawing", "interrupted", "failed"].includes(item.state) ||
    (item.reportedRequestsAccepted !== undefined &&
      item.reportedRequestsAccepted !== null &&
      typeof item.reportedRequestsAccepted !== "boolean") ||
    typeof item.configured !== "boolean" ||
    typeof item.enabled !== "boolean" ||
    typeof item.canPublish !== "boolean" ||
    !(
      item.identityId === null ||
      (typeof item.identityId === "string" && /^[a-f0-9]{64}$/.test(item.identityId))
    ) ||
    !(item.error === null || (typeof item.error === "string" && item.error.length <= 600)) ||
    ![item.updatedAt, item.expiresAt].every(
      (time) => time === null || (Number.isSafeInteger(time) && time > 0),
    )
  )
    return null;
  if (item.registryUrl !== null) {
    if (typeof item.registryUrl !== "string") return null;
    try {
      const url = new URL(item.registryUrl);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))
      )
        return null;
    } catch {
      return null;
    }
  }
  if (item.configured && item.registryUrl === null) return null;
  return item;
}
export function usePublication() {
  const [status, setStatus] = useState<Publication | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const mounted = useRef(true);
  const request = useCallback(async (action?: "start" | "stop") => {
    if (mutation.current) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    mutation.current = !!action;
    setPending(!!action);
    setLoading(true);
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`/api/directory${action ? `/${action}` : ""}`, {
        method: action ? "POST" : "GET",
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(action ? { "Content-Type": "application/json" } : {}),
        },
        body: action ? "{}" : undefined,
      });
      const next = parse(await readBoundedJson(response, 16_384));
      if (!next) throw new Error("Invalid status");
      if (active.current !== controller || controller.signal.aborted || !mounted.current) return;
      setStatus(next);
      setError("");
    } catch {
      if (active.current === controller && mounted.current)
        setError(
          action
            ? "The directory action could not be confirmed. Refresh its status before trying again."
            : "Directory status could not be checked. Refresh to try again.",
        );
    } finally {
      clearTimeout(timer);
      if (active.current === controller) {
        active.current = null;
        mutation.current = false;
        if (mounted.current) {
          setPending(false);
          setLoading(false);
        }
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void request();
    const poll = setInterval(() => {
      if (document.visibilityState !== "hidden" && !active.current) void request();
    }, 3000);
    const visible = () => {
      if (document.visibilityState !== "hidden" && !mutation.current) void request();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      const previous = active.current;
      active.current = null;
      mutation.current = false;
      previous?.abort();
      clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [request]);
  return {
    status,
    error,
    loading,
    pending,
    refresh: () => request(),
    start: () => request("start"),
    stop: () => request("stop"),
  };
}
