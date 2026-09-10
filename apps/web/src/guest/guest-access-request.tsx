import { requestNameProblem } from "./request-name";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { Button, muted } from "../components/ui";
import { isRequestTerminal, type AccessRequest } from "./request-api";
import { type useGuestAccessRequest, type GuestRequestView } from "./use-guest-access-request";

const actions = css({ display: "flex", gap: "2", flexWrap: "wrap", mt: "3" });
const text = css({ overflowWrap: "anywhere" });
const statuses: Record<AccessRequest["state"], string> = {
  pending: "Waiting for the host to review your request.",
  approved: "Access approved. Connect when you are ready; no message will be sent.",
  rejected: "The host declined this request.",
  cancelled: "The host confirmed cancellation. This request no longer permits access.",
  expired: "The host confirmed that this request or its access has expired.",
  revoked: "The host revoked this request’s access.",
  failed: "The host could not complete this request.",
};

export function GuestAccessRequest({
  state,
  request,
  enabled,
  connecting,
  connected = false,
  anotherKey = false,
  onConnect,
}: {
  state: GuestRequestView;
  request: ReturnType<typeof useGuestAccessRequest>["request"];
  enabled: boolean;
  connecting: boolean;
  connected?: boolean;
  anotherKey?: boolean;
  onConnect: (key: string) => void | Promise<void>;
}) {
  if (!enabled && !state.submission) return null;
  const blocked = !!state.busy || connecting || state.retrySeconds > 0;

  const content = (
    <section aria-labelledby="request-access-heading" className={css({ my: "4" })}>
      <h3 id="request-access-heading" className={css({ fontWeight: 750, mb: "2" })}>
        {enabled ? "Request access from this host" : "Your access request"}
      </h3>
      {anotherKey && state.submission && (
        <p className={muted}>
          This request is separate from the key currently used by chat. Cancelling it does not
          revoke that other key.
        </p>
      )}
      {enabled && state.hello?.requestsAccepted && (
        <dl className={css({ display: "grid", gap: "2", mb: "3" })}>
          <div>
            <dt className={muted}>Host-provided name · not a verified identity</dt>
            <dd className={text}>{state.hello.hostLabel || "No host name provided"}</dd>
          </div>
          <div>
            <dt className={muted}>Shared model</dt>
            <dd className={`${text} ${css({ fontFamily: "mono", fontSize: "sm" })}`}>
              {state.hello.model}
            </dd>
          </div>
        </dl>
      )}
      {(state.submission || state.hello?.requestsAccepted) && (
        <p id="request-access-memory" className={`${muted} ${css({ mt: "2" })}`}>
          Keep this tab open. Reloading or closing it loses your request and key; approved access
          still lasts until expiry or revocation.
          {state.submission &&
            " Disconnecting chat keeps this request available here. Cancellation requires the host to still have its request record."}
        </p>
      )}
      <p role="status" className={`${muted} ${css({ mt: "3" })}`}>
        {state.busy === "details"
          ? "Checking whether this host accepts requests…"
          : state.busy === "submit"
            ? "Submitting your request…"
            : state.busy === "cancel"
              ? "Asking the host to cancel or revoke access…"
              : state.recovery === "cancel"
                ? state.intakeStopped
                  ? state.request?.grantId
                    ? "Cancellation could not be confirmed on this connection. Ask the host to revoke this key in Access keys."
                    : "Cancellation is not confirmed. Ask the host to check this request and revoke any key it issued."
                  : "Cancellation is not confirmed. Retry cancellation before connecting."
                : state.request
                  ? connected && state.request.state === "approved"
                    ? "This chat uses your approved request. You can ask the host to end its access here."
                    : statuses[state.request.state]
                  : state.submission
                    ? "The submission is unconfirmed. Retry the same request to recover the response."
                    : state.details === "unsupported"
                      ? "Access requests require HTTPS and browser cryptography support. You can still use an existing key."
                      : state.details === "unavailable"
                        ? "This host is not accepting access requests. You can still use an existing key."
                        : state.details === "ready"
                          ? "The host must approve before you can connect."
                          : "Use an existing key, or refresh the host details to check for access requests."}
      </p>
      {state.error && (
        <p
          role="alert"
          className={css({ color: "danger", fontSize: "sm", lineHeight: 1.7, mt: "2" })}
        >
          {state.error}
        </p>
      )}
      {state.request?.state === "failed" && state.request.grantId && (
        <p className={muted}>
          This failure does not confirm that the approved key was revoked. Ask the host to revoke it
          in Access keys.
        </p>
      )}
      {state.retrySeconds > 0 && (
        <p className={muted}>You can retry in {state.retrySeconds} seconds.</p>
      )}
      {state.intakeStopped && state.submission && (
        <p className={muted}>
          Automatic checks have stopped. Refreshing details will not submit another request or end
          the current one.
        </p>
      )}
      {enabled &&
        !state.submission &&
        ((state.hello?.requestsAccepted && state.details === "ready") ||
          state.nameDraft !== null) && (
          <RequestNameForm
            name={state.nameDraft ?? ""}
            onNameChange={request.editName}
            editingDisabled={state.busy === "submit" || connecting}
            disabled={
              blocked ||
              state.intakeStopped ||
              state.details !== "ready" ||
              !state.hello?.requestsAccepted
            }
            onSubmit={request.submit}
          />
        )}
      {state.submission && (
        <RequestProgress
          state={state}
          request={request}
          blocked={blocked}
          connecting={connecting}
          connected={connected}
          discovery={enabled}
          onConnect={onConnect}
        />
      )}
      {enabled && (
        <div className={actions}>
          <Button disabled={blocked} onClick={() => void request.refresh()}>
            Refresh host details
          </Button>
        </div>
      )}
    </section>
  );
  return enabled ? (
    content
  ) : (
    <>
      <p role="status" className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
        {state.busy === "cancel"
          ? "Cancelling request…"
          : state.recovery === "cancel"
            ? "Cancellation unconfirmed"
            : state.request
              ? `Last request status: ${state.request.state}`
              : "Submission unconfirmed"}
        {anotherKey && " · separate from the current chat key"}
      </p>
      <details className={css({ my: "3" })}>
        <summary className={css({ cursor: "pointer", fontWeight: 650, minH: "44px", py: "2" })}>
          Manage access request
        </summary>
        {content}
      </details>
    </>
  );
}

