import { createFileRoute, Link } from "@tanstack/react-router";
import { KeyCleanup } from "../components/key-cleanup";
import { AccessRequests } from "../components/access-requests";
import { QrCode } from "../components/qr-code";
import { AccessKeyField } from "../components/access-key-field";
import {
  canRequestAction,
  parseRequests,
  type RequestAction,
  type RequestsStatus,
} from "../components/access-requests-model";
import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, KeyRound, Play, RefreshCw, Square } from "lucide-react";
import { css } from "../../styled-system/css";
import {
  Badge,
  Button,
  CopyButton,
  DataList,
  Disclosure,
  Field,
  Led,
  Note,
  PageHeading,
  Section,
  button,
  caption,
  control,
  legend,
  mono,
  muted,
  type LedState,
} from "../components/ui";
import { useHost } from "../lib/host-context";
import { interfaceUnavailableReason } from "../lib/model-admission";
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
  recoverable?: boolean;
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
  removableKeys?: number;
  internet?: InternetStatus;
  requests?: RequestsStatus;
}
/** A key the host has asked to see. Held in this tab only; the gateway can always reissue it. */
interface ShownKey {
  id: string;
  token: string;
}

const date = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const internetLabels: Record<InternetStatus["state"], string> = {
  off: "Hosting is off",
  starting: "Starting hosting…",
  verifying: "Verifying the public address…",
  live: "Hosting is live",
  interrupted: "Hosting is interrupted",
  stopping: "Stopping hosting…",
  failed: "Hosting failed",
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
    throw new Error("Guest access status could not be read. Check the gateway and try again.");
  }
}
function statusValue(value: Status): Status {
  if (
    !value ||
    !["stopped", "local", "unavailable"].includes(value.state) ||
    !Array.isArray(value.grants) ||
    value.grants.length > 100 ||
    (value.removableKeys !== undefined &&
      (!Number.isInteger(value.removableKeys) ||
        value.removableKeys < 0 ||
        value.removableKeys > value.grants.length))
  )
    throw new Error("Guest access status could not be read.");
  if (
    value.internet !== undefined &&
    (!value.internet ||
      !Object.hasOwn(internetLabels, value.internet.state) ||
      value.internet.provider !== "cloudflare-quick" ||
      typeof value.internet.available !== "boolean" ||
      (value.internet.restartRequired !== undefined &&
        typeof value.internet.restartRequired !== "boolean"))
  )
    throw new Error("Hosting status could not be read.");
  const requests = parseRequests(value.requests);
  if (requests?.available && (value.state !== "local" || value.internet?.state !== "live"))
    throw new Error("Guest access request availability could not be read. Refresh status.");
  return { ...value, requests };
}

/** A state sentence led by its light: the first thing each panel says. */
const statusLine = css({
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  alignItems: "start",
  columnGap: "2",
  fontSize: "sm",
  fontWeight: 500,
  lineHeight: 1.5,
  color: "ink",
  minW: 0,
  overflowWrap: "anywhere",
  "& > span[aria-hidden]": { mt: "6px" },
});

const well = css({
  px: "3",
  py: "2.5",
  bg: "well",
  border: "1px solid token(colors.line)",
  borderRadius: "sm",
  minW: 0,
});

