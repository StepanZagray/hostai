import { getJson, type HostStatus, type Model, type RequestRecord } from "./api";

export interface HostSnapshot {
  status: HostStatus | null;
  models: Model[];
  requests: RequestRecord[];
  errors: { status: string | null; models: string | null; requests: string | null };
}

export async function readHostSnapshot(signal: AbortSignal): Promise<HostSnapshot> {
  const [status, models, requests] = await Promise.allSettled([
    getJson<HostStatus>("/api/status", signal),
    getJson<{ models: Model[]; connected: boolean }>("/api/models", signal),
    getJson<{ requests: RequestRecord[] }>("/api/requests", signal),
  ]);
  signal.throwIfAborted();
  const statusAvailable = status.status === "fulfilled" && status.value?.status === "online";
  const discovered =
    models.status === "fulfilled" &&
    models.value?.connected === true &&
    Array.isArray(models.value.models);
  const historyAvailable =
    requests.status === "fulfilled" && Array.isArray(requests.value?.requests);
  return {
    status: statusAvailable ? status.value : null,
    models: discovered ? models.value.models : [],
    requests: historyAvailable ? requests.value.requests : [],
    errors: {
      status: !statusAvailable ? "Gateway status could not be refreshed." : null,
      models: !discovered ? "Model discovery is unavailable. Check Ollama, then refresh." : null,
      requests: !historyAvailable ? "Request activity could not be refreshed." : null,
    },
  };
}