function RequestNameForm({
  name,
  onNameChange,
  editingDisabled,
  disabled,
  onSubmit,
}: {
  name: string;
  onNameChange: (name: string) => void;
  editingDisabled: boolean;
  disabled: boolean;
  onSubmit: (name: string) => Promise<void>;
}) {
  const problem = name.length ? requestNameProblem(name) : null;
  return (
    <form
      className={css({ mt: "3" })}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !problem) void onSubmit(name);
      }}
    >
      <label
        htmlFor="request-access-name"
        className={css({ display: "block", fontWeight: 650, mb: "2" })}
      >
        Your name
      </label>
      <input
        id="request-access-name"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        maxLength={40}
        required
        autoComplete="off"
        disabled={editingDisabled}
        aria-invalid={!!problem}
        aria-describedby={`request-access-name-help guest-disclosure${problem ? " request-access-name-error" : ""}`}
        className={css({
          w: "full",
          minW: 0,
          minH: "44px",
          px: "3",
          py: "2",
          bg: "canvas",
          border: "1px solid token(colors.line)",
          borderRadius: "7px",
        })}
      />
      <p id="request-access-name-help" className={muted}>
        Your name draft stays in this tab through refreshes and chat connection changes. It is sent
        only when you request access, and reloading clears it. Only request access from a host you
        trust.
      </p>
      {problem && (
        <p
          id="request-access-name-error"
          role="alert"
          className={css({ color: "danger", fontSize: "sm", mt: "2" })}
        >
          {problem}
        </p>
      )}
      <div className={actions}>
        <Button type="submit" variant="primary" disabled={disabled || !!problem || !name.trim()}>
          Request access
        </Button>
      </div>
    </form>
  );
}

