import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { css } from "../../styled-system/css";
import { RequestTable } from "../components/request-table";
import { Button, PageHeading, muted, panel } from "../components/ui";
import { useHost } from "../lib/host-context";

export const Route = createFileRoute("/activity")({ component: Activity });
function Activity() {
  const { requests, refresh, refreshing, loading, errors } = useHost();
  const [filter, setFilter] = useState("all");
  return (
    <>
      <PageHeading
        title="Request activity"
        description="See how your host responds, one generation at a time."
        action={
          <Button disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw />
            Refresh activity
          </Button>
        }
      />
      <div
        className={css({
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "4",
          flexWrap: "wrap",
          mb: "5",
        })}
      >
        <label className={css({ display: "flex", gap: "3", alignItems: "center", fontSize: "xs" })}>
          Status
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={css({
              bg: "surface",
              border: "1px solid token(colors.line)",
              borderRadius: "6px",
              px: "3",
              minH: "42px",
            })}
          >
            <option value="all">All requests</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="running">Running</option>
          </select>
        </label>
        <p className={muted}>Latest 50 requests · Current gateway session</p>
      </div>
      <section className={panel}>
        <RequestTable
          requests={requests.filter((r) => filter === "all" || r.status === filter)}
          error={errors.requests}
          loading={loading}
        />
      </section>
      <p className={`${muted} ${css({ mt: "5" })}`}>
        Only request metadata is recorded. History is stored in memory and resets when the gateway
        restarts.
      </p>
    </>
  );
}
