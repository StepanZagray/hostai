import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Check, RefreshCw } from "lucide-react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { interfaceUnavailableReason } from "../lib/model-admission";
import {
  Badge,
  Button,
  PageHeading,
  Readout,
  Section,
  button,
  muted,
  panel,
  type Tone,
} from "../components/ui";
import { RuntimeCommand } from "../components/runtime-command";
import { RequestTable } from "../components/request-table";

export const Route = createFileRoute("/")({ component: Overview });

function Overview() {
  const { status, models, requests, loading, refreshing, errors, refresh } = useHost();
  const eligibleModels = models.filter((model) => interfaceUnavailableReason(model) === null);
  const runtimeReady = !!status?.ollamaConnected;
  const ready = runtimeReady && eligibleModels.length > 0;
  const tone: Tone = loading ? "busy" : ready ? "good" : "warning";
  const readings: { label: string; value: string; sub: string; tone?: Tone }[] = [
    {
      label: "Models",
      value: loading ? "…" : errors.models ? "—" : String(models.length),
      sub: errors.models ? "Discovery unavailable" : `${eligibleModels.length} available to try`,
      tone: errors.models ? "warning" : "neutral",
    },
    {
      label: "In flight",
      value: status ? `${status.activeRequests}/${status.maxConcurrentRequests}` : "—",
      sub: "Concurrent generation slots",
    },
    {
      label: "Requests",
      value: status ? String(status.totalRequests) : "—",
      sub: "Since the gateway started",
    },
    {
      label: "Gateway",
      value: status ? `v${status.version}` : "—",
      sub: status ? `Java ${status.javaVersion.split(".")[0]}` : "Waiting for the gateway",
    },
  ];
  return (
    <>
      <PageHeading
        title="Overview"
        description="Your runtime, models and recent generations."
        action={
          <Button onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw />
            {refreshing ? "Refreshing…" : "Refresh host"}
          </Button>
        }
      />

      <section
        aria-label="Host status"
        className={`${panel} ${css({
          px: { base: "3.5", md: "4" },
          py: "3.5",
          mb: "4",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "4",
          flexWrap: "wrap",
        })}`}
      >
        <div className={css({ display: "grid", gap: "1.5", minW: 0 })}>
          <Badge tone={tone}>
            {loading ? "Checking host" : ready ? "Ready to run" : "Setup required"}
          </Badge>
          <p className={css({ fontSize: "md", fontWeight: 500, minW: 0 })}>
            {loading
              ? "Reading gateway status."
              : ready
                ? `${eligibleModels.length} ${eligibleModels.length === 1 ? "model" : "models"} on this machine can answer a prompt.`
                : !runtimeReady
                  ? "Ollama is not connected to the gateway."
                  : "No installed model can answer a prompt yet."}
          </p>
        </div>
        <div className={css({ display: "flex", gap: "2", flexWrap: "wrap" })}>
          {ready ? (
            <>
              <Link to="/playground" className={button({ variant: "primary" })}>
                Open playground
                <ArrowRight size={15} />
              </Link>
              <Link to="/models" className={button()}>
                Models
              </Link>
            </>
          ) : (
            <Link
              to={runtimeReady ? "/models" : "/connection"}
              className={button({ variant: "primary" })}
            >
              {runtimeReady ? "Download a model" : "Connect your runtime"}
              <ArrowRight size={15} />
            </Link>
          )}
        </div>
      </section>

      <section
        aria-label="Host metrics"
        aria-busy={loading}
        className={`${panel} ${css({
          display: "grid",
          gridTemplateColumns: { base: "1fr 1fr", lg: "repeat(4, 1fr)" },
          mb: "5",
          overflow: "hidden",
          "& > div": {
            px: { base: "3.5", md: "4" },
            py: "3.5",
            borderTop: "1px solid token(colors.lineSoft)",
            borderLeft: "1px solid token(colors.lineSoft)",
          },
          "& > div:nth-child(-n + 2)": { borderTop: "none" },
          "& > div:nth-child(odd)": { borderLeft: "none" },
          lg: {
            "& > div": { borderTop: "none", borderLeft: "1px solid token(colors.lineSoft)" },
            "& > div:first-child": { borderLeft: "none" },
          },
        })}`}
      >
        {readings.map(({ label, value, sub, tone }) => (
          <Readout key={label} label={label} value={value} sub={sub} tone={tone} />
        ))}
      </section>

      <div className={css({ display: "grid", gap: "5" })}>
        <Section
          aria-label="Host setup"
          title="Host setup"
          description={
            ready ? "Both prerequisites are met." : "Two prerequisites before your first prompt."
          }
        >
          <ol className={css({ display: "grid", gap: "4" })}>
            {[
              {
                title: "Run Ollama",
                action: "serve" as const,
                complete: "Ollama is already connected.",
                done: runtimeReady,
              },
              {
                title: "Install a model",
                action: "pull" as const,
                complete: "Your library has a model available to try.",
                done: eligibleModels.length > 0,
              },
            ].map((step, index) => (
              <li key={step.title} className={css({ display: "flex", gap: "3", minW: 0 })}>
                <span
                  aria-hidden="true"
                  data-done={step.done}
                  className={css({
                    flexShrink: 0,
                    border: "1px solid token(colors.lineStrong)",
                    borderRadius: "full",
                    w: "22px",
                    h: "22px",
                    display: "grid",
                    placeItems: "center",
                    color: "muted",
                    fontFamily: "mono",
                    fontSize: "2xs",
                    "&[data-done=true]": {
                      bg: "liveSoft",
                      borderColor: "liveSoft",
                      color: "live",
                    },
                  })}
                >
                  {step.done ? <Check size={12} strokeWidth={2.5} /> : index + 1}
                </span>
                <div className={css({ minW: 0, flex: 1 })}>
                  <h3 className={css({ fontSize: "sm", fontWeight: 600, mb: "1.5" })}>
                    {step.title}
                  </h3>
                  {step.done ? (
                    <p className={muted}>{step.complete}</p>
                  ) : (
                    <RuntimeCommand
                      endpoint={status?.ollamaUrl}
                      loading={loading}
                      action={step.action}
                    />
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section
          title="Recent requests"
          description="Metadata only — prompts and responses are never recorded."
          action={
            <Link to="/activity" className={button({ variant: "ghost", size: "sm" })}>
              All activity
              <ArrowRight size={14} />
            </Link>
          }
          flush
        >
          <RequestTable requests={requests.slice(0, 5)} error={errors.requests} loading={loading} />
        </Section>
      </div>
    </>
  );
}
