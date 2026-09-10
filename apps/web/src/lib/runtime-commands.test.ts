import { describe, expect, it } from "vite-plus/test";
import { runtimeCommands } from "./runtime-commands";

describe("runtime commands follow the gateway's local endpoint", () => {
  it.each([
    ["http://127.0.0.1:11434", "http://127.0.0.1:11434"],
    ["http://localhost:11500/", "http://127.0.0.1:11500"],
    ["http://[::1]:11500", "http://[::1]:11500"],
    ["http://localhost", "http://127.0.0.1:80"],
    ["http://localhost:/", "http://127.0.0.1:80"],
    ["http://localhost:00080", "http://127.0.0.1:80"],
    ["https://localhost", "https://127.0.0.1:443"],
    ["https://[::1]:8443/", "https://[::1]:8443"],
  ])("preserves the effective destination for %s", (input, endpoint) => {
    const commands = runtimeCommands(input);
    expect(commands?.endpoint).toBe(endpoint);
    expect(commands?.pull).toBe(`OLLAMA_HOST='${endpoint}' ollama pull qwen3:0.6b`);
    expect(commands?.serve).toBe(
      input.startsWith("https:") ? null : `OLLAMA_HOST='${endpoint}' ollama serve`,
    );
  });

  it.each([
    undefined,
    null,
    {},
    "",
    "localhost:11434",
    "http://0.0.0.0:11434",
    "http://[::]:11434",
    "http://192.168.1.1:11434",
    "http://example.com:11434",
    "http://127.1:11434",
    "http://2130706433:11434",
    "http://0177.0.0.1:11434",
    "http://%31%32%37.0.0.1:11434",
    "http://localhost.:11434",
    "http://LOCALHOST:11434",
    "HTTP://localhost:11434",
    "http://localhost:0",
    "http://localhost:65536",
    "http://localhost:-1",
    "http://localhost:1e3",
    "http://localhost:11434/api",
    "http://localhost:11434//",
    "http://user@localhost:11434",
    "http://localhost:11434?test=1",
    "http://localhost:11434#fragment",
    " http://localhost:11434",
    "http://localhost:11434\n",
    "http://localhost:11434'; touch /tmp/unsafe; '",
    "http://localhost:$(id)",
    "http://localhost:`id`",
  ])("withholds executable commands for an unknown or unsafe address: %j", (input) => {
    expect(runtimeCommands(input)).toBeNull();
  });
});
