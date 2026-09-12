import { useEffect, useRef, useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { Check, ChevronRight, Copy, ArrowUpRight } from "lucide-react";
import { css, cva } from "../../styled-system/css";

/* Text ------------------------------------------------------------------ */

export const muted = css({ color: "muted", fontSize: "sm", lineHeight: 1.55 });
export const caption = css({ color: "muted", fontSize: "xs", lineHeight: 1.55 });
/** A panel legend: the small engraved label beside a reading. */
export const legend = css({ textStyle: "legend", color: "muted" });
export const label = legend;
export const mono = css({ fontFamily: "mono", overflowWrap: "anywhere" });
export const row = css({ display: "flex", alignItems: "center", gap: "2", flexWrap: "wrap" });

/* Surfaces -------------------------------------------------------------- */

export const panel = css({
  bg: "panel",
  border: "1px solid token(colors.line)",
  borderRadius: "lg",
});

/* Status lights --------------------------------------------------------- */

export type LedState = "live" | "amber" | "stop" | "off" | "busy";

const led = cva({
  base: {
    display: "inline-block",
    w: "7px",
    h: "7px",
    borderRadius: "full",
    flexShrink: 0,
    bg: "faint",
  },
  variants: {
    state: {
      live: {
        bg: "live",
        boxShadow: "0 0 0 2px token(colors.liveSoft), 0 0 6px token(colors.liveGlow)",
      },
      amber: {
        bg: "amber",
        boxShadow: "0 0 0 2px token(colors.amberSoft), 0 0 6px token(colors.amberGlow)",
      },
      stop: {
        bg: "stop",
        boxShadow: "0 0 0 2px token(colors.stopSoft), 0 0 6px token(colors.stopGlow)",
      },
      off: { bg: "faint", opacity: 0.7 },
      busy: { bg: "amber", animation: "breathe 1.6s ease-in-out infinite" },
    },
  },
  defaultVariants: { state: "off" },
});

/** A hardware-style indicator. Decorative: the state is always also spelled out. */
export function Led({ state, className = "" }: { state: LedState; className?: string }) {
  return <span aria-hidden="true" className={`${led({ state })} ${className}`} />;
}

const toneState: Record<string, LedState> = {
  neutral: "off",
  good: "live",
  warning: "amber",
  bad: "stop",
  accent: "live",
  busy: "busy",
};
const toneColor = cva({
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "2",
    fontFamily: "mono",
    fontSize: "2xs",
    fontWeight: 500,
    letterSpacing: "0.01em",
    lineHeight: 1.4,
    whiteSpace: "nowrap",
  },
  variants: {
    tone: {
      neutral: { color: "muted" },
      good: { color: "live" },
      warning: { color: "amber" },
      bad: { color: "stop" },
      accent: { color: "inkSoft" },
      busy: { color: "muted" },
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type Tone = "neutral" | "good" | "warning" | "bad" | "accent" | "busy";

/** A light and a legend: the only way state is shown anywhere in the workspace. */
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={toneColor({ tone })}>
      <Led state={toneState[tone]} />
      {children}
    </span>
  );
}

/* Buttons --------------------------------------------------------------- */

export const button = cva({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "2",
    minH: "36px",
    px: "3",
    py: "1.5",
    borderRadius: "sm",
    fontSize: "sm",
    fontWeight: 500,
    lineHeight: 1.3,
    border: "1px solid transparent",
    transition:
      "background token(durations.fast) token(easings.out), color token(durations.fast), border-color token(durations.fast), transform token(durations.fast)",
    _active: { transform: "scale(0.98)" },
    _disabled: { opacity: 0.45, transform: "none" },
    "& svg": { width: "15px", height: "15px", flexShrink: 0 },
  },
  variants: {
    variant: {
      primary: {
        bg: "action",
        color: "onAction",
        borderColor: "action",
        _hover: { bg: "actionHover", borderColor: "actionHover" },
        _disabled: { _hover: { bg: "action", borderColor: "action" } },
      },
      secondary: {
        bg: "panel",
        color: "ink",
        borderColor: "lineStrong",
        _hover: { bg: "well" },
        _disabled: { _hover: { bg: "panel" } },
      },
      ghost: {
        color: "inkSoft",
        _hover: { bg: "well", color: "ink" },
        _disabled: { _hover: { bg: "transparent", color: "inkSoft" } },
      },
      danger: {
        color: "stop",
        _hover: { bg: "stopSoft" },
      },
    },
    size: {
      sm: { minH: "32px", px: "2.5", fontSize: "xs", gap: "1.5" },
      md: {},
    },
  },
  defaultVariants: { variant: "secondary", size: "md" },
});

export function Button({
  variant,
  size,
  className = "",
  ...props
}: ComponentPropsWithRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
}) {
  return <button className={`${button({ variant, size })} ${className}`} {...props} />;
}

/* Headings -------------------------------------------------------------- */

