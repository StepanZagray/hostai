import { errorMessage } from "./api";

export interface ModelDownload {
  id: string;
  model: string;
  state: "running" | "completed" | "failed" | "cancelled";
  phase: "starting" | "downloading" | "verifying" | "finalizing";
  message: string;
  digest: string | null;
  completedBytes: number | null;
  totalBytes: number | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}
export interface DownloadRequest {
  requestId: string;
  model: string;
}
export class DownloadRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function downloadModelError(model: string): string | null {
  if (!model.trim()) return "Enter a model and tag, such as qwen3:0.6b.";
  if (
    model.length > 128 ||
    model.includes("..") ||
    model.startsWith("localhost/") ||
    !/^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\/)?[a-z0-9][a-z0-9._-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(
      model,
    )
  )
    return "Use model:tag or namespace/model:tag from the Ollama library.";
  if (
    model.toLowerCase().endsWith(":cloud") ||
    model.toLowerCase().endsWith("-cloud") ||
    model.split(":")[0].endsWith("-cloud")
  )
    return "Choose a local model, not a cloud model.";
  return null;
}
function parseJob(value: unknown): ModelDownload {
  if (!value || typeof value !== "object") throw new Error("Download status could not be read.");
  const job = value as ModelDownload;
  const count = (n: unknown) => n === null || (Number.isSafeInteger(n) && (n as number) >= 0);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.id) ||
    typeof job.model !== "string" ||
    typeof job.message !== "string" ||
    !["running", "completed", "failed", "cancelled"].includes(job.state) ||
    !["starting", "downloading", "verifying", "finalizing"].includes(job.phase) ||
    !count(job.completedBytes) ||
    !count(job.totalBytes) ||
    (job.completedBytes !== null &&
      job.totalBytes !== null &&
      job.completedBytes > job.totalBytes) ||
    !(job.digest === null || typeof job.digest === "string") ||
    !(job.error === null || typeof job.error === "string")
  )
    throw new Error("Download status could not be read.");
  return job;
}
export async function downloadApi(path: string, signal: AbortSignal, body?: object) {
  const response = await fetch(path, {
    signal,
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new DownloadRequestError(
      response.status,
      response.status === 404 && path === "/api/model-downloads"
        ? "Download controls are unavailable. Update and restart the gateway."
        : await errorMessage(response),
    );
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("Download status could not be read. Check the gateway and try again.");
  }
}
export async function listDownloads(signal: AbortSignal) {
  const data = (await downloadApi("/api/model-downloads", signal)) as { downloads?: unknown[] };
  if (!Array.isArray(data?.downloads) || data.downloads.length > 20)
    throw new Error("Download status could not be read.");
  return data.downloads.map(parseJob);
}
export async function startDownload(body: DownloadRequest, signal: AbortSignal) {
  return parseJob(await downloadApi("/api/model-downloads", signal, body));
}
export async function cancelDownload(id: string, signal: AbortSignal) {
  return parseJob(
    await downloadApi(`/api/model-downloads/${encodeURIComponent(id)}/cancel`, signal, {}),
  );
}
