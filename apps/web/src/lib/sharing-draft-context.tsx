import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface SharingDraft {
  hostLabel: string | null;
  editHostLabel: (value: string | null) => void;
  acknowledgeHostLabel: (submitted: string) => void;
}

const Context = createContext<SharingDraft | null>(null);

/** Owner-tab form intent only. Server status and access credentials stay outside. */
export function SharingDraftProvider({ children }: { children: ReactNode }) {
  const [hostLabel, editHostLabel] = useState<string | null>(null);
  const acknowledgeHostLabel = useCallback((submitted: string) => {
    // A delayed response must not discard a newer edit.
    editHostLabel((current) => (current === submitted ? null : current));
  }, []);
  return <Context value={{ hostLabel, editHostLabel, acknowledgeHostLabel }}>{children}</Context>;
}

export function useSharingDraft() {
  const draft = useContext(Context);
  if (!draft) throw new Error("Sharing drafts require their owner workspace provider.");
  return draft;
}
