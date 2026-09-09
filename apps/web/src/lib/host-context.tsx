import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { readHostSnapshot, type HostSnapshot } from "./host-refresh";

interface HostData extends HostSnapshot {
  loading: boolean;
  refreshing: boolean;
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
    errors: { status: null, models: null, requests: null },
  });
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setData((d) => ({ ...d, refreshing: true }));
    try {
      const snapshot = await readHostSnapshot(current.signal);
      if (controller.current === current && !current.signal.aborted)
        setData({ ...snapshot, loading: false, refreshing: false });
    } catch (error) {
      // Superseded refreshes and unmounts must never replace the current snapshot.
      if (!current.signal.aborted) throw error;
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
