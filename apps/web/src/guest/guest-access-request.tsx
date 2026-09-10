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
  onConnect,
}: {
  state: GuestRequestView;
  request: ReturnType<typeof useGuestAccessRequest>["request"];
  enabled: boolean;
  connecting: boolean;
  onConnect: (key: string) => void | Promise<void>;
}) {
  if (!enabled) return null;
  const blocked = !!state.busy || connecting || state.retrySeconds > 0;

  return (
    <section aria-labelledby="request-access-heading" className={css({ my: "4" })}>
      <h3 id="request-access-heading" className={css({ fontWeight: 750, mb: "2" })}>
        Request access from this host
      </h3>
      {state.hello?.requestsAccepted && (
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
          {state.submission && " Cancel here to ask the host to end it."}
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
                ? "Cancellation is not confirmed. Retry cancellation before connecting."
                : state.request
                  ? statuses[state.request.state]
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
      {state.retrySeconds > 0 && (
        <p className={muted}>You can retry in {state.retrySeconds} seconds.</p>
      )}
      {state.intakeStopped && state.submission && (
        <p className={muted}>
          Automatic checks have stopped. Refreshing details will not submit another request or end
          the current one.
        </p>
      )}
      {!state.submission && state.hello?.requestsAccepted && state.details === "ready" && (
        <RequestNameForm disabled={blocked || state.intakeStopped} onSubmit={request.submit} />
      )}
      {state.submission && (
        <RequestProgress
          state={state}
          request={request}
          blocked={blocked}
          connecting={connecting}
          onConnect={onConnect}
        />
      )}
      <div className={actions}>
        <Button disabled={blocked} onClick={() => void request.refresh()}>
          Refresh host details
        </Button>
      </div>
    </section>
  );
}

function RequestNameForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <form
      className={css({ mt: "3" })}
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(name);
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
        onChange={(event) => setName(event.target.value)}
        maxLength={40}
        required
        autoComplete="off"
        disabled={disabled}
        aria-describedby="request-access-name-help guest-disclosure request-access-memory"
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
        Visible to the host with your requested model. Only request access from a host you trust.
      </p>
      <div className={actions}>
        <Button type="submit" variant="primary" disabled={disabled || !name.trim()}>
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
  onConnect,
}: {
  state: GuestRequestView;
  request: ReturnType<typeof useGuestAccessRequest>["request"];
  blocked: boolean;
  connecting: boolean;
  onConnect: (key: string) => void | Promise<void>;
}) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const terminal = !!state.request && isRequestTerminal(state.request.state);
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
            ? "The request recovery timer has ended. An approved key can still be checked with Connect; its expiry is shown separately."
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
        {state.request?.state === "approved" && (
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
            {state.recovery === "cancel" ? "Retry cancellation" : "Cancel request / access"}
          </Button>
        )}
        <Button disabled={blocked} onClick={() => (terminal ? discard() : setConfirmDiscard(true))}>
          {terminal ? "Start another request" : "Discard this request…"}
        </Button>
      </div>
      {confirmDiscard && !terminal && (
        <div className={css({ mt: "3", p: "3", bg: "warningSoft", borderRadius: "7px" })}>
          <p id="request-discard-warning">
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
