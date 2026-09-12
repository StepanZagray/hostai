import { css } from "../../styled-system/css";
import { runtimeCommands } from "../lib/runtime-commands";
import { CodeBlock, ExternalLink, caption, muted } from "./ui";

export function RuntimeCommand({
  endpoint,
  loading,
  action,
}: {
  endpoint: unknown;
  loading: boolean;
  action: "serve" | "pull";
}) {
  const commands = runtimeCommands(endpoint);
  if (loading) return <p className={muted}>Checking your Ollama address…</p>;
  if (!commands)
    return (
      <p className={muted}>Ollama’s address is unavailable. Check the gateway connection first.</p>
    );
  if (action === "serve" && !commands.serve)
    return (
      <p className={`${muted} ${css({ overflowWrap: "anywhere" })}`}>
        HostAI expects HTTPS at {commands.endpoint}. Point that endpoint at your Ollama runtime and
        check the connection again — starting Ollama alone does not provide HTTPS.
      </p>
    );
  return (
    <div className={css({ minW: "0", maxW: "full" })}>
      <p className={`${muted} ${css({ mb: "2" })}`}>
        {action === "serve" ? (
          <>
            <ExternalLink href="https://ollama.com/download">Install Ollama</ExternalLink> if you do
            not have it. If it is already running, check that it listens on this address.
          </>
        ) : (
          "Pulls a small model into the runtime HostAI is configured to use. Refresh the library when it finishes."
        )}
      </p>
      <p className={`${caption} ${css({ mb: "1.5" })}`}>Linux or macOS terminal</p>
      <CodeBlock
        code={commands[action]!}
        copyLabel={action === "serve" ? "Copy Ollama start command" : "Copy model download command"}
      />
    </div>
  );
}
