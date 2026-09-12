import { useCallback, useEffect, useRef, useState } from "react";
import { readChatStream } from "../lib/api";
import { modelInterface } from "../lib/model-admission";
import { prepareChatRequest, type ConversationTurn } from "../lib/conversation";
import { guestInfer } from "./infer";
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
  // A failed replacement keeps the conversation owned by its original key,
  // while reconnect retries the most recently attempted key above.
  const sessionKey = useRef<string | null>(null);
  const availableSession = useRef<GuestSession | null>(null);
  const [phase, setPhase] = useState<Phase>(() => {
    key.current = takeInvite();
    return key.current !== null ? "checking" : "disconnected";
  });
  const [session, setSession] = useState<GuestSession | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unsentAttempt, setUnsentAttempt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(() => performance.now());
  const metadata = useRef<AbortController | null>(null);
  const active = useRef<ActiveChat | null>(null);
  const sequence = useRef(0);
  const retrySeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const ready =
    phase === "ready" &&
    !!session?.available &&
    modelInterface(session) !== "unsupported" &&
    retrySeconds === 0;

  function abortAll() {
    availableSession.current = null;
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
      availableSession.current = null;
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
    sessionKey.current = null;
    setSession(null);
    setTurns([]);
    setDraft("");
    setError("");
    setNotice("");
    setUnsentAttempt(false);
    setRetryAt(0);
    setPhase("disconnected");
  }

  function rejectResponse(response: Response) {
    availableSession.current = null;
    setPhase(response.status === 401 ? "needs-key" : "blocked");
    setError(responseProblem(response.status));
    setRetryAt(response.status === 429 ? retryAfter(response) : 0);
    setNow(performance.now());
  }

  async function connect(candidate: string) {
    candidate = candidate.trim();
    // Validate length only; the listener owns token syntax and validity.
    if (!validKeyLength(candidate)) {
      setError("Enter an access key of 1–256 characters.");
      if (phase === "checking") setPhase("needs-key");
      return;
    }
    if (candidate === key.current && retryAt > performance.now()) {
      setError("Wait for the reconnect delay to finish before using this key again.");
      return;
    }
    availableSession.current = null;
    stop();
    metadata.current?.abort();
    if (candidate !== key.current) setRetryAt(0);
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
      if (next.available || sessionKey.current === null || sessionKey.current === candidate) {
        if (sessionKey.current !== null && sessionKey.current !== candidate) {
          setTurns([]);
          setDraft("");
          setNotice("");
          setUnsentAttempt(false);
        }
        // Initial unavailable metadata still owns an editable draft. Metadata
        // for an unavailable replacement must not relabel the old conversation.
        sessionKey.current = candidate;
        setSession(next);
      }
      setNow(performance.now());
      setRetryAt(0);
      // The host authenticated this key. Its expiry instant cannot be compared
      // with the guest's wall clock, which may be wrong or change mid-answer.
      if (!next.available) {
        setPhase("blocked");
        setError("This host is not accepting guest messages. Reconnect to check availability.");
      } else {
        availableSession.current = next;
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
    // A response is already in progress; its live status explains why another
    // draft is not submitted. Do not replace that status or enqueue a send.
    if (active.current) return;
    // Matching the available metadata also blocks a stale render from sending
    // retained history before React commits a successful replacement's reset.
    if (
      !ready ||
      !session ||
      modelInterface(session) !== "chat" ||
      !key.current ||
      key.current !== sessionKey.current ||
      availableSession.current !== session ||
      metadata.current
    ) {
      if (draft.trim()) setUnsentAttempt(true);
      return;
    }
    setUnsentAttempt(false);
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
      availableSession.current = null;
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

  /**
   * One model-UI inference for the connected session. The key stays inside this hook:
   * the frame host only receives the Response. Access failures update the access panel
   * the same way a rejected chat does; per-request outcomes (400, 429) stay in the frame.
   */
  async function infer(input: unknown, signal: AbortSignal): Promise<Response> {
    if (
      !session ||
      !key.current ||
      key.current !== sessionKey.current ||
      availableSession.current !== session ||
      metadata.current
    )
      throw new Error("Guest access is not connected. Reconnect to use this interface.");
    const response = await guestInfer(key.current, session, input, signal);
    if ([401, 403, 503].includes(response.status) && availableSession.current === session)
      rejectResponse(response);
    return response;
  }

  useEffect(() => {
    if (key.current !== null) void connect(key.current);
    return () => {
      availableSession.current = null;
      metadata.current?.abort();
      metadata.current = null;
      active.current?.controller.abort();
      active.current = null;
      key.current = null;
      sessionKey.current = null;
    };
    // Only the captured startup invite triggers an automatic handshake.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => {
      const current = performance.now();
      setNow(current);
      if (current >= retryAt) setRetryAt(0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  return {
    phase,
    session,
    turns,
    draft,
    setDraft,
    error,
    notice: unsentAttempt
      ? phase === "checking"
        ? "Message not sent. Access is being checked. Your draft is kept; send it after the check finishes."
        : retrySeconds > 0
          ? "Message not sent. Wait for the reconnect delay, then reconnect and send your draft manually."
          : ready
            ? "Message not sent. Access is available again. Review your draft and send it when ready."
            : "Message not sent. Reconnect with usable access before sending your draft. Nothing will be sent automatically."
      : notice,
    busy,
    ready,
    retrySeconds,
    hasKey: key.current !== null,
    replacingKey: sessionKey.current !== null && key.current !== sessionKey.current,
    connect,
    disconnect,
    stop,
    pauseAccess,
    send,
    infer,
    reconnect: () => {
      if (key.current !== null) void connect(key.current);
    },
  };
}
