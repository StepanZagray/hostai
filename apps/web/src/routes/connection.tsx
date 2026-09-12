import { useEffect, useState, type ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, RefreshCw } from "lucide-react";
import { css } from "../../styled-system/css";
import { RuntimeCommand } from "../components/runtime-command";
import { Topology } from "../components/topology";
import {
  Badge,
  Button,
  CodeBlock,
  DataList,
  PageHeading,
  Section,
  button,
  caption,
  muted,
} from "../components/ui";
import { useHost } from "../lib/host-context";
import { interfaceUnavailableReason } from "../lib/model-admission";

export const Route = createFileRoute("/connection")({ component: Connection });

function Connection() {
  const { status, models, errors, loading, refreshing, refresh } = useHost();
  const ready =
    !!status?.ollamaConnected && models.some((model) => interfaceUnavailableReason(model) === null);
  const [workspaceUrl, setWorkspaceUrl] = useState("");
  useEffect(() => setWorkspaceUrl(window.location.origin), []);
  return (
    <>
      <PageHeading
        title="Connection & setup"
        description="One workspace, served from this machine to your desktop app and your browser."
        action={
          <Button disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw />
            Check connection
          </Button>
        }
      />
      <Section
        aria-label="Get your host ready"
        title="Get your host ready"
        description="Four steps from a cold machine to a first answer."
        className={css({ mb: "5" })}
      >
        <ol
          className={css({
            display: "grid",
            gridTemplateColumns: { base: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" },
            rowGap: "5",
            columnGap: "8",
          })}
        >
          <Step index={1} title="Start the Java gateway" done={!loading && !!status}>
            {loading ? (
              <p className={muted}>Checking your gateway…</p>
            ) : status ? (
              <p className={muted}>Your gateway is already running. Keep this workspace open.</p>
            ) : (
              <>
                <p className={`${muted} ${css({ mb: "2" })}`}>
                  Run this from the project directory with Java 26. If it is already running, check
                  its terminal for errors.
                </p>
                <CodeBlock code="pnpm backend:dev" />
              </>
            )}
          </Step>
          <Step index={2} title="Start Ollama" done={!!status?.ollamaConnected}>
            {status?.ollamaConnected ? (
              <p className={muted}>Ollama is already connected.</p>
            ) : (
              <RuntimeCommand endpoint={status?.ollamaUrl} loading={loading} action="serve" />
            )}
          </Step>
          <Step index={3} title="Install a model" done={!loading && ready}>
            {loading ? (
              <p className={muted}>Checking your model library…</p>
            ) : ready ? (
              <p className={muted}>Your library has a model available to try.</p>
            ) : errors.models && status?.ollamaConnected ? (
              <p className={muted}>
                Model discovery failed. Check the connection again before downloading anything.
              </p>
            ) : status?.ollamaConnected && models.length > 0 ? (
              <>
                <p className={`${muted} ${css({ mb: "2" })}`}>
                  None of your installed models can chat. Review why before downloading another.
                </p>
                <Link to="/models" className={button()}>
                  Review model library
                </Link>
              </>
            ) : (
              <>
                <p className={`${muted} ${css({ mb: "2" })}`}>
                  Pick a model in the library and track its download there. Check its disk and
                  memory requirements first.
                </p>
                <Link to="/models" className={button()}>
                  Download a local model
                </Link>
              </>
            )}
          </Step>
          <Step index={4} title="Send a prompt">
            <p className={`${muted} ${css({ mb: "2" })}`}>
              {ready
                ? "Installed does not mean tested. Try the model before you rely on it."
                : "Available once Ollama is connected and a model is installed."}
            </p>
            {ready && (
              <Link to="/models" className={button({ variant: "primary" })}>
                Try a local model
              </Link>
            )}
          </Step>
        </ol>
      </Section>
      <div
        className={css({
          display: "grid",
          gridTemplateColumns: { base: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" },
          gap: "5",
          mb: "5",
        })}
      >
        <Topology />
        <Section
          aria-label="Local connection details"
          title="Host connection"
          aside={
            <Badge tone={status ? "good" : "warning"}>
              {status ? "Gateway connected" : "Gateway unavailable"}
            </Badge>
          }
        >
          <DataList
            items={[
              { term: "Inference runtime", value: status?.ollamaUrl ?? "Unavailable" },
              { term: "Gateway version", value: status?.version ?? "—" },
              { term: "Java runtime", value: status?.javaVersion ?? "—" },
              { term: "Reachable from", value: "This machine only" },
            ]}
          />
        </Section>
      </div>
      <div
        className={css({
          display: "grid",
          gridTemplateColumns: { base: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" },
          gap: "5",
        })}
      >
        <Section title="Open this workspace in a browser">
          <p className={`${muted} ${css({ mb: "3" })}`}>
            The running workspace serves both interfaces. Open this address on this machine — no
            second launcher or gateway.
          </p>
          {workspaceUrl && <CodeBlock code={workspaceUrl} copyLabel="Copy workspace address" />}
          <p className={`${caption} ${css({ mt: "2" })}`}>
            A localhost address is reachable only from this machine.
          </p>
        </Section>
        <Section title="Let someone else use a model">
          <p className={`${muted} ${css({ mb: "3" })}`}>
            Guest access serves one model on a separate page, behind expiring keys you can revoke.
            Local by default; a temporary Cloudflare link is opt-in. Sharing this workspace address
            grants nothing.
          </p>
          <Link to="/sharing" search={{ model: undefined }} className={button()}>
            Set up guest access
          </Link>
        </Section>
      </div>
    </>
  );
}

/**
 * One numbered step of the setup sequence. The marker is a small mono numeral
 * in a hairline circle, lit green with a check once that step is met.
 */
function Step({
  index,
  title,
  done = false,
  children,
}: {
  index: number;
  title: string;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={css({ display: "flex", gap: "3", minW: 0 })}>
      <span
        aria-hidden="true"
        data-done={done}
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
        {done ? <Check size={12} strokeWidth={2.5} /> : index}
      </span>
      <div className={css({ minW: 0, flex: 1 })}>
        <h3 className={css({ fontSize: "sm", fontWeight: 600, lineHeight: "22px", mb: "1.5" })}>
          {title}
        </h3>
        {children}
      </div>
    </li>
  );
}
