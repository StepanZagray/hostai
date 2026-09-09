import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Play, RefreshCw, Square } from "lucide-react";
import { css } from "../../styled-system/css";
import {
  Badge,
  Button,
  CopyButton,
  PageHeading,
  PanelHeading,
  button,
  muted,
  panel,
} from "../components/ui";
import { useHost } from "../lib/host-context";
import { chatUnavailableReason } from "../lib/model-admission";
import { errorMessage } from "../lib/api";

export const Route = createFileRoute("/sharing")({
  validateSearch: (search: Record<string, unknown>) => ({
    model: typeof search.model === "string" ? search.model : undefined,
  }),
  component: Sharing,
});
interface Grant {
  id: string;
  label: string;
  model: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
interface Status {
  state: "stopped" | "local" | "unavailable";
  hostLabel: string;
  model: string | null;
  guestUrl: string | null;
  error: string | null;
  grants: Grant[];
}
interface Invite {
  grant: Grant;
  token: string;
  inviteUrl: string;
}

const field = css({
  minH: "44px",
  w: "full",
  minW: 0,
  bg: "canvas",
  border: "1px solid token(colors.line)",
  borderRadius: "7px",
  px: "3",
  fontSize: "sm",
});
const labelStyle = css({ display: "grid", gap: "2", fontSize: "xs", fontWeight: 650, minW: 0 });
const date = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

class AccessRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api(path: string, signal: AbortSignal, body?: object) {
  const response = await fetch(path, {
    signal,
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new AccessRequestError(await errorMessage(response), response.status);
  try {
    return await response.json();
  } catch {
    throw new Error("Client access status could not be read. Check the gateway and try again.");
  }
}
function statusValue(value: Status): Status {
  if (
    !value ||
    !["stopped", "local", "unavailable"].includes(value.state) ||
    !Array.isArray(value.grants) ||
    value.grants.length > 100
  )
    throw new Error("Client access status could not be read.");
  return value;
}

function Sharing() {
  const { models, status: host, refresh: refreshHost } = useHost();
  const search = Route.useSearch();
  const [selected, setSelected] = useState(search.model || "");
  const [hostLabel, setHostLabel] = useState("Local host");
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState("24");
  const [status, setStatus] = useState<Status | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const read = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const eligible = models.filter((model) => chatUnavailableReason(model) === null);
  const chosen = selected || eligible[0]?.name || "";
  const running = status?.state === "local";
  const ready = !!status && !error && status.state !== "unavailable";
  const refresh = useCallback(async () => {
    if (read.current) return;
    const abort = new AbortController();
    read.current = abort;
    setRefreshing(true);
    const timer = setTimeout(() => abort.abort(), 12_000);
    try {
      const next = statusValue(await api("/api/sharing", abort.signal));
      if (read.current !== abort) return;
      setStatus(next);
      setInvite((previous) =>
        previous &&
        next.state === "local" &&
        previous.grant.model === next.model &&
        Date.parse(previous.grant.expiresAt) > Date.now() &&
        !next.grants.some((grant) => grant.id === previous.grant.id && grant.revokedAt)
          ? previous
          : null,
      );
      setError("");
    } catch (error) {
      if (read.current === abort)
        setError(
          abort.signal.aborted
            ? "Client access status timed out."
            : error instanceof Error
              ? error.message
              : "Client access status is unavailable.",
        );
    } finally {
      clearTimeout(timer);
      if (read.current === abort) {
        read.current = null;
        setRefreshing(false);
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(visible, 5_000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      const previous = read.current;
      read.current = null;
      previous?.abort();
      const mutation = action.current;
      action.current = null;
      mutation?.abort();
    };
  }, [refresh]);

  async function mutate(name: string, path: string, body: object) {
    if (action.current) return;
    const abort = new AbortController();
    action.current = abort;
    setPending(name);
    setActionError("");
    const timer = setTimeout(() => abort.abort(), 12_000);
    try {
      const result = await api(path, abort.signal, body);
      if (action.current !== abort) return;
      const previous = read.current;
      read.current = null;
      previous?.abort();
      setRefreshing(false);
      if (name === "create") {
        if (
          !result?.grant?.id ||
          typeof result.inviteUrl !== "string" ||
          typeof result.token !== "string"
        )
          throw new Error(
            "The new access link could not be read. Check the key list before creating another.",
          );
        // The credential remains in this page's memory only and is never reconstructed from history.
        setInvite(result);
        setLabel("");
        void refresh();
      } else {
        const next = statusValue(result);
        setStatus(next);
        setError("");
        if (
          name === "stop" ||
          next.grants.some((grant) => grant.id === invite?.grant.id && grant.revokedAt)
        )
          setInvite(null);
      }
    } catch (error) {
      if (action.current !== abort) return;
      setActionError(
        name === "create" &&
          !(error instanceof AccessRequestError && error.status >= 400 && error.status < 500)
          ? "Key creation could not be confirmed. Refresh the key list and revoke any unwanted key before creating another."
          : error instanceof Error
            ? error.message
            : "The access change could not be confirmed. Refresh its status.",
      );
      void refresh();
    } finally {
      clearTimeout(timer);
      if (action.current === abort) {
        action.current = null;
        setPending("");
      }
    }
  }

  return (
    <>
      <PageHeading
        title="Client access"
        description="Choose one model and manage who can use the separate client page."
        action={
          <Button disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw size={16} />
            {refreshing ? "Checking access…" : "Refresh access"}
          </Button>
        }
      />
      <section
        className={css({ mb: "6", p: "5", bg: "accentSoft", borderRadius: "10px" })}
        aria-label="Local preview"
      >
        <Badge tone="neutral">Local preview only</Badge>
        <p className={css({ mt: "3", fontSize: "sm", lineHeight: 1.7 })}>
          These links work in a browser on this machine. Internet sharing, public host discovery and
          a tunnel are not connected yet.
        </p>
        <p className={`${muted} ${css({ mt: "2", fontSize: "xs" })}`}>
          The client page is separate from your host controls. Access keys permit one model; clients
          receive no download controls or request history.
        </p>
      </section>
      {!status && !error && <p role="status">Checking client access…</p>}
      {error && (
        <p role="alert" className={css({ mb: "4", color: "warning" })}>
          {error} Saved access status may be out of date.
        </p>
      )}
      {actionError && (
        <p role="alert" className={css({ mb: "4", color: "danger" })}>
          {actionError}
        </p>
      )}
      {status?.error && (
        <p role="alert" className={css({ mb: "4", color: "danger" })}>
          {status.error}
        </p>
      )}
      <section className={`${panel} ${css({ mb: "6" })}`} aria-label="Serving controls">
        <PanelHeading
          title={
            !status
              ? "Client access status unknown"
              : status.state === "unavailable"
                ? "Client access unavailable"
                : running
                  ? "Local client access is on"
                  : "Client access is stopped"
          }
          description="Local chat in your playground remains available independently."
        />
        <div className={css({ px: "5", pb: "5" })}>
          {running ? (
            <>
              <p className={css({ fontFamily: "mono", overflowWrap: "anywhere", mb: "3" })}>
                {status.model}
              </p>
              <p className={`${muted} ${css({ mb: "4", fontSize: "sm" })}`}>
                Clients see “{status.hostLabel}” as a host-provided name. One guest may generate at
                a time, leaving capacity for your own chat.
              </p>
              <Button
                disabled={!!pending}
                onClick={() => void mutate("stop", "/api/sharing/stop", {})}
              >
                <Square size={16} />
                Stop client access
              </Button>
              <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
                Stopping ends active client requests. Existing keys remain valid when you start the
                same model again; revoke a key to end its permission.
              </p>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (ready && chosen && host?.ollamaConnected && !pending)
                  void mutate("start", "/api/sharing/start", { model: chosen, hostLabel });
              }}
            >
              <div
                className={css({
                  display: "grid",
                  gridTemplateColumns: { base: "1fr", md: "1fr 1fr" },
                  gap: "4",
                  mb: "4",
                })}
              >
                <label className={labelStyle}>
                  Model for clients
                  <select
                    className={field}
                    value={chosen}
                    onChange={(event) => setSelected(event.target.value)}
                    disabled={!!pending || !eligible.length}
                  >
                    {!eligible.some((model) => model.name === chosen) && (
                      <option value={chosen}>{chosen || "No model available"}</option>
                    )}
                    {eligible.map((model) => (
                      <option key={model.name} value={model.name}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelStyle}>
                  Host name shown to clients
                  <input
                    className={field}
                    maxLength={80}
                    required
                    value={hostLabel}
                    disabled={!!pending}
                    onChange={(event) => setHostLabel(event.target.value)}
                  />
                </label>
              </div>
              <div
                className={css({
                  display: "flex",
                  gap: "3",
                  flexWrap: "wrap",
                  alignItems: "center",
                })}
              >
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    !ready ||
                    !!pending ||
                    !host?.ollamaConnected ||
                    !eligible.some((model) => model.name === chosen) ||
                    !hostLabel.trim()
                  }
                >
                  <Play size={16} />
                  {pending === "start" ? "Starting client access…" : "Start local client access"}
                </Button>
                {chosen && (
                  <Link
                    to="/playground"
                    search={{ model: chosen }}
                    className={button({ variant: "secondary" })}
                  >
                    Test model in playground
                  </Link>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!!pending}
                  onClick={() => void refreshHost()}
                >
                  Check model library
                </Button>
              </div>
              <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
                Try a prompt first to check that this model runs on your hardware. Starting client
                access does not test or preload the model.
              </p>
            </form>
          )}
        </div>
      </section>
      <section className={`${panel} ${css({ mb: "6" })}`} aria-label="Create client key">
        <PanelHeading
          title="Create an access key"
          description="Give each client its own key so you can revoke access separately."
        />
        <div className={css({ px: "5", pb: "5" })}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (running && ready && label.trim() && !pending)
                void mutate("create", "/api/sharing/grants", {
                  label: label.trim(),
                  expiresInHours: Number(hours),
                });
            }}
          >
            <div
              className={css({
                display: "grid",
                gridTemplateColumns: { base: "1fr", md: "2fr 1fr" },
                gap: "4",
                mb: "4",
              })}
            >
              <label className={labelStyle}>
                Key label
                <input
                  className={field}
                  placeholder="For a friend"
                  required
                  maxLength={80}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={!!pending || !running}
                />
              </label>
              <label className={labelStyle}>
                Expires after
                <select
                  className={field}
                  value={hours}
                  onChange={(event) => setHours(event.target.value)}
                  disabled={!!pending || !running}
                >
                  <option value="1">1 hour</option>
                  <option value="24">24 hours</option>
                  <option value="168">7 days</option>
                </select>
              </label>
            </div>
            <Button
              type="submit"
              disabled={
                !ready ||
                !running ||
                !!pending ||
                !label.trim() ||
                !!invite ||
                (status?.grants.length ?? 0) >= 100
              }
            >
              <KeyRound size={16} />
              {pending === "create" ? "Creating key…" : "Create client link"}
            </Button>
            {(status?.grants.length ?? 0) >= 100 && (
              <p className={`${muted} ${css({ mt: "3" })}`}>
                The local preview supports 100 saved keys, including expired and revoked keys. New
                keys cannot be created at this limit.
              </p>
            )}
            {!running && (
              <p className={`${muted} ${css({ mt: "3" })}`}>
                Start local client access before creating a key.
              </p>
            )}
          </form>
          {invite && (
            <div
              className={css({
                mt: "5",
                p: "4",
                border: "1px solid token(colors.line)",
                borderRadius: "7px",
              })}
              role="region"
              aria-label="New client link"
            >
              <p className={css({ fontWeight: 650, mb: "2" })}>Your link is ready</p>
              <p className={`${muted} ${css({ mb: "3", fontSize: "sm" })}`}>
                Copy this local preview link into a browser on this machine. Anyone with the link
                can use {invite.grant.model} until {date(invite.grant.expiresAt)}.
              </p>
              <div className={css({ display: "flex", gap: "3", flexWrap: "wrap" })}>
                <CopyButton text={invite.inviteUrl} label="Copy client link" />
                <Button onClick={() => setInvite(null)}>Hide link</Button>
              </div>
              <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
                This link is shown only once. If you lose it, revoke its key and create another. It
                is not saved in your browser.
              </p>
            </div>
          )}
        </div>
      </section>
      <section className={panel} aria-label="Access keys">
        <PanelHeading
          title="Access keys"
          description="Revocation ends active requests and survives a gateway restart."
        />
        <div className={css({ px: "5", pb: "5" })}>
          {status && status.state !== "unavailable" && !error && !status.grants.length && (
            <p className={muted}>No keys are recorded.</p>
          )}
          <ul className={css({ display: "grid", gap: "4" })}>
            {status?.grants.map((grant) => {
              const expired = Date.parse(grant.expiresAt) <= Date.now();
              return (
                <li
                  key={grant.id}
                  className={css({ borderTop: "1px solid token(colors.line)", pt: "4" })}
                >
                  <div
                    className={css({
                      display: "flex",
                      alignItems: "center",
                      gap: "3",
                      flexWrap: "wrap",
                      justifyContent: "space-between",
                    })}
                  >
                    <h3 className={css({ fontWeight: 650, overflowWrap: "anywhere" })}>
                      {grant.label}
                    </h3>
                    <Badge tone={grant.revokedAt || expired ? "neutral" : "good"}>
                      {grant.revokedAt ? "Revoked" : expired ? "Expired" : "Valid key"}
                    </Badge>
                  </div>
                  <p
                    className={`${muted} ${css({ fontSize: "xs", mt: "2", overflowWrap: "anywhere" })}`}
                  >
                    {grant.model} · Expires {date(grant.expiresAt)}
                  </p>
                  {!grant.revokedAt && (
                    <Button
                      variant="ghost"
                      disabled={!!pending}
                      onClick={() =>
                        void mutate("revoke", `/api/sharing/grants/${grant.id}/revoke`, {})
                      }
                    >
                      Revoke {grant.label}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className={`${muted} ${css({ mt: "5", fontSize: "xs" })}`}>
            Keys are stored privately by the gateway and cannot be recovered as links. Client access
            starts stopped after every gateway restart. Up to 100 keys are retained, including
            revoked keys.
          </p>
        </div>
      </section>
    </>
  );
}
