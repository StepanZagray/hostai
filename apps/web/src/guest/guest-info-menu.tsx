import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { css } from "../../styled-system/css";
import { Led, panel, type LedState } from "../components/ui";

/**
 * The top bar's session menu: what this connection is, what it exposes and how to
 * change it, without a wall of prose above the model interface.
 *
 * A native `<details>` is deliberate. Its content stays in the document while the
 * menu is closed, so the access key field and the composer can keep pointing at
 * `#guest-disclosure` with `aria-describedby`; a conditionally rendered panel would
 * silently break those descriptions. Nothing in here is an alert: errors, the retry
 * countdown and the key form stay on the page where they cannot be missed.
 */
const shell = css({ minW: 0 });
const trigger = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "1.5",
  minH: "44px",
  px: "2.5",
  borderRadius: "sm",
  border: "1px solid transparent",
  fontSize: "xs",
  fontWeight: 500,
  lineHeight: 1.3,
  color: "inkSoft",
  whiteSpace: "nowrap",
  listStyle: "none",
  transition: "background token(durations.fast) token(easings.out), color token(durations.fast)",
  "&::-webkit-details-marker": { display: "none" },
  _hover: { bg: "well", color: "ink" },
  "& svg": {
    flexShrink: 0,
    width: "15px",
    height: "15px",
    color: "muted",
    transition: "transform token(durations.fast) token(easings.out)",
  },
});
const disclosure = css({
  "&[open] > summary": { bg: "well", color: "ink", borderColor: "line" },
  "&[open] [data-chevron]": { transform: "rotate(180deg)" },
});
const sheet = css({
  // Anchored to the header, not to the trigger: the trigger sits an unknown distance
  // from the right edge (the theme toggle follows it), so anchoring to it would push
  // the sheet off the left of a narrow screen. Left overflow never raises
  // scrollWidth, so no overflow assertion would have caught that.
  position: "absolute",
  top: "100%",
  right: { base: "4", md: "6" },
  left: { base: "4", md: "auto" },
  zIndex: 50,
  w: { base: "auto", md: "360px" },
  maxH: "calc(100dvh - 96px)",
  overflowY: "auto",
  overscrollBehavior: "contain",
  boxShadow: "pop",
  px: "4",
  py: "4",
  textAlign: "start",
  whiteSpace: "normal",
});
const hideNarrow = css({ display: { base: "none", sm: "inline" } });

/**
 * `state` is the access reading in three or four words. It rides on the summary's
 * accessible name and is mirrored by the lamp beside it, so a guest can tell whether
 * their access is live without opening anything, whether they read the bar or hear it.
 * The full sentence still lives inside the menu.
 */
export function GuestInfoMenu({
  label,
  state,
  light,
  children,
}: {
  label: string;
  state: string;
  light: LedState;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return (
    <details
      ref={root}
      open={open}
      className={`${shell} ${disclosure}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        // Escape closes the menu and hands focus back to its own control, so the
        // panel never disappears from under the keyboard.
        event.stopPropagation();
        setOpen(false);
        summary.current?.focus();
      }}
    >
      <summary
        ref={summary}
        id="guest-session-menu"
        className={trigger}
        aria-label={`${label} · ${state}`}
      >
        <Info aria-hidden="true" />
        <Led state={light} />
        <span className={hideNarrow}>{label}</span>
        <ChevronDown data-chevron="" aria-hidden="true" />
      </summary>
      <div className={`${panel} ${sheet}`}>{children}</div>
    </details>
  );
}
