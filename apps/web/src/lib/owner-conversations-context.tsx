import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createOwnerConversations, type OwnerConversations } from "./owner-conversations";

const Context = createContext<OwnerConversations | null>(null);
export function OwnerConversationsProvider({ children }: { children: ReactNode }) {
  const [conversations] = useState(createOwnerConversations);
  useEffect(() => () => conversations.close(), [conversations]);
  return <Context value={conversations}>{children}</Context>;
}
export function useOwnerConversations() {
  const conversations = useContext(Context);
  if (!conversations) throw new Error("Owner conversations require their workspace provider.");
  const snapshot = useSyncExternalStore(
    conversations.subscribe,
    conversations.getSnapshot,
    conversations.getSnapshot,
  );
  return { conversations, snapshot };
}
