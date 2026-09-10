/** Match LocalOllamaEndpoint's loopback origins without URL parser alias normalization. */
export function runtimeCommands(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]*))?\/?$/.exec(value);
  // `$` can match before a final newline; never accept trailing shell input.
  if (!match || match[0] !== value) return null;
  const [, scheme, host, rawPort] = match;
  const port = rawPort ? Number(rawPort) : scheme === "https" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  // The gateway pins localhost to IPv4, including when the machine prefers IPv6.
  const endpoint = `${scheme}://${host === "localhost" ? "127.0.0.1" : host}:${port}`;
  const prefix = `OLLAMA_HOST='${endpoint}' ollama`;
  return {
    endpoint,
    // Ollama's serve command does not terminate TLS.
    serve: scheme === "http" ? `${prefix} serve` : null,
    pull: `${prefix} pull qwen3:0.6b`,
  };
}
