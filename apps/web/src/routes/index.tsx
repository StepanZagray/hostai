import { Link, createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  Cpu,
  RefreshCw,
  Terminal,
  Zap,
} from "lucide-react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import {
  Badge,
  Button,
  CodeBlock,
  PageHeading,
  PanelHeading,
  button,
  eyebrow,
  muted,
  panel,
} from "../components/ui";
import { Topology } from "../components/topology";
import { RequestTable } from "../components/request-table";

export const Route = createFileRoute("/")({ component: Overview });

function Overview() {
  const { status, models, requests, loading, refreshing, error, refresh } = useHost();
  const ready = !!status?.ollamaConnected && models.length > 0;
  const metrics = [
    {
      label: "Available models",
      value: loading ? "…" : status ? String(models.length).padStart(2, "0") : "—",
      sub: status?.ollamaConnected ? "Installed on your machine" : "Connect Ollama to discover",
      icon: Box,
    },
    {
      label: "Active requests",
      value: status ? `${status.activeRequests} / ${status.maxConcurrentRequests}` : "—",
      sub: "Concurrent generation slots",
      icon: Zap,
    },
    {
      label: "Total requests",
      value: status ? String(status.totalRequests) : "—",
      sub: "Since the gateway started",
      icon: Activity,
    },
    {
      label: "Host runtime",
      value: status ? `Java ${status.javaVersion.split(".")[0]}` : "—",
      sub: status ? `Gateway v${status.version}` : "Waiting for the gateway",
      icon: Cpu,
    },
  ];
  return (
    <>
      <PageHeading
        title="Host overview"
        description="Your models, connections, and activity. All in one place."
        action={
          <Button onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw />
            {refreshing ? "Refreshing…" : "Refresh host"}
          </Button>
        }
      />
      <section
        className={css({
          bg: "surface",
          border: "1px solid token(colors.line)",
          borderRadius: "12px",
          p: { base: "5", md: "7" },
          mb: "6",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "6",
          position: "relative",
          overflow: "hidden",
        })}
      >
        <div className={css({ maxW: "490px", position: "relative", zIndex: 1 })}>
          <div className={css({ display: "flex", gap: "3", alignItems: "center", mb: "4" })}>
            <span className={eyebrow}>PERSONAL INFERENCE</span>
            <Badge tone={ready ? "good" : "warning"}>
              {loading ? "Checking host" : ready ? "Ready to run" : "Setup required"}
            </Badge>
          </div>
          <h2
            className={css({
              fontSize: { base: "24px", lg: "30px" },
              fontWeight: 750,
              letterSpacing: "-0.045em",
              mb: "3",
            })}
          >
            {ready ? "Your next idea runs here." : "Make yourself at host."}
          </h2>
          <p className={muted}>
            {ready
              ? "Your local models are connected. Open the playground and give them something to work on."
              : "Bring your local models into one workspace. Connect your runtime, try a prompt, and see what your machine can do."}
          </p>
          <div
            className={css({
              display: "flex",
              alignItems: "center",
              gap: "3",
              mt: "5",
              flexWrap: "wrap",
            })}
          >
            <Link
              to={ready ? "/playground" : "/connection"}
              className={button({ variant: "primary" })}
            >
              {ready ? "Open playground" : "Connect your runtime"}
              <ArrowRight size={15} />
            </Link>
            <Link to="/models" className={button({ variant: "ghost" })}>
              Explore models
              <ChevronRight size={15} />
            </Link>
          </div>
        </div>
        <div
          aria-hidden="true"
          className={css({
            display: { base: "none", xl: "grid" },
            placeItems: "center",
            w: "200px",
            h: "165px",
            flexShrink: 0,
            bgImage: "radial-gradient(#c5d9df 1px, transparent 1px)",
            bgSize: "12px 12px",
          })}
        >
          <div
            className={css({
              bg: "surface",
              border: "1px solid #c4dfe6",
              p: "5",
              borderRadius: "20px",
              boxShadow: "0 8px 30px #096f860c",
              position: "relative",
            })}
          >
            <Cpu size={58} strokeWidth={1.1} className={css({ color: "accent" })} />
            <span
              className={css({
                position: "absolute",
                right: "-7px",
                bottom: "-7px",
                border: "4px solid white",
                bg: "accent",
                color: "white",
                borderRadius: "50%",
                p: "1.5",
              })}
            >
              <Check size={15} />
            </span>
          </div>
        </div>
      </section>
      {error && (
        <div
          role="alert"
          className={css({
            mb: "6",
            py: "3",
            px: "4",
            borderRadius: "8px",
            color: "warning",
            bg: "warningSoft",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "3",
            flexWrap: "wrap",
            fontSize: "xs",
          })}
        >
          <span>{error}</span>
          <Link to="/connection" className={css({ fontWeight: 750, textDecoration: "underline" })}>
            View setup
          </Link>
        </div>
      )}
      <section
        aria-label="Host metrics"
        aria-busy={loading}
        className={css({
          display: "grid",
          gridTemplateColumns: { base: "1fr 1fr", xl: "repeat(4, 1fr)" },
          gap: "4",
          mb: "6",
        })}
      >
        {metrics.map(({ label, value, sub, icon: Icon }) => (
          <div key={label} className={`${panel} ${css({ p: { base: "4", md: "5" } })}`}>
            <div
              className={css({
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                mb: "4",
                gap: "2",
              })}
            >
              <span className={css({ fontSize: "xs", fontWeight: 600, color: "muted" })}>
                {label}
              </span>
              <Icon size={16} className={css({ color: "muted" })} />
            </div>
            <p
              className={css({
                fontFamily: "mono",
                fontSize: { base: "23px", lg: "27px" },
                fontWeight: 450,
                letterSpacing: "-0.06em",
                mb: "2",
                fontVariantNumeric: "tabular-nums",
              })}
            >
              {value}
            </p>
            <p className={css({ color: "muted", fontSize: "10px", lineHeight: 1.6 })}>{sub}</p>
          </div>
        ))}
      </section>
      <div
        className={css({
          display: "grid",
          gridTemplateColumns: { base: "1fr", xl: "1.2fr 1fr" },
          gap: "6",
          mb: "6",
        })}
      >
        <Topology />
        <section className={panel}>
          <PanelHeading
            title="From zero to first token"
            description="A small setup. A lot of possibilities."
          />
          <div
            className={css({
              px: "5",
              pb: "5",
              display: "flex",
              flexDirection: "column",
              gap: "4",
            })}
          >
            {[
              {
                title: "Start your Ollama runtime",
                command: "ollama serve",
                done: !!status?.ollamaConnected,
              },
              {
                title: "Download a model that fits your hardware",
                command: "ollama pull qwen3:0.6b",
                done: models.length > 0,
              },
            ].map((step, i) => (
              <div key={step.title}>
                <div
                  className={css({
                    display: "flex",
                    alignItems: "center",
                    gap: "2",
                    mb: "2",
                    fontSize: "xs",
                    fontWeight: 600,
                  })}
                >
                  <span
                    className={css({
                      border: "1px solid token(colors.line)",
                      borderRadius: "50%",
                      w: "20px",
                      h: "20px",
                      display: "grid",
                      placeItems: "center",
                      color: "accent",
                      fontSize: "10px",
                    })}
                  >
                    {step.done ? <Check size={12} /> : i + 1}
                  </span>
                  {step.title}
                </div>
                <CodeBlock code={step.command} />
              </div>
            ))}
            <Link
              to="/playground"
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "2",
                color: "accent",
                fontSize: "xs",
                fontWeight: 700,
                minH: "36px",
              })}
            >
              <Terminal size={15} />
              Send your first prompt
              <ArrowRight size={14} />
            </Link>
          </div>
        </section>
      </div>
      <section className={panel}>
        <PanelHeading
          title="Recent requests"
          description="A little visibility into every generation."
          action={
            <Link to="/activity" className={button({ variant: "ghost" })}>
              View activity
              <ArrowRight size={14} />
            </Link>
          }
        />
        <RequestTable requests={requests.slice(0, 5)} />
      </section>
    </>
  );
}
