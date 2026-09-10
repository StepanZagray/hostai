import { createFileRoute, Link } from "@tanstack/react-router";
import { DirectorySharing } from "../components/directory-sharing";
import { AccessRequests } from "../components/access-requests";
import {
  canRequestAction,
  parseRequests,
  type RequestAction,
  type RequestsStatus,
} from "../components/access-requests-model";
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
import { useSharingDraft } from "../lib/sharing-draft-context";
import { useOwnerConversations } from "../lib/owner-conversations-context";
import { hasCompletedModelAnswer } from "../lib/conversation";

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
  channel?: "local" | "internet";
}
interface InternetStatus {
  state: "off" | "starting" | "verifying" | "live" | "interrupted" | "stopping" | "failed";
  provider: "cloudflare-quick";
  available: boolean;
  publicUrl: string | null;
  checkedAt: string | null;
  error: string | null;
  restartRequired?: boolean;
}
interface Status {
  state: "stopped" | "local" | "unavailable";
  hostLabel: string;
  model: string | null;
  guestUrl: string | null;
  error: string | null;
  grants: Grant[];
  internet?: InternetStatus;
  requests?: RequestsStatus;
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

const internetLabels: Record<InternetStatus["state"], string> = {
  off: "Internet sharing is off",
  starting: "Starting internet sharing…",
  verifying: "Verifying the public connection…",
  live: "Internet sharing is live",
  interrupted: "Internet sharing is interrupted",
  stopping: "Stopping internet sharing…",
  failed: "Internet sharing failed",
};

function httpsOrigin(value: string | null | undefined) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

function liveOrigin(status: Status | null) {
  const internet = status?.internet;
  return status?.state === "local" &&
    internet?.state === "live" &&
    internet.checkedAt &&
    Number.isFinite(Date.parse(internet.checkedAt))
    ? httpsOrigin(internet.publicUrl)
    : null;
}

function inviteUsable(invite: Invite, status: Status | null) {
  let url: URL;
  try {
    url = new URL(invite.inviteUrl);
  } catch {
    return false;
  }
  const recorded = status?.grants.find((grant) => grant.id === invite.grant.id);
  return !!(
    invite.token &&
    new URLSearchParams(url.hash.slice(1)).get("access") === invite.token &&
    !url.username &&
    !url.password &&
    status?.state === "local" &&
    invite.grant.model === status.model &&
    !invite.grant.revokedAt &&
    Date.parse(invite.grant.expiresAt) > Date.now() &&
    recorded &&
    recorded.model === status.model &&
    !recorded.revokedAt &&
    Date.parse(recorded.expiresAt) > Date.now() &&
    (recorded.channel ?? "local") === (invite.grant.channel ?? "local") &&
    ((invite.grant.channel ?? "local") === "local"
      ? url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.origin === status.guestUrl
      : liveOrigin(status) && httpsOrigin(invite.inviteUrl) === liveOrigin(status))
  );
}

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
  if (
    value.internet !== undefined &&
    (!value.internet ||
      !Object.hasOwn(internetLabels, value.internet.state) ||
      value.internet.provider !== "cloudflare-quick" ||
      typeof value.internet.available !== "boolean" ||
      (value.internet.restartRequired !== undefined &&
        typeof value.internet.restartRequired !== "boolean"))
  )
    throw new Error("Internet sharing status could not be read.");
  const requests = parseRequests(value.requests);
  if (requests?.available && (value.state !== "local" || value.internet?.state !== "live"))
    throw new Error("Guest access request availability could not be read. Refresh status.");
  return { ...value, requests };
}

