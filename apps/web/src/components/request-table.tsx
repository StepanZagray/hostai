import { css } from "../../styled-system/css";
import type { RequestRecord } from "../lib/api";
import { Badge, EmptyState } from "./ui";

export function RequestTable({
  requests,
  error,
  loading = false,
}: {
  requests: RequestRecord[];
  error?: string | null;
  loading?: boolean;
}) {
  if (loading || error)
    return (
      <EmptyState
        title={loading ? "Loading request activity" : "Request activity unavailable"}
        description={loading ? "Checking your gateway…" : "Refresh to load the history again."}
      />
    );
  if (!requests.length)
    return <EmptyState title="No requests yet" description="Generations you run appear here." />;
  return (
    <div className={css({ overflowX: "auto" })}>
      <table
        className={css({
          w: "full",
          textAlign: "left",
          fontSize: "xs",
          lineHeight: 1.4,
          whiteSpace: "nowrap",
          borderCollapse: "collapse",
          "& th": {
            textStyle: "legend",
            color: "muted",
            py: "2",
            px: { base: "3.5", md: "4" },
            borderTop: "1px solid token(colors.line)",
            borderBottom: "1px solid token(colors.line)",
            bg: "well",
          },
          "& td": {
            py: "2.5",
            px: { base: "3.5", md: "4" },
            color: "ink",
            borderBottom: "1px solid token(colors.lineSoft)",
          },
          "& tr:last-child td": { borderBottom: "none" },
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
              <td className={css({ fontFamily: "mono" })}>{r.model}</td>
              <td>
                <Badge
                  tone={
                    r.status === "completed" ? "good" : r.status === "failed" ? "bad" : "neutral"
                  }
                >
                  {r.status}
                </Badge>
              </td>
              <td className={css({ fontFamily: "mono", fontVariantNumeric: "tabular-nums" })}>
                {r.durationMs === null ? "—" : `${(r.durationMs / 1000).toFixed(1)}s`}
              </td>
              <td className={css({ fontFamily: "mono", fontVariantNumeric: "tabular-nums" })}>
                {r.outputTokens ?? "—"}
              </td>
              <td
                className={css({
                  fontFamily: "mono",
                  fontVariantNumeric: "tabular-nums",
                  color: "muted",
                })}
              >
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
