import { useEffect, useRef } from "react";
import { css } from "../../styled-system/css";
import { Button, caption, control, fieldLabel } from "../components/ui";

/**
 * The primary way in: the host sends a plain address, the guest pastes the key here.
 * It is never hidden behind a disclosure while a working key is missing.
 */
export function GuestKeyForm({
  shown,
  checking,
  blocked = false,
  value,
  focusOnShow,
  focusWhenIdle = false,
  onChange,
  onConnect,
}: {
  shown: boolean;
  checking: boolean;
  blocked?: boolean;
  value: string;
  focusOnShow: boolean;
  focusWhenIdle?: boolean;
  onChange: (value: string) => void;
  onConnect: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (shown && focusOnShow) input.current?.focus({ preventScroll: true });
  }, [shown, focusOnShow]);
  useEffect(() => {
    if (shown && focusWhenIdle && document.activeElement === document.body)
      input.current?.focus({ preventScroll: true });
  }, [shown, focusWhenIdle]);
  if (!shown) return null;
  return (
    <form
      className={css({ my: "3" })}
      onSubmit={(event) => {
        event.preventDefault();
        if (!checking && !blocked) {
          input.current?.focus({ preventScroll: true });
          onConnect();
        }
      }}
    >
      <label
        htmlFor="guest-key"
        className={`${fieldLabel} ${css({ display: "block", mb: "1.5" })}`}
      >
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
          onChange={(event) => onChange(event.target.value)}
          readOnly={checking}
          aria-busy={checking}
          aria-describedby="guest-disclosure guest-key-help"
          className={`${control} ${css({ flex: "1 1 180px", w: "auto", _readOnly: { opacity: 0.65 } })}`}
        />
        <Button type="submit" variant="primary" disabled={checking || blocked || !value}>
          Connect
        </Button>
      </div>
      <p id="guest-key-help" className={`${caption} ${css({ mt: "1.5" })}`}>
        Paste the key your host sent you. It stays in this tab only. Connecting with a different key
        clears your conversation; a failed attempt keeps it.
      </p>
    </form>
  );
}
