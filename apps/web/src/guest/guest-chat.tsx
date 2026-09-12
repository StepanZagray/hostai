import { useEffect, useRef, useState } from "react";
import { css } from "../../styled-system/css";
import {
  Badge,
  Button,
  EmptyState,
  Led,
  Note,
  caption,
  fieldLabel,
  legend,
  mono,
  panel,
  type LedState,
  type Tone,
} from "../components/ui";
import { ModelUiFrame } from "../components/model-ui-frame";
import { ThemeToggle } from "../components/theme-toggle";
import { modelUiAssetPath } from "../lib/model-ui-host";
import { modelInterface, NO_SUPPORTED_INTERFACE } from "../lib/model-admission";
import { GuestConversation } from "./guest-conversation";
import { GuestAccessRequest } from "./guest-access-request";
import { GuestInfoMenu } from "./guest-info-menu";
import { GuestKeyForm } from "./guest-key-form";
import { useGuestAccessRequest } from "./use-guest-access-request";
import { useGuestChat } from "./use-guest-chat";
import { isRequestTerminal } from "./request-api";

const BAR = "52px";
const controls = css({ display: "flex", alignItems: "center", gap: "2", flexWrap: "wrap" });
/** The session facts: engraved legends with their readings, stacked inside the menu. */
const facts = css({
  display: "grid",
  gap: "3",
  mb: "3.5",
  "& > div": { minW: 0, display: "grid", gap: "1", alignContent: "start" },
  "& dd": { fontSize: "sm", lineHeight: 1.5, color: "ink", overflowWrap: "anywhere" },
});
/**
 * Two shapes for the connection band. With no interface to show there is nothing to
 * fill, so the key form reads as a card at a comfortable measure; once a session or a
 * transcript exists the band is a full-width strip above a surface that takes the page.
 */
