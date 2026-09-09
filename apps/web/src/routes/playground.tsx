import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
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
import { Badge, Button, CodeBlock, PageHeading, button, muted, panel } from "../components/ui";
import { useHost } from "../lib/host-context";
import { readChatStream, type ChatMessage } from "../lib/api";

export const Route = createFileRoute("/playground")({
  validateSearch: (search: Record<string, unknown>): { model?: string } => ({
    model: typeof search.model === "string" ? search.model : undefined,
  }),
  component: Playground,
});
function Playground() {
  const { model: requestedModel } = Route.useSearch();
  const { models, status, refresh } = useHost();
  const [chosenModel, setChosenModel] = useState(requestedModel ?? "");
  const model = models.some((m) => m.name === chosenModel) ? chosenModel : (models[0]?.name ?? "");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(512);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showApi, setShowApi] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);
  const ready = !!status?.ollamaConnected && !!model;
  async function send() {
    if (busy || !ready || !prompt.trim()) return;
    const history: ChatMessage[] = [...messages, { role: "user", content: prompt.trim() }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setPrompt("");
    setError("");
    setNotice("");
    setBusy(true);
    const current = new AbortController();
    abort.current = current;
    let answer = "";
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        signal: current.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: history, temperature, maxTokens }),
      });
      await readChatStream(response, (chunk) => {
        answer += chunk.content;
        setMessages([...history, { role: "assistant", content: answer }]);
        if (chunk.done && chunk.outputTokens !== undefined)
          setNotice(`${chunk.outputTokens} output tokens · Generated locally`);
      });
    } catch (cause) {
      if (current.signal.aborted) setNotice("Generation stopped. The response may be incomplete.");
      else
        setError(cause instanceof Error ? cause.message : "Generation failed. Please try again.");
      // Do not include an empty or partial failed assistant response in a future prompt.
      setMessages(answer ? [...history, { role: "assistant", content: answer }] : history);
    } finally {
      setBusy(false);
      abort.current = null;
      void refresh();
    }
  }
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
          <CodeBlock
            code={`curl -N http://127.0.0.1:8080/api/chat \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ model: model || "your-model-name", messages: [{ role: "user", content: "Hello!" }], temperature, maxTokens })}'`}
          />
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
              onClick={() => {
                setMessages([]);
                setError("");
                setNotice("");
              }}
            >
              <Trash2 />
              Clear
            </Button>
          </div>
          <div
            className={css({ flex: 1, maxH: "570px", minH: "350px", overflowY: "auto", p: "5" })}
            aria-label="Conversation messages"
          >
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
                  className={css({ fontSize: "20px", fontWeight: 750, letterSpacing: "-0.03em" })}
                >
                  What’s on your mind?
                </h3>
                <p className={`${muted} ${css({ maxW: "330px" })}`}>
                  {ready
                    ? "Ask a question, work through an idea, or put your model to the test."
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
                    {["Explain virtual threads simply", "Write a Java health check"].map((text) => (
                      <Button key={text} onClick={() => setPrompt(text)}>
                        {text}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Link to="/connection" className={button({ variant: "secondary" })}>
                    Set up your host
                    <ArrowRight size={14} />
                  </Link>
                )}
              </div>
            ) : (
              messages.map((message, i) => (
                <article key={i} className={css({ display: "flex", gap: "3", mb: "6" })}>
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
                      {message.role === "user" ? "You" : model}
                    </h3>
                    <p
                      className={css({
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        fontSize: "sm",
                        lineHeight: 1.9,
                      })}
                    >
                      {message.content || (busy ? "Thinking…" : "")}
                    </p>
                  </div>
                </article>
              ))
            )}
            <div ref={bottom} />
          </div>
          <div className={css({ p: "4", pt: 0 })}>
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
                aria-label="Message"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={!ready || busy}
                maxLength={16000}
                placeholder={ready ? "Message your model…" : "Your model will be ready after setup"}
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
                  <Button type="button" onClick={() => abort.current?.abort()}>
                    <Square />
                    Stop
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={!ready || !prompt.trim()}
                    aria-label="Send message"
                  >
                    <ArrowUp />
                  </Button>
                )}
              </div>
            </form>
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
              setChosenModel(e.target.value);
              setMessages([]);
              setError("");
              setNotice("");
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
            {!models.length && <option value="">No models available</option>}
            {models.map((m) => (
              <option key={m.name}>{m.name}</option>
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
              {ready ? "Local inference ready" : "Runtime not ready"}
            </Badge>
            <p className={`${muted} ${css({ fontSize: "11px", mt: "3" })}`}>
              Conversations live in this tab and clear when you leave the playground.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
