import { ArrowRight, Box, Globe2, Laptop, Route } from "lucide-react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { Badge, PanelHeading, panel } from "./ui";

export function Topology() {
  const { status } = useHost();
  const nodes = [
    { name: "This workspace", detail: "Browser client", icon: Laptop, ready: true },
    {
      name: "HostAI gateway",
      detail: status ? "Connected" : "Status unavailable",
      icon: Route,
      ready: !!status,
    },
    {
      name: "Ollama runtime",
      detail: !status
        ? "Status unavailable"
        : status.ollamaConnected
          ? "Ready for requests"
          : "Waiting for runtime",
      icon: Box,
      ready: !!status?.ollamaConnected,
    },
  ];
  return (
    <section className={panel} aria-label="Inference connection path">
      <PanelHeading title="Your inference path" action={<Badge>On this machine</Badge>} />
      <div
        className={css({
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: { base: "1", sm: "3" },
          px: { base: "3", sm: "7" },
          pb: "7",
          pt: "3",
        })}
      >
        {nodes.map(({ name, detail, icon: Icon, ready }, i) => (
          <div key={name} className={css({ display: "contents" })}>
            {i > 0 && (
              <div
                className={css({
                  flex: 1,
                  borderTop: "1px dashed token(colors.line)",
                  position: "relative",
                  top: "-23px",
                  minW: "6px",
                })}
              >
                <ArrowRight
                  size={13}
                  className={css({ position: "absolute", right: 0, top: "-7px", color: "muted" })}
                />
              </div>
            )}
            <div
              className={css({
                display: "flex",
                alignItems: "center",
                flexDirection: "column",
                gap: "2",
                textAlign: "center",
                width: { base: "85px", sm: "132px" },
              })}
            >
              <div
                data-ready={ready}
                className={css({
                  w: "56px",
                  h: "56px",
                  borderRadius: "13px",
                  display: "grid",
                  placeItems: "center",
                  border: "1px solid token(colors.line)",
                  bg: "canvas",
                  color: "muted",
                  mb: "1",
                  "&[data-ready=true]": {
                    bg: "accentSoft",
                    borderColor: "#c4dfe6",
                    color: "accent",
                  },
                })}
              >
                <Icon size={24} strokeWidth={1.5} />
              </div>
              <span className={css({ fontWeight: 700, fontSize: { base: "10px", sm: "xs" } })}>
                {name}
              </span>
              <span className={css({ color: "muted", fontSize: "10px" })}>{detail}</span>
            </div>
          </div>
        ))}
      </div>
      <div
        className={css({
          borderTop: "1px solid token(colors.line)",
          bg: "canvas",
          px: "5",
          py: "3",
          display: "flex",
          gap: "2",
          alignItems: "center",
          fontSize: "11px",
          color: "muted",
        })}
      >
        <Globe2 size={14} />
        <span>Internet sharing is not available in this version. This workspace is local.</span>
      </div>
    </section>
  );
}
