import { Children, isValidElement, memo, useDeferredValue, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { css } from "../../styled-system/css";
import { externalUrl } from "../../../shared/external-url.mjs";
import { CopyButton } from "./ui";

function CodeFence({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children)[0];
  const props = isValidElement<{ children?: string; className?: string }>(code) ? code.props : {};
  const text = typeof props.children === "string" ? props.children : "";
  const language = props.className?.replace(/^language-/, "") || "Code";
  return (
    <div
      className={css({
        my: "3",
        minW: 0,
        bg: "well",
        border: "1px solid token(colors.line)",
        borderRadius: "sm",
        overflow: "hidden",
      })}
    >
      <div
        className={css({
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "3",
          pl: "3",
          pr: "1",
          minH: "34px",
          borderBottom: "1px solid token(colors.line)",
        })}
      >
        <span
          className={css({
            fontFamily: "mono",
            fontSize: "xs",
            color: "muted",
            overflowWrap: "anywhere",
            minW: 0,
          })}
        >
          {language}
        </span>
        <CopyButton text={text} label="Copy code" disabled={!text} />
      </div>
      <pre
        tabIndex={0}
        aria-label={`${language} code`}
        className={css({
          overflowX: "auto",
          px: "3",
          py: "3",
          fontSize: "xs",
          lineHeight: 1.7,
          color: "ink",
        })}
      >
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  pre: CodeFence,
  // Model links never navigate the current conversation, invoke other URL
  // schemes, or fetch images. The desktop uses the same HTTPS policy.
  a: ({ href, children }) => {
    const url = href ? externalUrl(href) : null;
    const label = Children.toArray(children).join("");
    const sameLabel = href === label || href === `mailto:${label}` || href === `http://${label}`;
    return url ? (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>
        {children}
        {href && !sameLabel ? ` (${href})` : ""}
      </span>
    );
  },
  img: ({ alt }) => (
    <span className={css({ color: "muted", fontStyle: "italic" })}>
      [Image: {alt || "No description"}]
    </span>
  ),
  h1: ({ children }) => <h4>{children}</h4>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h4>{children}</h4>,
  h5: ({ children }) => <h5>{children}</h5>,
  h6: ({ children }) => <h6>{children}</h6>,
  table: ({ children }) => (
    <div
      role="region"
      aria-label="Answer table"
      tabIndex={0}
      className={css({ overflowX: "auto", my: "3", minW: 0 })}
    >
      <table>{children}</table>
    </div>
  ),
};

// Keep the expensive parser behind a memo boundary: urgent updates with the
// previous deferred value must not parse it again.
const FormattedAnswer = memo(function FormattedAnswer({ text }: { text: string }) {
  return (
    <div
      className={css({
        fontSize: "sm",
        lineHeight: 1.7,
        color: "ink",
        overflowWrap: "anywhere",
        minW: 0,
        "& p": { my: "2.5", whiteSpace: "pre-wrap" },
        "& > :first-child": { mt: 0 },
        "& > :last-child": { mb: 0 },
        "& h4, & h5, & h6": {
          fontWeight: 600,
          letterSpacing: "-0.01em",
          lineHeight: 1.35,
          mt: "4",
          mb: "1.5",
        },
        "& h4": { fontSize: "md" },
        "& h5, & h6": { fontSize: "sm" },
        "& h6": { color: "inkSoft" },
        "& strong": { fontWeight: 600 },
        "& ul": { listStyleType: "disc", pl: "5", my: "2.5" },
        "& ol": { listStyleType: "decimal", pl: "5", my: "2.5" },
        "& li": { my: "1" },
        "& li > p": { my: "1" },
        "& blockquote": {
          borderLeft: "2px solid token(colors.lineStrong)",
          pl: "3",
          color: "inkSoft",
          my: "3",
        },
        "& a": {
          color: "ink",
          textDecoration: "underline",
          textUnderlineOffset: "3px",
          textDecorationColor: "token(colors.lineStrong)",
          _hover: { textDecorationColor: "token(colors.ink)" },
        },
        "& code": { fontFamily: "mono", fontSize: "0.92em" },
        "& :not(pre) > code": { bg: "well", px: "1", borderRadius: "xs" },
        "& pre code": { whiteSpace: "pre", overflowWrap: "normal", fontSize: "inherit" },
        "& table": { w: "full", borderCollapse: "collapse", fontSize: "xs", lineHeight: 1.5 },
        "& th, & td": {
          px: "2.5",
          py: "1.5",
          textAlign: "left",
          verticalAlign: "top",
          overflowWrap: "normal",
        },
        "& td": { borderBottom: "1px solid token(colors.lineSoft)" },
        "& th": {
          fontFamily: "mono",
          fontSize: "2xs",
          fontWeight: 500,
          letterSpacing: "0.04em",
          color: "muted",
          borderBottom: "1px solid token(colors.line)",
        },
        "& hr": { my: "4", border: "none", borderTop: "1px solid token(colors.line)" },
        "& [tabindex]:focus-visible": {
          outline: "2px solid token(colors.ink)",
          outlineOffset: "-2px",
        },
      })}
    >
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
});

export function Answer({ text }: { text: string }) {
  // Prioritize interaction and fresh request state over another full Markdown parse.
  const displayedText = useDeferredValue(text);
  return (
    <div aria-busy={displayedText !== text}>
      <FormattedAnswer text={displayedText} />
    </div>
  );
}
