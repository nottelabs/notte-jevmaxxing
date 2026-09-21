---
name: Notte Jevmaxxing
description: Inherited pink paper and dark browser instruments, extended for the Wikipedia race.
colors:
  ink: "#1e1e1e"
  paper: "#fefefe"
  pink: "#f386a1"
  pink-deep: "#d45bb6"
  dash: "rgba(136, 136, 136, 0.35)"
  dim: "rgba(254, 254, 254, 0.55)"
  jev: "#f7a8be"
  cerebras: "#f4c889"
typography:
  display:
    fontFamily: '"Archivo", system-ui, sans-serif'
    fontWeight: 500
  label:
    fontFamily: '"JetBrains Mono", ui-monospace, monospace'
rounded:
  square: "0px"
---

# Design System: Notte Jevmaxxing

## Overview
This records the existing system in `app/globals.css` and its `/race` extension in `app/race/race.css` and `page.tsx`. A soft pink paper background surrounds dark browser instruments. The race is an operate/experience surface: enter a route, watch two browsers, and compare their article trails and measurements. Product behavior is documented in `README.md`.

## Colors
Pink and pink-deep shape the inherited gradient canvas. Ink supports dark browser panels and page text; paper supports panel text and translucent fields. Dashed separators and dim labels organize dense instrument content. Jev uses pale pink and Cerebras warm amber for lane headings, trail numbers, focus, and winner badges; status text also communicates outcomes.

## Typography
Archivo carries headings, body text, and race controls. The race heading scales with `clamp(36px, 5vw, 66px)`, a tight line height (1.04), and tracking (-0.04em). JetBrains Mono carries model identifiers, time, counts, and trail timestamps, with tabular numerals for measurements. The original inspector also uses Silkscreen for compact uppercase labels.

## Layout
The original inspector has a centered container (1240px maximum); the race expands to 1480px. Its route inputs lead into two equal browser lanes separated by 18px. Each lane follows the same order: identity/status, three measurements, address, browser, article trail. Viewports retain the inherited 1120/780 aspect ratio; long trails scroll within 260px.
At 900px and below, the start button spans the form and lane padding tightens. At 640px and below, inputs and lanes become a single column, the route arrow disappears, and footer items stack. Mobile inputs retain a 16px font size.

## Elevation & Depth
The canvas uses layered radial and linear gradients. Broad dark shadows lift the browser instruments; dashed dividers separate their internal regions without introducing nested cards. Exact shadow values and breakpoints are recorded in `.impeccable/design.json`.

## Shapes
Square corners, thin underlined fields, and dashed panel dividers define the existing form language. The race's winner treatment is a compact rectangular badge using the lane accent.

## Components
Route fields are visibly labeled, translucent, and underlined. A solid ink button starts or stops the race; presets are compact text buttons. Busy controls disable with reduced opacity. Focus uses an offset outline, changing to the lane accent inside dark panels.
Paired browser panels give equal space to each racer. Measurements show race time, links followed, and average successful decision time. Article trails pair numbered links with timestamps. Empty, preparing, stopped, failed, and winner states remain explicit; race announcements use a status region and errors use alerts.
The footer exposes race rules and completed-run data download. Keep provider/model labels and the explanation that this is one live race visible in their established places; do not present these measurements as a general model benchmark.

## Do's and Don'ts
- Do preserve the inherited typography, pink canvas, dark instruments, and equal lane hierarchy.
- Do retain readable measurements, labeled inputs, keyboard focus, and mobile stacking.
- Don't use accent color as the sole indication of winner or status.
- Don't substitute fabricated race results for setup, loading, or failure states.