function Sharing() {
  const { models, status: host, refresh: refreshHost, loading, errors: hostErrors } = useHost();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const {
    hostLabel: editedHostLabel,
    editHostLabel: setEditedHostLabel,
    acknowledgeHostLabel,
  } = useSharingDraft();
  const { snapshot: conversations } = useOwnerConversations();
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState("24");
  const [channel, setChannel] = useState<"local" | "internet">("local");
  const [status, setStatus] = useState<Status | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [approvalUncertain, setApprovalUncertain] = useState(false);
  const approvalNeedsRefresh = useRef(false);
  const read = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const hostNameInput = useRef<HTMLInputElement>(null);
  const servingControls = useRef<HTMLElement>(null);
  const eligible = models.filter((model) => chatUnavailableReason(model) === null);
  // Explicit URL intent wins; otherwise resume the server's last configuration.
  // Never silently substitute another model when the intended one disappears.
  const chosen = search.model || status?.model || "";
  const modelAnswered = hasCompletedModelAnswer(
    conversations.conversations.get(chosen)?.turns,
    chosen,
  );
  const hostLabel = editedHostLabel ?? status?.hostLabel ?? "Local host";
  const chosenModel = models.find((model) => model.name === chosen);
  const modelIssue = loading
    ? "Checking your model library…"
    : hostErrors.status || hostErrors.models
      ? "The runtime and model library could not be checked. Check model library to try again."
      : !host?.ollamaConnected
        ? "Connect to your local runtime before starting client access."
        : !chosen
          ? eligible.length
            ? "Choose the model clients may use."
            : "No model is available for chat. Open your model library to download or check a model."
          : !chosenModel
            ? "The selected model is no longer in your library. Choose another installed model or download it again."
            : chatUnavailableReason(chosenModel);
  const running = status?.state === "local";
  const ready = !!status && !error && status.state !== "unavailable";
  const canStart = ready && !pending && modelIssue === null && !!hostLabel.trim();
  const internet = status?.internet;
  const publicOrigin = liveOrigin(status);
  const internetLive = !!publicOrigin;
  const internetBusy =
    internet?.state === "starting" ||
    internet?.state === "verifying" ||
    internet?.state === "stopping";
  const canStartInternet =
    ready &&
    running &&
    internet?.available === true &&
    !internet.restartRequired &&
    (internet.state === "off" || internet.state === "failed");
  const newInvite = invite && inviteUsable(invite, status) ? invite : null;
  const applyStatus = useCallback((next: Status) => {
    setStatus(next);
    setInvite((previous) => (previous && inviteUsable(previous, next) ? previous : null));
    setError("");
  }, []);
  const refresh = useCallback(
    async (acknowledgeApproval = false) => {
      if (read.current || action.current || document.visibilityState !== "visible") return;
      const abort = new AbortController();
      read.current = abort;
      setRefreshing(true);
      const timer = setTimeout(() => abort.abort(), 12_000);
      try {
        const next = statusValue(await api("/api/sharing", abort.signal));
        if (read.current !== abort) return;
        applyStatus(next);
        // Polling can reconcile the key list, but only an explicit refresh acknowledges
        // an approval whose response was lost. Do not silently enable a new approval.
        if (acknowledgeApproval && next.requests) {
          approvalNeedsRefresh.current = false;
          setApprovalUncertain(false);
          setActionError("");
        }
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
    },
    [applyStatus],
  );
  useEffect(() => {
    void refresh();
    return () => {
      const previous = read.current;
      read.current = null;
      previous?.abort();
      const mutation = action.current;
      action.current = null;
      mutation?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(visible, internetBusy ? 2_000 : 5_000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, internetBusy]);
  useEffect(() => {
    if (!invite) return;
    const timer = setTimeout(
      () => setInvite(null),
      Math.max(0, Date.parse(invite.grant.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [invite]);

  async function mutate(name: string, path: string, body: object) {
    if (action.current) return;
    if ((name.startsWith("request-approve:") || name === "create") && approvalNeedsRefresh.current)
      return;
    const abort = new AbortController();
    action.current = abort;
    const previous = read.current;
    read.current = null;
    previous?.abort();
    setRefreshing(false);
    setPending(name);
    setActionError("");
    const timer = setTimeout(() => abort.abort(), 12_000);
    try {
      const result = await api(path, abort.signal, body);
      if (action.current !== abort) return;
      if (name === "create") {
        if (
          !result?.grant?.id ||
          typeof result.inviteUrl !== "string" ||
          typeof result.token !== "string" ||
          !Number.isFinite(Date.parse(result.grant.expiresAt)) ||
          ![undefined, "local", "internet"].includes(result.grant.channel)
        )
          throw new Error(
            "The new access link could not be read. Check the key list before creating another.",
          );
        // The credential remains in this page's memory only and is never reconstructed from history.
        setStatus((previous) =>
          previous
            ? {
                ...previous,
                grants: [
                  ...previous.grants.filter((grant) => grant.id !== result.grant.id),
                  result.grant,
                ],
              }
            : previous,
        );
        setInvite(result);
        setLabel("");
      } else {
        const next = statusValue(result);
        if (name.startsWith("request-") && !next.requests)
          throw new Error("Guest access request status could not be read. Refresh status.");
        applyStatus(next);
        if (
          name === "start" &&
          next.state === "local" &&
          next.model === chosen &&
          next.hostLabel === hostLabel.trim()
        )
          acknowledgeHostLabel(hostLabel);
      }
    } catch (error) {
      if (action.current !== abort) return;
      if (name.startsWith("request-approve:")) {
        approvalNeedsRefresh.current = true;
        setApprovalUncertain(true);
      }
      if (name.startsWith("request-") && !(error instanceof AccessRequestError))
        setError("Guest access request status is out of date. Refresh status.");
      setActionError(
        name === "create" &&
          !(error instanceof AccessRequestError && error.status >= 400 && error.status < 500)
          ? "Key creation could not be confirmed. Refresh the key list and revoke any unwanted key before creating another."
          : error instanceof Error
            ? error.message
            : "The access change could not be confirmed. Refresh its status.",
      );
    } finally {
      clearTimeout(timer);
      if (action.current === abort) {
        action.current = null;
        setPending("");
        void refresh();
      }
    }
  }

  function requestAction(intent: RequestAction) {
    if (action.current) return;
    if (intent.type === "refresh") {
      void refresh(true);
      return;
    }
    if (
      !canRequestAction(
        intent,
        status,
        ready && internetLive && !refreshing,
        approvalNeedsRefresh.current,
      )
    )
      return;
    if (intent.type === "start" || intent.type === "stop") {
      void mutate(`request-${intent.type}`, `/api/sharing/requests/${intent.type}`, {});
    } else {
      void mutate(
        `request-${intent.type}:${intent.id}`,
        `/api/sharing/requests/${intent.id}/${intent.type}`,
        intent.type === "approve"
          ? { code: intent.code, expiresInHours: intent.expiresInHours }
          : { code: intent.code },
      );
    }
  }

  return (
    <div
      className={css({
        minW: 0,
        "& button, & a": {
          minH: "44px",
          maxW: "full",
          whiteSpace: "normal",
          overflowWrap: "anywhere",
        },
        "& svg": { flexShrink: 0 },
      })}
    >
      <PageHeading
        title="Client access"
        description="Choose one model and manage who can use the separate client page."
        action={
          <Button disabled={refreshing || !!pending} onClick={() => void refresh(true)}>
            <RefreshCw size={16} />
            {refreshing ? "Checking access…" : "Refresh access"}
          </Button>
        }
      />
      <section
        className={css({ mb: "6", p: "5", bg: "accentSoft", borderRadius: "10px" })}
        aria-label="Sharing scope"
      >
        <Badge tone={internetLive && !error ? "good" : "neutral"}>
          {!status
            ? "Checking sharing scope"
            : error
              ? "Sharing status is out of date"
              : internetLive
                ? "Temporary internet sharing"
                : internet?.state === "off" || !internet
                  ? "Local preview only"
                  : "Internet link unavailable"}
        </Badge>
        <p className={css({ mt: "3", fontSize: "sm", lineHeight: 1.7 })}>
          {internetLive && !error
            ? "Internet keys let clients use this model from their own browsers. Local keys still work only on this machine."
            : "Local preview links work in a browser on this machine. Internet links require a verified public connection and a separate internet key."}{" "}
          Public discovery requires an optional directory listing below.
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
      <section
        ref={servingControls}
        tabIndex={-1}
        className={`${panel} ${css({ mb: "6" })}`}
        aria-label="Serving controls"
      >
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
              {search.model && search.model !== status.model && (
                <p
                  role="status"
                  className={css({ mb: "4", fontSize: "sm", overflowWrap: "anywhere" })}
                >
                  You selected {search.model} to share. Client access still serves {status.model}.
                  Stop client access, then review and start the selected model.
                </p>
              )}
              <Button
                disabled={!!pending}
                onClick={() => void mutate("stop", "/api/sharing/stop", {})}
              >
                <Square size={16} />
                Stop client access
              </Button>
              {status.model && (
                <Link
                  to="/playground"
                  search={{ model: status.model }}
                  className={button({ variant: "ghost" })}
                >
                  Test the shared model
                </Link>
              )}
              <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
                Stopping ends active client requests and stops internet sharing. Local keys work
                again when you start the same model; revoke a key to end its permission. Internet
                sharing must be started explicitly each time.
              </p>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (canStart)
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
                    onChange={(event) =>
                      void navigate({
                        search: { model: event.target.value },
                        replace: true,
                        resetScroll: false,
                      })
                    }
                    disabled={!!pending || !eligible.length}
                  >
                    {!eligible.some((model) => model.name === chosen) && (
                      <option value={chosen}>
                        {chosen ? `${chosen} (unavailable for chat)` : "Choose a model"}
                      </option>
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
                    ref={hostNameInput}
                    className={field}
                    maxLength={80}
                    required
                    value={hostLabel}
                    disabled={!!pending}
                    onChange={(event) => setEditedHostLabel(event.target.value)}
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
                <Button type="submit" variant="primary" disabled={!canStart}>
                  <Play size={16} />
                  {pending === "start" ? "Starting client access…" : "Start local client access"}
                </Button>
                {chosenModel && chatUnavailableReason(chosenModel) === null && (
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
                <Link to="/models" className={button({ variant: "ghost" })}>
                  Open model library
                </Link>
              </div>
              {modelIssue && (
                <p role="status" className={`${muted} ${css({ mt: "3" })}`}>
                  {modelIssue}
                </p>
              )}
              {!hostLabel.trim() && (
                <p className={`${muted} ${css({ mt: "3" })}`}>
                  Enter a host name clients will recognize.
                </p>
              )}
              {chosen && (
                <p role="status" className={css({ mt: "3", fontSize: "sm", fontWeight: 650 })}>
                  {modelAnswered
                    ? "This model answered a prompt in this tab."
                    : "No completed answer for this model in this tab."}
                </p>
              )}
              <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
                {modelAnswered
                  ? "This evidence comes from the retained conversation and clears on reload or Clear. It does not prove current availability or memory fit. "
                  : modelIssue === null
                    ? "Try a prompt first to check that this model runs on your hardware. "
                    : ""}
                Starting client access does not test or preload the model.
              </p>
            </form>
          )}
          {editedHostLabel !== null && (
            <div className={css({ mt: "4", pt: "4", borderTop: "1px solid token(colors.line)" })}>
              <p
                className={`${muted} ${css({ fontSize: "xs", mb: "2", overflowWrap: "anywhere" })}`}
              >
                Host-name draft kept in this tab: {editedHostLabel || "(empty)"}. It follows you to
                Playground and back. Starting client access applies the name; reloading or closing
                this tab clears unsaved edits.
              </p>
              <Button
                type="button"
                variant="ghost"
                disabled={!!pending}
                onClick={() => {
                  setEditedHostLabel(null);
                  (hostNameInput.current ?? servingControls.current)?.focus({
                    preventScroll: true,
                  });
                }}
              >
                Discard name draft
              </Button>
            </div>
          )}
        </div>
      </section>
      <section className={`${panel} ${css({ mb: "6" })}`} aria-label="Temporary internet sharing">
        <PanelHeading
          title="Temporary internet sharing"
          description="Let clients reach your shared model from their own browsers."
        />
        <div className={css({ px: "5", pb: "5" })}>
          <p role="status" className={css({ fontWeight: 650, mb: "3" })}>
            {!status
              ? "Checking internet sharing…"
              : !internet
                ? "Internet sharing is not available in this gateway"
                : error
                  ? `Last known status: ${internetLabels[internet.state]}`
                  : internetLabels[internet.state]}
          </p>
          <p id="internet-disclosure" className={`${muted} ${css({ mb: "3" })}`}>
            Starting publishes the guest page through Cloudflare. Anyone can open the page in a
            browser; an internet access key is required for chat. Cloudflare terminates TLS and can
            see messages and access keys. This is a temporary connection: the URL changes on every
            start, there is no uptime guarantee, and it is not production hosting.
          </p>
          {publicOrigin && !error && (
            <div className={css({ mb: "4" })}>
              <p className={css({ fontSize: "xs", fontWeight: 650 })}>Public guest page</p>
              <p className={css({ fontFamily: "mono", fontSize: "sm", overflowWrap: "anywhere" })}>
                {publicOrigin}
              </p>
              <p className={`${muted} ${css({ mt: "2", fontSize: "xs" })}`}>
                This address contains no access key. Create an internet client link below to give
                someone permission to chat, or allow guest access requests and approve them below.
              </p>
            </div>
          )}
          {internet?.error && (
            <p
              role={internet.state === "verifying" ? "status" : "alert"}
              className={`${muted} ${css({ mb: "3", overflowWrap: "anywhere" })}`}
            >
              {internet.error}
            </p>
          )}
          {internet && !internet.available && (
            <p className={`${muted} ${css({ mb: "3" })}`}>
              Cloudflare’s connector (cloudflared) is missing. Follow the{" "}
              <a
                href="https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/"
                className={css({ color: "accent", textDecoration: "underline" })}
              >
                official installation instructions
              </a>
              , then restart the gateway and refresh access.
            </p>
          )}
          {!running && (
            <p className={`${muted} ${css({ mb: "3" })}`}>
              Start local client access to publish a model before starting internet sharing.
            </p>
          )}
          {internet?.state === "interrupted" && (
            <p className={`${muted} ${css({ mb: "3" })}`}>
              Internet links are hidden while the connection is unverified. The gateway checks it
              periodically. To start a new connection, stop internet sharing first.
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canStartInternet && !pending)
                void mutate("internet-start", "/api/sharing/internet/start", {});
            }}
          >
            <div className={css({ display: "flex", gap: "3", flexWrap: "wrap" })}>
              <Button
                type="submit"
                variant="primary"
                aria-describedby="internet-disclosure"
                disabled={!canStartInternet || !!pending}
              >
                <Play size={16} />
                {pending === "internet-start"
                  ? "Starting internet sharing…"
                  : "Start internet sharing"}
              </Button>
              {internet && internet.state !== "off" && (
                <Button
                  type="button"
                  disabled={!!pending || internet.state === "stopping" || internet.restartRequired}
                  onClick={() => void mutate("internet-stop", "/api/sharing/internet/stop", {})}
                >
                  <Square size={16} />
                  {pending === "internet-stop" || internet.state === "stopping"
                    ? "Stopping internet sharing…"
                    : "Stop internet sharing"}
                </Button>
              )}
            </div>
          </form>
          <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
            Stopping internet sharing leaves local client access and local keys available. It does
            not automatically restart or publish again. Unexpired internet keys can be used again
            with the same model and a new tunnel address; revoke a key to end its permission.
          </p>
        </div>
      </section>
      <DirectorySharing requestsEnabled={status?.requests?.enabled === true} />
      <AccessRequests
        status={status}
        ready={ready && !refreshing && (internet?.state !== "live" || internetLive)}
        pending={pending}
        error={!!error || !!actionError}
        refreshing={refreshing}
        approvalUncertain={approvalUncertain}
        onAction={requestAction}
      />
      <section className={`${panel} ${css({ mb: "6" })}`} aria-label="Create client key">
        <PanelHeading
          title="Create an access key"
          description="Give each client its own key so you can revoke access separately."
        />
        <div className={css({ px: "5", pb: "5" })}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (
                running &&
                ready &&
                label.trim() &&
                !pending &&
                !invite &&
                !approvalUncertain &&
                (channel === "local" || internetLive) &&
                (status?.grants.length ?? 0) < 100
              )
                void mutate("create", "/api/sharing/grants", {
                  label: label.trim(),
                  expiresInHours: Number(hours),
                  channel,
                });
            }}
          >
            <div
              className={css({
                display: "grid",
                gridTemplateColumns: {
                  base: "minmax(0, 1fr)",
                  md: "minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)",
                },
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
                Key channel
                <select
                  className={field}
                  value={channel}
                  onChange={(event) =>
                    setChannel(event.target.value === "internet" ? "internet" : "local")
                  }
                  disabled={!!pending || !running}
                  aria-describedby="key-channel-help"
                >
                  <option value="local">Local preview</option>
                  <option value="internet" disabled={!internetLive || !ready}>
                    Temporary internet
                  </option>
                </select>
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
            <p id="key-channel-help" className={`${muted} ${css({ mb: "3" })}`}>
              Local keys work only on this machine and cannot become internet keys. Create a
              separate internet key while internet sharing is live.
            </p>
            <Button
              type="submit"
              disabled={
                !ready ||
                !running ||
                (channel === "internet" && !internetLive) ||
                !!pending ||
                !label.trim() ||
                !!invite ||
                approvalUncertain ||
                (status?.grants.length ?? 0) >= 100
              }
            >
              <KeyRound size={16} />
              {pending === "create" ? "Creating key…" : "Create client link"}
            </Button>
            {(status?.grants.length ?? 0) >= 100 && (
              <p className={`${muted} ${css({ mt: "3" })}`}>
                Client access supports 100 saved keys, including expired and revoked keys. New keys
                cannot be created at this limit.
              </p>
            )}
            {!running && (
              <p className={`${muted} ${css({ mt: "3" })}`}>
                Start local client access before creating a key.
              </p>
            )}
          </form>
          {newInvite && (
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
              <p className={css({ fontWeight: 650, mb: "2" })}>
                {newInvite.grant.channel === "internet"
                  ? "Your internet link is ready"
                  : "Your local preview link is ready"}
              </p>
              <p className={`${muted} ${css({ mb: "3", fontSize: "sm" })}`}>
                {newInvite.grant.channel === "internet"
                  ? "Share this internet link with your client. It works only while this temporary public connection is live."
                  : "Copy this local preview link into a browser on this machine."}{" "}
                Anyone with the link can use {newInvite.grant.model} until{" "}
                {date(newInvite.grant.expiresAt)} (your local time).
              </p>
              <div className={css({ display: "flex", gap: "3", flexWrap: "wrap" })}>
                <CopyButton
                  text={newInvite.inviteUrl}
                  label="Copy client link"
                  disabled={!ready || !!pending}
                />
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
              const pausedReason = error
                ? "Refresh access to check this key’s current availability."
                : status.state === "unavailable"
                  ? "Client access is unavailable. Resolve the access error before using this key."
                  : !running
                    ? "Client access is stopped. This permission can resume when its model and access channel are started again."
                    : grant.model !== status.model
                      ? `This key permits ${grant.model}; client access currently serves ${status.model}.`
                      : grant.channel === "internet" && !internetLive
                        ? "Internet sharing is not live. Restore the public connection before using this key."
                        : null;
              const request = status.requests?.items.find((item) => item.grantId === grant.id);
              const grantLabel = request
                ? `Request · ${request.name} · ${request.code}`
                : grant.label;
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
                      {grantLabel}
                    </h3>
                    <Badge tone={grant.revokedAt || expired || pausedReason ? "neutral" : "good"}>
                      {grant.revokedAt
                        ? "Revoked"
                        : expired
                          ? "Expired"
                          : error
                            ? "Status unknown"
                            : pausedReason
                              ? "Access paused"
                              : "Permission active"}
                    </Badge>
                  </div>
                  <p
                    className={`${muted} ${css({ fontSize: "xs", mt: "2", overflowWrap: "anywhere" })}`}
                  >
                    {grant.channel === "internet" ? "Temporary internet" : "Local preview"} ·{" "}
                    {grant.model} · Expires {date(grant.expiresAt)} (your local time)
                  </p>
                  {!grant.revokedAt && !expired && pausedReason && (
                    <p
                      className={`${muted} ${css({ mt: "2", fontSize: "xs", overflowWrap: "anywhere" })}`}
                    >
                      {pausedReason} Pausing access does not revoke the key.
                    </p>
                  )}
                  {!grant.revokedAt && (
                    <Button
                      variant="ghost"
                      disabled={!!pending}
                      onClick={() =>
                        void mutate("revoke", `/api/sharing/grants/${grant.id}/revoke`, {})
                      }
                    >
                      Revoke {grantLabel}
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
    </div>
  );
}
