---
version: alpha
name: Afterlight
description: A focused recovery chamber for privately protected reserves on Starknet, with calm light and dark appearances.
colors:
  canvas: "#0D100F"
  canvas-soft: "#121714"
  surface: "#171D19"
  surface-raised: "#1D2520"
  text: "#F4F0E6"
  text-muted: "#A7B0A9"
  line: "#313A34"
  primary: "#E69A55"
  primary-soft: "#2E241B"
  success: "#72C99B"
  danger: "#E17C72"
  focus: "#F2B778"
spacing:
  compact: "8px"
  control: "16px"
  panel: "24px"
  section: "48px"
rounded:
  control: "8px"
  panel: "16px"
  chamber: "28px"
typography:
  body:
    fontFamily: "Avenir Next, Avenir, ui-sans-serif, system-ui, sans-serif"
  display:
    fontFamily: "Georgia, Times New Roman, serif"
    fontWeight: 400
    lineHeight: 0.94
    letterSpacing: -0.045em
  data:
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace"
components:
  protectionPath:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.panel}"
    padding: "{spacing.control}"
  recoveryChamber:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.chamber}"
    padding: "{spacing.panel}"
  recoveryMap:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel}"
  activityLine:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.control}"
    padding: "{spacing.control}"
---

## Overview

Afterlight is a high-stakes self-custody recovery product. Its interface should feel like entering a quiet, protected chamber and following one illuminated path. The afterglow signal identifies the current action while deep neutral surfaces keep attention on the reserve state. The product remains user-first and never becomes an evaluator dashboard.

## Colors

Use one appearance across the whole product so the application reads as one environment. In dark mode, raised surfaces stay within the green-neutral family rather than becoming unrelated black panels. In light mode, surfaces use the warm paper family from the original Afterlight interface rather than stark white and gray. The signal color marks the current stage and primary action. Success and danger appear only for confirmed outcomes or irreversible choices. Never use decorative blue or purple gradients.

## Themes

The installed DESIGN.md specification does not encode alternate themes, so the dark values in frontmatter remain the canonical default and this table preserves the exact light equivalents.

| Role | Dark | Light |
| --- | --- | --- |
| Canvas | `#0D100F` | `#F3EFE6` |
| Canvas soft | `#121714` | `#E9E3D7` |
| Surface | `#171D19` | `#FFFDF8` |
| Surface raised | `#1D2520` | `#F7F3EB` |
| Text | `#F4F0E6` | `#191915` |
| Muted text | `#A7B0A9` | `#68685F` |
| Line | `#313A34` | `#D8D3C8` |
| Signal | `#E69A55` | `#C8642F` |
| Signal soft | `#2E241B` | `#FFF3E7` |
| Success | `#72C99B` | `#2E7652` |
| Danger | `#E17C72` | `#A33A2B` |
| Focus | `#F2B778` | `#1E63D5` |

Use the system preference on a first visit and retain an explicit user choice locally. The appearance control uses the words System, Light and Dark so its state is not conveyed by an icon alone. Changing appearance must not change role, wallet, key, invitation, vault or transaction state.

## Typography

Use the display family for the product promise and live outcome only. Use the body family for actions, guidance and wallet state. Use the data family for amounts, epochs, deadlines and shortened identifiers. Keep paragraphs narrow enough to scan while a wallet is open.

## Layout

Place the role choice and protection path before the action chamber. The active role must be unmistakable without using a generic tab bar. The recovery chamber owns the leading edge and most of the width. The recovery map sits beside it on wide screens and follows it on narrow screens.

The chamber reveals prerequisites in the order they are needed. Completed steps become compact confirmations instead of remaining equally prominent. The current step receives the most space and the only dominant action. Secondary controls use a separate utility zone so cancellation, restoration and emergency submission cannot compete with the next useful action.

Keep a compact journey summary visible between the role choice and chamber. It names the current task, what is already safe and the next consequential action without repeating every instruction in the form.

At narrow widths, preserve this order: product promise, role choice, activity line, protection path, current action, recovery map, secondary details. Do not hide the product promise, live state, deadline, cost boundary or primary action. Controls remain inset from viewport edges and account for safe areas.

## Components

The protection path uses three connected stages with explicit complete, current and locked states. It must communicate progression before the labels are read and remain understandable without color.

The recovery chamber begins with an outcome sentence, not a technical heading. It contains one current task, the exact consequence of that task and the minimum controls required to finish it. Wallet connection, key protection, terms and funding remain one continuous owner journey. Key creation, invitation import, grace and recovery remain one continuous successor journey.

The recovery map explains what is protected, what remains public and what happens next. Before a vault exists it shows the privacy model. After import or creation it becomes the live state surface with reserve amount, deadline, epoch and contextual receipts.

The appearance control belongs in the header utility area. It remains keyboard reachable at every supported width, uses a native select control, and never competes with the recovery action.

Normal mode is the canonical owner choice. Recovery Drill is a clearly marked accelerated route and never looks like the production default. Exact STRK costs appear before wallet confirmation.

Loading states preserve the chamber shape and announce the action in progress. Errors stay next to the failed action and state what remains safe. A wallet rejection never implies that funds moved. Reload recovery restores the invitation, key status, pending package and receipts without changing the user’s role unexpectedly.

Hover, pressed and focus states must remain legible in both appearances. Theme transitions may soften color and shadow changes, but reduced motion removes them. Decorative orbit motion must never communicate a state by itself.

The emergency Ready X control path is secondary and collapsed. Its disclosure must state that it restores availability by publicly linking the Ready address to the vault. Neutral relay wording says unlinked, not private, because timing and the relayer transaction remain public.

Interactive controls use native elements, visible labels, visible focus, reduced-motion-safe transitions and touch targets at least 44px in both dimensions. State changes announce through the activity line without stealing focus.

## Do's and Don'ts

Lead with “Create a recovery reserve” for owners and “Prepare to recover a reserve” for successors. Show the useful result before receipts. Make heartbeat, inactivity, grace, veto and exact private recovery understandable without Cairo or STRK20 terminology.

Do not add judge navigation, proof cards, generic analytics, a left dashboard sidebar or equal card grids. Do not lead with hashes or architecture. Do not describe Afterlight as automatic legal inheritance. Do not imply hidden amounts, hidden timing, invisible application keys or proof that a private note belongs to a precommitted wallet.