const connectCard = css({ maxW: "560px", mx: "auto" });
const fullBand = css({ maxW: "none" });

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
    !chat.hasKey || chat.phase === "needs-key" || changeKey || !chat.session || chat.replacingKey;
  const checking = chat.phase === "checking";
  const scope = chat.session?.scope;
  const potentiallyInternet =
    typeof window !== "undefined" && window.location.protocol === "https:";

  useEffect(() => {
    if (chat.ready) {
      setChangeKey(false);
      composer.current?.focus({ preventScroll: true });
    }
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
  const showConversation = !!chat.session || chat.turns.length > 0 || !!chat.draft;
  // A runtime interface replaces the transcript and composer (docs/model-ui.md). The
  // connection band above stays; the frame keeps its own state and never sees the key.
  const presentation = chat.session ? modelInterface(chat.session) : "chat";
  const modelUi = presentation === "custom" ? (chat.session?.ui ?? null) : null;
  // Nothing to show below means nothing to fill: the way in becomes the page. A
  // session, a transcript or a retained draft always brings a surface with it.
  const connectOnly = !showConversation;
  // Getting in and getting unstuck never hide: the key form, the request panel and
  // every alert stay in the body. Facts and connection controls live in the menu.
  const connectionBand =
    showKey ||
    !!chat.error ||
    chat.replacingKey ||
    chat.retrySeconds > 0 ||
    requestEnabled ||
    !!accessRequest.state.submission;

  // The lights: the scope badge, the menu's own lamp and the access line inside it.
  const scopeTone: Tone =
    scope === "temporary-internet"
      ? "warning"
      : scope === "local-preview"
        ? "accent"
        : checking
          ? "busy"
          : "neutral";
  const accessLight: LedState = checking
    ? "busy"
    : requestPaused
      ? "amber"
      : chat.ready
        ? "live"
        : "off";
  // The same reading as the status line, short enough to sit in the bar's own label.
  const accessReading = checking
    ? "Checking access"
    : requestPaused
      ? "Access paused"
      : chat.ready
        ? "Access available"
        : "Not connected";

  return (
    <div
      className={css({
        minH: "100dvh",
        display: "flex",
        flexDirection: "column",
        "& button, & input, & select": { minH: "44px" },
      })}
    >
      <header
        className={css({
          // The session menu hangs off this box, so it owns the horizontal anchor and
          // the sheet can never be pushed past the viewport edge on a narrow screen.
          position: "relative",
          minH: BAR,
          flexShrink: 0,
          bg: "paper",
          borderBottom: "1px solid token(colors.line)",
          px: { base: "4", md: "6" },
          py: "1",
          display: "flex",
          alignItems: "center",
          gap: "3",
          rowGap: "1",
          flexWrap: "wrap",
        })}
      >
        <p
          className={css({
            fontSize: "md",
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "ink",
            lineHeight: 1,
            whiteSpace: "nowrap",
          })}
        >
          host<span className={css({ color: "muted" })}>ai</span>{" "}
          <span
            className={css({
              fontFamily: "mono",
              fontSize: "xs",
              fontWeight: 500,
              letterSpacing: "0",
              color: "muted",
            })}
          >
            / Guest
          </span>
        </p>
        <div
          className={css({ ml: "auto", display: "flex", alignItems: "center", gap: "2", minW: 0 })}
        >
          <Badge tone={scopeTone}>
            {scope === "temporary-internet"
              ? "Temporary internet access"
              : scope === "local-preview"
                ? "Local preview"
                : potentiallyInternet
                  ? "Internet access not checked"
                  : "Access not checked"}
          </Badge>
          <GuestInfoMenu label="Session details" state={accessReading} light={accessLight}>
            {chat.session && (
              <dl id="guest-session-facts" className={facts}>
                <div>
                  <dt className={legend}>Host</dt>
                  <dd className={css({ fontWeight: 600 })}>
                    {chat.session.hostLabel}
                    <span
                      className={css({
                        display: "block",
                        fontSize: "xs",
                        fontWeight: 400,
                        lineHeight: 1.55,
                        color: "muted",
                      })}
                    >
                      Host-provided name · not a verified identity
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className={legend}>Model</dt>
                  <dd className={mono}>{chat.session.model}</dd>
                </div>
                <div>
                  <dt className={legend}>Host-reported expiry</dt>
                  <dd className={css({ fontFamily: "mono", fontVariantNumeric: "tabular-nums" })}>
                    <time dateTime={chat.session.expiresAt}>
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: "medium",
                        timeStyle: "long",
                      }).format(new Date(chat.session.expiresAt))}
                    </time>
                  </dd>
                </div>
              </dl>
            )}
            <Note id="guest-disclosure" tone="neutral">
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
              The host’s name is self-asserted, not a verified identity. Keep your key private.
            </Note>
            <p
              id="guest-access-status"
              role="status"
              className={css({
                display: "flex",
                alignItems: "start",
                gap: "2.5",
                mt: "3",
                fontSize: "sm",
                lineHeight: 1.55,
                color: "inkSoft",
                minW: 0,
              })}
            >
              <Led state={accessLight} className={css({ mt: "1.5" })} />
              {checking
                ? "Checking guest access…"
                : requestPaused
                  ? "This request’s access is paused. Manage the request below."
                  : chat.ready
                    ? "Access was available at the last check."
                    : "Connect with a valid key before sending a message."}
            </p>
            {showConversation && (
              <p id="guest-retention" className={`${caption} ${css({ mt: "3" })}`}>
                {modelUi
                  ? accessRequest.state.submission
                    ? "The model interface keeps its own state in this tab and HostAI does not store it. Disconnecting clears it but keeps your access request in this tab. Reloading loses every credential here. Neither revokes permission."
                    : "Your key lives in this tab only. The model interface keeps its own state in this tab and HostAI does not store it. Disconnecting or reloading clears both; permission itself lasts until expiry or host revocation."
                  : accessRequest.state.submission
                    ? "Disconnecting clears this conversation and draft but keeps your access request in this tab. Reloading loses every credential here. Neither revokes permission."
                    : "Your key, conversation and draft live in this tab only. Disconnecting or reloading clears them; permission itself lasts until expiry or host revocation."}
                {scope === "temporary-internet" &&
                  " This temporary address can change or go offline."}
              </p>
            )}
            {chat.hasKey && (
              <div className={`${controls} ${css({ mt: "3.5" })}`}>
                <Button
                  size="sm"
                  onClick={() => {
                    if (!requestPaused) chat.reconnect();
                  }}
                  disabled={checking || chat.busy || chat.retrySeconds > 0 || requestPaused}
                >
                  Reconnect
                </Button>
                {!showKey && (
                  <Button
                    size="sm"
                    onClick={() => setChangeKey(true)}
                    disabled={checking || chat.busy}
                  >
                    Use another key
                  </Button>
                )}
                {changeKey && chat.session && !chat.replacingKey && (
                  <Button
                    size="sm"
                    disabled={checking}
                    onClick={() => {
                      setEnteredKey("");
                      setChangeKey(false);
                    }}
                  >
                    Keep current access
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
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
          </GuestInfoMenu>
          <ThemeToggle />
        </div>
      </header>

      <main
        className={css({
          w: "full",
          px: { base: "4", md: "6" },
          py: { base: "4", md: "5" },
          minW: 0,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: "5",
          minH: 0,
        })}
      >
        {connectionBand && (
          <section
            aria-label="Guest connection"
            className={`${panel} ${connectOnly ? connectCard : fullBand} ${css({
              w: "full",
              px: { base: "3.5", md: "4" },
              py: { base: "3.5", md: "4" },
              minW: 0,
              flexShrink: 0,
            })}`}
          >
            {chat.error && (
              <Note role="alert" tone="danger">
                {chat.error}
              </Note>
            )}
            {chat.replacingKey && (
              <p className={`${caption} ${css({ mt: "2.5" })}`}>
                Previous conversation retained. Reconnect retries the latest key, or enter the
                earlier key to return to it. Sending stays paused until a key connects.
              </p>
            )}
            {chat.retrySeconds > 0 && (
              <p className={`${caption} ${css({ mt: "2.5", fontVariantNumeric: "tabular-nums" })}`}>
                Try reconnecting in {chat.retrySeconds} seconds.
              </p>
            )}
            <GuestKeyForm
              shown={showKey}
              checking={checking}
              blocked={requestKeyBlocked && accessRequest.request.matchesKey(enteredKey)}
              value={enteredKey}
              onChange={setEnteredKey}
              focusOnShow={changeKey}
              focusWhenIdle={!chat.session && (chat.phase === "needs-key" || !chat.hasKey)}
              onConnect={() => {
                const requested = accessRequest.request.matchesKey(enteredKey);
                if (requested && requestKeyBlocked) return;
                setChatRequest(requested ? requestIdentity() : null);
                void chat.connect(enteredKey);
                setEnteredKey("");
                setChangeKey(true);
              }}
            />
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
          </section>
        )}

        {modelUi && chat.session ? (
          <section
            aria-labelledby="interface-heading"
            className={`${panel} ${css({
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              flex: 1,
              minW: 0,
            })}`}
          >
            <div
              className={css({
                px: { base: "3.5", md: "4" },
                py: "2.5",
                borderBottom: "1px solid token(colors.line)",
                flexShrink: 0,
              })}
            >
              <h2 id="interface-heading" className={css({ textStyle: "title" })}>
                Model interface
              </h2>
            </div>
            <ModelUiFrame
              scope="guest"
              model={chat.session.model}
              runtime={modelUi.runtime}
              src={modelUiAssetPath("/guest/v1/model-ui", modelUi)}
              title={`${chat.session.model} interface`}
              infer={chat.infer}
            />
          </section>
        ) : presentation === "unsupported" ? (
          <section className={panel}>
            <EmptyState title="No supported interface" description={NO_SUPPORTED_INTERFACE} />
          </section>
        ) : showConversation ? (
          <section
            aria-labelledby="conversation-heading"
            className={`${panel} ${css({
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              flex: 1,
              minH: 0,
              minW: 0,
            })}`}
          >
            <div
              className={css({
                px: { base: "3.5", md: "4" },
                py: "2.5",
                borderBottom: "1px solid token(colors.line)",
                flexShrink: 0,
              })}
            >
              <h2 id="conversation-heading" className={css({ textStyle: "title" })}>
                Conversation
              </h2>
            </div>
            <GuestConversation turns={chat.turns} />
            <form
              aria-label="Message composer"
              className={css({
                p: "3",
                bg: "well",
                borderTop: "1px solid token(colors.line)",
                flexShrink: 0,
                minW: 0,
              })}
              onSubmit={(event) => {
                event.preventDefault();
                if (!requestPaused) void chat.send();
              }}
            >
              <label
                htmlFor="guest-message"
                className={`${fieldLabel} ${css({ display: "block", mb: "1.5" })}`}
              >
                Message
              </label>
              <div
                className={css({
                  bg: "panel",
                  border: "1px solid token(colors.line)",
                  borderRadius: "sm",
                  minW: 0,
                  transition: "border-color token(durations.fast)",
                  _focusWithin: {
                    borderColor: "lineStrong",
                    outline: "1px solid token(colors.lineStrong)",
                  },
                })}
              >
                <textarea
                  id="guest-message"
                  ref={composer}
                  value={chat.draft}
                  rows={3}
                  disabled={!chat.session}
                  onChange={(event) => chat.setDraft(event.target.value)}
                  aria-describedby="guest-disclosure guest-message-help"
                  className={css({
                    display: "block",
                    w: "full",
                    minW: 0,
                    bg: "transparent",
                    border: "none",
                    outline: "none",
                    color: "ink",
                    fontSize: "sm",
                    lineHeight: 1.6,
                    px: "3",
                    pt: "2.5",
                    pb: "1.5",
                    resize: "vertical",
                    minH: "80px",
                    maxH: "220px",
                    overflowY: "auto",
                    _disabled: { cursor: "not-allowed", color: "muted" },
                  })}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
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
                    pl: "3",
                    pr: "2",
                    py: "2",
                    borderTop: "1px solid token(colors.lineSoft)",
                  })}
                >
                  <p
                    id="guest-message-help"
                    className={`${caption} ${css({ minW: 0, fontVariantNumeric: "tabular-nums" })}`}
                  >
                    Enter to send · Shift+Enter for a new line
                    <br />
                    512 output tokens · 1,024 token maximum · Temperature 0.7 · 6 requests/minute ·
                    1 guest request at a time
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
              </div>
              <p role="status" className={`${caption} ${css({ mt: "2", minH: "18px" })}`}>
                {chat.busy ? "Receiving a response…" : chat.notice}
              </p>
            </form>
          </section>
        ) : null}
      </main>
    </div>
  );
}
