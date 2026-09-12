import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { css } from "../../styled-system/css";
import { Button, caption, control, fieldLabel } from "./ui";

const mask = css({
  fontFamily: "mono",
  fontSize: "xs",
  color: "muted",
  letterSpacing: "0.18em",
  userSelect: "none",
  px: "3",
  py: "2.5",
  minH: "44px",
  display: "flex",
  alignItems: "center",
  bg: "well",
  border: "1px solid token(colors.line)",
  borderRadius: "sm",
});

/**
 * A stored key stays masked until the host asks for it: copying never renders the
 * credential, and only an explicit unmask puts it in the document.
 */
export function AccessKeyField({
  label,
  token,
  reading,
  disabled,
  onCopy,
  onReveal,
  onMask,
}: {
  label: string;
  token: string | null;
  reading: boolean;
  disabled: boolean;
  onCopy: () => Promise<string | null>;
  onReveal: () => void;
  onMask: () => void;
}) {
  const [status, setStatus] = useState("");
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const copy = useCallback(async () => {
    const attempt = ++sequence.current;
    setStatus("Copying…");
    try {
      const value = await onCopy();
      if (attempt !== sequence.current) return;
      if (!value) return setStatus("The key could not be read. Refresh access and try again.");
      await navigator.clipboard.writeText(value);
      if (attempt === sequence.current) setStatus("Copied");
    } catch {
      if (attempt === sequence.current)
        setStatus("Copy failed. Show the key and copy it manually.");
    }
  }, [onCopy]);
  return (
    <div
      role="group"
      aria-label={`Access key for ${label}`}
      className={css({ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "2", minW: 0 })}
    >
      <span className={fieldLabel}>Access key</span>
      {token ? (
        <input
          readOnly
          value={token}
          aria-label={`Access key for ${label}, visible`}
          autoComplete="off"
          spellCheck={false}
          className={`${control} ${css({ fontFamily: "mono", fontSize: "xs" })}`}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : (
        <p className={mask}>{"•".repeat(24)}</p>
      )}
      <div className={css({ display: "flex", gap: "2", flexWrap: "wrap", alignItems: "center" })}>
        <Button size="sm" disabled={disabled || status === "Copying…"} onClick={() => void copy()}>
          {status === "Copied" ? <Check size={15} /> : <Copy size={15} />}
          Copy key {label}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          aria-pressed={!!token}
          onClick={() => (token ? onMask() : onReveal())}
        >
          {token ? <EyeOff size={15} /> : <Eye size={15} />}
          {reading ? "Reading key…" : token ? `Hide key ${label}` : `Show key ${label}`}
        </Button>
        <span role="status" className={caption}>
          {status}
        </span>
      </div>
    </div>
  );
}