export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={css({
        display: "flex",
        justifyContent: "space-between",
        alignItems: "end",
        gap: "4",
        flexWrap: "wrap",
        mb: { base: "5", md: "6" },
      })}
    >
      <div className={css({ minW: 0 })}>
        <h1 className={css({ textStyle: "display" })}>{title}</h1>
        {description && <p className={`${muted} ${css({ mt: "1" })}`}>{description}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * A card with an optional header. `flush` skips body padding so tables and
 * lists can reach the card edges.
 */
export function Section({
  title,
  description,
  action,
  aside,
  children,
  flush = false,
  className = "",
  ...props
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  className?: string;
} & Omit<ComponentPropsWithRef<"section">, "title">) {
  return (
    <section className={`${panel} ${css({ overflow: "hidden", minW: 0 })} ${className}`} {...props}>
      {(title || action) && (
        <div
          className={css({
            display: "flex",
            alignItems: "start",
            justifyContent: "space-between",
            gap: "3",
            flexWrap: "wrap",
            px: { base: "3.5", md: "4" },
            pt: { base: "3.5", md: "4" },
            pb: description ? "3" : "2.5",
          })}
        >
          <div className={css({ minW: 0 })}>
            <div
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "3",
                flexWrap: "wrap",
                minW: 0,
              })}
            >
              {title && <h2 className={css({ textStyle: "title" })}>{title}</h2>}
              {aside}
            </div>
            {description && <p className={`${caption} ${css({ mt: "1" })}`}>{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div
        className={
          flush
            ? css({ minW: 0 })
            : css({
                px: { base: "3.5", md: "4" },
                pb: { base: "3.5", md: "4" },
                pt: title ? "0" : { base: "3.5", md: "4" },
                minW: 0,
              })
        }
      >
        {children}
      </div>
    </section>
  );
}

/* Readings -------------------------------------------------------------- */

/** One instrument reading: a legend, a large tabular value and a note. */
export function Readout({
  label: text,
  value,
  sub,
  tone = "neutral",
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className={css({ minW: 0, display: "grid", gap: "1", alignContent: "start" })}>
      <p className={legend}>{text}</p>
      <p
        className={css({
          fontFamily: "mono",
          fontSize: { base: "xl", md: "2xl" },
          fontWeight: 400,
          letterSpacing: "-0.02em",
          lineHeight: 1.1,
          fontVariantNumeric: "tabular-nums",
          color: tone === "warning" ? "amber" : tone === "bad" ? "stop" : "ink",
          overflowWrap: "anywhere",
        })}
      >
        {value}
      </p>
      {sub && <p className={caption}>{sub}</p>}
    </div>
  );
}

/* Form fields ----------------------------------------------------------- */

export const control = css({
  minH: "36px",
  w: "full",
  minW: 0,
  bg: "well",
  color: "ink",
  border: "1px solid token(colors.line)",
  borderRadius: "sm",
  px: "2.5",
  fontSize: "sm",
  transition: "border-color token(durations.fast)",
  _hover: { borderColor: "lineStrong" },
  _focusVisible: { outlineOffset: "1px" },
  _disabled: { opacity: 0.55, cursor: "not-allowed", _hover: { borderColor: "line" } },
});

export const fieldLabel = css({ fontSize: "xs", fontWeight: 500, color: "ink" });

export function Field({
  label: text,
  hint,
  error,
  htmlFor,
  children,
  className = "",
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const Tag = htmlFor ? "div" : "label";
  return (
    <Tag className={`${css({ display: "grid", gap: "1.5", minW: 0 })} ${className}`}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={fieldLabel}>
          {text}
        </label>
      ) : (
        <span className={fieldLabel}>{text}</span>
      )}
      {children}
      {hint && <span className={caption}>{hint}</span>}
      {error && (
        <span role="alert" className={css({ fontSize: "xs", color: "stop" })}>
          {error}
        </span>
      )}
    </Tag>
  );
}

/** A keyboard key, for composer hints. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className={css({
        fontFamily: "mono",
        fontSize: "2xs",
        px: "1",
        py: "0.5",
        borderRadius: "xs",
        border: "1px solid token(colors.lineStrong)",
        bg: "panel",
        color: "inkSoft",
        lineHeight: 1,
        display: "inline-block",
      })}
    >
      {children}
    </kbd>
  );
}

/* Callouts and disclosure ----------------------------------------------- */

const note = cva({
  base: {
    display: "flex",
    gap: "2.5",
    alignItems: "start",
    fontSize: "xs",
    lineHeight: 1.55,
    borderRadius: "sm",
    borderLeft: "2px solid",
    px: "3",
    py: "2.5",
    "& a": { color: "inherit", textDecoration: "underline", textUnderlineOffset: "2px" },
  },
  variants: {
    tone: {
      neutral: { bg: "well", color: "inkSoft", borderColor: "lineStrong" },
      accent: { bg: "well", color: "ink", borderColor: "ink" },
      warning: { bg: "amberSoft", color: "amber", borderColor: "amber" },
      danger: { bg: "stopSoft", color: "stop", borderColor: "stop" },
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Note({
  tone,
  icon,
  children,
  className = "",
  ...props
}: {
  tone?: "neutral" | "accent" | "warning" | "danger";
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
} & ComponentPropsWithRef<"p">) {
  return (
    <p className={`${note({ tone })} ${className}`} {...props}>
      {icon && (
        <span className={css({ mt: "0.5", "& svg": { w: "14px", h: "14px" } })}>{icon}</span>
      )}
      <span className={css({ minW: 0 })}>{children}</span>
    </p>
  );
}

/** Progressive disclosure for detail that most people never need to read. */
export function Disclosure({
  summary,
  children,
  className = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details
      className={`${css({
        borderTop: "1px solid token(colors.lineSoft)",
        "&[open] > summary": { color: "ink" },
        "&[open] > summary > svg": { transform: "rotate(90deg)" },
      })} ${className}`}
    >
      <summary
        className={css({
          display: "flex",
          alignItems: "center",
          gap: "1.5",
          minH: "36px",
          fontSize: "xs",
          fontWeight: 500,
          color: "muted",
          listStyle: "none",
          _hover: { color: "ink" },
          "&::-webkit-details-marker": { display: "none" },
          "& svg": { transition: "transform token(durations.fast) token(easings.out)" },
        })}
      >
        <ChevronRight size={13} aria-hidden="true" />
        {summary}
      </summary>
      <div className={`${caption} ${css({ pb: "2", display: "grid", gap: "2" })}`}>{children}</div>
    </details>
  );
}

/* Data ------------------------------------------------------------------ */

export function DataList({ items }: { items: { term: ReactNode; value: ReactNode }[] }) {
  return (
    <dl
      className={css({
        display: "grid",
        gap: "0",
        "& > div": {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "3",
          py: "2.5",
          flexWrap: "wrap",
          borderBottom: "1px solid token(colors.lineSoft)",
        },
        "& > div:last-child": { borderBottom: "none", pb: 0 },
        "& dt": { textStyle: "legend", color: "muted" },
        "& dd": {
          fontFamily: "mono",
          fontSize: "xs",
          overflowWrap: "anywhere",
          textAlign: "right",
          color: "ink",
        },
      })}
    >
      {items.map((item, index) => (
        <div key={index}>
          <dt>{item.term}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* Clipboard ------------------------------------------------------------- */

export function CopyButton({
  text,
  label: text_label = "Copy",
  compact = false,
  disabled = false,
  failureMessage = "Copy failed — select the text and copy it manually",
}: {
  text: string;
  label?: string;
  compact?: boolean;
  disabled?: boolean;
  failureMessage?: string;
}) {
  const [copyState, setCopyState] = useState<{ text: string; result: string } | null>(null);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const result = copyState?.text === text ? copyState.result : "";
  async function copy() {
    const attempt = ++sequence.current;
    setCopyState({ text, result: "Copying…" });
    try {
      await navigator.clipboard.writeText(text);
      if (attempt === sequence.current) setCopyState({ text, result: "Copied" });
    } catch {
      if (attempt === sequence.current) setCopyState({ text, result: failureMessage });
    }
  }
  return (
    <span
      className={css({ display: "inline-flex", alignItems: "center", gap: "2", flexWrap: "wrap" })}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void copy()}
        aria-label={text_label}
        disabled={disabled || result === "Copying…"}
      >
        {result === "Copied" ? <Check /> : <Copy />}
        {!compact && text_label}
      </Button>
      <span role="status" className={caption}>
        {result}
      </span>
    </span>
  );
}

export function CodeBlock({
  code,
  copyLabel = "Copy command",
}: {
  code: string;
  copyLabel?: string;
}) {
  return (
    <div
      className={css({
        bg: "well",
        border: "1px solid token(colors.line)",
        borderRadius: "sm",
        display: "flex",
        alignItems: "center",
        gap: "1",
        pl: "3",
        pr: "1",
        minW: 0,
      })}
    >
      <pre
        className={css({
          fontSize: "xs",
          lineHeight: 1.6,
          overflowX: "auto",
          py: "2.5",
          flex: 1,
          minW: 0,
          color: "ink",
        })}
      >
        {code}
      </pre>
      <CopyButton text={code} compact label={copyLabel} />
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={css({
        display: "inline-flex",
        alignItems: "center",
        gap: "1",
        color: "ink",
        fontWeight: 500,
        fontSize: "sm",
        minH: "32px",
        textDecoration: "underline",
        textUnderlineOffset: "3px",
        textDecorationColor: "token(colors.lineStrong)",
        _hover: { textDecorationColor: "token(colors.ink)" },
      })}
    >
      {children}
      <ArrowUpRight size={13} />
    </a>
  );
}

/* Empty state ----------------------------------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={css({
        py: { base: "8", md: "10" },
        px: "5",
        textAlign: "center",
        display: "flex",
        alignItems: "center",
        flexDirection: "column",
        gap: "1.5",
      })}
    >
      {icon && (
        <div className={css({ color: "faint", mb: "1" })} aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className={css({ fontWeight: 600, fontSize: "md" })}>{title}</h3>
      {description && <p className={`${muted} ${css({ maxW: "44ch" })}`}>{description}</p>}
      {action && <div className={css({ mt: "2.5" })}>{action}</div>}
    </div>
  );
}
