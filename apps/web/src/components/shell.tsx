import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  ArrowUpRight,
  Box,
  ChevronRight,
  Cpu,
  LayoutDashboard,
  Menu,
  Network,
  Radio,
  Share2,
  Search,
  Terminal,
  X,
} from "lucide-react";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { Badge, Button } from "./ui";

const navigation = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/models", label: "Models", icon: Box },
  { to: "/playground", label: "Playground", icon: Terminal },
  { to: "/activity", label: "Request activity", icon: Activity },
  { to: "/connection", label: "Connection", icon: Network },
  { to: "/sharing", label: "Client access", icon: Share2 },
  { to: "/hosts", label: "Find a host", icon: Search },
] as const;

export function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { status, loading, errors, refreshing, refresh } = useHost();
  const refreshErrors = Object.values(errors).filter((error) => error !== null);
  const current = navigation.find((n) => n.to === path)?.label ?? "Workspace";
  return (
    <div className={css({ minH: "100dvh", display: "flex" })}>
      <a
        href="#main"
        className={css({
          position: "fixed",
          top: "-60px",
          left: "4",
          zIndex: 100,
          bg: "surface",
          p: "3",
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
            bg: "#142b3e80",
            zIndex: 39,
            md: { display: "none" },
          })}
        />
      )}
      <aside
        data-open={menuOpen}
        className={css({
          width: "224px",
          flexShrink: 0,
          bg: "rail",
          color: "white",
          position: "fixed",
          inset: "0 auto 0 0",
          zIndex: 40,
          display: { base: "none", md: "flex" },
          flexDirection: "column",
          "&[data-open=true]": { display: "flex" },
        })}
      >
        <div
          className={css({
            height: "80px",
            display: "flex",
            alignItems: "center",
            px: "6",
            gap: "3",
          })}
        >
          <div
            className={css({
              w: "32px",
              h: "32px",
              bg: "#ffffff12",
              border: "1px solid #ffffff30",
              borderRadius: "8px",
              display: "grid",
              placeItems: "center",
            })}
          >
            <Cpu size={20} strokeWidth={1.6} />
          </div>
          <Link
            to="/"
            className={css({ fontSize: "22px", fontWeight: 750, letterSpacing: "-0.05em" })}
          >
            host<span className={css({ color: "#93d3de" })}>ai</span>
          </Link>
          <button
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
            className={css({ ml: "auto", p: "2", md: { display: "none" } })}
          >
            <X size={18} />
          </button>
        </div>
        <div
          className={css({
            mx: "4",
            mt: "3",
            mb: "7",
            border: "1px solid #ffffff20",
            borderRadius: "8px",
            p: "3",
            display: "flex",
            gap: "3",
            alignItems: "center",
          })}
        >
          <div className={css({ bg: "#ffffff0c", borderRadius: "6px", p: "2" })}>
            <Radio size={17} />
          </div>
          <div>
            <p className={css({ fontSize: "xs", fontWeight: 650 })}>Personal workspace</p>
            <p className={css({ fontSize: "11px", color: "railMuted", mt: "1" })}>Local host</p>
          </div>
        </div>
        <p
          className={css({
            px: "6",
            mb: "3",
            fontSize: "10px",
            letterSpacing: "0.13em",
            color: "railMuted",
            fontWeight: 600,
          })}
        >
          WORKSPACE
        </p>
        <nav
          aria-label="Main navigation"
          className={css({ px: "3", display: "flex", flexDirection: "column", gap: "1" })}
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
                gap: "3",
                px: "3",
                minH: "44px",
                fontSize: "13px",
                borderRadius: "6px",
                color: "railMuted",
                _hover: { bg: "#ffffff08", color: "white" },
                "&[aria-current=page]": {
                  bg: "#ffffff12",
                  color: "white",
                  boxShadow: "inset 2px 0 0 #8dd5df",
                },
              })}
            >
              <Icon size={17} strokeWidth={1.7} />
              {label}
            </Link>
          ))}
        </nav>
        <div className={css({ mt: "auto", p: "4" })}>
          <div
            className={css({
              p: "4",
              bg: "#ffffff06",
              border: "1px solid #ffffff10",
              borderRadius: "9px",
              mb: "5",
            })}
          >
            <Cpu size={20} className={css({ color: "#93d3de", mb: "3" })} />
            <p className={css({ fontSize: "xs", fontWeight: 650, mb: "1.5" })}>
              Your hardware. Your models.
            </p>
            <p className={css({ fontSize: "11px", color: "railMuted", lineHeight: 1.8 })}>
              Inference stays on the machine you control.
            </p>
            <a
              href="https://docs.ollama.com"
              target="_blank"
              rel="noreferrer"
              className={css({
                display: "inline-flex",
                gap: "2",
                alignItems: "center",
                color: "#a3dbe5",
                mt: "2",
                fontSize: "11px",
                minH: "36px",
              })}
            >
              Ollama documentation <ArrowUpRight size={13} />
            </a>
          </div>
          <div
            className={css({
              borderTop: "1px solid #ffffff15",
              pt: "4",
              display: "flex",
              alignItems: "center",
              gap: "3",
            })}
          >
            <span
              className={css({
                w: "30px",
                h: "30px",
                borderRadius: "50%",
                display: "grid",
                placeItems: "center",
                bg: "#ffffff10",
                fontSize: "11px",
                fontWeight: 700,
              })}
            >
              LH
            </span>
            <div>
              <p className={css({ fontSize: "xs", fontWeight: 600 })}>Local host</p>
              <p className={css({ fontSize: "10px", color: "railMuted", mt: "0.5" })}>
                Development workspace
              </p>
            </div>
          </div>
        </div>
      </aside>
      <div className={css({ flex: 1, minW: 0, ml: { base: 0, md: "224px" } })}>
        <header
          className={css({
            height: "64px",
            bg: "surface",
            borderBottom: "1px solid token(colors.line)",
            px: { base: "4", lg: "9" },
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "3",
          })}
        >
          <div className={css({ display: "flex", alignItems: "center", gap: "3", fontSize: "xs" })}>
            <Button
              variant="ghost"
              aria-label="Open navigation"
              disabled={loading}
              onClick={() => setMenuOpen(true)}
              className={css({ md: { display: "none" } })}
            >
              <Menu />
            </Button>
            <span className={css({ color: "muted", display: { base: "none", sm: "inline" } })}>
              Workspace
            </span>
            <ChevronRight
              size={13}
              className={css({ color: "muted", display: { base: "none", sm: "block" } })}
            />
            <span className={css({ fontWeight: 650 })}>{current}</span>
          </div>
          <div className={css({ display: "flex", alignItems: "center", gap: "4" })}>
            <span
              className={css({
                fontSize: "11px",
                color: "muted",
                display: { base: "none", lg: "inline" },
              })}
            >
              Local owner workspace
            </span>
            <Badge tone={status ? "good" : "neutral"}>
              {loading ? "Connecting" : status ? "Gateway online" : "Gateway unavailable"}
            </Badge>
          </div>
        </header>
        <main
          id="main"
          className={css({
            p: { base: "4", sm: "6", lg: "9" },
            maxW: "1440px",
            mx: "auto",
            minH: "calc(100dvh - 116px)",
          })}
        >
          {refreshErrors.length > 0 && (
            <div
              role="alert"
              className={css({
                mb: "6",
                p: "4",
                borderRadius: "8px",
                bg: "warningSoft",
                color: "warning",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "3",
                flexWrap: "wrap",
                fontSize: "xs",
              })}
            >
              <div>
                {refreshErrors.map((error) => (
                  <p key={error}>{error}</p>
                ))}
              </div>
              <Button disabled={refreshing} onClick={() => void refresh()}>
                Retry refresh
              </Button>
            </div>
          )}
          <Outlet />
        </main>
        <footer
          className={css({
            px: { base: "4", lg: "9" },
            pb: "5",
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "2",
            fontSize: "10px",
            color: "muted",
          })}
        >
          <span>HostAI · Local inference workspace</span>
          <span>Built to run on your terms.</span>
        </footer>
      </div>
    </div>
  );
}