function RequestProgress({
  state,
  request,
  blocked,
  connecting,
  connected,
  discovery,
  onConnect,
}: {
  state: GuestRequestView;
  request: ReturnType<typeof useGuestAccessRequest>["request"];
  blocked: boolean;
  connecting: boolean;
  connected: boolean;
  discovery: boolean;
  onConnect: (key: string) => void | Promise<void>;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const terminal = !!state.request && isRequestTerminal(state.request.state);
  const permissionUncertain = state.request?.state === "failed" && !!state.request.grantId;
  const safeToForget = terminal && !permissionUncertain;
  const expired = state.remainingSeconds === 0 && !terminal;
  const discard = () => {
    request.discard(true);
    setConfirmDiscard(false);
  };
  if (!state.submission) return null;
  return (
    <div className={css({ mt: "3" })}>
      <p className={text}>
        Requested as <strong>{state.submission.name}</strong> for{" "}
        <span className={css({ fontFamily: "mono" })}>{state.submission.model}</span>.
      </p>
      {state.request && (
        <p className={css({ mt: "2" })}>
          Request code:{" "}
          <strong className={css({ fontFamily: "mono", letterSpacing: "0.05em" })}>
            {state.request.code.slice(0, 3)}-{state.request.code.slice(3)}
          </strong>
        </p>
      )}
      {!terminal && state.remainingSeconds !== null && (
        <p className={muted}>
          {expired
            ? `This browser’s request recovery timer has ended. You can still try cancellation, but the host may no longer have the record. ${state.request?.grantId ? "Ask the host to revoke the key in Access keys if cancellation cannot be confirmed. Key expiry is separate." : "Ask the host to check this request and revoke any key it issued if cancellation cannot be confirmed."}`
            : `${state.remainingSeconds} seconds remaining to recover or cancel this request. Approved key expiry is shown separately.`}
        </p>
      )}
      {state.request?.state === "approved" && state.request.grantExpiresAt && (
        <p className={muted}>
          Host-reported expiry:{" "}
          <time dateTime={state.request.grantExpiresAt}>
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "long",
            }).format(new Date(state.request.grantExpiresAt))}
          </time>{" "}
          (your local time).
        </p>
      )}
      {state.request?.state === "pending" && !state.error && !state.intakeStopped && !expired && (
        <p className={muted}>Status checks run every five seconds while this tab is visible.</p>
      )}
      <div className={actions}>
        {state.request?.state === "approved" && !connected && (
          <Button
            variant="primary"
            disabled={!!state.busy || connecting || state.recovery === "cancel"}
            onClick={() => void request.connect(onConnect)}
          >
            Connect to model
          </Button>
        )}
        {!state.request && state.recovery === "submit" && (
          <Button
            disabled={blocked || state.intakeStopped}
            onClick={() => void request.retrySubmit()}
          >
            Retry same request
          </Button>
        )}
        {state.request && !terminal && state.recovery !== "cancel" && (
          <Button disabled={blocked || state.intakeStopped} onClick={() => void request.check()}>
            Check status
          </Button>
        )}
        {!terminal && (
          <Button disabled={blocked} onClick={() => void request.cancel()}>
            {state.recovery === "cancel"
              ? "Retry cancellation"
              : expired
                ? "Try cancellation"
                : "Cancel request / access"}
          </Button>
        )}
        <Button
          disabled={blocked}
          onClick={() => (safeToForget ? discard() : setConfirmDiscard(true))}
        >
          {safeToForget
            ? discovery
              ? "Start another request"
              : "Forget request record"
            : "Discard this request…"}
        </Button>
      </div>
      {confirmDiscard && !safeToForget && (
        <div className={css({ mt: "3", p: "3", bg: "warningSoft", borderRadius: "7px" })}>
          <p id="request-discard-warning">
            {state.recovery === "cancel" && "Cancellation is still unconfirmed. "}
            {permissionUncertain &&
              "The host has not confirmed that this request’s key was revoked. "}
            Discarding loses this tab’s ability to recover or cancel the request. It does not cancel
            it: the host may still approve it, and approved permission remains until expiry or
            revocation. Cancel first if possible.
          </p>
          <div className={actions}>
            <Button disabled={blocked} aria-describedby="request-discard-warning" onClick={discard}>
              Discard and refresh details
            </Button>
            <Button onClick={() => setConfirmDiscard(false)}>Keep this request</Button>
          </div>
        </div>
      )}
    </div>
  );
}
