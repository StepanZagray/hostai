import { useId, useState } from "react";
import { css } from "../../styled-system/css";
import { Button, muted } from "./ui";
import {
  canRequestAction,
  type OwnerRequest,
  type RequestAction,
  type RequestSharingStatus,
} from "./access-requests-model";

export function AccessRequestRow({
  item,
  status,
  ready,
  pending,
  approvalUncertain,
  onAction,
}: {
  item: OwnerRequest;
  status: RequestSharingStatus;
  ready: boolean;
  pending: string;
  approvalUncertain: boolean;
  onAction: (action: RequestAction) => void;
}) {
  const id = useId();
  const [hours, setHours] = useState("");
  const approve: RequestAction = {
    type: "approve",
    id: item.id,
    code: item.code,
    expiresInHours: Number(hours),
  };
  const reject: RequestAction = { type: "reject", id: item.id, code: item.code };
  const canApprove = !!hours && canRequestAction(approve, status, ready, approvalUncertain);
  const canReject = canRequestAction(reject, status, ready, approvalUncertain);
  return (
    <li
      className={css({ borderTop: "1px solid token(colors.line)", pt: "4", minW: 0 })}
      aria-labelledby={`${id}-name`}
    >
      <h4 id={`${id}-name`} className={css({ fontWeight: 650, overflowWrap: "anywhere" })}>
        {item.name || "Unnamed guest"}
      </h4>
      <p id={`${id}-code`} className={`${muted} ${css({ mt: "1" })}`}>
        Matching code: <code className={css({ color: "ink", fontWeight: 650 })}>{item.code}</code>
      </p>
      <p
        id={`${id}-permission`}
        className={`${muted} ${css({ mt: "2", overflowWrap: "anywhere" })}`}
      >
        Approval grants internet access to <strong>{item.model}</strong> for the duration you
        choose.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && canApprove) onAction(approve);
        }}
        className={css({ mt: "3" })}
      >
        <label
          htmlFor={`${id}-duration`}
          className={css({
            display: "block",
            fontSize: "xs",
            fontWeight: 650,
            mb: "2",
            overflowWrap: "anywhere",
          })}
        >
          Access duration for {item.name || "unnamed guest"} · {item.code}
        </label>
        <select
          id={`${id}-duration`}
          value={hours}
          required
          disabled={!!pending || !canReject || approvalUncertain || !status.requests?.available}
          onChange={(event) => setHours(event.target.value)}
          aria-describedby={`${id}-permission`}
          className={css({
            minH: "44px",
            w: "full",
            minW: 0,
            maxW: "20rem",
            bg: "canvas",
            border: "1px solid token(colors.line)",
            borderRadius: "7px",
            px: "3",
            fontSize: "sm",
          })}
        >
          <option value="" disabled>
            Choose a duration
          </option>
          <option value="1">1 hour</option>
          <option value="24">24 hours</option>
          <option value="168">7 days</option>
        </select>
        <div className={css({ display: "flex", gap: "3", flexWrap: "wrap", mt: "3" })}>
          <Button
            type="submit"
            variant="primary"
            disabled={!!pending || !canApprove}
            aria-describedby={`${id}-name ${id}-code ${id}-permission`}
          >
            {pending === `request-approve:${item.id}` ? "Approving…" : "Approve"}
          </Button>
          <Button
            type="button"
            disabled={!!pending || !canReject}
            aria-describedby={`${id}-name ${id}-code`}
            onClick={() => onAction(reject)}
          >
            {pending === `request-reject:${item.id}` ? "Rejecting…" : "Reject"}
          </Button>
        </div>
      </form>
      {item.expiresInSeconds === 0 && (
        <p className={`${muted} ${css({ mt: "2" })}`}>This request has expired. Refresh status.</p>
      )}
    </li>
  );
}
