import { useState } from "react";
import { css } from "../../styled-system/css";
import { Button, PanelHeading, muted, panel } from "./ui";
import { AccessRequestRow } from "./access-request-row";
import {
  canRequestAction,
  requestStates,
  type RequestAction,
  type RequestSharingStatus,
} from "./access-requests-model";

export function AccessRequests({
  status,
  ready,
  pending,
  error,
  refreshing,
  approvalUncertain,
  onAction,
}: {
  status: RequestSharingStatus | null;
  ready: boolean;
  pending: string;
  error: boolean;
  refreshing: boolean;
  approvalUncertain: boolean;
  onAction: (action: RequestAction) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const requests = status?.requests;
  const waiting = requests?.items.filter((item) => item.state === "pending") ?? [];
  const resolved =
    requests?.items
      .filter((item) => item.state !== "pending")
      .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt)) ?? [];
  const canStart = canRequestAction({ type: "start" }, status, ready);
  return (
    <section
      className={`${panel} ${css({ mb: "6", minW: 0, "& button": { minH: "44px", maxW: "full", whiteSpace: "normal", overflowWrap: "anywhere" } })}`}
      aria-label="Guest access requests"
    >
      <PanelHeading
        title="Guest access requests"
        description="Send your guest page directly to someone you want to invite, then approve their request."
      />
      <div className={css({ px: "5", pb: "5", minW: 0 })}>
        <p className={muted}>
          Guest names are unverified. Confirm the matching code with your guest before approving.
        </p>
        <p role="status" className={css({ fontWeight: 650, mt: "3" })}>
          {error
            ? "Request status needs attention"
            : !status
              ? "Checking guest access requests…"
              : !requests
                ? "Guest access requests are unavailable in this gateway."
                : !ready
                  ? "Checking current request availability…"
                  : requests.available
                    ? "Accepting access requests"
                    : requests.enabled
                      ? "Requests enabled · currently unavailable"
                      : "Access requests are off"}
        </p>
        {requests && (
          <>
            <p className={`${muted} ${css({ mt: "2" })}`}>
              {requests.remainingGrantSlots} of 100 retained key slots remaining ·{" "}
              {requests.remainingRequestSlots} of 20 active request key slots remaining.
              {!ready && " These are the last known counts."}
            </p>
            {requests.remainingGrantSlots === 0 ? (
              <p className={`${muted} ${css({ mt: "2" })}`}>
                The 100 retained key limit is reached. Expiry and revocation do not free these
                slots, and there is no key deletion control. New approvals and new keys are
                unavailable; existing valid keys can still be used.
              </p>
            ) : requests.remainingRequestSlots === 0 ? (
              <p className={`${muted} ${css({ mt: "2" })}`}>
                All 20 active request key slots are in use. Wait for a request key to expire or
                revoke one in Access keys below before approving another request.
              </p>
            ) : null}
            {status?.internet?.state !== "live" || status.state !== "local" ? (
              <p className={`${muted} ${css({ mt: "2" })}`}>
                Start local client access and wait for internet sharing to be live to allow or
                approve requests. An interrupted connection keeps this inbox but pauses requests.
              </p>
            ) : requests.enabled &&
              !requests.available &&
              requests.remainingGrantSlots > 0 &&
              requests.remainingRequestSlots > 0 ? (
              <p className={`${muted} ${css({ mt: "2" })}`}>
                The intake is unavailable. Refresh status, or stop requests and enable them again
                when internet sharing is live.
              </p>
            ) : null}
          </>
        )}
        {approvalUncertain && (
          <p role="alert" className={css({ color: "warning", mt: "3", fontSize: "sm" })}>
            Approval could not be confirmed. Refresh status and check Access keys before approving
            another request. Any issued key is already durable; revoke an unwanted key below.
            Retrying the same request after refreshing does not create a second key.
          </p>
        )}
        <div className={css({ display: "flex", gap: "3", flexWrap: "wrap", mt: "4" })}>
          {requests && !requests.enabled && (
            <Button
              variant="primary"
              disabled={!!pending || !canStart}
              onClick={() => onAction({ type: "start" })}
            >
              {pending === "request-start" ? "Allowing requests…" : "Allow access requests"}
            </Button>
          )}
          {(requests?.enabled || error || approvalUncertain) && (
            <Button disabled={!!pending} onClick={() => onAction({ type: "stop" })}>
              {pending === "request-stop" ? "Stopping requests…" : "Stop requests"}
            </Button>
          )}
          <Button disabled={!!pending || refreshing} onClick={() => onAction({ type: "refresh" })}>
            {refreshing ? "Refreshing status…" : "Refresh status"}
          </Button>
        </div>
        <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
          Stopping requests clears the inbox. Approved keys remain usable until expiry or
          revocation; manage them in Access keys below.
        </p>
        {requests && (
          <>
            <details className={`${muted} ${css({ mt: "2", fontSize: "xs" })}`}>
              <summary className={css({ minH: "44px", py: "3", cursor: "pointer", color: "ink" })}>
                Request limits and when access ends
              </summary>
              <p>
                Up to 10 requests can wait for approval. Requests turn off when sharing stops, a new
                tunnel starts, or the gateway restarts. A matching code does not verify identity.
              </p>
              <p className={css({ mt: "2" })}>
                The app stores up to 100 keys, including expired and revoked keys; there is no key
                deletion control yet. Up to 20 request keys may be active. Revocation frees an
                active request slot, but does not free a stored key slot.
              </p>
            </details>
            <h3 className={css({ fontWeight: 650, mt: "5", mb: "3" })}>
              Pending requests ({waiting.length}/10)
            </h3>
            {!waiting.length && (
              <p className={muted}>
                {requests.enabled
                  ? "No pending requests. Guests can request access while the intake is available."
                  : "Allow access requests to open the inbox."}
              </p>
            )}
            <ul className={css({ display: "grid", gap: "4", minW: 0 })}>
              {waiting.map((item) => (
                <AccessRequestRow
                  key={`${requests.intakeId}:${item.id}`}
                  item={item}
                  status={status!}
                  ready={ready}
                  pending={pending}
                  approvalUncertain={approvalUncertain}
                  onAction={onAction}
                />
              ))}
            </ul>
            {resolved.length > 0 && (
              <>
                <h3 className={css({ fontWeight: 650, mt: "5", mb: "2" })}>
                  Recent resolved requests ({resolved.length})
                </h3>
                <ul className={css({ display: "grid", gap: "2" })}>
                  {(showAll ? resolved : resolved.slice(0, 5)).map((item) => (
                    <li
                      key={item.id}
                      className={css({
                        fontSize: "sm",
                        py: "2",
                        borderTop: "1px solid token(colors.line)",
                        overflowWrap: "anywhere",
                      })}
                    >
                      <span className={css({ fontWeight: 650 })}>
                        {item.name || "Unnamed guest"}
                      </span>{" "}
                      · <code>{item.code}</code> · {requestStates[item.state]}
                      {item.state === "approved" && (
                        <span className={muted}> · Key saved in Access keys</span>
                      )}
                    </li>
                  ))}
                </ul>
                {resolved.length > 5 && (
                  <Button
                    variant="ghost"
                    className={css({ mt: "2" })}
                    aria-expanded={showAll}
                    onClick={() => setShowAll(!showAll)}
                  >
                    {showAll
                      ? "Show fewer resolved requests"
                      : `Show all ${resolved.length} resolved requests`}
                  </Button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
