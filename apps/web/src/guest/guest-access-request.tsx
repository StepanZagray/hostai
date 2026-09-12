import { requestNameProblem } from "./request-name";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { css } from "../../styled-system/css";
import { Button, Note, caption, control, fieldLabel, legend, mono } from "../components/ui";
import { isRequestTerminal, type AccessRequest } from "./request-api";
import { type useGuestAccessRequest, type GuestRequestView } from "./use-guest-access-request";

const actions = css({ display: "flex", alignItems: "center", gap: "2", flexWrap: "wrap", mt: "3" });
/** Standing alone the panel rules itself off; inside a disclosure the summary already does. */
const divided = css({
  mt: "4",
  pt: "4",
  borderTop: "1px solid token(colors.lineSoft)",
  minW: 0,
});
const nested = css({ minW: 0 });
const disclosure = css({
  mt: "4",
  borderTop: "1px solid token(colors.lineSoft)",
  minW: 0,
  "&[open] > summary": { color: "ink" },
  "&[open] > summary > svg": { transform: "rotate(90deg)" },
});
const text = css({ overflowWrap: "anywhere" });
const heading = css({ fontSize: "md", fontWeight: 600, letterSpacing: "-0.01em", mb: "2.5" });
const facts = css({
  display: "grid",
  gap: { base: "3", sm: "4" },
  mb: "3",
  gridTemplateColumns: { base: "minmax(0, 1fr)", sm: "repeat(2, minmax(0, 1fr))" },
  "& > div": { minW: 0, display: "grid", gap: "1", alignContent: "start" },
  "& dd": { fontSize: "sm", lineHeight: 1.5, color: "ink", overflowWrap: "anywhere" },
});
const summary = css({
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: "1.5",
  minH: "44px",
  py: "2",
  fontSize: "sm",
  fontWeight: 500,
  color: "inkSoft",
  listStyle: "none",
  "&::-webkit-details-marker": { display: "none" },
  _hover: { color: "ink" },
  "& svg": {
    flexShrink: 0,
    color: "muted",
    transition: "transform token(durations.fast) token(easings.out)",
  },
});
const statuses: Record<AccessRequest["state"], string> = {
  pending: "Waiting for the host to review your request.",
  approved: "Access approved. Connect when you are ready.",
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
  const [expanded, setExpanded] = useState(false);
  if (!enabled && !state.submission) return null;
  const blocked = !!state.busy || connecting || state.retrySeconds > 0;
  // The access key is the primary way in. Asking the host is the fallback, so before a
  // request exists it waits behind a disclosure below the key form; once one is under way
  // its status is never hidden.
  const secondary = enabled && !state.submission;

  const content = (
    <section aria-labelledby="request-access-heading" className={secondary ? nested : divided}>
      <h3 id="request-access-heading" className={heading}>
        {enabled ? "Request access from this host" : "Your access request"}
      </h3>
      {anotherKey && state.submission && (
        <p className={`${caption} ${css({ mb: "2.5" })}`}>
          This request is separate from the key currently used by chat. Cancelling it does not
          revoke that other key.
        </p>
      )}
      {enabled && state.hello?.requestsAccepted && (
        <dl className={facts}>
          <div>
            <dt className={legend}>Host-provided name · not a verified identity</dt>
            <dd className={css({ fontWeight: 600 })}>
              {state.hello.hostLabel || "No host name provided"}
            </dd>
          </div>
          <div>
            <dt className={legend}>Shared model</dt>
            <dd className={mono}>{state.hello.model}</dd>
          </div>
        </dl>
      )}
      {(state.submission || state.hello?.requestsAccepted) && (
        <p id="request-access-memory" className={`${caption} ${css({ mt: "2" })}`}>
          Keep this tab open. Reloading or closing it loses your request and key; approved access
          still lasts until expiry or revocation.
          {state.submission &&
            " Disconnecting chat keeps this request here. Cancellation needs the host to still hold its record."}
        </p>
      )}
      <p
        role="status"
        className={css({ mt: "2.5", fontSize: "sm", lineHeight: 1.55, color: "inkSoft" })}
      >
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
        <Note role="alert" tone="danger" className={css({ mt: "2.5" })}>
          {state.error}
        </Note>
      )}
      {state.request?.state === "failed" && state.request.grantId && (
        <p className={`${caption} ${css({ mt: "1.5" })}`}>
          This failure does not confirm that the approved key was revoked. Ask the host to revoke it
          in Access keys.
        </p>
      )}
      {state.retrySeconds > 0 && (
        <p className={`${caption} ${css({ mt: "1.5", fontVariantNumeric: "tabular-nums" })}`}>
          You can retry in {state.retrySeconds} seconds.
        </p>
      )}
      {state.intakeStopped && state.submission && (
        <p className={`${caption} ${css({ mt: "1.5" })}`}>
          Automatic checks have stopped. Refreshing details neither submits nor ends a request.
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
          <Button variant="ghost" disabled={blocked} onClick={() => void request.refresh()}>
            Refresh host details
          </Button>
        </div>
      )}
    </section>
  );
  if (secondary)
    return (
      <details
        className={disclosure}
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className={summary}>
          <ChevronRight size={14} aria-hidden="true" />
          No key? Ask the host for access
        </summary>
        {content}
      </details>
    );
  return enabled ? (
    content
  ) : (
    <>
      <p role="status" className={`${caption} ${css({ mt: "3" })}`}>
        {state.busy === "cancel"
          ? "Cancelling request…"
          : state.recovery === "cancel"
            ? "Cancellation unconfirmed"
            : state.request
              ? `Last request status: ${state.request.state}`
              : "Submission unconfirmed"}
        {anotherKey && " · separate from the current chat key"}
      </p>
      <details
        className={css({
          mt: "1",
          "&[open] > summary": { color: "ink" },
          "&[open] > summary > svg": { transform: "rotate(90deg)" },
        })}
      >
        <summary className={summary}>
          <ChevronRight size={14} aria-hidden="true" />
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
      className={css({ mt: "3.5" })}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !problem) void onSubmit(name);
      }}
    >
      <label
        htmlFor="request-access-name"
        className={`${fieldLabel} ${css({ display: "block", mb: "1.5" })}`}
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
        className={`${control} ${css({ maxW: "420px" })}`}
      />
      <p id="request-access-name-help" className={`${caption} ${css({ mt: "1.5" })}`}>
        Sent to the host only when you request access, and never stored beyond this tab. Only
        request access from a host you trust.
      </p>
      {problem && (
        <p
          id="request-access-name-error"
          role="alert"
          className={css({ color: "stop", fontSize: "xs", lineHeight: 1.55, mt: "1.5" })}
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
    <div className={css({ mt: "3", fontSize: "sm", lineHeight: 1.55, minW: 0 })}>
      <p className={text}>
        Requested as <strong className={css({ fontWeight: 600 })}>{state.submission.name}</strong>{" "}
        for <span className={mono}>{state.submission.model}</span>.
      </p>
      {state.request && (
        <p className={`${text} ${css({ mt: "1.5" })}`}>
          Request code:{" "}
          <strong
            className={css({
              fontFamily: "mono",
              fontWeight: 500,
              fontSize: "md",
              letterSpacing: "0.1em",
              fontVariantNumeric: "tabular-nums",
              color: "ink",
            })}
          >
            {state.request.code.slice(0, 3)}-{state.request.code.slice(3)}
          </strong>
        </p>
      )}
      {!terminal && state.remainingSeconds !== null && (
        <p className={`${caption} ${css({ mt: "1.5", fontVariantNumeric: "tabular-nums" })}`}>
          {expired
            ? `This browser’s request recovery timer has ended. You can still try cancellation, but the host may no longer have the record. ${state.request?.grantId ? "Ask the host to revoke the key in Access keys if cancellation cannot be confirmed. Key expiry is separate." : "Ask the host to check this request and revoke any key it issued if cancellation cannot be confirmed."}`
            : `${state.remainingSeconds} seconds remaining to recover or cancel this request. Approved key expiry is shown separately.`}
        </p>
      )}
      {state.request?.state === "approved" && state.request.grantExpiresAt && (
        <p className={`${caption} ${css({ mt: "1.5" })}`}>
          Host-reported expiry:{" "}
          <time
            dateTime={state.request.grantExpiresAt}
            className={css({ fontFamily: "mono", fontVariantNumeric: "tabular-nums" })}
          >
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "long",
            }).format(new Date(state.request.grantExpiresAt))}
          </time>{" "}
          (your local time).
        </p>
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
          variant="ghost"
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
        <div
          className={css({
            mt: "3",
            px: "3",
            py: "2.5",
            bg: "amberSoft",
            color: "amber",
            borderLeft: "2px solid token(colors.amber)",
            borderRadius: "sm",
            fontSize: "xs",
            lineHeight: 1.55,
            minW: 0,
          })}
        >
          <p id="request-discard-warning" className={text}>
            {state.recovery === "cancel" && "Cancellation is still unconfirmed. "}
            {permissionUncertain &&
              "The host has not confirmed that this request’s key was revoked. "}
            Discarding does not cancel the request — the host may still approve it, and approved
            permission lasts until expiry or revocation. It only removes this tab’s ability to
            recover or cancel it. Cancel first if you can.
          </p>
          <div className={actions}>
            <Button
              size="sm"
              disabled={blocked}
              aria-describedby="request-discard-warning"
              onClick={discard}
            >
              Discard and refresh details
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>
              Keep this request
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
