import { createFileRoute } from "@tanstack/react-router";
import { Globe2, Laptop, RefreshCw, ShieldCheck } from "lucide-react";
import { css } from "../../styled-system/css";
import { Topology } from "../components/topology";
import {
  Badge,
  Button,
  CodeBlock,
  ExternalLink,
  PageHeading,
  PanelHeading,
  muted,
  panel,
} from "../components/ui";
import { useHost } from "../lib/host-context";

export const Route = createFileRoute("/connection")({ component: Connection });
function Connection() {
  const { status, refreshing, refresh } = useHost();
  return (
    <>
      <PageHeading
        title="Connection & setup"
        description="One local workspace. Open it on your desktop or in your browser."
        action={
          <Button disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw />
            Check connection
          </Button>
        }
      />
      <div
        className={css({
          display: "grid",
          gridTemplateColumns: { base: "1fr", xl: "1.3fr 1fr" },
          gap: "6",
          mb: "6",
        })}
      >
        <Topology />
        <section className={panel}>
          <PanelHeading
            title="Host connection"
            action={
              <Badge tone={status ? "good" : "warning"}>
                {status ? "Connected" : "Unavailable"}
              </Badge>
            }
          />
          <dl
            className={css({
              px: "5",
              pb: "5",
              fontSize: "xs",
              "& > div": {
                display: "flex",
                justifyContent: "space-between",
                gap: "3",
                py: "3",
                borderBottom: "1px solid token(colors.line)",
                flexWrap: "wrap",
              },
              "& dt": { color: "muted" },
              "& dd": { fontFamily: "mono", overflowWrap: "anywhere" },
            })}
          >
            <div>
              <dt>Inference runtime</dt>
              <dd>{status?.ollamaUrl ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>Gateway version</dt>
              <dd>{status?.version ?? "—"}</dd>
            </div>
            <div>
              <dt>Java runtime</dt>
              <dd>{status?.javaVersion ?? "—"}</dd>
            </div>
            <div>
              <dt>Access</dt>
              <dd>Local machine only</dd>
            </div>
          </dl>
        </section>
      </div>
      <section className={panel}>
        <PanelHeading
          title="Get your host ready"
          description="Start the gateway and your model runtime, then check the connection above."
        />
        <div
          className={css({
            px: "5",
            pb: "6",
            display: "grid",
            gridTemplateColumns: { base: "1fr", lg: "1fr 1fr" },
            gap: "6",
          })}
        >
          <div>
            <h3 className={css({ fontSize: "sm", fontWeight: 700, mb: "2" })}>
              1. Start the Java gateway
            </h3>
            <p className={`${muted} ${css({ mb: "3" })}`}>
              Use Java 26. Run this from the project directory.
            </p>
            <CodeBlock code="pnpm backend:dev" />
          </div>
          <div>
            <h3 className={css({ fontSize: "sm", fontWeight: 700, mb: "2" })}>2. Start Ollama</h3>
            <p className={`${muted} ${css({ mb: "3" })}`}>
              If Ollama is already running, you can skip this step.
            </p>
            <CodeBlock code="ollama serve" />
          </div>
          <div>
            <h3 className={css({ fontSize: "sm", fontWeight: 700, mb: "2" })}>
              3. Choose a small first model
            </h3>
            <p className={`${muted} ${css({ mb: "3" })}`}>
              This downloads a model. Check disk space and hardware first.
            </p>
            <CodeBlock code="ollama pull qwen3:0.6b" />
          </div>
          <div>
            <h3 className={css({ fontSize: "sm", fontWeight: 700, mb: "2" })}>
              4. Open your workspace
            </h3>
            <p className={`${muted} ${css({ mb: "3" })}`}>
              The desktop app and browser share this same frontend.
            </p>
            <CodeBlock code="pnpm desktop:dev" />
          </div>
        </div>
      </section>
      <div
        className={css({
          display: "grid",
          gridTemplateColumns: { base: "1fr", lg: "1fr 1fr" },
          gap: "6",
          mt: "6",
        })}
      >
        <section className={`${panel} ${css({ p: "5" })}`}>
          <Laptop size={22} className={css({ color: "accent", mb: "3" })} />
          <h2 className={css({ fontWeight: 750, mb: "2" })}>Prefer your browser?</h2>
          <p className={`${muted} ${css({ mb: "4" })}`}>
            Run the frontend with <code>pnpm dev</code> and open the address below. Both interfaces
            use the same gateway and models.
          </p>
          <CodeBlock code="http://127.0.0.1:3000" />
        </section>
        <section className={`${panel} ${css({ p: "5" })}`}>
          <ShieldCheck size={22} className={css({ color: "accent", mb: "3" })} />
          <h2 className={css({ fontWeight: 750, mb: "2" })}>Local by design, for now</h2>
          <p className={muted}>
            This version has no account system or API keys. Keep the gateway and UI on localhost.
            Internet sharing and authentication are not implemented.
          </p>
          <ExternalLink href="https://docs.ollama.com">Ollama setup guide</ExternalLink>
        </section>
      </div>
      <p
        className={`${muted} ${css({ mt: "5", display: "flex", gap: "2", alignItems: "center" })}`}
      >
        <Globe2 size={15} />A localhost address is accessible only from this machine.
      </p>
    </>
  );
}
