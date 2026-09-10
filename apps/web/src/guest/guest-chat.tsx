import { useEffect, useRef, useState } from "react";
import { css } from "../../styled-system/css";
import { Button, muted, panel } from "../components/ui";
import { GuestConversation } from "./guest-conversation";
import { GuestAccessRequest } from "./guest-access-request";
import { GuestKeyForm } from "./guest-key-form";
import { useGuestAccessRequest } from "./use-guest-access-request";
import { useGuestChat } from "./use-guest-chat";
import { isRequestTerminal } from "./request-api";

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
  const [epoch, setEpoch] = useState(0);
  const [discoverRequests, setDiscoverRequests] = useState(false);
  const accessRequest = useGuestAccessRequest(discoverRequests);
  return (
    <GuestChatSession
      key={epoch}
      accessRequest={accessRequest}
      onDiscoverRequests={setDiscoverRequests}
      onDisconnect={() => setEpoch((value) => value + 1)}
    />
  );
}

function GuestChatSession({
  onDisconnect,
  accessRequest,
  onDiscoverRequests,
}: {
  onDisconnect: () => void;
  accessRequest: ReturnType<typeof useGuestAccessRequest>;
  onDiscoverRequests: (enabled: boolean) => void;
}) {
  const chat = useGuestChat();
  const [enteredKey, setEnteredKey] = useState("");
  const [changeKey, setChangeKey] = useState(false);
  const [chatRequest, setChatRequest] = useState<{ id: string; grantId: string } | null>(null);
  const currentRequest = accessRequest.state.request;
  const usingRequestedAccess =
    !!chatRequest &&
    currentRequest?.id === chatRequest.id &&
    currentRequest.grantId === chatRequest.grantId;
  const requestIdentity = () =>
    currentRequest?.grantId ? { id: currentRequest.id, grantId: currentRequest.grantId } : null;
  const composer = useRef<HTMLTextAreaElement>(null);
  const showKey =
    !chat.hasKey ||
    chat.phase === "needs-key" ||
    changeKey ||
    (!chat.session && chat.phase === "blocked");
  const checking = chat.phase === "checking";
  const scope = chat.session?.scope;
  const potentiallyInternet =
    typeof window !== "undefined" && window.location.protocol === "https:";

  useEffect(() => {
    if (chat.ready) composer.current?.focus({ preventScroll: true });
  }, [chat.ready]);
  const requestEnabled = showKey && potentiallyInternet && !changeKey;
  useEffect(
    () => onDiscoverRequests(requestEnabled && !checking),
    [onDiscoverRequests, requestEnabled, checking],
  );
  const requestEnded =
    !!accessRequest.state.request && isRequestTerminal(accessRequest.state.request.state);
  const requestCancellationPending =
    accessRequest.state.busy === "cancel" || accessRequest.state.recovery === "cancel";
  const requestKeyBlocked = requestEnded || requestCancellationPending;
  const requestPaused = usingRequestedAccess && requestKeyBlocked;
  const pauseMessage = requestPaused
    ? requestEnded
      ? accessRequest.state.request?.state === "failed"
        ? "The host could not confirm this request’s access. Ask the host to revoke its key. Your conversation and draft are retained."
        : "The host ended this request’s access. Your conversation and draft are retained."
      : "Cancellation is not confirmed. This request’s key is paused until the outcome is known. Your conversation and draft are retained."
    : "";
  useEffect(() => {
    if (pauseMessage) chat.pauseAccess(pauseMessage);
  }, [pauseMessage, chat.pauseAccess]);
  const requestFirst =
    potentiallyInternet &&
    !chat.hasKey &&
    !changeKey &&
    !["unavailable", "unsupported", "error"].includes(accessRequest.state.details);
  const showConversation = !!chat.session || chat.turns.length > 0 || !!chat.draft;

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
            {scope === "temporary-internet"
              ? "Temporary internet access"
              : scope === "local-preview"
                ? "Local preview"
                : potentiallyInternet
                  ? "Internet access not checked"
                  : "Access not checked"}
          </span>
        </div>
        <p id="guest-disclosure" className={`${muted} ${css({ mt: "3" })}`}>
          Messages go to the operator of this host.{" "}
          {scope === "temporary-internet"
            ? "This connection uses a Cloudflare relay. Cloudflare terminates TLS and can see messages and access keys."
            : scope === "local-preview"
              ? "Local preview is local-only, with no internet sharing."
              : potentiallyInternet
                ? "Cloudflare can see messages, access keys, your name and request credentials when it relays the connection."
                : "The transport may use a Cloudflare relay. Cloudflare can see messages and access keys when it relays the connection."}{" "}
          {scope &&
            (requestEnabled || accessRequest.state.submission) &&
            "Cloudflare can also see your name and request credentials. "}
          Keep your key private. The host’s name is self-asserted, not a verified identity.
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
              Host-reported expiry:{" "}
              <time dateTime={chat.session.expiresAt}>
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "long",
                }).format(new Date(chat.session.expiresAt))}
              </time>{" "}
              (your time zone). The host checks access when you send and ends responses when access
              expires.
              {chat.phase !== "ready" && " Details from the last access check."}
            </p>
          </div>
        )}
        {(checking || chat.hasKey || !potentiallyInternet) && (
          <p role="status" className={`${muted} ${css({ my: "3" })}`}>
            {checking
              ? "Checking guest access…"
              : requestPaused
                ? "This request’s access is paused. Manage the request below."
                : chat.ready
                  ? "Access was available at the last check."
                  : "Connect with a valid key before sending a message."}
          </p>
        )}
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
        <GuestAccessRequest
          state={accessRequest.state}
          request={accessRequest.request}
          enabled={requestEnabled}
          connecting={checking}
          connected={usingRequestedAccess && chat.hasKey}
          anotherKey={chat.hasKey && !usingRequestedAccess}
          onConnect={(key) => {
            setChatRequest(requestIdentity());
            setEnteredKey("");
            setChangeKey(false);
            return chat.connect(key);
          }}
        />
        <GuestKeyForm
          shown={showKey}
          secondary={requestFirst}
          checking={checking}
          blocked={requestKeyBlocked && accessRequest.request.matchesKey(enteredKey)}
          value={enteredKey}
          onChange={setEnteredKey}
          focusOnShow={changeKey || (!potentiallyInternet && !chat.hasKey)}
          onConnect={() => {
            const requested = accessRequest.request.matchesKey(enteredKey);
            if (requested && requestKeyBlocked) return;
            setChatRequest(requested ? requestIdentity() : null);
            void chat.connect(enteredKey);
            setEnteredKey("");
            setChangeKey(false);
          }}
        />
        {chat.hasKey && (
          <div className={controls}>
            <Button
              onClick={() => {
                if (!requestPaused) chat.reconnect();
              }}
              disabled={checking || chat.busy || chat.retrySeconds > 0 || requestPaused}
            >
              Reconnect
            </Button>
            {!showKey && (
              <Button onClick={() => setChangeKey(true)} disabled={checking || chat.busy}>
                Use another key
              </Button>
            )}
            {changeKey && (
              <Button
                onClick={() => {
                  setEnteredKey("");
                  setChangeKey(false);
                }}
              >
                Keep current access
              </Button>
            )}
            <Button
              onClick={() => {
                chat.disconnect();
                onDisconnect();
                setEnteredKey("");
                setChangeKey(false);
              }}
            >
              Disconnect
            </Button>
          </div>
        )}
        {showConversation && (
          <p className={`${muted} ${css({ mt: "3", fontSize: "xs" })}`}>
            {accessRequest.state.submission
              ? "Disconnect clears this conversation and draft. Your access request stays in this tab so you can cancel it or connect again. Reloading or closing the tab loses all its credentials. Neither action revokes permission."
              : "This tab keeps your key, conversation and draft in memory only. Disconnecting or reloading clears them. Permission lasts until expiry or host revocation."}
            {scope === "temporary-internet" && " This temporary address can change or go offline."}
          </p>
        )}
      </section>

      {showConversation && (
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
              if (!requestPaused) void chat.send();
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
                  if (!requestPaused) void chat.send();
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
                    composer.current?.focus({ preventScroll: true });
                  }}
                >
                  Stop
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!chat.ready || requestPaused || !chat.draft.trim()}
                >
                  Send message
                </Button>
              )}
            </div>
            <p role="status" className={`${muted} ${css({ mt: "3" })}`}>
              {chat.busy ? "Receiving a response…" : chat.notice}
            </p>
          </form>
        </section>
      )}
    </main>
  );
}
