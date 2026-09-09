import { Activity } from "lucide-react";
import { css } from "../../styled-system/css";
import type { RequestRecord } from "../lib/api";
import { Badge, EmptyState } from "./ui";

export function RequestTable({ requests }: { requests: RequestRecord[] }) {
  if (!requests.length)
    return (
      <EmptyState
        icon={<Activity size={22} />}
        title="A quiet workspace"
        description="Your requests will appear here as you use the playground. Prompt contents are never included in this log."
      />
    );
  return (
    <div className={css({ overflowX: "auto" })}>
      <table
        className={css({
          w: "full",
          textAlign: "left",
          fontSize: "xs",
          whiteSpace: "nowrap",
          "& th": { color: "muted", fontWeight: 500, bg: "canvas", py: "3", px: "5" },
          "& td": { py: "4", px: "5", borderTop: "1px solid token(colors.line)" },
        })}
      >
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Status</th>
            <th scope="col">Duration</th>
            <th scope="col">Output tokens</th>
            <th scope="col">Started</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td className={css({ fontFamily: "mono", fontSize: "11px" })}>{r.model}</td>
              <td>
                <Badge
                  tone={
                    r.status === "completed" ? "good" : r.status === "failed" ? "bad" : "neutral"
                  }
                >
                  {r.status}
                </Badge>
              </td>
              <td>{r.durationMs === null ? "—" : `${(r.durationMs / 1000).toFixed(1)}s`}</td>
              <td>{r.outputTokens ?? "—"}</td>
              <td>
                {new Date(r.startedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
