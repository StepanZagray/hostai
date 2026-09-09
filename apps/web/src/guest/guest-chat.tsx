import { useEffect, useRef, useState } from "react";
import { css } from "../../styled-system/css";
import { Button, muted, panel } from "../components/ui";
import { GuestConversation } from "./guest-conversation";
import { useGuestChat } from "./use-guest-chat";

const controls = css({ display: "flex", alignItems: "center", gap: "2", flexWrap: "wrap" });
const field = css({
  w: "full",
  minW: 0,
  minH: "44px",
  bg: "canvas",
  border: "1px solid token(colors.line)",
  borderRadius: "7px",
  px: "3",
  py: "2",
  _disabled: { opacity: 0.65, cursor: "not-allowed" },
});

export function GuestChat() {
  const chat = useGuestChat();
  const [enteredKey, setEnteredKey] = useState("");
  const [changeKey, setChangeKey] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const showKey =
    !chat.hasKey ||
    chat.phase === "needs-key" ||
    changeKey ||
    (!chat.session && chat.phase === "blocked");
  const checking = chat.phase === "checking";

  useEffect(() => {
    if (chat.ready) composer.current?.focus({ preventScroll: true });
  }, [chat.ready]);
  useEffect(() => {
    if (showKey) keyInput.current?.focus({ preventScroll: true });
  }, [showKey]);

  return (
    <main
      className={css({
        maxW: "960px",
        mx: "auto",
        p: { base: "3", md: "8" },
        minW: 0,
        "& button": { minH: "44px" },
      })}
    >
      <header className={css({ mb: "5" })}>
        <p className={css({ color: "accent", fontWeight: 750, fontSize: "sm", mb: "2" })}>
          HostAI / Guest
        </p>
        <h1 className={css({ fontSize: "2xl", fontWeight: 750, letterSpacing: "-0.03em" })}>
          A conversation with this host
        </h1>
        <p className={muted}>Temporary access to one shared model.</p>
      </header>

      <section
        aria-label="Guest access"
        className={`${panel} ${css({ p: { base: "4", md: "5" }, mb: "4" })}`}
      >
        <div
          className={css({
            display: "flex",
            justifyContent: "space-between",
            gap: "3",
            flexWrap: "wrap",
          })}
        >
          <h2 className={css({ fontSize: "md", fontWeight: 750 })}>Guest access</h2>
          <span
            className={css({
              color: "accent",
              bg: "accentSoft",
              px: "2",
              py: "1",
              borderRadius: "5px",
              fontSize: "xs",
            })}
          >
            Local preview
          </span>
        </div>
        <p id="guest-disclosure" className={`${muted} ${css({ mt: "3" })}`}>
          Messages go to the operator of this host. Local preview is local-only, with no internet
          sharing. Your access key is still private; keep it to yourself.
        </p>
        {chat.session && (
          <div
            className={css({
              my: "4",
              display: "grid",
              gap: "3",
              gridTemplateColumns: { base: "minmax(0, 1fr)", md: "minmax(0, 1fr) minmax(0, 1fr)" },
            })}
          >
            <div>
              <p className={muted}>Host-provided name · not a verified identity</p>
              <p className={css({ fontWeight: 700, overflowWrap: "anywhere" })}>
                {chat.session.hostLabel}
              </p>
            </div>
            <div>
              <p className={muted}>Model</p>
              <p className={css({ fontFamily: "mono", fontSize: "sm", overflowWrap: "anywhere" })}>
                {chat.session.model}
              </p>
            </div>
            <p className={`${muted} ${css({ gridColumn: "1 / -1" })}`}>
              Access expires{" "}
              <time dateTime={chat.session.expiresAt}>
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "long",
                }).format(new Date(chat.session.expiresAt))}
              </time>{" "}
              (your local time).
              {chat.phase !== "ready" && " Details from the last access check."}
            </p>
          </div>
        )}
        <p role="status" className={`${muted} ${css({ my: "3" })}`}>
          {checking
            ? "Checking guest access…"
            : chat.ready
              ? "Guest access checked. You can send a message."
              : "Connect with a valid key before sending a message."}
        </p>
        {chat.error && (
          <p
            role="alert"
            className={css({ color: "danger", fontSize: "sm", lineHeight: 1.7, my: "3" })}
          >
            {chat.error}
          </p>
        )}
        {chat.retrySeconds > 0 && (
          <p className={`${muted} ${css({ mb: "3", fontVariantNumeric: "tabular-nums" })}`}>
            Try reconnecting in {chat.retrySeconds} seconds. Nothing will be sent automatically.
          </p>
        )}
        {showKey && (
          <form
            className={css({ my: "3" })}
            onSubmit={(event) => {
              event.preventDefault();
              void chat.connect(enteredKey);
              setEnteredKey("");
              setChangeKey(false);
            }}
          >
            <label
              htmlFor="guest-key"
              className={css({ display: "block", fontWeight: 650, mb: "2" })}
            >
              Access key
            </label>
            <div className={controls}>
              <input
                id="guest-key"
                ref={keyInput}
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={256}
                required
                value={enteredKey}
                onChange={(event) => setEnteredKey(event.target.value)}
                disabled={checking}
                aria-describedby="guest-key-help"
                className={`${field} ${css({ flex: "1 1 180px" })}`}
              />
              <Button type="submit" variant="primary" disabled={checking || !enteredKey}>
                Connect
              </Button>
            </div>
            <p id="guest-key-help" className={`${muted} ${css({ mt: "2" })}`}>
              Use the key supplied by this host. Connecting with a different key clears this
              conversation and draft.
            </p>
          </form>
        )}
        {chat.hasKey && (
          <div className={controls}>
            <Button
              onClick={chat.reconnect}
              disabled={checking || chat.busy || chat.retrySeconds > 0}
            >
              Reconnect
            </Button>
            {!showKey && (
              <Button onClick={() => setChangeKey(true)} disabled={checking || chat.busy}>
                Use another key
              </Button>
            )}
            <Button
              onClick={() => {
                chat.disconnect();
                setEnteredKey("");
                setChangeKey(false);
              }}
            >
              Disconnect
            </Button>
          </div>
        )}
        <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
          Kept in this tab's memory only. Disconnecting or reloading clears the conversation and
          draft.
        </p>
      </section>

      <section aria-labelledby="conversation-heading" className={panel}>
        <div className={css({ px: "4", py: "3", borderBottom: "1px solid token(colors.line)" })}>
          <h2 id="conversation-heading" className={css({ fontWeight: 750 })}>
            Conversation
          </h2>
        </div>
        <GuestConversation turns={chat.turns} />
        <form
          aria-label="Message composer"
          className={css({ p: "4", borderTop: "1px solid token(colors.line)" })}
          onSubmit={(event) => {
            event.preventDefault();
            void chat.send();
          }}
        >
          <label
            htmlFor="guest-message"
            className={css({ display: "block", fontWeight: 650, mb: "2" })}
          >
            Message
          </label>
          <textarea
            id="guest-message"
            ref={composer}
            value={chat.draft}
            rows={3}
            disabled={!chat.session}
            onChange={(event) => chat.setDraft(event.target.value)}
            aria-describedby="guest-disclosure guest-message-help"
            className={`${field} ${css({ display: "block", resize: "vertical", minH: "96px", maxH: "240px", overflowY: "auto" })}`}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void chat.send();
              }
            }}
          />
          <div
            className={css({
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "3",
              flexWrap: "wrap",
              mt: "3",
            })}
          >
            <p id="guest-message-help" className={`${muted} ${css({ fontSize: "xs" })}`}>
              Enter to send · Shift+Enter for a new line
              <br />
              512 output tokens · 1,024 token maximum · Temperature 0.7
              <br />6 requests/minute · 1 guest request at a time
            </p>
            {chat.busy ? (
              <Button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  chat.stop();
                }}
              >
                Stop
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!chat.ready || !chat.draft.trim()}>
                Send message
              </Button>
            )}
          </div>
          <p role="status" className={`${muted} ${css({ mt: "3" })}`}>
            {chat.busy ? "Receiving a response…" : chat.notice}
          </p>
        </form>
      </section>
    </main>
  );
}
