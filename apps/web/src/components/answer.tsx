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
        my: "4",
        minW: 0,
        border: "1px solid token(colors.line)",
        borderRadius: "7px",
        overflow: "hidden",
        bg: "canvas",
      })}
    >
      <div
        className={css({
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          px: "3",
          gap: "3",
          borderBottom: "1px solid token(colors.line)",
        })}
      >
        <span
          className={css({ fontFamily: "mono", fontSize: "xs", overflowWrap: "anywhere", minW: 0 })}
        >
          {language}
        </span>
        <CopyButton text={text} label="Copy code" disabled={!text} />
      </div>
      <pre
        tabIndex={0}
        aria-label={`${language} code`}
        className={css({ overflowX: "auto", p: "4", fontSize: "xs", lineHeight: 1.7 })}
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
      className={css({ overflowX: "auto", my: "4" })}
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
        lineHeight: 1.8,
        overflowWrap: "anywhere",
        minW: 0,
        "& p": { my: "3", whiteSpace: "pre-wrap" },
        "& > :first-child": { mt: 0 },
        "& > :last-child": { mb: 0 },
        "& h4, & h5, & h6": { fontWeight: 750, mt: "5", mb: "2", fontSize: "md" },
        "& ul": { listStyleType: "disc", pl: "6", my: "3" },
        "& ol": { listStyleType: "decimal", pl: "6", my: "3" },
        "& li": { my: "1" },
        "& blockquote": {
          borderLeft: "3px solid token(colors.line)",
          pl: "4",
          color: "muted",
          my: "3",
        },
        "& a": { color: "accent", textDecoration: "underline", textUnderlineOffset: "3px" },
        "& code": { fontFamily: "mono", fontSize: "0.92em" },
        "& :not(pre) > code": { bg: "canvas", px: "1", borderRadius: "3px" },
        "& pre code": { whiteSpace: "pre", overflowWrap: "normal" },
        "& th, & td": {
          border: "1px solid token(colors.line)",
          px: "3",
          py: "2",
          textAlign: "left",
        },
        "& th": { fontWeight: 700, bg: "canvas" },
        "& hr": { my: "4", borderColor: "line" },
        "& [tabindex]:focus-visible": {
          outline: "2px solid token(colors.accent)",
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
