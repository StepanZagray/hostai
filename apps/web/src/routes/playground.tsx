import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowDown,
  ArrowUp,
  Code2,
  SlidersHorizontal,
  Square,
  Trash2,
} from "lucide-react";
import { css } from "../../styled-system/css";
import {
  Badge,
  Button,
  CodeBlock,
  CopyButton,
  EmptyState,
  Field,
  Note,
  button,
  caption,
  control,
  muted,
  panel,
} from "../components/ui";
import { useHost } from "../lib/host-context";
import { useOwnerConversations } from "../lib/owner-conversations-context";
import { emptyOwnerConversation } from "../lib/owner-conversations";
import {
  interfaceUnavailableReason,
  modelInterface,
  NO_SUPPORTED_INTERFACE,
} from "../lib/model-admission";
import { hasCompletedModelAnswer, prepareChatRequest } from "../lib/conversation";
import { Answer } from "../components/answer";
import { ModelUiFrame } from "../components/model-ui-frame";
import { modelUiAssetPath } from "../lib/model-ui-host";
import { useConversationScroll } from "../lib/use-conversation-scroll";
import type { Model } from "../lib/api";

export const Route = createFileRoute("/playground")({
  validateSearch: (search: Record<string, unknown>): { model?: string } => ({
    model: typeof search.model === "string" ? search.model : undefined,
  }),
  component: Playground,
});

/** Plain message text: user prompts and the assistant's placeholder lines. */
const messageText = css({
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  fontSize: "sm",
  lineHeight: 1.7,
});

/** A model is worth selecting by default when it can chat or brings its own interface. */
const usable = (model: Model) => interfaceUnavailableReason(model) === null;

/** Owner inference goes through the same-origin proxy; the frame never sees the URL. */
const ownerInfer = (model: string) => (input: unknown, signal: AbortSignal) =>
  fetch("/api/infer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify({ model, input }),
    signal,
  });

const chatLayout = css({
  display: "grid",
  gridTemplateColumns: { base: "1fr", xl: "minmax(0, 1fr) 272px" },
  gap: "5",
  alignItems: "start",
});
const frameLayout = css({ display: "grid", gap: "5", alignItems: "start" });
/** A model's own interface is the page: the shell gives up its gutters for it. */
const fillLayout = css({ display: "flex", flexDirection: "column", flex: 1, minH: 0, minW: 0 });

