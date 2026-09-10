import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useHost } from "./host-context";
import { useModelDownloads } from "./use-model-downloads";

const Context = createContext<ReturnType<typeof useModelDownloads> | null>(null);

/** One owner-tab session. Opening Models activates checks; navigation does not cancel work. */
export function ModelDownloadProvider({ children }: { children: ReactNode }) {
  const { refresh } = useHost();
  const session = useModelDownloads(refresh);
  return <Context value={session}>{children}</Context>;
}

export function useModelDownloadSession() {
  const session = useContext(Context);
  if (!session) throw new Error("Download sessions require their owner workspace provider.");
  const { activate } = session;
  useEffect(() => activate(), [activate]);
  return session;
}
