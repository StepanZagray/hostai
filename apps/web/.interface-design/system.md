# HostAI interface system

## Direction

An instrument panel for a machine you own. Warm graphite ink on stone paper, hairline rules
instead of shadows, and small status lights that carry every state. Calm, tactile, quiet. The
persistent header strip draws the request path (browser → gateway → Ollama → models) with live
lights; the Overview readings row is an instrument readout, not a KPI grid; conversations are
transcripts with mono legends, not chat bubbles.

Tokens live in `apps/web/panda.config.ts` as CSS variables (`--hai-*`) so light and dark are one
set: paper · panel · well · ink · inkSoft · muted · faint · line · lineSoft · lineStrong · action ·
onAction · live · amber · stop (+ `*Soft`, `*Glow`) · selection · scrim.

## Depth and spacing

- Depth strategy: borders only. `line` for card edges, `lineSoft` for row dividers, `lineStrong`
  for control edges. The single shadow token `pop` is for floating elements (Jump to latest).
- Spacing base 4px. Card padding 16px (14px under 768px). Gap between cards 20px. Dense list rows
  10–12px vertical padding. Page max width 1180px, which a `data-fill` surface gives up to run
  edge to edge. Rail 224px. Header/rail bar 52px.
- Radii: 3 (kbd) · 4 (buttons, controls, notes, code) · 8 (cards) · full (lights).

## Type

- Body/UI: Instrument Sans Variable 400/500/600. Mono: IBM Plex Mono 400/500 for model tags,
  URLs, versions, counts, codes, timestamps and legends.
- Scale (ratio 1.2 from 14px): 11 · 12 · 13 · 14 · 17 · 20 · 24 · 29.
- Page h1 `display` 24px/600/-0.025em. Card h2 `title` 15px/600. Body 13–14px/400/1.55.
  Captions 12px muted. `legend` = mono 11px/500, 0.08em, uppercase (terms, table headers).
- Hierarchy through weight and colour tiers (ink › inkSoft › muted › faint), not size alone.

## Components (values)

- Button — 36px h · 12px 16px pad · 4px radius · 13px/500. `sm`: 32px h · 12px/500. Primary =
  ink fill (`action`/`onAction`), secondary = panel + `lineStrong` border, ghost = text only,
  hover fill `well`. Press: scale(0.98). Icons 15px.
- Controls (`control`) — 36px h · `well` fill · `line` border · 4px radius. Focus ring 2px ink.
  The guest-access page and the guest bundle force ≥44px through a root override.
- Led — 7px round light; live/amber/stop glow with a 2px soft halo; `busy` breathes 1.6s.
- Badge — Led + mono 11px/500 text. The only status treatment; never coloured pills.
- Section — panel card, header 16px padding, title + optional aside Badge + caption.
- Readout — legend · mono 24px tabular value · caption. Four in one panel with hairline dividers.
- Note — 12px, 2px left rule in tone colour, soft tone fill, 4px radius.
- Transcript row — user prompt in `well` with 2px `lineStrong` left rule and mono "You" legend;
  assistant answer plain with mono model legend.
- DataList — legend terms, mono 12px right-aligned values, `lineSoft` dividers.
- Model interface frame — a runtime-provided page in an `iframe` with `sandbox="allow-scripts"`
  that replaces transcript, composer and run settings (flex 1, min height 320px, `paper`
  background, `color-scheme: light dark`, no border). In Playground it is the page: the surface
  drops its card and the page gutters (`main:has([data-fill])`) so the frame fills the content
  area under the 52px bar, its chrome inset matching that bar (12px, 24px from `lg`). The chrome
  keeps the model select and a Badge ("Interface ready" / "Runtime not ready"); Clear is absent.
  The guest page titles its panel "Model interface". Under the frame, a 12px muted caption on a
  `line` top rule with 12px/8px padding: "Interface provided by the <runtime> runtime. It runs
  sandboxed with no network or storage access.", runtime id in mono. The host passes its theme
  to the frame through the bridge; the page inside decides its own styling.
