import { useEffect, useRef } from "react";
import { css } from "../../styled-system/css";
import { createModelUiHost, type ModelUiScope } from "../lib/model-ui-host";
import { observeEffectiveTheme, resolveEffectiveTheme } from "../lib/theme";
import { caption } from "./ui";

export interface ModelUiFrameProps {
  /** Model name announced to the frame in `hello`. */
  model: string;
  /** Runtime id, shown in the caption. */
  runtime: string;
  /** Same-origin asset route for the runtime's entry page. */
  src: string;
  scope: ModelUiScope;
  /** Starts one inference on the caller's channel; must honour `signal`. */
  infer: (input: unknown, signal: AbortSignal) => Promise<Response>;
  title: string;
  className?: string;
}

/**
 * A runtime-provided interface in a sandboxed frame that fills its container.
 * Remount (change `key`) when the model changes; the frame keeps its own state.
 */
export function ModelUiFrame({
  model,
  runtime,
  src,
  scope,
  infer,
  title,
  className = "",
}: ModelUiFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const inferRef = useRef(infer);
  inferRef.current = infer;
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const host = createModelUiHost({
      frame,
      model,
      scope,
      theme: resolveEffectiveTheme(),
      infer: (input, signal) => inferRef.current(input, signal),
    });
    const stopTheme = observeEffectiveTheme((theme) => host.setTheme(theme));
    return () => {
      stopTheme();
      host.dispose();
    };
  }, [model, scope]);
  return (
    <div
      className={`${css({
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minH: 0,
        minW: 0,
      })} ${className}`}
    >
      <iframe
        ref={frameRef}
        key={`${model}:${src}`}
        src={src}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={css({
          display: "block",
          flex: 1,
          w: "full",
          minH: "320px",
          border: "none",
          bg: "paper",
          colorScheme: "light dark",
        })}
      />
      <p
        className={`${caption} ${css({
          px: "3",
          py: "2",
          borderTop: "1px solid token(colors.line)",
        })}`}
      >
        Interface provided by the <span className={css({ fontFamily: "mono" })}>{runtime}</span>{" "}
        runtime. It runs sandboxed with no network or storage access.
      </p>
    </div>
  );
}
