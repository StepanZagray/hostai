import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getJson, type HostStatus, type Model, type RequestRecord } from "./api";

interface HostData {
  status: HostStatus | null;
  models: Model[];
  requests: RequestRecord[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}
const HostContext = createContext<HostData | null>(null);

export function HostProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Omit<HostData, "refresh">>({
    status: null,
    models: [],
    requests: [],
    loading: true,
    refreshing: false,
    error: null,
  });
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setData((d) => ({ ...d, refreshing: true }));
    try {
      const [status, modelData, requestData] = await Promise.all([
        getJson<HostStatus>("/api/status", current.signal),
        getJson<{ models: Model[] }>("/api/models", current.signal),
        getJson<{ requests: RequestRecord[] }>("/api/requests", current.signal),
      ]);
      if (!current.signal.aborted)
        setData({
          status,
          models: modelData.models,
          requests: requestData.requests,
          loading: false,
          refreshing: false,
          error: null,
        });
    } catch (error) {
      if (!current.signal.aborted)
        setData({
          status: null,
          models: [],
          requests: [],
          loading: false,
          refreshing: false,
          error: error instanceof Error ? error.message : "Could not reach your host.",
        });
    }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15000);
    return () => {
      clearInterval(interval);
      controller.current?.abort();
    };
  }, [refresh]);
  return <HostContext value={{ ...data, refresh }}>{children}</HostContext>;
}

export function useHost() {
  const context = useContext(HostContext);
  if (!context) throw new Error("useHost requires HostProvider");
  return context;
}
