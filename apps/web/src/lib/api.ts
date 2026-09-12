export interface HostStatus {
  status: "online";
  ollamaConnected: boolean;
  ollamaUrl: string;
  version: string;
  javaVersion: string;
  uptimeSeconds: number;
  activeRequests: number;
  maxConcurrentRequests: number;
  totalRequests: number;
  failedRequests: number;
}
/** A runtime-provided interface that replaces the chat panel. See docs/model-ui.md. */
export interface ModelUi {
  runtime: string;
  /** Entry path relative to the runtime asset prefix, without a leading slash. */
  entry: string;
}
export interface ModelCapabilities {
  chat: boolean;
  infer: boolean;
}
export interface Model {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
  modifiedAt: string;
  chatUnavailableReason: string | null;
  ui: ModelUi | null;
  /** Older gateways omit this; normalize before making capability decisions. */
  capabilities?: ModelCapabilities;
  /** Provider-authored instructions, schemas and examples for non-visual clients. */
  interaction?: {
    instructions: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    examples: { description: string; input: unknown; output: unknown }[];
  } | null;
}
export interface RequestRecord {
  id: string;
  model: string;
  status: "completed" | "failed" | "cancelled" | "running";
  startedAt: string;
  durationMs: number | null;
  outputTokens: number | null;
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
export interface StreamChunk {
  content: string;
  done: boolean;
  outputTokens?: number;
  error?: string;
}
/** One record of an `/api/infer` NDJSON stream. `event` is opaque runtime JSON. */
export interface InferRecord {
  event?: unknown;
  done: boolean;
  error?: string;
}

/** Older gateways omit `ui`; a missing field means the default chat interface. */
export function normalizeModelUi(value: unknown): ModelUi | null {
  if (!value || typeof value !== "object") return null;
  const { runtime, entry } = value as Record<string, unknown>;
  if (typeof runtime !== "string" || typeof entry !== "string") return null;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(runtime)) return null;
  const segments = entry.split("/");
  if (
    !segments.length ||
    segments.length > 8 ||
    !segments.every(
      (segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== ".." && segment !== ".",
    )
  )
    return null;
  return { runtime, entry };
}

export function normalizeCapabilities(value: unknown, ui: ModelUi | null): ModelCapabilities {
  // Compatibility is only for omission, never malformed explicit declarations.
  if (value === undefined) return { chat: ui === null, infer: ui !== null };
  if (value && typeof value === "object") {
    const { chat, infer } = value as Record<string, unknown>;
    if (typeof chat === "boolean" && typeof infer === "boolean") return { chat, infer };
  }
  return { chat: false, infer: false };
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<T>;
}

export async function errorMessage(response: Response) {
  try {
    const body = await response.json();
    return String(body.detail || body.error || `Request failed (${response.status}).`);
  } catch {
    return `Request failed (${response.status}). Please try again.`;
  }
}

// Network chunks can split JSON records and UTF-8 code points at any byte.
export async function readChatStream(response: Response, onChunk: (chunk: StreamChunk) => void) {
  if (!response.ok) throw new Error(await errorMessage(response));
  if (!response.body) throw new Error("The model returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    let chunk: unknown;
    try {
      chunk = JSON.parse(line);
    } catch {
      throw new Error("The model returned an invalid stream.");
    }
    if (
      !chunk ||
      typeof chunk !== "object" ||
      !("content" in chunk) ||
      typeof chunk.content !== "string" ||
      !("done" in chunk) ||
      typeof chunk.done !== "boolean" ||
      ("error" in chunk && typeof chunk.error !== "string") ||
      ("outputTokens" in chunk &&
        (typeof chunk.outputTokens !== "number" ||
          !Number.isSafeInteger(chunk.outputTokens) ||
          chunk.outputTokens < 0))
    )
      throw new Error("The model returned an invalid stream.");
    if ("error" in chunk && chunk.error) throw new Error(chunk.error as string);
    onChunk(chunk as StreamChunk);
    finished = chunk.done;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consume(line);
        // The protocol terminates at done:true, even if the socket stays open.
        if (finished) return;
      }
      if (done) break;
    }
    consume(buffer);
    if (!finished) throw new Error("The connection closed before the model finished. Try again.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Reads an `/api/infer` stream. Mirrors `readChatStream`; events are passed through untouched. */
export async function readInferStream(response: Response, onRecord: (record: InferRecord) => void) {
  if (!response.ok) throw new Error(await errorMessage(response));
  if (!response.body) throw new Error("The model returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error("The model returned an invalid stream.");
    }
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      !("done" in record) ||
      typeof record.done !== "boolean" ||
      ("error" in record && typeof record.error !== "string")
    )
      throw new Error("The model returned an invalid stream.");
    if ("error" in record && record.error) throw new Error(record.error as string);
    onRecord(record as InferRecord);
    finished = record.done;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consume(line);
        if (finished) return;
      }
      if (done) break;
    }
    consume(buffer);
    if (!finished) throw new Error("The connection closed before the model finished. Try again.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function formatBytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}