/** Shared by both surfaces: a column of chrome above one scrolling region. */
const surface = css({
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  minW: 0,
});
/** The chat card: the shell's bar plus the main padding; the panel starts the page. */
const cardSurface = css({ height: "calc(100dvh - 108px)", minH: "480px" });
/** A model's own interface takes the content area the shell frees for `data-fill`. */
const fillSurface = css({ flex: 1, minH: 0 });
/** Chrome inset: a card keeps its own rhythm, a filled page follows the shell's bar. */
const cardChrome = css({ px: "3" });
const fillChrome = css({ px: { base: "3", lg: "6" } });

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
  const defaultModel = models.find(usable) ?? models[0];
  const model = requestedModel || snapshot.selectedModel || (defaultModel?.name ?? "");
  const conversation = snapshot.conversations.get(model) ?? emptyOwnerConversation();
  const selectedModel = models.find((item) => item.name === model);
  const modelAvailable = !!selectedModel;
  const presentation = selectedModel ? modelInterface(selectedModel) : "chat";
  const unsupported = presentation === "unsupported";
  const modelUi = presentation === "custom" ? (selectedModel?.ui ?? null) : null;
  const modelError = selectedModel ? interfaceUnavailableReason(selectedModel) : null;
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
  const modelSelect = (
    <select
      id="model"
      aria-label="Model"
      value={model}
      disabled={!models.length || busy}
      onChange={(e) => {
        void navigate({ search: { model: e.target.value }, replace: true });
      }}
      className={`${control} ${css({ fontFamily: "mono", fontSize: "xs", minH: "34px", maxW: "340px" })}`}
    >
      {model && !modelAvailable && <option value={model}>{model} (unavailable)</option>}
      {!model && !models.length && <option value="">No models available</option>}
      {models.map((m) => (
        <option key={m.name} value={m.name}>
          {m.name}
          {interfaceUnavailableReason(m) !== null ? " (unavailable)" : ""}
        </option>
      ))}
    </select>
  );
  const apiExample = showApi && (
    <div
      className={`${css({
        borderBottom: "1px solid token(colors.line)",
        bg: "well",
        py: "3",
        display: "grid",
        gap: "2",
        minW: 0,
      })} ${modelUi ? fillChrome : cardChrome}`}
    >
      {!modelAvailable || modelError !== null ? (
        <p className={muted}>Select a model available to try to see its API example.</p>
      ) : modelUi ? (
        <CodeBlock
          code={`curl -N http://127.0.0.1:8080/api/infer \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ model, input: {} })}'`}
        />
      ) : (
        <CodeBlock
          code={`curl -N http://127.0.0.1:8080/api/chat \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ model: model || "your-model-name", messages: [{ role: "user", content: "Hello!" }], temperature, maxTokens })}'`}
        />
      )}
      <p className={caption}>Returns newline-delimited JSON. No API key on localhost.</p>
    </div>
  );
  return (
    <>
      <div className={modelUi ? fillLayout : unsupported ? frameLayout : chatLayout}>
        {/* The page has no heading of its own, so the surface carries the name. */}
        <section
          aria-label="Playground"
          // The shell drops the page gutters around a model's own interface, so the
          // frame gets the whole content area instead of sitting inside a card.
          data-fill={modelUi ? true : undefined}
          className={`${modelUi ? fillSurface : `${panel} ${cardSurface}`} ${surface}`}
        >
          <div
            className={`${css({
              borderBottom: "1px solid token(colors.line)",
              py: "2",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "2",
              flexWrap: "wrap",
            })} ${modelUi ? fillChrome : cardChrome}`}
          >
            <div
              className={css({
                display: "flex",
                gap: "2",
                alignItems: "center",
                minW: 0,
                flex: "1 1 200px",
              })}
            >
              {modelSelect}
            </div>
            <div className={css({ display: "flex", gap: "2", alignItems: "center", minW: 0 })}>
              <Badge tone={ready ? (busy && !modelUi ? "busy" : "good") : "warning"}>
                {modelUi
                  ? ready
                    ? "Interface ready"
                    : "Runtime not ready"
                  : ready
                    ? busy
                      ? "Generating"
                      : responded
                        ? "Model answered a prompt"
                        : "Available to try"
                    : unsupported
                      ? "No supported interface"
                      : modelBlocked
                        ? "Selected model cannot chat"
                        : status?.ollamaConnected && model && !modelAvailable
                          ? "Selected model unavailable"
                          : "Runtime not ready"}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowApi((v) => !v)}
                aria-expanded={showApi}
              >
                <Code2 />
                {showApi ? "Hide API example" : "API example"}
              </Button>
              {!modelUi && !unsupported && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !messages.length}
                  onClick={() => conversations.clear(model)}
                >
                  <Trash2 />
                  Clear
                </Button>
              )}
            </div>
          </div>
          {apiExample}
          {modelUi ? (
            <ModelUiFrame
              key={model}
              model={model}
              runtime={modelUi.runtime}
              src={modelUiAssetPath("/api/model-ui", modelUi)}
              scope="owner"
              infer={ownerInfer(model)}
              title={`${model} interface`}
            />
          ) : unsupported ? (
            <EmptyState title="No supported interface" description={NO_SUPPORTED_INTERFACE} />
          ) : (
            <>
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
                    position: "absolute",
                    inset: 0,
                    minW: 0,
                    overflowY: "auto",
                    overflowX: "hidden",
                    overscrollBehaviorY: "contain",
                    px: { base: "3", sm: "5" },
                    py: "4",
                    _focusVisible: {
                      outline: "2px solid token(colors.ink)",
                      outlineOffset: "-2px",
                    },
                  })}
                  aria-label="Conversation messages"
                >
                  <div ref={scroll.contentRef}>
                    {!messages.length ? (
                      <div
                        className={css({ minH: "260px", display: "grid", placeItems: "center" })}
                      >
                        <EmptyState
                          title="No messages yet"
                          description={
                            ready
                              ? "Everything you send stays on this machine."
                              : modelBlocked
                                ? "This model cannot chat. Pick another one above."
                                : modelMissing
                                  ? "This model is no longer in your library. Its draft is kept — reinstall it or pick another."
                                  : "Connect Ollama and install a model to start."
                          }
                          action={
                            ready ? (
                              <div
                                className={css({
                                  display: "flex",
                                  gap: "2",
                                  flexWrap: "wrap",
                                  justifyContent: "center",
                                })}
                              >
                                {[
                                  "Explain virtual threads simply",
                                  "Write a Java health check",
                                ].map((text) => (
                                  <Button size="sm" key={text} onClick={() => setPrompt(text)}>
                                    {text}
                                  </Button>
                                ))}
                              </div>
                            ) : (
                              <Link
                                to={modelBlocked || modelMissing ? "/models" : "/connection"}
                                className={button()}
                              >
                                {modelBlocked || modelMissing
                                  ? "Review model library"
                                  : "Set up your host"}
                                <ArrowRight size={14} />
                              </Link>
                            )
                          }
                        />
                      </div>
                    ) : (
                      messages.map((message) => (
                        <article
                          key={`${message.turn.id}-${message.role}`}
                          data-role={message.role}
                          className={css({
                            minW: 0,
                            mb: "5",
                            "&:last-child": { mb: 0 },
                            "& > h3": {
                              fontFamily: "mono",
                              fontSize: "2xs",
                              fontWeight: 500,
                              lineHeight: 1.4,
                              letterSpacing: "0.01em",
                              color: "muted",
                              mb: "1.5",
                              overflowWrap: "anywhere",
                            },
                            "&[data-role=user]": {
                              bg: "well",
                              borderLeft: "2px solid token(colors.lineStrong)",
                              borderRadius: "sm",
                              px: "3",
                              py: "2.5",
                            },
                            "&[data-role=user] > h3": {
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                            },
                          })}
                        >
                          <h3>{message.role === "user" ? "You" : message.turn.model}</h3>
                          <div className={css({ minW: 0 })}>
                            {message.role === "assistant" && message.content.trim() ? (
                              <Answer text={message.content} />
                            ) : (
                              <p
                                className={`${messageText} ${
                                  message.role === "assistant" ? css({ color: "muted" }) : ""
                                }`}
                              >
                                {message.content.trim()
                                  ? message.content
                                  : message.turn.state === "streaming"
                                    ? "Thinking…"
                                    : "No response text returned."}
                              </p>
                            )}
                            {message.role === "assistant" && message.content.trim() && (
                              <div className={css({ mt: "1.5", ml: "-2.5" })}>
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
                              <p className={`${caption} ${css({ mt: "1.5" })}`}>
                                Sent with {message.turn.omittedTurns} earlier{" "}
                                {message.turn.omittedTurns === 1 ? "turn" : "turns"} omitted.
                              </p>
                            )}
                            {message.role === "assistant" &&
                              message.turn.state !== "streaming" &&
                              (message.turn.state !== "completed" || !message.content.trim()) && (
                                <p className={`${caption} ${css({ mt: "1.5" })}`}>
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
                    size="sm"
                    onClick={scroll.jumpToLatest}
                    className={css({
                      position: "absolute",
                      bottom: "3",
                      left: "50%",
                      transform: "translateX(-50%)",
                      boxShadow: "pop",
                    })}
                  >
                    <ArrowDown /> Jump to latest
                  </Button>
                )}
              </div>
              <div
                className={css({
                  p: "3",
                  borderTop: "1px solid token(colors.line)",
                  display: "grid",
                  gap: "2",
                  minW: 0,
                })}
              >
                {modelError && (
                  <Note role="alert" tone="warning">
                    {modelError} Choose another model above.
                  </Note>
                )}
                {!busy && draft.error === null && draft.omittedTurns > 0 && (
                  <Note role="status" tone="warning">
                    {draft.omittedTurns} earlier {draft.omittedTurns === 1 ? "turn" : "turns"} will
                    be omitted to fit the request limits.{" "}
                    {draft.includedTurns === 0
                      ? "Only your new message will be sent."
                      : "The most recent turns will be sent."}{" "}
                    Your full conversation stays visible.
                  </Note>
                )}
                {!busy && prompt.trim() && draft.error !== null && (
                  <Note role="alert" tone="danger">
                    {draft.error}
                  </Note>
                )}
                {error && (
                  <Note role="alert" tone="danger">
                    {error}
                  </Note>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                  className={css({
                    bg: "panel",
                    border: "1px solid token(colors.line)",
                    borderRadius: "md",
                    minW: 0,
                    transition: "border-color token(durations.fast)",
                    _focusWithin: { borderColor: "lineStrong" },
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
                      display: "block",
                      bg: "transparent",
                      border: "none",
                      w: "full",
                      resize: "vertical",
                      fontSize: "sm",
                      lineHeight: 1.6,
                      color: "ink",
                      minH: "52px",
                      maxH: "180px",
                      px: "3",
                      pt: "2.5",
                      pb: "1",
                      outline: "none",
                      _disabled: { cursor: "not-allowed" },
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
                      pl: "3",
                      pr: "2",
                      pb: "2",
                      pt: "1",
                    })}
                  >
                    <span className={`${caption} ${css({ minW: 0 })}`}>
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
                        className={css({ flexShrink: 0 })}
                      >
                        <ArrowUp />
                      </Button>
                    )}
                  </div>
                </form>
                {snapshot.retryAt !== null && (
                  <div className={`${caption} ${css({ display: "grid", gap: "0.5" })}`}>
                    <p role="status">
                      {retrySeconds > 0
                        ? "The host asked you to wait before sending again. Your draft is retained."
                        : "The wait is over. Send manually when you are ready; capacity may still be busy."}
                    </p>
                    {retrySeconds > 0 && (
                      <p aria-live="off" className={css({ fontVariantNumeric: "tabular-nums" })}>
                        Retry available in {retrySeconds}{" "}
                        {retrySeconds === 1 ? "second" : "seconds"}.
                      </p>
                    )}
                    <p>This wait applies to all models in this workspace tab.</p>
                  </div>
                )}
                <p
                  role="status"
                  className={`${caption} ${css({ textAlign: "center", minH: "16px" })}`}
                >
                  {notice}
                </p>
              </div>
            </>
          )}
        </section>
        {!modelUi && !unsupported && (
          <aside className={`${panel} ${css({ p: { base: "3.5", md: "4" }, minW: 0 })}`}>
            <div
              className={css({
                display: "flex",
                gap: "2",
                alignItems: "center",
                mb: "4",
                "& svg": { color: "muted", flexShrink: 0 },
              })}
            >
              <SlidersHorizontal size={15} strokeWidth={1.75} />
              <h2 className={css({ fontSize: "sm", fontWeight: 600 })}>Run settings</h2>
            </div>
            <Field
              htmlFor="temperature"
              label={
                <span
                  className={css({ display: "flex", justifyContent: "space-between", gap: "2" })}
                >
                  Temperature
                  <output
                    className={css({
                      fontFamily: "mono",
                      fontSize: "xs",
                      fontWeight: 400,
                      color: "inkSoft",
                      fontVariantNumeric: "tabular-nums",
                    })}
                  >
                    {temperature.toFixed(1)}
                  </output>
                </span>
              }
              hint="Lower is steadier, higher is more varied."
              className={css({ mb: "4" })}
            >
              <input
                id="temperature"
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
                disabled={busy}
                className={css({
                  w: "full",
                  h: "20px",
                  accentColor: "ink",
                  cursor: "pointer",
                  _disabled: { cursor: "not-allowed", opacity: 0.55 },
                })}
              />
            </Field>
            <Field htmlFor="maxTokens" label="Maximum output tokens">
              <select
                id="maxTokens"
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                disabled={busy}
                className={`${control} ${css({ fontFamily: "mono", fontVariantNumeric: "tabular-nums" })}`}
              >
                {[128, 256, 512, 1024, 2048].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <div
              className={css({
                borderTop: "1px solid token(colors.lineSoft)",
                pt: "4",
                mt: "4",
                display: "grid",
                gap: "2.5",
              })}
            >
              {ready && !busy && responded ? (
                <>
                  <p className={caption}>
                    This model answered here. Review its guest settings before sharing it.
                  </p>
                  <Link
                    to="/sharing"
                    search={{ model }}
                    className={`${button({ size: "sm" })} ${css({ justifySelf: "start" })}`}
                  >
                    Set up guest access <ArrowRight size={13} />
                  </Link>
                </>
              ) : (
                ready && (
                  <p className={caption}>
                    Installed does not mean tested. Send a prompt to try this model.
                  </p>
                )
              )}
              <p className={caption}>
                Each model keeps its own conversation, draft and settings in this tab. Leaving
                Playground stops generation; reloading clears the work.
              </p>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
