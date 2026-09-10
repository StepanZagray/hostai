import { useEffect, useRef, useState } from "react";
import { css } from "../../styled-system/css";
import { Button, muted } from "../components/ui";

export function GuestKeyForm({
  shown,
  secondary,
  checking,
  value,
  focusOnShow,
  onChange,
  onConnect,
}: {
  shown: boolean;
  secondary: boolean;
  checking: boolean;
  value: string;
  focusOnShow: boolean;
  onChange: (value: string) => void;
  onConnect: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (shown && focusOnShow) input.current?.focus({ preventScroll: true });
  }, [shown, focusOnShow]);
  if (!shown) return null;
  const form = (
    <form
      className={css({ my: "3" })}
      onSubmit={(event) => {
        event.preventDefault();
        onConnect();
      }}
    >
      <label htmlFor="guest-key" className={css({ display: "block", fontWeight: 650, mb: "2" })}>
        Access key
      </label>
      <div className={css({ display: "flex", alignItems: "center", gap: "2", flexWrap: "wrap" })}>
        <input
          id="guest-key"
          ref={input}
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={256}
          required
          value={value}
          onFocus={() => setExpanded(true)}
          onChange={(event) => onChange(event.target.value)}
          disabled={checking}
          aria-describedby="guest-disclosure guest-key-help"
          className={css({
            w: "full",
            minW: 0,
            minH: "44px",
            bg: "canvas",
            border: "1px solid token(colors.line)",
            borderRadius: "7px",
            px: "3",
            py: "2",
            flex: "1 1 180px",
            _disabled: { opacity: 0.65, cursor: "not-allowed" },
          })}
        />
        <Button type="submit" variant="primary" disabled={checking || !value}>
          Connect
        </Button>
      </div>
      <p id="guest-key-help" className={`${muted} ${css({ mt: "2" })}`}>
        Use the key supplied by this host. A different key clears your conversation and draft. Your
        key stays in this tab only; disconnecting or reloading loses it.
      </p>
    </form>
  );
  return (
    <details
      open={expanded || !secondary}
      className={
        secondary ? css({ borderTop: "1px solid token(colors.line)", pt: "3", mt: "4" }) : undefined
      }
      onToggle={(event) => {
        if (secondary) setExpanded(event.currentTarget.open);
      }}
    >
      <summary
        hidden={!secondary}
        className={css({ cursor: "pointer", fontWeight: 650, py: "2", minH: "44px" })}
      >
        Have an access key?
      </summary>
      {form}
    </details>
  );
}
