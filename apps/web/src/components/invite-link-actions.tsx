import { useCallback, useEffect, useId, useRef, useState } from "react";
import { css } from "../../styled-system/css";
import { Button, CopyButton, muted } from "./ui";

/** An explicit, temporary reveal; the parent owns permission and invite lifetime. */
export function InviteLinkActions({
  url,
  disabled,
  onDismiss,
  onFocusLost,
  disabledReason,
}: {
  url: string;
  disabled: boolean;
  onDismiss: () => void;
  onFocusLost: () => void;
  disabledReason: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const revealButton = useRef<HTMLButtonElement>(null);
  const help = useId();
  const fieldId = useId();
  useEffect(() => {
    if (disabled) setRevealed(false);
  }, [disabled]);
  const selectField = useCallback(
    (input: HTMLInputElement | null) => {
      if (!input) return;
      input.focus();
      input.select();
      return () => {
        // A status change can remove a focused secret without an explicit button press.
        if (document.activeElement === input) {
          if (group.current) group.current.focus({ preventScroll: true });
          else onFocusLost();
        }
      };
    },
    [onFocusLost],
  );
  return (
    <div ref={group} role="group" aria-label="Client link actions" tabIndex={-1}>
      <div className={css({ display: "flex", gap: "3", flexWrap: "wrap" })}>
        <CopyButton
          text={url}
          label="Copy client link"
          disabled={disabled}
          failureMessage="Copy failed. Use Show link for manual copy."
        />
        <Button type="button" onClick={onDismiss}>
          Hide link
        </Button>
      </div>
      <Button
        type="button"
        ref={revealButton}
        variant="ghost"
        disabled={disabled}
        aria-expanded={revealed && !disabled}
        aria-controls={revealed && !disabled ? fieldId : undefined}
        onClick={() => {
          setRevealed((value) => !value);
          revealButton.current?.focus();
        }}
        className={css({ mt: "2", whiteSpace: "normal", textAlign: "left" })}
      >
        {revealed && !disabled ? "Hide link text" : "Show link for manual copy"}
      </Button>
      {disabled && (
        <p role="status" className={muted}>
          {disabledReason}
        </p>
      )}
      {revealed && !disabled && (
        <div
          className={css({ display: "grid", gap: "2", mt: "2", fontSize: "xs", fontWeight: 650 })}
        >
          <label htmlFor={fieldId}>Client link for manual copy</label>
          <input
            id={fieldId}
            ref={selectField}
            value={url}
            readOnly
            autoComplete="off"
            spellCheck={false}
            aria-describedby={help}
            className={css({
              w: "full",
              minW: 0,
              minH: "44px",
              px: "3",
              bg: "canvas",
              border: "1px solid token(colors.line)",
              borderRadius: "7px",
              fontSize: "sm",
              fontFamily: "mono",
            })}
            onFocus={(event) => event.currentTarget.select()}
          />
          <span id={help} className={muted}>
            Copy the selected link with your browser’s copy command. It includes the access key;
            send it only to your intended guest. Hiding this text does not revoke the key.
          </span>
        </div>
      )}
    </div>
  );
}
