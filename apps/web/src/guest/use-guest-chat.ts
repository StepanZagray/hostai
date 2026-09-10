import { useCallback, useEffect, useRef, useState } from "react";
import { readChatStream } from "../lib/api";
import { prepareChatRequest, type ConversationTurn } from "../lib/conversation";
import { guestSocket } from "./socket";
import {
  guestFetch,
  parseSession,
  responseProblem,
  retryAfter,
  takeInvite,
  validKeyLength,
  type GuestSession,
} from "./session";

type Phase = "disconnected" | "checking" | "ready" | "blocked" | "needs-key";
type ActiveChat = { controller: AbortController; turn: ConversationTurn };

export function useGuestChat() {
  const key = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>(() => {
    key.current = takeInvite();
    return key.current !== null ? "checking" : "disconnected";
  });
  const [session, setSession] = useState<GuestSession | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const metadata = useRef<AbortController | null>(null);
  const active = useRef<ActiveChat | null>(null);
  const sequence = useRef(0);
  const retrySeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const expired = !!session && Date.parse(session.expiresAt) <= now;
  const ready = phase === "ready" && !!session?.available && !expired && retrySeconds === 0;

  function abortAll() {
    metadata.current?.abort();
    metadata.current = null;
    active.current?.controller.abort();
    active.current = null;
    setBusy(false);
  }

  const stop = useCallback(
    (message = "Generation stopped. The unfinished exchange is excluded from later context.") => {
      const current = active.current;
      if (!current) return;
      active.current = null;
      current.controller.abort();
      setBusy(false);
      setTurns((items) =>
        items.map((item) => (item.id === current.turn.id ? { ...item, state: "cancelled" } : item)),
      );
      setDraft((value) => value || current.turn.prompt);
      setNotice(`${message} Edit the draft and send manually to try again.`);
    },
    [],
  );

  const pauseAccess = useCallback(
    (message: string) => {
      metadata.current?.abort();
      metadata.current = null;
      stop("Guest access is paused. The unfinished exchange is excluded from later context.");
      setPhase("blocked");
      setError(message);
    },
    [stop],
  );

  function disconnect() {
    abortAll();
    key.current = null;
    setSession(null);
    setTurns([]);
    setDraft("");
    setError("");
    setNotice("");
    setRetryAt(0);
    setPhase("disconnected");
  }

  function rejectResponse(response: Response) {
    setPhase(response.status === 401 ? "needs-key" : "blocked");
    setError(responseProblem(response.status));
    setRetryAt(response.status === 429 ? retryAfter(response) : 0);
    setNow(Date.now());
  }

  async function connect(candidate: string) {
    candidate = candidate.trim();
    // Validate length only; the listener owns token syntax and validity.
    if (!validKeyLength(candidate)) {
      setError("Enter an access key of 1–256 characters.");
      if (phase === "checking") setPhase("needs-key");
      return;
    }
    if (candidate === key.current && retryAt > Date.now()) return;
    const differentKey = candidate !== key.current;
    if (differentKey) {
      abortAll();
      setTurns([]);
      setDraft("");
      setSession(null);
      setNotice("");
      setRetryAt(0);
    } else {
      stop();
      metadata.current?.abort();
    }
    key.current = candidate;
    setPhase("checking");
    setError("");
    const controller = new AbortController();
    metadata.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await guestFetch("/guest/v1/session", candidate, {
        signal: controller.signal,
      });
      if (metadata.current !== controller) return;
      if (!response.ok) {
        rejectResponse(response);
        return;
      }
      const next = parseSession(await response.json());
      if (metadata.current !== controller) return;
      if (!next) throw new Error("Invalid guest metadata");
      setSession(next);
      setNow(Date.now());
      setRetryAt(0);
      if (Date.parse(next.expiresAt) <= Date.now()) {
        setPhase("needs-key");
        setError(responseProblem(401));
      } else if (!next.available) {
        setPhase("blocked");
        setError("This host is not accepting guest messages. Reconnect to check availability.");
      } else {
        setPhase("ready");
      }
    } catch {
      if (metadata.current !== controller) return;
      setPhase("blocked");
      setError(
        "Could not check guest access. Your conversation and draft are retained. Reconnect to try again.",
      );
    } finally {
      window.clearTimeout(timeout);
      if (metadata.current === controller) metadata.current = null;
    }
  }

  async function send() {
    if (!ready || !session || !key.current || active.current || metadata.current) return;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      setPhase("needs-key");
      setError(responseProblem(401));
      return;
    }
    // Exclude the entire unfinished exchange, including its user prompt. Retrying
    // the restored draft therefore cannot duplicate it in the request context.
    const prepared = prepareChatRequest(
      turns.filter((turn) => turn.state === "completed"),
      session.model,
      draft,
      { temperature: 0.7, maxTokens: 512 },
    );
    if (prepared.error !== null) {
      setError(prepared.error);
      return;
    }
    const turn: ConversationTurn = {
      id: `guest-turn-${++sequence.current}`,
      model: session.model,
      prompt: draft,
      response: "",
      state: "streaming",
      omittedTurns: prepared.omittedTurns,
    };
    const current: ActiveChat = { controller: new AbortController(), turn };
    active.current = current;
    setTurns((items) => [...items, turn]);
    setDraft("");
    setError("");
    setNotice("");
    setBusy(true);
    let answer = "";
    const update = (state: ConversationTurn["state"]) => {
      setTurns((items) =>
        items.map((item) => (item.id === turn.id ? { ...item, response: answer, state } : item)),
      );
    };
    try {
      const response =
        session.scope === "temporary-internet"
          ? await guestSocket(key.current, prepared.body, current.controller.signal)
          : await guestFetch("/guest/v1/chat", key.current, {
              method: "POST",
              signal: current.controller.signal,
              body: prepared.body,
            });
      if (active.current !== current) return;
      if (!response.ok) {
        rejectResponse(response);
        update("failed");
        setDraft((value) => value || turn.prompt);
        setNotice(
          "The unfinished exchange is excluded from later context. Edit the draft and send manually after reconnecting.",
        );
        return;
      }
      await readChatStream(response, (chunk) => {
        if (active.current !== current) return;
        answer += chunk.content;
        update(chunk.done ? "completed" : "streaming");
      });
      if (active.current === current) {
        if (answer.trim()) setNotice("Response complete.");
        else {
          update("failed");
          setDraft((value) => value || turn.prompt);
          setNotice(
            "The host returned no answer. The unfinished exchange is excluded from later context. Edit the draft and send manually to try again, or copy the question above.",
          );
        }
      }
    } catch {
      if (active.current !== current || current.controller.signal.aborted) return;
      update("failed");
      setDraft((value) => value || turn.prompt);
      setPhase("blocked");
      setError(
        "The response ended before completion. Access may have ended or the host may be unavailable. Reconnect to check access.",
      );
      setNotice(
        "The unfinished exchange is excluded from later context. Edit the draft and send manually to try again.",
      );
    } finally {
      if (active.current === current) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    if (key.current !== null) void connect(key.current);
    return () => {
      metadata.current?.abort();
      metadata.current = null;
      active.current?.controller.abort();
      active.current = null;
      key.current = null;
    };
    // Only the captured startup invite triggers an automatic handshake.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session && !retryAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [session, retryAt]);

  useEffect(() => {
    if (!expired || phase !== "ready") return;
    stop("Guest access expired. The response is incomplete.");
    setPhase("needs-key");
    setError(responseProblem(401));
    // Expiry must also terminate a response already in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired, phase]);

  return {
    phase,
    session,
    turns,
    draft,
    setDraft,
    error,
    notice,
    busy,
    ready,
    retrySeconds,
    hasKey: key.current !== null,
    connect,
    disconnect,
    stop,
    pauseAccess,
    send,
    reconnect: () => {
      if (key.current !== null) void connect(key.current);
    },
  };
}
