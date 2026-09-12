import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Box,
  LayoutDashboard,
  Menu,
  Network,
  RefreshCw,
  Share2,
  Terminal,
  X,
} from "lucide-react";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { interfaceUnavailableReason } from "../lib/model-admission";
import { Button, Led, legend, type LedState } from "./ui";
import { ThemeToggle } from "./theme-toggle";

const navigation = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/playground", label: "Playground", icon: Terminal },
  { to: "/models", label: "Models", icon: Box },
  { to: "/sharing", label: "Guest access", icon: Share2 },
  { to: "/activity", label: "Request activity", icon: Activity },
  { to: "/connection", label: "Connection", icon: Network },
] as const;

const RAIL = "224px";
const BAR = "52px";

export function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { status, loading, errors, refreshing, refresh } = useHost();
  const refreshErrors = Object.values(errors).filter((error) => error !== null);
  const power: LedState = loading ? "busy" : status ? "live" : "amber";
  return (
    <div className={css({ minH: "100dvh", display: "flex" })}>
      <a
        href="#main"
        className={css({
          position: "fixed",
          top: "-60px",
          left: "4",
          zIndex: 100,
          bg: "panel",
          border: "1px solid token(colors.line)",
          borderRadius: "sm",
          px: "3",
          py: "2",
          fontSize: "sm",
          _focus: { top: "4" },
        })}
      >
        Skip to content
      </a>
      {menuOpen && (
        <button
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
          className={css({
            position: "fixed",
            inset: 0,
            bg: "scrim",
            zIndex: 39,
            md: { display: "none" },
          })}
        />
      )}
      <aside
        data-open={menuOpen}
        className={css({
          width: RAIL,
          flexShrink: 0,
          bg: "paper",
          borderRight: "1px solid token(colors.line)",
          position: "fixed",
          inset: "0 auto 0 0",
          zIndex: 40,
          display: { base: "none", md: "flex" },
          flexDirection: "column",
          "&[data-open=true]": { display: "flex", bg: "panel" },
        })}
      >
        <div
          className={css({
            height: BAR,
            display: "flex",
            alignItems: "center",
            px: "4",
            gap: "2",
            flexShrink: 0,
          })}
        >
          <Link
            to="/"
            className={css({ display: "inline-flex", alignItems: "center", gap: "2.5" })}
          >
            <Led state={power} />
            <Wordmark />
          </Link>
          <button
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
            className={css({
              ml: "auto",
              p: "2",
              borderRadius: "sm",
              color: "muted",
              md: { display: "none" },
              _hover: { color: "ink", bg: "well" },
            })}
          >
            <X size={18} />
          </button>
        </div>
        <nav
          aria-label="Main navigation"
          className={css({
            px: "3",
            py: "2",
            display: "flex",
            flexDirection: "column",
            gap: "0.5",
            overflowY: "auto",
          })}
        >
          {navigation.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              onClick={() => setMenuOpen(false)}
              aria-current={path === to ? "page" : undefined}
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "2.5",
                px: "2.5",
                minH: "36px",
                fontSize: "sm",
                fontWeight: 500,
                borderRadius: "sm",
                border: "1px solid transparent",
                color: "inkSoft",
                transition: "background token(durations.fast), color token(durations.fast)",
                _hover: { bg: "well", color: "ink" },
                "&[aria-current=page]": {
                  bg: "panel",
                  borderColor: "line",
                  color: "ink",
                  fontWeight: 600,
                },
                "& svg": { color: "muted", flexShrink: 0 },
                "&[aria-current=page] svg, &:hover svg": { color: "ink" },
              })}
            >
              <Icon size={16} strokeWidth={1.75} />
              {label}
            </Link>
          ))}
        </nav>
        <div
          className={css({
            mt: "auto",
            p: "4",
            borderTop: "1px solid token(colors.lineSoft)",
            display: "grid",
            gap: "2",
          })}
        >
          <Plate
            label="gateway"
            value={
              loading
                ? "checking"
                : status
                  ? `v${status.version} · Java ${status.javaVersion.split(".")[0]}`
                  : "offline"
            }
          />
          <Plate
            label="runtime"
            value={loading ? "checking" : status ? hostOf(status.ollamaUrl) : "unknown"}
          />
        </div>
      </aside>
      <div className={css({ flex: 1, minW: 0, ml: { base: 0, md: RAIL } })}>
        <header
          className={css({
            height: BAR,
            bg: "paper",
            borderBottom: "1px solid token(colors.line)",
            px: { base: "3", lg: "6" },
            display: "flex",
            alignItems: "center",
            gap: "3",
            position: "sticky",
            top: 0,
            zIndex: 30,
          })}
        >
          <Button
            variant="ghost"
            aria-label="Open navigation"
            disabled={loading}
            onClick={() => setMenuOpen(true)}
            className={css({ md: { display: "none" }, px: "2" })}
          >
            <Menu />
          </Button>
          <span className={css({ md: { display: "none" }, display: "inline-flex" })}>
            <Wordmark />
          </span>
          <SignalPath />
          <div className={css({ ml: "auto", display: "flex", alignItems: "center", gap: "1" })}>
            <ThemeToggle />
          </div>
        </header>
        <main
          id="main"
          className={css({
            px: { base: "4", sm: "5", lg: "8" },
            py: { base: "5", lg: "7" },
            maxW: "1180px",
            mx: "auto",
            minH: `calc(100dvh - ${BAR})`,
            minW: 0,
            // A page can hand its whole content area to one surface, such as a model's
            // own interface: no gutters and no reading width, only the bar above it.
            // The column keeps refresh errors visible above a surface that fills the rest.
            "&:has([data-fill])": {
              px: 0,
              py: 0,
              maxW: "none",
              height: `calc(100dvh - ${BAR})`,
              display: "flex",
              flexDirection: "column",
            },
          })}
        >
          {refreshErrors.length > 0 && (
            <div
              role="alert"
              className={css({
                mb: "5",
                px: "3.5",
                py: "3",
                borderRadius: "sm",
                borderLeft: "2px solid token(colors.amber)",
                bg: "amberSoft",
                color: "amber",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "3",
                flexWrap: "wrap",
                fontSize: "xs",
                lineHeight: 1.55,
              })}
            >
              <div>
                {refreshErrors.map((error) => (
                  <p key={error}>{error}</p>
                ))}
              </div>
              <Button size="sm" disabled={refreshing} onClick={() => void refresh()}>
                <RefreshCw />
                Retry refresh
              </Button>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Wordmark() {
  return (
    <span
      className={css({
        fontSize: "md",
        fontWeight: 600,
        letterSpacing: "-0.02em",
        color: "ink",
        lineHeight: 1,
      })}
    >
      host
      <span className={css({ color: "muted" })}>ai</span>
    </span>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/** A stamped plate on the machine: what this workspace is wired to. */
function Plate({ label, value }: { label: string; value: string }) {
  return (
    <p className={css({ display: "flex", justifyContent: "space-between", gap: "3", minW: 0 })}>
      <span className={legend}>{label}</span>
      <span
        className={css({
          fontFamily: "mono",
          fontSize: "2xs",
          color: "inkSoft",
          textAlign: "right",
          overflowWrap: "anywhere",
        })}
      >
        {value}
      </span>
    </p>
  );
}

/**
 * The request path, always in view: browser, gateway, runtime, models. Each
 * light is the live state of that hop, so the header reads like the machine.
 */
function SignalPath() {
  const { status, models, loading, errors } = useHost();
  const ready = models.filter((model) => interfaceUnavailableReason(model) === null).length;
  const runtime = !status ? null : status.ollamaConnected;
  const nodes: { key: string; text: string; state: LedState; mobile?: boolean }[] = [
    { key: "browser", text: "Browser", state: "live" },
    {
      key: "gateway",
      text: loading ? "Connecting" : status ? "Gateway online" : "Gateway unavailable",
      state: loading ? "busy" : status ? "live" : "amber",
      mobile: true,
    },
    {
      key: "runtime",
      text: loading
        ? "Runtime"
        : runtime === null
          ? "Runtime unknown"
          : runtime
            ? "Runtime connected"
            : "Runtime not connected",
      state: loading ? "busy" : runtime ? "live" : runtime === false ? "amber" : "off",
    },
    {
      key: "models",
      text: loading
        ? "Models"
        : errors.models || !runtime
          ? "Models unknown"
          : ready === 0
            ? "No models ready"
            : `${ready} ${ready === 1 ? "model" : "models"} ready`,
      state: loading ? "busy" : errors.models || !runtime ? "off" : ready > 0 ? "live" : "amber",
    },
  ];
  // Spans, not a list: page-wide listitem counts belong to the content.
  return (
    <div
      role="group"
      aria-label="Request path"
      className={css({
        display: "flex",
        alignItems: "center",
        minW: 0,
        overflow: "hidden",
        fontFamily: "mono",
        fontSize: "2xs",
        fontWeight: 500,
        color: "muted",
        "& > span": {
          display: "flex",
          alignItems: "center",
          gap: "2",
          whiteSpace: "nowrap",
        },
        "& > span[data-mobile=false]": { display: { base: "none", md: "flex" } },
        "& > span + span::before": {
          content: '""',
          display: { base: "none", md: "block" },
          w: "18px",
          h: "1px",
          bg: "lineStrong",
          mx: "1.5",
        },
        "& > span[data-state=live]": { color: "inkSoft" },
        "& > span[data-state=amber]": { color: "amber" },
      })}
    >
      {nodes.map((node) => (
        <span key={node.key} data-mobile={!!node.mobile} data-state={node.state}>
          <Led state={node.state} />
          {node.text}
        </span>
      ))}
    </div>
  );
}
