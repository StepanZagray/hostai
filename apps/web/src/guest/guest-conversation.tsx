import { css } from "../../styled-system/css";
import { Answer } from "../components/answer";
import { Button, CopyButton, caption, legend, muted } from "../components/ui";
import type { ConversationTurn } from "../lib/conversation";
import { useConversationScroll } from "../lib/use-conversation-scroll";

export function GuestConversation({ turns }: { turns: ConversationTurn[] }) {
  const scroll = useConversationScroll(turns);
  return (
    // The transcript takes whatever height the panel has left and scrolls inside it,
    // so a full-page guest view has no dead band under the conversation.
    <div
      className={css({
        position: "relative",
        flex: "1 1 auto",
        minH: "180px",
      })}
    >
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
        className={css({
          position: "absolute",
          inset: 0,
          minW: 0,
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehaviorY: "contain",
          px: { base: "3.5", md: "5" },
          py: { base: "3.5", md: "4" },
          _focusVisible: { outline: "2px solid token(colors.ink)", outlineOffset: "-2px" },
        })}
      >
        <div ref={scroll.contentRef}>
          {!turns.length && (
            <p className={`${muted} ${css({ maxW: "44ch" })}`}>
              Nothing sent yet. Your messages go to whoever runs this host.
            </p>
          )}
          {turns.map((turn, index) => {
            const incomplete = turn.state === "failed" || turn.state === "cancelled";
            const copyable = turn.state !== "streaming" && !!turn.response.trim();
            return (
              <article
                key={turn.id}
                aria-label={`Exchange ${index + 1}`}
                className={css({
                  minW: 0,
                  "&:not(:first-child)": {
                    mt: "5",
                    pt: "5",
                    borderTop: "1px solid token(colors.lineSoft)",
                  },
                })}
              >
                <div
                  className={css({
                    bg: "well",
                    borderLeft: "2px solid token(colors.lineStrong)",
                    borderRadius: "sm",
                    px: "3",
                    py: "2.5",
                    mb: "3.5",
                    minW: 0,
                  })}
                >
                  <h3 className={`${legend} ${css({ mb: "1" })}`}>You</h3>
                  <p
                    className={css({
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      fontSize: "sm",
                      lineHeight: 1.7,
                      color: "ink",
                    })}
                  >
                    {turn.prompt}
                  </p>
                </div>
                <h3 className={`${legend} ${css({ mb: "1.5", overflowWrap: "anywhere" })}`}>
                  Model response{" "}
                  <span
                    className={css({
                      textTransform: "none",
                      letterSpacing: "normal",
                      fontWeight: 400,
                      color: "inkSoft",
                    })}
                  >
                    / {turn.model}
                  </span>
                </h3>
                {turn.omittedTurns ? (
                  <p className={`${caption} ${css({ mb: "2" })}`}>
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
                {incomplete && (
                  <p
                    className={css({ color: "amber", fontSize: "xs", lineHeight: 1.55, mt: "2.5" })}
                  >
                    Incomplete exchange · This prompt and response are excluded from later context.
                  </p>
                )}
                {(incomplete || copyable) && (
                  <div
                    className={css({
                      display: "flex",
                      alignItems: "center",
                      gap: "1",
                      flexWrap: "wrap",
                      mt: "1.5",
                      ml: "-2.5",
                    })}
                  >
                    {incomplete && <CopyButton text={turn.prompt} label="Copy question" />}
                    {copyable && (
                      <CopyButton
                        text={turn.response}
                        label={
                          turn.state === "completed" ? "Copy response" : "Copy partial response"
                        }
                      />
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
      {!scroll.following && (
        <div
          className={css({
            position: "absolute",
            bottom: "3",
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          })}
        >
          <Button
            size="sm"
            onClick={scroll.jumpToLatest}
            className={css({ pointerEvents: "auto", bg: "panel", boxShadow: "pop" })}
          >
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}
