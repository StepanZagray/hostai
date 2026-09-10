import { css } from "../../styled-system/css";
import { Answer } from "../components/answer";
import { Button, CopyButton, muted } from "../components/ui";
import type { ConversationTurn } from "../lib/conversation";
import { useConversationScroll } from "../lib/use-conversation-scroll";

export function GuestConversation({ turns }: { turns: ConversationTurn[] }) {
  const scroll = useConversationScroll(turns);
  return (
    <>
      <div
        key={scroll.viewportKey}
        ref={scroll.viewportRef}
        role="region"
        aria-label="Conversation messages"
        tabIndex={0}
        onScroll={scroll.onScroll}
        onWheel={scroll.onWheel}
        onKeyDown={scroll.onKeyDown}
        onTouchStart={scroll.onTouchStart}
        onTouchMove={scroll.onTouchMove}
        className={`${css({
          minW: 0,
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehaviorY: "contain",
          p: { base: "4", md: "6" },
          _focusVisible: { outline: "2px solid token(colors.accent)", outlineOffset: "-2px" },
        })} ${turns.length ? css({ height: "clamp(240px, 48dvh, 560px)" }) : css({ minH: "160px" })}`}
      >
        <div ref={scroll.contentRef}>
          {!turns.length && (
            <div className={css({ py: "8", maxW: "420px" })}>
              <h3 className={css({ fontWeight: 750, fontSize: "lg", mb: "2" })}>
                Space for a question
              </h3>
              <p className={muted}>
                After connecting, ask a question or work through an idea with the host's model.
              </p>
            </div>
          )}
          {turns.map((turn, index) => (
            <article
              key={turn.id}
              aria-label={`Exchange ${index + 1}`}
              className={css({ minW: 0, mb: "6", "&:last-child": { mb: 0 } })}
            >
              <div
                className={css({ bg: "accentSoft", borderRadius: "8px", p: "4", mb: "4", minW: 0 })}
              >
                <h3 className={css({ color: "accent", fontSize: "xs", fontWeight: 750, mb: "2" })}>
                  You
                </h3>
                <p
                  className={css({
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    lineHeight: 1.8,
                  })}
                >
                  {turn.prompt}
                </p>
              </div>
              <h3
                className={css({
                  fontSize: "sm",
                  fontWeight: 750,
                  mb: "2",
                  overflowWrap: "anywhere",
                })}
              >
                Model response{" "}
                <span
                  className={css({
                    fontFamily: "mono",
                    color: "muted",
                    fontSize: "xs",
                    fontWeight: 400,
                  })}
                >
                  / {turn.model}
                </span>
              </h3>
              {turn.omittedTurns ? (
                <p className={muted}>
                  {turn.omittedTurns} older exchanges were omitted to fit request limits.
                </p>
              ) : null}
              {turn.response.trim() ? (
                <Answer text={turn.response} />
              ) : (
                <p className={muted}>
                  {turn.state === "streaming" ? "Waiting for the host…" : "No response received."}
                </p>
              )}
              {(turn.state === "failed" || turn.state === "cancelled") && (
                <>
                  <p
                    className={css({ color: "warning", fontSize: "xs", lineHeight: 1.7, mt: "3" })}
                  >
                    Incomplete exchange · This prompt and response are excluded from later context.
                  </p>
                  <CopyButton text={turn.prompt} label="Copy question" />
                </>
              )}
              {turn.state !== "streaming" && turn.response.trim() && (
                <CopyButton
                  text={turn.response}
                  label={turn.state === "completed" ? "Copy response" : "Copy partial response"}
                />
              )}
            </article>
          ))}
        </div>
      </div>
      {!scroll.following && (
        <div className={css({ px: "4", pb: "3" })}>
          <Button onClick={scroll.jumpToLatest}>Jump to latest</Button>
        </div>
      )}
    </>
  );
}
