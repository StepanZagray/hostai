import { Box, Laptop, Route } from "lucide-react";
import { css } from "../../styled-system/css";
import { useHost } from "../lib/host-context";
import { Badge, Section, caption, type Tone } from "./ui";

/**
 * The request path drawn as a vertical signal chain: browser, gateway,
 * runtime. Each hop is a well tile on a shared hairline, with its live state
 * spelled out beside it.
 */
export function Topology() {
  const { status } = useHost();
  const nodes: {
    name: string;
    detail: string;
    icon: typeof Laptop;
    ready: boolean;
    tone?: Tone;
  }[] = [
    { name: "This workspace", detail: "Browser client", icon: Laptop, ready: true },
    {
      name: "HostAI gateway",
      detail: status ? "Connected" : "Unavailable",
      icon: Route,
      ready: !!status,
      tone: status ? "good" : "warning",
    },
    {
      name: "Ollama runtime",
      detail: !status ? "Unknown" : status.ollamaConnected ? "Ready for requests" : "Not connected",
      icon: Box,
      ready: !!status?.ollamaConnected,
      tone: !status ? "neutral" : status.ollamaConnected ? "good" : "warning",
    },
  ];
  return (
    <Section
      aria-label="Inference connection path"
      title="Request path"
      aside={<Badge>On this machine</Badge>}
    >
      <ol
        className={css({
          display: "grid",
          "& > li": {
            position: "relative",
            display: "grid",
            gridTemplateColumns: "30px minmax(0, 1fr)",
            alignItems: "center",
            columnGap: "3",
            py: "2.5",
          },
          "& > li::before": {
            content: '""',
            position: "absolute",
            left: "14.5px",
            top: 0,
            bottom: 0,
            w: "1px",
            bg: "lineStrong",
          },
          "& > li:first-child::before": { top: "50%" },
          "& > li:last-child::before": { bottom: "50%" },
        })}
      >
        {nodes.map(({ name, detail, icon: Icon, ready, tone }) => (
          <li key={name}>
            <span
              data-ready={ready}
              className={css({
                position: "relative",
                w: "30px",
                h: "30px",
                borderRadius: "sm",
                display: "grid",
                placeItems: "center",
                border: "1px solid token(colors.line)",
                bg: "well",
                color: "muted",
                "&[data-ready=true]": { borderColor: "lineStrong", color: "ink" },
              })}
            >
              <Icon size={15} strokeWidth={1.75} />
            </span>
            <span
              className={css({
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                columnGap: "3",
                rowGap: "1",
                flexWrap: "wrap",
                minW: 0,
              })}
            >
              <span className={css({ fontSize: "sm", fontWeight: 600, color: "ink" })}>{name}</span>
              {tone ? (
                <Badge tone={tone}>{detail}</Badge>
              ) : (
                <span className={`${caption} ${css({ textAlign: "right" })}`}>{detail}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
