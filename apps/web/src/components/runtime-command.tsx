import { css } from "../../styled-system/css";
import { runtimeCommands } from "../lib/runtime-commands";
import { CodeBlock, ExternalLink, muted } from "./ui";

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
      <p className={muted}>
        Ollama’s address is unavailable. Check the gateway connection before using terminal
        commands.
      </p>
    );
  if (action === "serve" && !commands.serve)
    return (
      <p className={`${muted} ${css({ overflowWrap: "anywhere" })}`}>
        HostAI expects HTTPS at {commands.endpoint}. Check your existing TLS endpoint and the Ollama
        runtime behind it, then check the connection again. Starting Ollama alone does not provide
        HTTPS.
      </p>
    );
  return (
    <div className={css({ minW: "0", maxW: "full" })}>
      <p className={`${muted} ${css({ mb: "3" })}`}>
        {action === "serve" ? (
          <>
            <ExternalLink href="https://ollama.com/download">Install Ollama</ExternalLink> if
            needed. If it is already running, check that its address matches HostAI before starting
            another copy.
          </>
        ) : (
          "With Ollama running, this downloads a small first model to HostAI’s configured runtime. Refresh the library when it finishes."
        )}
      </p>
      <p className={`${muted} ${css({ mb: "2" })}`}>Run in a Linux or macOS terminal:</p>
      <CodeBlock
        code={commands[action]!}
        copyLabel={action === "serve" ? "Copy Ollama start command" : "Copy model download command"}
      />
    </div>
  );
}
