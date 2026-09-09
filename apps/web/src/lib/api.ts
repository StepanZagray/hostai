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
export interface Model {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
  modifiedAt: string;
  chatUnavailableReason: string | null;
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

export function formatBytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}
