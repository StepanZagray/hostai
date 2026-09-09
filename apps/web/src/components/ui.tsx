import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, Copy, ArrowUpRight, Circle } from "lucide-react";
import { css, cva } from "../../styled-system/css";

export const panel = css({
  bg: "surface",
  border: "1px solid token(colors.line)",
  borderRadius: "12px",
  overflow: "hidden",
});
export const muted = css({ color: "muted", fontSize: "sm", lineHeight: 1.8 });
export const eyebrow = css({
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "muted",
});
export const row = css({ display: "flex", alignItems: "center", gap: "3" });
export const button = cva({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "2",
    minH: "42px",
    px: "4",
    py: "2",
    borderRadius: "7px",
    fontSize: "sm",
    fontWeight: 650,
    whiteSpace: "nowrap",
    transition: "background 140ms",
    _disabled: { opacity: 0.5 },
    "& svg": { width: "16px", height: "16px" },
  },
  variants: {
    variant: {
      primary: {
        bg: "accent",
        color: "white",
        border: "1px solid token(colors.accent)",
        _hover: { bg: "#075a6d" },
      },
      secondary: {
        bg: "surface",
        color: "ink",
        border: "1px solid token(colors.line)",
        _hover: { bg: "canvas" },
      },
      ghost: { color: "muted", _hover: { bg: "canvas", color: "ink" } },
    },
  },
  defaultVariants: { variant: "secondary" },
});
export function Button({
  variant,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  return <button className={`${button({ variant })} ${className}`} {...props} />;
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning" | "bad";
}) {
  return (
    <span className={badge({ tone })}>
      <Circle size={6} fill="currentColor" aria-hidden="true" />
      {children}
    </span>
  );
}
const badge = cva({
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "1.5",
    fontSize: "11px",
    fontWeight: 650,
    borderRadius: "5px",
    px: "2",
    py: "1",
    whiteSpace: "nowrap",
  },
  variants: {
    tone: {
      neutral: { bg: "canvas", color: "muted" },
      good: { bg: "successSoft", color: "success" },
      warning: { bg: "warningSoft", color: "warning" },
      bad: { bg: "dangerSoft", color: "danger" },
    },
  },
});
export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={css({
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "5",
        flexWrap: "wrap",
        mb: "7",
      })}
    >
      <div>
        <h1
          className={css({
            fontSize: { base: "25px", md: "29px" },
            fontWeight: 750,
            letterSpacing: "-0.035em",
            mb: "1.5",
          })}
        >
          {title}
        </h1>
        <p className={muted}>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function PanelHeading({
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
        p: "5",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "4",
        flexWrap: "wrap",
      })}
    >
      <div>
        <h2 className={css({ fontWeight: 750, fontSize: "15px", letterSpacing: "-0.02em" })}>
          {title}
        </h2>
        {description && <p className={muted}>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function CopyButton({
  text,
  label = "Copy",
  compact = false,
  disabled = false,
}: {
  text: string;
  label?: string;
  compact?: boolean;
  disabled?: boolean;
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
      if (attempt === sequence.current)
        setCopyState({ text, result: "Select and copy the text manually" });
    }
  }
  return (
    <span
      className={css({ display: "inline-flex", alignItems: "center", gap: "2", flexWrap: "wrap" })}
    >
      <Button
        variant="ghost"
        onClick={() => void copy()}
        aria-label={label}
        disabled={disabled || result === "Copying…"}
      >
        {result === "Copied" ? <Check /> : <Copy />}
        {!compact && label}
      </Button>
      <span role="status" className={css({ fontSize: "xs", color: "muted" })}>
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
        bg: "canvas",
        border: "1px solid token(colors.line)",
        borderRadius: "7px",
        display: "flex",
        alignItems: "center",
        gap: "2",
        pl: "4",
        pr: "1",
        minW: 0,
      })}
    >
      <pre
        className={css({
          fontSize: "xs",
          overflowX: "auto",
          py: "3",
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
        gap: "1.5",
        color: "accent",
        fontWeight: 650,
        fontSize: "sm",
        minH: "40px",
        _hover: { textDecoration: "underline" },
      })}
    >
      {children}
      <ArrowUpRight size={14} />
    </a>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={css({
        p: { base: "6", md: "10" },
        textAlign: "center",
        display: "flex",
        alignItems: "center",
        flexDirection: "column",
        gap: "3",
      })}
    >
      <div
        className={css({
          bg: "canvas",
          border: "1px solid token(colors.line)",
          color: "muted",
          p: "3",
          borderRadius: "10px",
          mb: "1",
        })}
      >
        {icon}
      </div>
      <h3 className={css({ fontWeight: 750 })}>{title}</h3>
      <p className={css({ color: "muted", maxW: "380px", fontSize: "sm", lineHeight: 1.8 })}>
        {description}
      </p>
      {action}
    </div>
  );
}