const internetLights: Record<InternetStatus["state"], LedState> = {
  off: "off",
  starting: "busy",
  verifying: "busy",
  live: "live",
  interrupted: "amber",
  stopping: "busy",
  failed: "amber",
};

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
  const [status, setStatus] = useState<Status | null>(null);
  const [shownKey, setShownKey] = useState<ShownKey | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [cleanupMessage, setCleanupMessage] = useState("");
  const [pending, setPending] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [approvalUncertain, setApprovalUncertain] = useState(false);
  const approvalNeedsRefresh = useRef(false);
  const read = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const hostNameInput = useRef<HTMLInputElement>(null);
  const hostingControls = useRef<HTMLElement>(null);
  const keyControls = useRef<HTMLElement>(null);
  const eligible = models.filter((model) => interfaceUnavailableReason(model) === null);
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
        ? "Connect to your local runtime before hosting."
        : !chosen
          ? eligible.length
            ? "Choose the model guests may use."
            : "No model has a supported interface. Open your model library to download or check a model."
          : !chosenModel
            ? "The selected model is no longer in your library. Choose another installed model or download it again."
            : interfaceUnavailableReason(chosenModel);
  const running = status?.state === "local";
  const ready = !!status && !error && status.state !== "unavailable";
  const internet = status?.internet;
  const publicOrigin = liveOrigin(status);
  const internetLive = !!publicOrigin;
  const internetBusy =
    internet?.state === "starting" ||
    internet?.state === "verifying" ||
    internet?.state === "stopping";
  const hostingPending = pending === "start" || pending === "internet-start";
  // The gateway can only tunnel a model it is already serving, so hosting is one two-step action.
  const canStartHosting =
    ready &&
    !pending &&
    modelIssue === null &&
    !!hostLabel.trim() &&
    internet?.available === true &&
    !internet.restartRequired;
  // Local access is up but the tunnel is not: the public half needs another attempt.
  const tunnelIncomplete =
    running && !!internet && (internet.state === "off" || internet.state === "failed");
  const applyStatus = useCallback((next: Status) => {
    setStatus(next);
    // A key the gateway no longer recognises must not stay legible on screen.
    setShownKey((previous) =>
      previous &&
      next.grants.some(
        (grant) =>
          grant.id === previous.id && !grant.revokedAt && Date.parse(grant.expiresAt) > Date.now(),
      )
        ? previous
        : null,
    );
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
              ? "Guest access status timed out."
              : error instanceof Error
                ? error.message
                : "Guest access status is unavailable.",
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

  async function mutate(name: string, path: string, body: object) {
    if (action.current) return null;
    if ((name.startsWith("request-approve:") || name === "create") && approvalNeedsRefresh.current)
      return null;
    const abort = new AbortController();
    action.current = abort;
    const previous = read.current;
    read.current = null;
    previous?.abort();
    setRefreshing(false);
    setPending(name);
    setActionError("");
    setCleanupMessage("");
    let settled: Record<string, unknown> | null = null;
    const timer = setTimeout(() => abort.abort(), 12_000);
    try {
      const result = await api(path, abort.signal, body);
      if (action.current !== abort) return null;
      if (name === "cleanup") {
        const next = statusValue(result?.status);
        if (
          next.removableKeys === undefined ||
          !Number.isInteger(result.removedCount) ||
          result.removedCount < 0 ||
          result.removedCount + next.grants.length > 100
        )
          throw new Error("Key cleanup result could not be read.");
        applyStatus(next);
        setCleanupMessage(
          result.removedCount === 0
            ? "No keys were removed. The gateway found no expired or revoked keys."
            : `Removed ${result.removedCount} expired or revoked ${result.removedCount === 1 ? "key" : "keys"}. Active keys were kept.`,
        );
      } else if (name === "create") {
        if (
          !result?.grant?.id ||
          typeof result.token !== "string" ||
          !Number.isFinite(Date.parse(result.grant.expiresAt)) ||
          ![undefined, "local", "internet"].includes(result.grant.channel)
        )
          throw new Error(
            "The new key could not be read. Check the key list before creating another.",
          );
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
        setLabel("");
      } else if (name.startsWith("read-key:")) {
        if (typeof result?.token !== "string" || !result.token)
          throw new Error("That key could not be read. Refresh access and try again.");
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
      settled = result;
    } catch (error) {
      if (action.current !== abort) return null;
      if (name.startsWith("request-approve:")) {
        approvalNeedsRefresh.current = true;
        setApprovalUncertain(true);
      }
      if (name.startsWith("request-") && !(error instanceof AccessRequestError))
        setError("Guest access request status is out of date. Refresh status.");
      setActionError(
        name === "cleanup"
          ? "Key cleanup could not be confirmed. Refresh access to check the saved keys before trying again."
          : name === "create" &&
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
        // Chained hosting steps refresh once at the end, not between the two calls.
        if (!settled || name !== "start") void refresh();
      }
    }
    return settled;
  }

  /** Reads a stored key without rendering it; copying must not unmask. */
  async function readKey(id: string) {
    const result = await mutate(`read-key:${id}`, `/api/sharing/grants/${id}/key`, {});
    return typeof result?.token === "string" ? result.token : null;
  }

  // Serving a model and publishing it are one host-facing action in two gateway calls.
  async function startHosting() {
    if (!canStartHosting) return;
    if (await mutate("start", "/api/sharing/start", { model: chosen, hostLabel }))
      await mutate("internet-start", "/api/sharing/internet/start", {});
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
        // Every control on this page stays a 44px touch target, including compact variants.
        "& button, & a, & select, & input": {
          minH: "44px",
          maxW: "full",
          whiteSpace: "normal",
          overflowWrap: "anywhere",
        },
        "& svg": { flexShrink: 0 },
      })}
    >
      <PageHeading
        title="Guest access"
        description="Publish one model to the internet, then hand out keys you can revoke."
        action={
          <Button disabled={refreshing || !!pending} onClick={() => void refresh(true)}>
            <RefreshCw size={15} />
            {refreshing ? "Checking access…" : "Refresh access"}
          </Button>
        }
      />
      <div className={css({ display: "grid", gap: "5", minW: 0 })}>
        {!status && !error && (
          <p role="status" className={statusLine}>
            <Led state="busy" />
            Checking guest access…
          </p>
        )}
        {error && (
          <Note role="alert" tone="warning">
            {error} Saved access status may be out of date.
          </Note>
        )}
        {actionError && (
          <Note role="alert" tone="danger">
            {actionError}
          </Note>
        )}
        {status?.error && (
          <Note role="alert" tone="danger">
            {status.error}
          </Note>
        )}

        <Section
          ref={hostingControls}
          tabIndex={-1}
          aria-label="Internet hosting"
          title="Host on the internet"
          description="Publish one model at a temporary public address your guests can open."
          aside={
            <Badge
              tone={
                !status
                  ? "busy"
                  : error
                    ? "warning"
                    : internetLive
                      ? "good"
                      : running
                        ? "warning"
                        : "neutral"
              }
            >
              {!status
                ? "Checking hosting"
                : error
                  ? "Hosting status is out of date"
                  : internetLive
                    ? "Reachable from the internet"
                    : running
                      ? "Not reachable yet"
                      : "Not hosting"}
            </Badge>
          }
        >
          <p role="status" className={statusLine}>
            <Led
              state={
                !status
                  ? "busy"
                  : status.state === "unavailable"
                    ? "amber"
                    : !running
                      ? "off"
                      : !internet
                        ? "off"
                        : error
                          ? "amber"
                          : internetLights[internet.state]
              }
            />
            {!status
              ? "Checking hosting…"
              : status.state === "unavailable"
                ? "Guest access is unavailable"
                : !internet
                  ? "Hosting is not available in this gateway"
                  : !running
                    ? "Hosting is off"
                    : error
                      ? `Last known status: ${internetLabels[internet.state]}`
                      : internetLabels[internet.state]}
          </p>

          {running && !error && (
            <DataList
              items={[
                { term: "Model", value: status.model },
                { term: "Host name guests see", value: status.hostLabel },
              ]}
            />
          )}

          {publicOrigin && !error && (
            <div
              className={css({
                mt: "3.5",
                display: "flex",
                gap: "4",
                flexWrap: "wrap",
                alignItems: "start",
              })}
            >
              <div className={css({ flex: "1 1 18rem", minW: 0 })}>
                <div className={well}>
                  <p className={legend}>Guest page address</p>
                  <p className={`${mono} ${css({ fontSize: "sm", color: "ink", mt: "1" })}`}>
                    {publicOrigin}
                  </p>
                </div>
                <div className={css({ mt: "2" })}>
                  <CopyButton text={publicOrigin} label="Copy guest address" />
                </div>
                <p className={`${caption} ${css({ mt: "2" })}`}>
                  This address carries no key. Send it to your guest, then send them a key from
                  Access keys below; they paste the key on the page.
                </p>
              </div>
              <div>
                <p className={`${legend} ${css({ mb: "1.5" })}`}>Scan to open</p>
                <QrCode
                  value={publicOrigin}
                  title="QR code for the guest page address"
                  size={168}
                />
              </div>
            </div>
          )}

          {internet?.error && (
            <Note
              role={internet.state === "verifying" ? "status" : "alert"}
              tone={internet.state === "verifying" ? "neutral" : "warning"}
              className={css({ mt: "3", overflowWrap: "anywhere" })}
            >
              {internet.error}
            </Note>
          )}
          {internet && !internet.available && (
            <Note tone="warning" className={css({ mt: "3" })}>
              Cloudflare’s connector (cloudflared) is missing, so this gateway cannot reach the
              internet. Follow the{" "}
              <a href="https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/">
                official installation instructions
              </a>
              , then restart the gateway and refresh access.
            </Note>
          )}
          {tunnelIncomplete && !error && (
            <Note tone="warning" className={css({ mt: "3" })}>
              This model is being served locally, but it is not reachable from the internet yet. Try
              the public connection again, or stop hosting.
            </Note>
          )}
          {internet?.state === "interrupted" && (
            <p className={`${caption} ${css({ mt: "2.5" })}`}>
              The address stays hidden while the connection is unverified. The gateway rechecks it
              periodically; stop hosting to start a new connection.
            </p>
          )}
          {search.model && running && search.model !== status.model && (
            <Note role="status" tone="warning" className={css({ mt: "3" })}>
              You selected {search.model} to share. Hosting still serves {status.model}. Stop
              hosting first, then start the selected model.
            </Note>
          )}

          {running ? (
            <>
              <div className={css({ display: "flex", gap: "2", flexWrap: "wrap", mt: "4" })}>
                <Button
                  disabled={!!pending}
                  onClick={() => void mutate("stop", "/api/sharing/stop", {})}
                >
                  <Square size={15} />
                  {pending === "stop" ? "Stopping hosting…" : "Stop hosting"}
                </Button>
                {tunnelIncomplete && (
                  <Button
                    variant="primary"
                    disabled={!!pending || !internet?.available || internet.restartRequired}
                    onClick={() => void mutate("internet-start", "/api/sharing/internet/start", {})}
                  >
                    <Globe size={15} />
                    {pending === "internet-start"
                      ? "Connecting…"
                      : "Try the public connection again"}
                  </Button>
                )}
                {status.model && (
                  <Link
                    to="/playground"
                    search={{ model: status.model }}
                    className={button({ variant: "ghost" })}
                  >
                    Test the shared model
                  </Link>
                )}
              </div>
              <p className={`${caption} ${css({ mt: "2.5" })}`}>
                One guest may generate at a time, leaving capacity for your own chat. Stopping ends
                active requests and takes the public address offline; your keys are kept and work
                again at the next address.
              </p>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void startHosting();
              }}
            >
              <div
                className={css({
                  display: "grid",
                  gridTemplateColumns: {
                    base: "minmax(0, 1fr)",
                    md: "minmax(0, 1fr) minmax(0, 1fr)",
                  },
                  gap: "3",
                  mb: "3.5",
                  mt: "3.5",
                })}
              >
                <Field label="Model for guests">
                  <select
                    className={control}
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
                </Field>
                <Field
                  label="Host name shown to guests"
                  hint={hostLabel.trim() ? undefined : "Enter a host name guests will recognize."}
                >
                  <input
                    ref={hostNameInput}
                    className={control}
                    maxLength={80}
                    required
                    value={hostLabel}
                    disabled={!!pending}
                    onChange={(event) => setEditedHostLabel(event.target.value)}
                  />
                </Field>
              </div>
              <div className={css({ display: "flex", gap: "2", flexWrap: "wrap" })}>
                <Button
                  type="submit"
                  variant="primary"
                  aria-describedby="hosting-disclosure"
                  disabled={!canStartHosting}
                >
                  <Play size={15} />
                  {hostingPending ? "Starting hosting…" : "Start hosting"}
                </Button>
                {chosenModel && interfaceUnavailableReason(chosenModel) === null && (
                  <Link to="/playground" search={{ model: chosen }} className={button()}>
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
              {chosen && (
                <p role="status" className={`${statusLine} ${css({ mt: "3" })}`}>
                  <Led state={modelAnswered ? "live" : "off"} />
                  {modelAnswered
                    ? "This model answered a prompt in this tab."
                    : "No completed answer for this model in this tab."}
                </p>
              )}
              <p className={`${caption} ${css({ mt: "1.5" })}`}>
                {modelAnswered
                  ? "Evidence from the retained conversation; it clears on reload and does not prove current availability or memory fit. "
                  : modelIssue === null
                    ? "Try a prompt first to check that this model runs on your hardware. "
                    : ""}
                Starting hosting does not test or preload the model.
              </p>
            </form>
          )}

          {editedHostLabel !== null && (
            <div
              className={css({
                mt: "4",
                pt: "3",
                borderTop: "1px solid token(colors.lineSoft)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "3",
                flexWrap: "wrap",
              })}
            >
              <p
                className={`${caption} ${css({ minW: 0, flex: "1 1 20rem", overflowWrap: "anywhere" })}`}
              >
                Host-name draft kept in this tab: {editedHostLabel || "(empty)"}. Starting hosting
                applies it; reloading discards it.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!!pending}
                onClick={() => {
                  setEditedHostLabel(null);
                  (hostNameInput.current ?? hostingControls.current)?.focus({
                    preventScroll: true,
                  });
                }}
              >
                Discard name draft
              </Button>
            </div>
          )}

          <Disclosure summary="What hosting exposes" className={css({ mt: "3.5" })}>
            <p id="hosting-disclosure">
              Starting makes the guest page reachable through Cloudflare. Anyone with its address
              can open the page; an access key is required for chat. Cloudflare terminates TLS and
              can see messages and access keys.
            </p>
            <p>
              The address changes on every start, there is no uptime guarantee, and it is not
              production hosting.
            </p>
          </Disclosure>
        </Section>

        <AccessRequests
          status={status}
          ready={ready && !refreshing && (internet?.state !== "live" || internetLive)}
          pending={pending}
          error={!!error || !!actionError}
          refreshing={refreshing}
          approvalUncertain={approvalUncertain}
          onAction={requestAction}
        />

        <Section
          ref={keyControls}
          tabIndex={-1}
          aria-label="Access keys"
          title="Access keys"
          description="One key per guest. Send a key alongside the address; you can look it up or revoke it at any time."
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (
                running &&
                ready &&
                label.trim() &&
                !pending &&
                !approvalUncertain &&
                (status?.grants.length ?? 0) < 100
              )
                void mutate("create", "/api/sharing/grants", {
                  label: label.trim(),
                  expiresInHours: Number(hours),
                  channel: "internet",
                });
            }}
          >
            <div
              className={css({
                display: "grid",
                gridTemplateColumns: {
                  base: "minmax(0, 1fr)",
                  md: "minmax(0, 2fr) minmax(0, 1fr)",
                },
                gap: "3",
                mb: "3.5",
              })}
            >
              <Field label="Key label">
                <input
                  className={control}
                  placeholder="For a friend"
                  required
                  maxLength={80}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={!!pending || !running}
                />
              </Field>
              <Field label="Expires after">
                <select
                  className={control}
                  value={hours}
                  onChange={(event) => setHours(event.target.value)}
                  disabled={!!pending || !running}
                >
                  <option value="1">1 hour</option>
                  <option value="24">24 hours</option>
                  <option value="168">7 days</option>
                </select>
              </Field>
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={
                !ready ||
                !running ||
                !!pending ||
                !label.trim() ||
                approvalUncertain ||
                (status?.grants.length ?? 0) >= 100
              }
            >
              <KeyRound size={15} />
              {pending === "create" ? "Creating key…" : "Create key"}
            </Button>
            {(status?.grants.length ?? 0) >= 100 && (
              <Note tone="warning" className={css({ mt: "3" })}>
                All 100 key slots are in use, including expired and revoked keys. Remove expired and
                revoked keys below; keys that still grant access must be revoked first.
              </Note>
            )}
            {!running && (
              <p className={`${caption} ${css({ mt: "2.5" })}`}>
                A key permits one model, so start hosting first to choose which model it permits.
                Existing keys stay readable and revocable below.
              </p>
            )}
          </form>

          <div className={css({ mt: "4", pt: "3", borderTop: "1px solid token(colors.lineSoft)" })}>
            <KeyCleanup
              removable={status?.removableKeys}
              total={status?.grants.length ?? 0}
              ready={ready}
              pending={!!pending}
              removing={pending === "cleanup"}
              message={cleanupMessage}
              onRemove={() => {
                if (ready && !pending && status?.removableKeys)
                  void mutate("cleanup", "/api/sharing/grants/cleanup", {});
              }}
            />
          </div>
          {status && status.state !== "unavailable" && !error && !status.grants.length && (
            <p
              className={`${muted} ${css({ pt: "3", borderTop: "1px solid token(colors.lineSoft)" })}`}
            >
              No keys are recorded.
            </p>
          )}
          <ul className={css({ display: "grid", minW: 0 })}>
            {status?.grants.map((grant) => {
              const expired = Date.parse(grant.expiresAt) <= Date.now();
              const pausedReason = error
                ? "Refresh access to check this key’s current availability."
                : status.state === "unavailable"
                  ? "Guest access is unavailable. Resolve the access error before using this key."
                  : !running
                    ? "Hosting is off. This permission resumes when its model is hosted again."
                    : grant.model !== status.model
                      ? `This key permits ${grant.model}; hosting currently serves ${status.model}.`
                      : !internetLive
                        ? "Hosting is not reachable from the internet yet. Restore the public address before using this key."
                        : null;
              const request = status.requests?.items.find((item) => item.grantId === grant.id);
              const grantLabel = request
                ? `Request · ${request.name} · ${request.code}`
                : grant.label;
              const usable = !grant.revokedAt && !expired;
              // Request-approved keys are derived by the guest, so the gateway never holds them.
              const readable = usable && grant.recoverable !== false;
              const revealed = shownKey?.id === grant.id ? shownKey.token : null;
              return (
                <li
                  key={grant.id}
                  className={css({
                    borderTop: "1px solid token(colors.lineSoft)",
                    py: "3",
                    minW: 0,
                  })}
                >
                  <div
                    className={css({
                      display: "flex",
                      alignItems: "center",
                      gap: "2",
                      flexWrap: "wrap",
                      justifyContent: "space-between",
                      minW: 0,
                    })}
                  >
                    <h3
                      className={css({
                        fontSize: "sm",
                        fontWeight: 600,
                        overflowWrap: "anywhere",
                        minW: 0,
                      })}
                    >
                      {grantLabel}
                    </h3>
                    <Badge
                      tone={
                        grant.revokedAt || expired ? "neutral" : pausedReason ? "warning" : "good"
                      }
                    >
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
                    className={`${caption} ${css({ mt: "1", fontFamily: "mono", overflowWrap: "anywhere" })}`}
                  >
                    {grant.model} · Expires {date(grant.expiresAt)} (your local time)
                  </p>
                  {usable && pausedReason && (
                    <p className={`${caption} ${css({ mt: "1.5", overflowWrap: "anywhere" })}`}>
                      {pausedReason} Pausing is not revocation.
                    </p>
                  )}
                  {usable && readable && (
                    <div className={css({ mt: "2.5", minW: 0 })}>
                      <AccessKeyField
                        label={grantLabel}
                        token={revealed}
                        reading={pending === `read-key:${grant.id}`}
                        disabled={!!pending || !ready}
                        onCopy={() => readKey(grant.id)}
                        onReveal={() => {
                          void readKey(grant.id).then(
                            (token) => token && setShownKey({ id: grant.id, token }),
                          );
                        }}
                        onMask={() => setShownKey(null)}
                      />
                    </div>
                  )}
                  {usable && (
                    <div
                      className={css({ display: "flex", gap: "2", flexWrap: "wrap", mt: "2.5" })}
                    >
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={!!pending}
                        onClick={() =>
                          void mutate("revoke", `/api/sharing/grants/${grant.id}/revoke`, {})
                        }
                      >
                        Revoke {grantLabel}
                      </Button>
                    </div>
                  )}
                  {usable && !readable && (
                    <p className={`${caption} ${css({ mt: "1.5" })}`}>
                      This guest generated its own key after you approved the request, so the
                      gateway never stored it. Revoke it to end its permission.
                    </p>
                  )}
                  {usable && revealed && publicOrigin && (
                    <div
                      className={css({
                        mt: "3",
                        px: "3.5",
                        py: "3",
                        bg: "well",
                        borderLeft: "2px solid token(colors.live)",
                        borderRadius: "sm",
                        minW: 0,
                        display: "flex",
                        gap: "4",
                        flexWrap: "wrap",
                        alignItems: "start",
                      })}
                    >
                      <div>
                        <p className={`${legend} ${css({ mb: "1.5" })}`}>Scan to connect</p>
                        <QrCode
                          value={`${publicOrigin}/#access=${revealed}`}
                          title={`QR code that opens the guest page with the key for ${grantLabel}`}
                        />
                      </div>
                      <p className={`${caption} ${css({ flex: "1 1 14rem", minW: 0 })}`}>
                        This image carries the key. It opens the guest page with the key already
                        filled in, so a phone guest does not retype it. Anyone holding it can use{" "}
                        <span className={mono}>{grant.model}</span> until{" "}
                        <span className={mono}>{date(grant.expiresAt)}</span> (your local time).
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p
            className={`${caption} ${css({ mt: "3", pt: "3", borderTop: "1px solid token(colors.lineSoft)" })}`}
          >
            Keys are stored by the gateway and survive a restart, so you can look one up again
            instead of reissuing it. Hosting starts off after every gateway restart. Up to 100 keys
            are retained, including revoked ones.
          </p>
        </Section>
      </div>
    </div>
  );
}
