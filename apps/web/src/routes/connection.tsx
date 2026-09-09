import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
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
  button,
} from "../components/ui";
import { useHost } from "../lib/host-context";
import { chatUnavailableReason } from "../lib/model-admission";

export const Route = createFileRoute("/connection")({ component: Connection });
function Connection() {
  const { status, models, errors, loading, refreshing, refresh } = useHost();
  const ready =
    !!status?.ollamaConnected && models.some((model) => chatUnavailableReason(model) === null);
  const [workspaceUrl, setWorkspaceUrl] = useState("");
  useEffect(() => setWorkspaceUrl(window.location.origin), []);
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
      <section className={`${panel} ${css({ mb: "6" })}`} aria-label="Get your host ready">
        <PanelHeading
          title="Get your host ready"
          description="This workspace is already open. Complete the missing steps, then check the connection."
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
            {loading ? (
              <p className={muted}>Checking your gateway…</p>
            ) : status ? (
              <p className={muted}>Your gateway is already running. Keep this workspace open.</p>
            ) : (
              <>
                <p className={`${muted} ${css({ mb: "3" })}`}>
                  Start only the missing gateway from the project directory with Java 26. If it is
                  already running, check its terminal for errors before retrying.
                </p>
                <CodeBlock code="pnpm backend:dev" />
              </>
            )}
          </div>
          <div>
            <h3 className={css({ fontSize: "sm", fontWeight: 700, mb: "2" })}>2. Start Ollama</h3>
            {status?.ollamaConnected ? (
              <p className={muted}>Ollama is already connected. No restart is needed.</p>
            ) : (
              <>
                <p className={`${muted} ${css({ mb: "3" })}`}>
                  Install Ollama first using the setup guide below. If it is already running, check
                  its connection instead of starting a second copy.
                </p>
                <CodeBlock code="ollama serve" />
              </>
            )}
          </div>
          <div>
            <h3 className={css({ fontSize: "sm", fontWeight: 700, mb: "2" })}>
              3. Choose a small first model
            </h3>
            {loading ? (
              <p className={muted}>Checking your model library…</p>
            ) : ready ? (
              <p className={muted}>
                Your library has a model available to try. Choose it in the next step.
              </p>
            ) : errors.models && status?.ollamaConnected ? (
              <p className={muted}>
                Model discovery failed. Check the connection again before downloading another model.
              </p>
            ) : status?.ollamaConnected && models.length > 0 ? (
              <>
                <p className={`${muted} ${css({ mb: "3" })}`}>
                  Your discovered models are not available for chat. Review their reasons before
                  downloading another model.
                </p>
                <Link to="/models" className={button({ variant: "secondary" })}>
                  Review model library
                </Link>
              </>
            ) : (
              <>
                <p className={`${muted} ${css({ mb: "3" })}`}>
                  Open the model library to choose a model and track its download. Check its disk
                  and memory requirements before starting.
                </p>
                <Link to="/models" className={button({ variant: "secondary" })}>
                  Download a local model
                </Link>
              </>
            )}
          </div>
          <div>
            <h3 className={css({ fontSize: "sm", fontWeight: 700, mb: "2" })}>
              4. Choose a model and chat
            </h3>
            <p className={`${muted} ${css({ mb: "3" })}`}>
              {ready
                ? "Open your library, select a model, and send a first prompt to test it."
                : "Once Ollama is connected and a model is available, continue to your library."}
            </p>
            {ready && (
              <Link to="/models" className={button({ variant: "primary" })}>
                Try a local model
              </Link>
            )}
          </div>
        </div>
      </section>
      <div
        className={css({
          display: "grid",
          gridTemplateColumns: { base: "1fr", xl: "1.3fr 1fr" },
          gap: "6",
          mb: "6",
        })}
      >
        <Topology />
        <section className={panel} aria-label="Local connection details">
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
          <h2 className={css({ fontWeight: 750, mb: "2" })}>Open this workspace in a browser</h2>
          <p className={`${muted} ${css({ mb: "4" })}`}>
            Open this address on this same machine. The existing workspace serves both interfaces;
            you do not need to run another launcher or gateway.
          </p>
          {workspaceUrl && <CodeBlock code={workspaceUrl} copyLabel="Copy workspace address" />}
        </section>
        <section className={`${panel} ${css({ p: "5" })}`}>
          <ShieldCheck size={22} className={css({ color: "accent", mb: "3" })} />
          <h2 className={css({ fontWeight: 750, mb: "2" })}>Sharing and remote clients</h2>
          <p className={muted}>
            Internet sharing, host discovery, and connecting to someone else’s host are not
            available in this version. There are no accounts or API keys. Keep this workspace on
            localhost; copying its address does not give other people access.
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
