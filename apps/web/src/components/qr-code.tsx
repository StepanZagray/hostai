import { useMemo } from "react";
import { encode } from "uqr";
import { css } from "../../styled-system/css";

const quiet = 4;

const frame = css({
  display: "inline-flex",
  bg: "#fff",
  p: "2",
  border: "1px solid token(colors.line)",
  borderRadius: "sm",
});

/** Always black on white: a QR inverted for dark mode often fails to scan. */
export function QrCode({
  value,
  title,
  size = 208,
}: {
  value: string;
  title: string;
  size?: number;
}) {
  const code = useMemo(() => {
    try {
      const { size: modules, data } = encode(value, { ecc: "M" });
      let path = "";
      for (let y = 0; y < modules; y += 1) {
        for (let x = 0; x < modules; x += 1) {
          if (data[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
        }
      }
      return { extent: modules + quiet * 2, path };
    } catch {
      // Longer than any QR version holds; the caller falls back to the plain link.
      return null;
    }
  }, [value]);
  if (!code) return null;
  return (
    <div className={frame}>
      <svg
        role="img"
        aria-label={title}
        viewBox={`0 0 ${code.extent} ${code.extent}`}
        shapeRendering="crispEdges"
        style={{ width: size, height: size, display: "block" }}
      >
        <rect width={code.extent} height={code.extent} fill="#fff" />
        <path d={code.path} fill="#000" />
      </svg>
    </div>
  );
}
