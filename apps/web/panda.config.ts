import { defineConfig } from "@pandacss/dev";

export default defineConfig({
  preflight: true,
  include: ["./src/**/*.{ts,tsx}"],
  exclude: ["**/*.test.ts"],
  outdir: "styled-system",
  theme: {
    extend: {
      tokens: {
        colors: {
          canvas: { value: "#f5f7fa" },
          surface: { value: "#ffffff" },
          ink: { value: "#172738" },
          muted: { value: "#627183" },
          line: { value: "#e3e9ef" },
          rail: { value: "#142b3e" },
          railMuted: { value: "#acbdcb" },
          accent: { value: "#096f86" },
          accentSoft: { value: "#e8f4f7" },
          success: { value: "#27724f" },
          successSoft: { value: "#eaf5ee" },
          warning: { value: "#8c5a17" },
          warningSoft: { value: "#fff5e5" },
          danger: { value: "#b33e3e" },
          dangerSoft: { value: "#fff0f0" },
        },
        fonts: {
          body: { value: '"Manrope Variable", sans-serif' },
          mono: { value: '"Geist Mono Variable", monospace' },
        },
      },
    },
  },
  globalCss: {
    html: {
      fontFamily: "body",
      color: "ink",
      bg: "canvas",
      fontSize: "14px",
      WebkitFontSmoothing: "antialiased",
    },
    body: { margin: 0 },
    "*": { boxSizing: "border-box" },
    "button, input, select, textarea": { font: "inherit" },
    "button, a, input, select, textarea, summary": {
      _focusVisible: { outline: "2px solid token(colors.accent)", outlineOffset: "4px" },
    },
    button: { cursor: "pointer", _disabled: { cursor: "not-allowed", opacity: 0.55 } },
    a: { textDecoration: "none" },
    "h1, h2, h3": { textWrap: "balance" },
    "code, pre": { fontFamily: "mono" },
    "::selection": { bg: "accentSoft", color: "accent" },
    "@media (prefers-reduced-motion: reduce)": {
      "*": {
        animation: "none !important",
        transition: "none !important",
        scrollBehavior: "auto !important",
      },
    },
  },
});
