import { useId, useState } from "react";
import { css } from "../../styled-system/css";
import { Badge, Button, caption, control, fieldLabel, muted } from "./ui";
import {
  canRequestAction,
  requestStates,
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
      className={css({ borderTop: "1px solid token(colors.lineSoft)", py: "3", minW: 0 })}
      aria-labelledby={`${id}-name`}
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
        <h4
          id={`${id}-name`}
          className={css({ fontSize: "sm", fontWeight: 600, overflowWrap: "anywhere", minW: 0 })}
        >
          {item.name || "Unnamed guest"}
        </h4>
        <Badge tone={item.expiresInSeconds === 0 ? "neutral" : "warning"}>
          {requestStates[item.state]}
        </Badge>
      </div>
      <p id={`${id}-code`} className={`${caption} ${css({ mt: "1" })}`}>
        Matching code:{" "}
        <code className={css({ fontFamily: "mono", color: "ink", fontWeight: 500 })}>
          {item.code}
        </code>
      </p>
      <p
        id={`${id}-permission`}
        className={`${muted} ${css({ mt: "1.5", overflowWrap: "anywhere" })}`}
      >
        Approval grants internet access to{" "}
        <strong className={css({ fontFamily: "mono", fontWeight: 500, color: "ink" })}>
          {item.model}
        </strong>{" "}
        for the duration you choose.
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
          className={`${fieldLabel} ${css({ display: "block", mb: "1.5", overflowWrap: "anywhere" })}`}
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
          className={`${control} ${css({ maxW: "20rem" })}`}
        >
          <option value="" disabled>
            Choose a duration
          </option>
          <option value="1">1 hour</option>
          <option value="24">24 hours</option>
          <option value="168">7 days</option>
        </select>
        <div className={css({ display: "flex", gap: "2", flexWrap: "wrap", mt: "2.5" })}>
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
        <p className={`${caption} ${css({ mt: "2", color: "amber" })}`}>
          This request has expired. Refresh status.
        </p>
      )}
    </li>
  );
}
