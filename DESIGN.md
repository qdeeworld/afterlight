---
version: alpha
name: Afterlight
description: User-first interaction guidance for a private Starknet recovery reserve.
colors:
  ink: "#191915"
  muted: "#68685f"
  paper: "#FFFDF8"
  line: "#D8D3C8"
  accent: "#D86F31"
  accent-dark: "#8E3514"
  soft: "#EBE6DB"
typography:
  body:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
  headline:
    fontFamily: Georgia, Times New Roman, serif
    fontWeight: 500
    lineHeight: 0.98
    letterSpacing: -0.045em
omitted:
  - section: spacing
    reason: Layout spacing is evidenced, but no named shared spacing scale exists.
  - section: rounded
    reason: Repeated radii exist, but no named shared radius scale exists.
  - section: components
    reason: Shared component behavior is documented in prose without a token contract.
---

## Overview

Afterlight is an ordinary self-custody recovery product, not an evaluator surface. Lead with the useful result: create a bounded private recovery reserve, remain in control through heartbeat and veto, and let only the designated successor key authorize recovery after inactivity and grace. Keep STRK20 receipts and technical proof contextual to the action that produced them.

## Colors

Use warm paper and soft neutral surfaces to keep the recovery journey calm and legible. Ink carries primary text and actions; muted supports explanatory copy; the earthy accent identifies privacy guidance and selected controls without becoming a decorative gradient. Reserve distinct success and error treatments for state feedback, and never rely on color alone.

## Typography

Use the body family for controls, instructions, wallet state and receipts. Use the headline family only for the product promise and major journey titles; its restrained weight and tight setting establish hierarchy without turning operational screens into marketing pages.

## Layout

Use one role-aware application shell with separate owner and successor journeys. Show the current vault state, the next meaningful deadline, and one primary action before secondary controls or transaction details. Preserve the same reading order at mobile and desktop widths; wider layouts may place contextual status beside the action, but must not turn the journey into a dashboard grid.

Every remote or wallet-dependent region needs loading, empty, error, wrong-network, insufficient-balance, interrupted-flow, and reload-recovery states. The owner and successor journeys must remain usable at 320px, 768px, 1024px, and 1440px widths.

## Components

The unauthenticated primary action is “Create a recovery reserve.” Owner setup progressively reveals Ready X connection, reserve mode and denomination, inactivity and grace periods, the successor public key, recovery-package backup, and private funding. Do not expose later actions before their prerequisites are satisfied.

Vault status presents `ACTIVE`, `GRACE`, `CLAIMED`, or `CANCELLED` in plain language together with the relevant heartbeat, request, grace, or terminal outcome. Do not use color alone to distinguish states.

Owner controls expose heartbeat, veto, and private cancellation only when valid. Successor controls expose key generation, invitation import, request, exact destination-note preparation, and claim only when valid. Explain why an action is unavailable instead of leaving a dead control.

Wallet reviews must repeat the expected role, network, token, amount, privacy consequence, and fee boundary immediately before confirmation. After an action, show the useful result first and place its receipt, contract address, and transaction hash in a contextual expandable region.

The privacy boundary belongs near reserve creation and recovery confirmation. State what remains public—contract, token, denomination, timing, application public keys, and state transitions—and what STRK20 keeps unlinked for public observers. Never describe Afterlight as automatic legal inheritance.

Interactive controls use native elements, visible labels, visible keyboard focus, reduced-motion-safe feedback, and touch targets at least 44px in both dimensions. Dialogs and wallet-return flows restore focus to the action that opened them, and status changes are announced without moving focus unexpectedly.

## Do's and Don'ts

Use outcome-first copy, ordinary wallet language, and contextual receipts. Make heartbeat, inactivity, grace, veto, cancellation, and exact private recovery understandable without requiring contract terminology.

Do not add “Judge,” “Judging,” “Proof,” or “Evidence” primary navigation. Do not lead with raw hashes, architecture, a generic explorer, or a separate evaluator dashboard. Do not create a one-use demo path that cannot recover after reload or an interrupted Ready X flow. Do not imply hidden amounts, hidden timing, invisible authorization keys, proof that a note belongs to a precommitted wallet, or legal inheritance guarantees.
