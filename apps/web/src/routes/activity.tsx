import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { css } from "../../styled-system/css";
import { RequestTable } from "../components/request-table";
import { Button, Field, PageHeading, caption, control, panel } from "../components/ui";
import { useHost } from "../lib/host-context";

export const Route = createFileRoute("/activity")({ component: Activity });

function Activity() {
  const { requests, refresh, refreshing, loading, errors } = useHost();
  const [filter, setFilter] = useState("all");
  return (
    <>
      <PageHeading
        title="Request activity"
        description="Every generation this gateway has handled since it started."
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
          alignItems: "end",
          justifyContent: "space-between",
          gap: "4",
          flexWrap: "wrap",
          mb: "4",
        })}
      >
        <Field label="Status" className={css({ w: "180px", maxW: "full" })}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className={control}>
            <option value="all">All requests</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="running">Running</option>
          </select>
        </Field>
        <p className={`${caption} ${css({ pb: "2" })}`}>
          Latest 50 requests · Current gateway session
        </p>
      </div>
      <section
        className={`${panel} ${css({
          overflow: "hidden",
          // The panel's own hairline already frames the table's top edge.
          "& thead th": { borderTop: "none" },
        })}`}
      >
        <RequestTable
          requests={requests.filter((r) => filter === "all" || r.status === filter)}
          error={errors.requests}
          loading={loading}
        />
      </section>
      <p className={`${caption} ${css({ mt: "4" })}`}>
        Prompts and responses are never stored. This history lives in memory and resets when the
        gateway restarts.
      </p>
    </>
  );
}
