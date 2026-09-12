import { useState } from "react";
import { css } from "../../styled-system/css";
import { Badge, Button, Disclosure, Led, Note, Section, caption, muted, type Tone } from "./ui";
import { AccessRequestRow } from "./access-request-row";
import {
  canRequestAction,
  requestStates,
  type OwnerRequest,
  type RequestAction,
  type RequestSharingStatus,
} from "./access-requests-model";

/** A state sentence led by its light: the first thing the panel says. */
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

const resolvedTone: Record<OwnerRequest["state"], Tone> = {
  pending: "warning",
  approved: "good",
  rejected: "neutral",
  cancelled: "neutral",
  expired: "neutral",
  revoked: "neutral",
  failed: "warning",
};

const listHeading = css({ fontSize: "sm", fontWeight: 600, mt: "5", mb: "1.5" });

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
    <Section
      aria-label="Guest access requests"
      title="Guest access requests"
      description="Send your guest page to someone, then approve the request they submit."
    >
      <p role="status" className={statusLine}>
        <Led
          state={
            error
              ? "amber"
              : !status
                ? "busy"
                : !requests
                  ? "off"
                  : !ready
                    ? "busy"
                    : requests.available
                      ? "live"
                      : requests.enabled
                        ? "amber"
                        : "off"
          }
        />
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
          <p className={`${caption} ${css({ mt: "1.5", fontVariantNumeric: "tabular-nums" })}`}>
            {requests.remainingGrantSlots} of 100 retained key slots remaining ·{" "}
            {requests.remainingRequestSlots} of 20 active request key slots remaining.
            {!ready && " Last known counts."}
          </p>
          {requests.remainingGrantSlots === 0 ? (
            <Note tone="warning" className={css({ mt: "2.5" })}>
              The 100 retained key limit is reached. Remove expired and revoked keys in Access keys
              below to free stored key slots. If every key still grants access, revoke an unused one
              first.
            </Note>
          ) : requests.remainingRequestSlots === 0 ? (
            <Note tone="warning" className={css({ mt: "2.5" })}>
              All 20 active request key slots are in use. Wait for one to expire, or revoke one in
              Access keys below.
            </Note>
          ) : null}
          {status?.internet?.state !== "live" || status.state !== "local" ? (
            <p className={`${caption} ${css({ mt: "2.5" })}`}>
              Requests need guest access running and internet sharing live. An interrupted
              connection keeps this inbox but pauses requests.
            </p>
          ) : requests.enabled &&
            !requests.available &&
            requests.remainingGrantSlots > 0 &&
            requests.remainingRequestSlots > 0 ? (
            <p className={`${caption} ${css({ mt: "2.5" })}`}>
              The intake is unavailable. Refresh status, or stop requests and enable them again when
              internet sharing is live.
            </p>
          ) : null}
        </>
      )}
      {approvalUncertain && (
        <Note role="alert" tone="warning" className={css({ mt: "3" })}>
          Approval could not be confirmed. Refresh status and check Access keys before approving
          again — any issued key is already durable, and retrying the same request after a refresh
          does not create a second key.
        </Note>
      )}
      <div className={css({ display: "flex", gap: "2", flexWrap: "wrap", mt: "3.5" })}>
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
      <p className={`${caption} ${css({ mt: "2.5" })}`}>
        Guest names are unverified — confirm the matching code with your guest before approving.
        Stopping requests clears the inbox; approved keys stay usable until they expire or you
        revoke them.
      </p>
      {requests && (
        <>
          <Disclosure summary="Request limits and when access ends" className={css({ mt: "3" })}>
            <p>
              Up to 10 requests can wait for approval. Requests turn off when sharing stops, a new
              tunnel starts, or the gateway restarts. A matching code does not verify identity.
            </p>
            <p>
              Up to 100 keys are stored, including expired and revoked ones, and up to 20 request
              keys may be active. Revocation frees an active slot; removing its saved record frees
              the stored slot.
            </p>
          </Disclosure>
          <h3 className={listHeading}>Pending requests ({waiting.length}/10)</h3>
          {!waiting.length && (
            <p className={muted}>
              {requests.enabled
                ? "No pending requests. Guests can request access while the intake is available."
                : "Allow access requests to open the inbox."}
            </p>
          )}
          <ul className={css({ display: "grid", minW: 0 })}>
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
              <h3 className={listHeading}>Recent resolved requests ({resolved.length})</h3>
              <ul className={css({ display: "grid", minW: 0 })}>
                {(showAll ? resolved : resolved.slice(0, 5)).map((item) => (
                  <li
                    key={item.id}
                    className={css({
                      py: "2.5",
                      borderTop: "1px solid token(colors.lineSoft)",
                      minW: 0,
                      display: "grid",
                      gap: "0.5",
                    })}
                  >
                    <div
                      className={css({
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "2",
                        flexWrap: "wrap",
                        minW: 0,
                      })}
                    >
                      <span
                        className={css({
                          fontSize: "sm",
                          fontWeight: 600,
                          overflowWrap: "anywhere",
                          minW: 0,
                        })}
                      >
                        {item.name || "Unnamed guest"}
                      </span>
                      <Badge tone={resolvedTone[item.state]}>{requestStates[item.state]}</Badge>
                    </div>
                    <p
                      className={`${caption} ${css({ fontFamily: "mono", overflowWrap: "anywhere" })}`}
                    >
                      <code>{item.code}</code>
                      {item.state === "approved" && <span> · Key saved in Access keys</span>}
                    </p>
                  </li>
                ))}
              </ul>
              {resolved.length > 5 && (
                <Button
                  variant="ghost"
                  size="sm"
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
    </Section>
  );
}
