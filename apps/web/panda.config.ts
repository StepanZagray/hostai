import { defineConfig } from "@pandacss/dev";

// HostAI reads like an instrument panel for a machine you own: warm graphite
// ink on stone paper, hairline rules instead of shadows, and small status lights
// that carry every state. One token set resolves light and dark through CSS
// variables, so no component needs a colour-scheme branch.
const day = {
  "--hai-paper": "#f2f1ed",
  "--hai-panel": "#fbfaf8",
  "--hai-well": "#e9e7e2",
  "--hai-ink": "#1a1b1e",
  "--hai-inkSoft": "#3f4247",
  "--hai-muted": "#6c7076",
  "--hai-faint": "#9a9ea5",
  "--hai-line": "#1a1b1e1a",
  "--hai-lineSoft": "#1a1b1e0f",
  "--hai-lineStrong": "#1a1b1e2e",
  "--hai-action": "#1a1b1e",
  "--hai-actionHover": "#2d2f34",
  "--hai-onAction": "#f6f5f1",
  "--hai-live": "#1f9d57",
  "--hai-liveSoft": "#dff1e6",
  "--hai-liveGlow": "#1f9d5766",
  "--hai-amber": "#a86a0c",
  "--hai-amberSoft": "#f7ead3",
  "--hai-amberGlow": "#c9861a66",
  "--hai-stop": "#b83232",
  "--hai-stopSoft": "#f8e3e3",
  "--hai-stopGlow": "#b8323266",
  "--hai-selection": "#dcd9d2",
  "--hai-scrim": "#1a1b1e8c",
  "--hai-shadowPop": "0 1px 2px #1a1b1e14, 0 12px 32px -12px #1a1b1e3d",
};
const night = {
  "--hai-paper": "#131416",
  "--hai-panel": "#1a1b1e",
  "--hai-well": "#0f1012",
  "--hai-ink": "#ececea",
  "--hai-inkSoft": "#c3c4c1",
  "--hai-muted": "#8f9196",
  "--hai-faint": "#63656a",
  "--hai-line": "#ffffff17",
  "--hai-lineSoft": "#ffffff0d",
  "--hai-lineStrong": "#ffffff2b",
  "--hai-action": "#ececea",
  "--hai-actionHover": "#ffffff",
  "--hai-onAction": "#151618",
  "--hai-live": "#3ecf7a",
  "--hai-liveSoft": "#12301f",
  "--hai-liveGlow": "#3ecf7a73",
  "--hai-amber": "#e0a44a",
  "--hai-amberSoft": "#2e2413",
  "--hai-amberGlow": "#e0a44a66",
  "--hai-stop": "#f07b7b",
  "--hai-stopSoft": "#341a1c",
  "--hai-stopGlow": "#f07b7b66",
  "--hai-selection": "#33363b",
  "--hai-scrim": "#000000a6",
  "--hai-shadowPop": "0 0 0 1px #ffffff14, 0 16px 40px -12px #000000cc",
};
const token = (name: string) => ({ value: `var(--hai-${name})` });
const colours = [
  "paper",
  "panel",
  "well",
  "ink",
  "inkSoft",
  "muted",
  "faint",
  "line",
  "lineSoft",
  "lineStrong",
  "action",
  "actionHover",
  "onAction",
  "live",
  "liveSoft",
  "liveGlow",
  "amber",
  "amberSoft",
  "amberGlow",
  "stop",
  "stopSoft",
  "stopGlow",
  "selection",
  "scrim",
] as const;

export default defineConfig({
  preflight: true,
  include: ["./src/**/*.{ts,tsx}"],
  exclude: ["**/*.test.{ts,tsx}"],
  outdir: "styled-system",
  theme: {
    extend: {
      tokens: {
        colors: Object.fromEntries(colours.map((name) => [name, token(name)])),
        // A 1.2 ratio from a 14px body: each step is visibly distinct.
        fontSizes: {
          "2xs": { value: "11px" },
          xs: { value: "12px" },
          sm: { value: "13px" },
          md: { value: "14px" },
          lg: { value: "17px" },
          xl: { value: "20px" },
          "2xl": { value: "24px" },
          "3xl": { value: "29px" },
        },
        durations: {
          fast: { value: "120ms" },
          normal: { value: "180ms" },
        },
        easings: {
          out: { value: "cubic-bezier(0.23, 1, 0.32, 1)" },
        },
        fonts: {
          body: { value: '"Instrument Sans Variable", system-ui, sans-serif' },
          mono: { value: '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace' },
        },
        radii: {
          xs: { value: "3px" },
          sm: { value: "4px" },
          md: { value: "6px" },
          lg: { value: "8px" },
          full: { value: "999px" },
        },
        shadows: {
          pop: token("shadowPop"),
        },
      },
      keyframes: {
        breathe: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.3" },
        },
      },
      textStyles: {
        display: {
          value: {
            fontSize: { base: "22px", md: "24px" },
            fontWeight: 600,
            letterSpacing: "-0.025em",
            lineHeight: 1.2,
          },
        },
        title: {
          value: { fontSize: "15px", fontWeight: 600, letterSpacing: "-0.01em", lineHeight: 1.35 },
        },
        body: { value: { fontSize: "14px", lineHeight: 1.55 } },
        caption: { value: { fontSize: "12px", lineHeight: 1.55 } },
        // Panel legends: the small engraved labels beside a reading.
        legend: {
          value: {
            fontFamily: "mono",
            fontSize: "11px",
            fontWeight: 500,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            lineHeight: 1.4,
          },
        },
      },
    },
  },
  globalCss: {
    ":root": { ...day, colorScheme: "light" },
    "@media (prefers-color-scheme: dark)": {
      ':root:not([data-theme="light"])': { ...night, colorScheme: "dark" },
    },
    '[data-theme="dark"]': { ...night, colorScheme: "dark" },
    '[data-theme="light"]': { ...day, colorScheme: "light" },
    html: {
      fontFamily: "body",
      color: "ink",
      bg: "paper",
      WebkitFontSmoothing: "antialiased",
      textRendering: "optimizeLegibility",
      fontFeatureSettings: '"ss01"',
    },
    body: { margin: 0, fontSize: "md", lineHeight: 1.55 },
    "*": { boxSizing: "border-box" },
    "button, input, select, textarea": { font: "inherit", color: "inherit" },
    "button, a, input, select, textarea, summary, [tabindex]": {
      _focusVisible: { outline: "2px solid token(colors.ink)", outlineOffset: "2px" },
    },
    button: { cursor: "pointer", _disabled: { cursor: "not-allowed" } },
    summary: { cursor: "pointer" },
    a: { textDecoration: "none", color: "inherit" },
    "h1, h2, h3, h4": { textWrap: "balance", fontWeight: 600 },
    p: { textWrap: "pretty" },
    "code, pre, kbd, samp": { fontFamily: "mono" },
    "::selection": { bg: "selection", color: "ink" },
    "::placeholder": { color: "faint", opacity: 1 },
    "@media (prefers-reduced-motion: reduce)": {
      "*": {
        animation: "none !important",
        transition: "none !important",
        scrollBehavior: "auto !important",
      },
    },
  },
});
