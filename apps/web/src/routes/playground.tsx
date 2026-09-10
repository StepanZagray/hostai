import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowDown,
  ArrowUp,
  Bot,
  Code2,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
  User,
} from "lucide-react";
import { css } from "../../styled-system/css";
import {
  Badge,
  Button,
  CodeBlock,
  CopyButton,
  PageHeading,
  button,
  muted,
  panel,
} from "../components/ui";
import { useHost } from "../lib/host-context";
import { useOwnerConversations } from "../lib/owner-conversations-context";
import { emptyOwnerConversation } from "../lib/owner-conversations";
import { chatUnavailableReason } from "../lib/model-admission";
import { hasCompletedModelAnswer, prepareChatRequest } from "../lib/conversation";
import { Answer } from "../components/answer";
import { useConversationScroll } from "../lib/use-conversation-scroll";

export const Route = createFileRoute("/playground")({
  validateSearch: (search: Record<string, unknown>): { model?: string } => ({
    model: typeof search.model === "string" ? search.model : undefined,
  }),
  component: Playground,
});
function Playground() {
  const { model: requestedModel } = Route.useSearch();
  const { models, status, refresh } = useHost();
  const navigate = Route.useNavigate();
  const { conversations, snapshot } = useOwnerConversations();
  const [, tickRetry] = useState(0);
  const retrySeconds = Math.max(0, Math.ceil(((snapshot.retryAt ?? 0) - performance.now()) / 1000));
  useEffect(() => {
    if (!snapshot.retryAt) return;
    const timer = setInterval(() => tickRetry((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [snapshot.retryAt]);
  const defaultModel = models.find((item) => chatUnavailableReason(item) === null) ?? models[0];
  const model = requestedModel || snapshot.selectedModel || (defaultModel?.name ?? "");
  const conversation = snapshot.conversations.get(model) ?? emptyOwnerConversation();
  const selectedModel = models.find((item) => item.name === model);
  const modelAvailable = !!selectedModel;
  const modelError = selectedModel ? chatUnavailableReason(selectedModel) : null;
  const modelBlocked = !!status?.ollamaConnected && modelError !== null;
  const modelMissing = !!status?.ollamaConnected && !!model && !modelAvailable;
  const { turns, prompt, temperature, maxTokens, busy, error, notice, focusRevision } =
    conversation;
  const messages = turns.flatMap((turn) => [
    { role: "user", content: turn.prompt, turn },
    { role: "assistant", content: turn.response, turn },
  ]);
  const setPrompt = (prompt: string) => conversations.edit(model, { prompt });
  const setTemperature = (temperature: number) => conversations.edit(model, { temperature });
  const setMaxTokens = (maxTokens: number) => conversations.edit(model, { maxTokens });
  const [showApi, setShowApi] = useState(false);
  const draft = useMemo(
    () => prepareChatRequest(turns, model, prompt.trim(), { temperature, maxTokens }),
    [turns, model, prompt, temperature, maxTokens],
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const lastFocus = useRef({ model, revision: focusRevision });
  useEffect(() => {
    if (lastFocus.current.model !== model) {
      lastFocus.current = { model, revision: focusRevision };
      return;
    }
    if (!busy && focusRevision !== lastFocus.current.revision) {
      lastFocus.current.revision = focusRevision;
      composer.current?.focus({ preventScroll: true });
    }
  }, [busy, focusRevision, model]);
  const scroll = useConversationScroll(turns);
  // Bind the visible controls before paint so the first edit cannot target an unselected model.
  useLayoutEffect(() => {
    conversations.select(model);
    return () => conversations.stop(model, "Leaving this conversation stopped generation.");
  }, [conversations, model]);
  const ready = !!status?.ollamaConnected && modelAvailable && modelError === null;
  const responded = hasCompletedModelAnswer(turns, model);
  const send = () =>
    conversations.send(model, ready, () => {
      void refresh();
    });
  return (
    <>
      <PageHeading
        title="Playground"
        description="A direct line to your local models. Try something out."
        action={
          <Button onClick={() => setShowApi((v) => !v)} aria-expanded={showApi}>
            <Code2 />
            {showApi ? "Hide API example" : "API example"}
          </Button>
        }
      />
      {showApi && (
        <section className={`${panel} ${css({ p: "5", mb: "5" })}`}>
          <h2 className={css({ fontWeight: 700, mb: "3" })}>Call your local gateway</h2>
          {!modelAvailable || modelError !== null ? (
            <p className={muted}>Select a model available to try to see its API example.</p>
          ) : (
            <CodeBlock
              code={`curl -N http://127.0.0.1:8080/api/chat \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ model: model || "your-model-name", messages: [{ role: "user", content: "Hello!" }], temperature, maxTokens })}'`}
            />
          )}
          <p className={`${muted} ${css({ mt: "3" })}`}>
            Returns newline-delimited JSON. This local development endpoint does not require an API
            key.
          </p>
        </section>
      )}
      <div
        className={css({
          display: "grid",
          gridTemplateColumns: { base: "1fr", xl: "minmax(0, 1fr) 260px" },
          gap: "5",
          alignItems: "start",
        })}
      >
        <section
          className={`${panel} ${css({ display: "flex", flexDirection: "column", minH: "570px" })}`}
        >
          <div
            className={css({
              borderBottom: "1px solid token(colors.line)",
              px: "5",
              py: "3",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "3",
            })}
          >
            <div className={css({ display: "flex", gap: "2", alignItems: "center" })}>
              <Terminal size={17} />
              <h2 className={css({ fontSize: "sm", fontWeight: 700 })}>Conversation</h2>
            </div>
            <Button
              variant="ghost"
              disabled={busy || !messages.length}
              onClick={() => conversations.clear(model)}
            >
              <Trash2 />
              Clear
            </Button>
          </div>
          <div className={css({ position: "relative", flex: 1, minH: 0 })}>
            <div
              key={scroll.viewportKey}
              ref={scroll.viewportRef}
              onScroll={scroll.onScroll}
              onWheel={scroll.onWheel}
              onKeyDown={scroll.onKeyDown}
              onTouchStart={scroll.onTouchStart}
              onTouchMove={scroll.onTouchMove}
              role="region"
              tabIndex={0}
              className={css({
                maxH: "570px",
                minH: "350px",
                overflowY: "auto",
                overscrollBehaviorY: "contain",
                p: "5",
                _focusVisible: { outline: "2px solid token(colors.accent)", outlineOffset: "-2px" },
              })}
              aria-label="Conversation messages"
            >
              <div ref={scroll.contentRef}>
                {!messages.length ? (
                  <div
                    className={css({
                      minH: "315px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      textAlign: "center",
                      gap: "3",
                    })}
                  >
                    <span
                      className={css({
                        p: "4",
                        borderRadius: "15px",
                        bg: "accentSoft",
                        color: "accent",
                        mb: "2",
                      })}
                    >
                      <Bot size={32} strokeWidth={1.5} />
                    </span>
                    <h3
                      className={css({
                        fontSize: "20px",
                        fontWeight: 750,
                        letterSpacing: "-0.03em",
                      })}
                    >
                      What’s on your mind?
                    </h3>
                    <p className={`${muted} ${css({ maxW: "330px" })}`}>
                      {ready
                        ? "Ask a question, work through an idea, or put your model to the test."
                        : modelBlocked
                          ? "Choose another model to start a conversation. The selected model is unavailable for chat."
                          : modelMissing
                            ? "This model is no longer in your library. Your draft is kept for it; restore the model or choose another one."
                            : "Connect Ollama and install a model to start a conversation on your machine."}
                    </p>
                    {ready ? (
                      <div
                        className={css({
                          display: "flex",
                          gap: "2",
                          flexWrap: "wrap",
                          justifyContent: "center",
                          mt: "3",
                        })}
                      >
                        {["Explain virtual threads simply", "Write a Java health check"].map(
                          (text) => (
                            <Button key={text} onClick={() => setPrompt(text)}>
                              {text}
                            </Button>
                          ),
                        )}
                      </div>
                    ) : (
                      <Link
                        to={modelBlocked || modelMissing ? "/models" : "/connection"}
                        className={button({ variant: "secondary" })}
                      >
                        {modelBlocked || modelMissing ? "Review model library" : "Set up your host"}
                        <ArrowRight size={14} />
                      </Link>
                    )}
                  </div>
                ) : (
                  messages.map((message) => (
                    <article
                      key={`${message.turn.id}-${message.role}`}
                      className={css({ display: "flex", gap: "3", mb: "6" })}
                    >
                      <span
                        className={css({
                          flexShrink: 0,
                          w: "30px",
                          h: "30px",
                          display: "grid",
                          placeItems: "center",
                          bg: "canvas",
                          border: "1px solid token(colors.line)",
                          borderRadius: "7px",
                          color: "accent",
                        })}
                      >
                        {message.role === "user" ? <User size={16} /> : <Bot size={17} />}
                      </span>
                      <div className={css({ minW: 0 })}>
                        <h3 className={css({ fontWeight: 750, fontSize: "xs", mb: "2" })}>
                          {message.role === "user" ? "You" : message.turn.model}
                        </h3>
                        {message.role === "assistant" && message.content.trim() ? (
                          <Answer text={message.content} />
                        ) : (
                          <p
                            className={css({
                              whiteSpace: "pre-wrap",
                              overflowWrap: "anywhere",
                              fontSize: "sm",
                              lineHeight: 1.9,
                            })}
                          >
                            {message.content.trim()
                              ? message.content
                              : message.turn.state === "streaming"
                                ? "Thinking…"
                                : "No response text returned."}
                          </p>
                        )}
                        {message.role === "assistant" && message.content.trim() && (
                          <div className={css({ mt: "2" })}>
                            <CopyButton
                              text={message.content}
                              disabled={message.turn.state === "streaming"}
                              label={
                                message.turn.state === "failed" ||
                                message.turn.state === "cancelled"
                                  ? "Copy partial response"
                                  : "Copy response"
                              }
                            />
                          </div>
                        )}
                        {message.role === "user" && (message.turn.omittedTurns ?? 0) > 0 && (
                          <p className={css({ mt: "2", fontSize: "xs", color: "muted" })}>
                            Sent with {message.turn.omittedTurns} earlier{" "}
                            {message.turn.omittedTurns === 1 ? "turn" : "turns"} omitted.
                          </p>
                        )}
                        {message.role === "assistant" &&
                          message.turn.state !== "streaming" &&
                          (message.turn.state !== "completed" || !message.content.trim()) && (
                            <p className={css({ mt: "2", fontSize: "xs", color: "muted" })}>
                              {message.turn.state === "cancelled"
                                ? "Stopped response"
                                : message.turn.state === "failed"
                                  ? "Incomplete response"
                                  : "Empty response"}
                              {" · Question and response excluded from later prompts."}
                            </p>
                          )}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </div>
            {!scroll.following && messages.length > 0 && (
              <Button
                onClick={scroll.jumpToLatest}
                className={css({
                  position: "absolute",
                  bottom: "3",
                  left: "50%",
                  transform: "translateX(-50%)",
                  boxShadow: "0 2px 8px #142b3e22",
                })}
              >
                <ArrowDown /> Jump to latest
              </Button>
            )}
          </div>
          <div className={css({ p: "4", pt: 0 })}>
            {modelError && (
              <p role="alert" className={css({ mb: "3", color: "warning", fontSize: "xs" })}>
                {modelError} Choose another model from Run settings.
              </p>
            )}
            {!busy && draft.error === null && draft.omittedTurns > 0 && (
              <p
                role="status"
                className={css({
                  mb: "3",
                  p: "3",
                  borderRadius: "6px",
                  bg: "warningSoft",
                  color: "warning",
                  fontSize: "xs",
                })}
              >
                {draft.omittedTurns} earlier {draft.omittedTurns === 1 ? "turn" : "turns"} will be
                omitted to fit the request limits.{" "}
                {draft.includedTurns === 0
                  ? "Only your new message will be sent. "
                  : "The most recent turns will be sent. "}
                Your full conversation stays visible.
              </p>
            )}
            {!busy && prompt.trim() && draft.error !== null && (
              <p role="alert" className={css({ mb: "3", color: "danger", fontSize: "xs" })}>
                {draft.error}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className={css({
                  mb: "3",
                  p: "3",
                  borderRadius: "6px",
                  bg: "dangerSoft",
                  color: "danger",
                  fontSize: "xs",
                })}
              >
                {error}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              className={css({
                border: "1px solid token(colors.line)",
                bg: "canvas",
                borderRadius: "9px",
                p: "3",
              })}
            >
              <textarea
                ref={composer}
                aria-label="Message"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={!ready || busy}
                placeholder={
                  ready
                    ? "Message your model…"
                    : modelBlocked
                      ? "Choose another model to chat"
                      : "Your model will be ready after setup"
                }
                rows={2}
                className={css({
                  bg: "transparent",
                  w: "full",
                  resize: "vertical",
                  fontSize: "sm",
                  lineHeight: 1.7,
                  minH: "60px",
                  maxH: "180px",
                })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div
                className={css({
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "3",
                })}
              >
                <span className={css({ color: "muted", fontSize: "10px" })}>
                  Enter to send · Shift + Enter for a new line
                </span>
                {busy ? (
                  <Button
                    key="stop"
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      conversations.stop(model);
                    }}
                  >
                    <Square />
                    Stop
                  </Button>
                ) : (
                  <Button
                    key="send"
                    type="submit"
                    variant="primary"
                    disabled={!ready || draft.error !== null || retrySeconds > 0}
                    aria-label="Send message"
                  >
                    <ArrowUp />
                  </Button>
                )}
              </div>
            </form>
            {snapshot.retryAt !== null && (
              <div className={css({ mt: "3", fontSize: "xs", color: "muted" })}>
                <p role="status">
                  {retrySeconds > 0
                    ? "The host asked you to wait before sending again. Your draft is retained."
                    : "The wait is over. Send manually when you are ready; capacity may still be busy."}
                </p>
                {retrySeconds > 0 && (
                  <p aria-live="off">
                    Retry available in {retrySeconds} {retrySeconds === 1 ? "second" : "seconds"}.
                  </p>
                )}
                <p>This wait applies to all models in this workspace tab.</p>
              </div>
            )}
            <p
              role="status"
              className={css({
                fontSize: "10px",
                color: "muted",
                textAlign: "center",
                mt: "3",
                minH: "16px",
              })}
            >
              {notice || "AI can make mistakes. Review generated answers."}
            </p>
          </div>
        </section>
        <aside className={`${panel} ${css({ p: "5" })}`}>
          <h2
            className={css({
              display: "flex",
              gap: "2",
              alignItems: "center",
              fontSize: "sm",
              fontWeight: 750,
              mb: "6",
            })}
          >
            <SlidersHorizontal size={16} />
            Run settings
          </h2>
          <label
            className={css({ display: "block", fontSize: "xs", fontWeight: 650, mb: "2" })}
            htmlFor="model"
          >
            Model
          </label>
          <select
            id="model"
            value={model}
            disabled={!models.length || busy}
            onChange={(e) => {
              void navigate({ search: { model: e.target.value }, replace: true });
            }}
            className={css({
              w: "full",
              minH: "42px",
              px: "2",
              bg: "canvas",
              border: "1px solid token(colors.line)",
              borderRadius: "6px",
              fontSize: "xs",
              mb: "5",
            })}
          >
            {model && !modelAvailable && <option value={model}>{model} (unavailable)</option>}
            {!model && !models.length && <option value="">No models available</option>}
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
                {chatUnavailableReason(m) !== null ? " (unavailable for chat)" : ""}
              </option>
            ))}
          </select>
          <label
            htmlFor="temperature"
            className={css({
              display: "flex",
              justifyContent: "space-between",
              fontSize: "xs",
              fontWeight: 650,
              mb: "3",
            })}
          >
            Temperature<output>{temperature.toFixed(1)}</output>
          </label>
          <input
            id="temperature"
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
            disabled={busy}
            className={css({ w: "full", accentColor: "accent" })}
          />
          <p className={`${muted} ${css({ fontSize: "11px", mt: "2", mb: "5" })}`}>
            Lower for consistency. Higher for more variation.
          </p>
          <label
            htmlFor="maxTokens"
            className={css({ display: "block", fontSize: "xs", fontWeight: 650, mb: "2" })}
          >
            Maximum output tokens
          </label>
          <select
            id="maxTokens"
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value))}
            disabled={busy}
            className={css({
              w: "full",
              minH: "42px",
              px: "3",
              bg: "canvas",
              border: "1px solid token(colors.line)",
              borderRadius: "6px",
              fontSize: "xs",
            })}
          >
            {[128, 256, 512, 1024, 2048].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <div className={css({ borderTop: "1px solid token(colors.line)", pt: "5", mt: "6" })}>
            <Badge tone={ready ? "good" : "warning"}>
              {ready
                ? busy
                  ? "Trying this model…"
                  : responded
                    ? "Model answered a prompt"
                    : "Available to try"
                : modelBlocked
                  ? "Selected model cannot chat"
                  : status?.ollamaConnected && model && !modelAvailable
                    ? "Selected model unavailable"
                    : "Runtime not ready"}
            </Badge>
            {ready && !busy && responded && (
              <div className={css({ mt: "3" })}>
                <p className={`${muted} ${css({ fontSize: "xs", mb: "3" })}`}>
                  This model answered a prompt here. Review its client access settings before
                  sharing.
                </p>
                <Link to="/sharing" search={{ model }} className={button({ variant: "secondary" })}>
                  Set up client access <ArrowRight size={14} />
                </Link>
              </div>
            )}
            <p className={`${muted} ${css({ fontSize: "11px", mt: "3" })}`}>
              {ready &&
                !responded &&
                "Installed does not mean tested. Send a prompt to try this model. "}
              Each model keeps its own conversation, draft and settings in this tab. Leaving
              Playground stops generation. Reloading or closing the tab clears this work.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
