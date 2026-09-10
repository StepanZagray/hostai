import { readChatStream } from "./api";
import { prepareChatRequest, type ConversationTurn } from "./conversation";
import { retryAfter } from "./retry-after";

export interface OwnerConversation {
  turns: ConversationTurn[];
  prompt: string;
  temperature: number;
  maxTokens: number;
  busy: boolean;
  error: string;
  notice: string;
  focusRevision: number;
}

export const emptyOwnerConversation = (): OwnerConversation => ({
  turns: [],
  prompt: "",
  temperature: 0.7,
  maxTokens: 512,
  busy: false,
  error: "",
  notice: "",
  focusRevision: 0,
});

/** One owner workspace in one tab. Nothing is stored on disk or sent on selection. */
export function createOwnerConversations(fetchChat: typeof fetch = (...args) => fetch(...args)) {
  let snapshot = {
    selectedModel: "",
    conversations: new Map<string, OwnerConversation>(),
    retryAt: null as number | null,
  };
  const listeners = new Set<() => void>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  function setRetry(deadline: number | null) {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    snapshot = { ...snapshot, retryAt: deadline };
    for (const listener of listeners) listener();
    if (deadline === null) return;
    const release = () => {
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        retryTimer = setTimeout(release, remaining);
        return;
      }
      retryTimer = null;
      // Announce availability once; expiry never sends a request.
      snapshot = { ...snapshot, retryAt: 0 };
      for (const listener of listeners) listener();
    };
    retryTimer = setTimeout(release, Math.max(0, deadline - performance.now()));
  }
  let active: { model: string; turn: ConversationTurn; controller: AbortController } | null = null;
  const publish = (model: string, update: Partial<OwnerConversation>) => {
    snapshot = {
      ...snapshot,
      conversations: new Map(snapshot.conversations).set(model, {
        ...(snapshot.conversations.get(model) ?? emptyOwnerConversation()),
        ...update,
      }),
    };
    for (const listener of listeners) listener();
  };
  const updateTurn = (model: string, id: string, update: Partial<ConversationTurn>) => {
    publish(model, {
      turns: snapshot.conversations
        .get(model)!
        .turns.map((turn) => (turn.id === id ? { ...turn, ...update } : turn)),
    });
  };
  function stop(model: string, reason = "Generation stopped.") {
    const run = active;
    if (!run || run.model !== model) return;
    active = null;
    run.controller.abort();
    const conversation = snapshot.conversations.get(model)!;
    const turn = conversation.turns.find((item) => item.id === run.turn.id)!;
    if (turn.state !== "completed") updateTurn(model, turn.id, { state: "cancelled" });
    publish(model, {
      busy: false,
      ...(!turn.response.trim() || turn.state !== "completed"
        ? {
            prompt: conversation.prompt || turn.prompt,
            notice: `${reason} Your prompt is restored; edit and send manually to retry.`,
            focusRevision: conversation.focusRevision + 1,
          }
        : {}),
    });
  }
  function select(model: string) {
    if (!model || model === snapshot.selectedModel) return;
    if (active) stop(active.model, "Changing models stopped generation.");
    const previous = snapshot.conversations.get(snapshot.selectedModel);
    const defaults = emptyOwnerConversation();
    const retained = new Map(snapshot.conversations);
    if (
      previous &&
      !previous.turns.length &&
      !previous.prompt &&
      !previous.error &&
      !previous.notice &&
      previous.temperature === defaults.temperature &&
      previous.maxTokens === defaults.maxTokens
    )
      retained.delete(snapshot.selectedModel);
    snapshot = { ...snapshot, selectedModel: model, conversations: retained };
    publish(model, {});
  }
  function edit(
    model: string,
    update: Partial<Pick<OwnerConversation, "prompt" | "temperature" | "maxTokens">>,
  ) {
    if (!model || model !== snapshot.selectedModel || snapshot.conversations.get(model)?.busy)
      return;
    publish(model, update);
  }
  function clear(model: string) {
    if (!model || model !== snapshot.selectedModel || snapshot.conversations.get(model)?.busy)
      return;
    publish(model, { turns: [], error: "", notice: "" });
  }
  async function send(model: string, ready: boolean, onSettled: () => void) {
    if (!ready || active || snapshot.selectedModel !== model) return;
    if (snapshot.retryAt !== null && performance.now() < snapshot.retryAt) return;
    const conversation = snapshot.conversations.get(model);
    if (!conversation) return;
    const draft = prepareChatRequest(
      conversation.turns,
      model,
      conversation.prompt.trim(),
      conversation,
    );
    if (draft.error !== null) return;
    const turn: ConversationTurn = {
      id: crypto.randomUUID(),
      model,
      prompt: conversation.prompt.trim(),
      response: "",
      state: "streaming",
      omittedTurns: draft.omittedTurns,
    };
    const run = { model, turn, controller: new AbortController() };
    active = run;
    if (snapshot.retryAt !== null) setRetry(null);
    publish(model, {
      turns: [...conversation.turns, turn],
      prompt: "",
      busy: true,
      error: "",
      notice: "",
    });
    let answer = "";
    const restore = (notice: string) => {
      const current = snapshot.conversations.get(model)!;
      publish(model, {
        prompt: current.prompt || turn.prompt,
        notice,
        focusRevision: current.focusRevision + 1,
      });
    };
    try {
      const response = await fetchChat("/api/chat", {
        method: "POST",
        signal: run.controller.signal,
        headers: { "Content-Type": "application/json" },
        body: draft.body,
      });
      if (active !== run) {
        await response.body?.cancel();
        return;
      }
      if (response.status === 429 || response.status === 503) {
        const deadline = retryAfter(response);
        if (deadline > 0) setRetry(deadline);
      }
      await readChatStream(response, (chunk) => {
        if (active !== run) return;
        answer += chunk.content;
        updateTurn(model, turn.id, {
          response: answer,
          state: chunk.done ? "completed" : "streaming",
        });
        if (chunk.done && chunk.outputTokens !== undefined)
          publish(model, { notice: `${chunk.outputTokens} output tokens · Generated locally` });
      });
      if (active === run && !answer.trim())
        restore(
          "The model returned no text. Your prompt is restored; edit and send manually to retry.",
        );
    } catch (cause) {
      if (active !== run) return;
      updateTurn(model, turn.id, { response: answer, state: "failed" });
      restore(
        "Your prompt is restored. Edit it and send manually to retry; the unfinished exchange is excluded from context.",
      );
      publish(model, {
        error: cause instanceof Error ? cause.message : "Generation failed. Please try again.",
      });
    } finally {
      if (active === run) {
        active = null;
        publish(model, { busy: false });
      }
      onSettled();
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select,
    edit,
    clear,
    send,
    stop,
    close: () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      if (active) stop(active.model);
    },
  };
}

export type OwnerConversations = ReturnType<typeof createOwnerConversations>;
