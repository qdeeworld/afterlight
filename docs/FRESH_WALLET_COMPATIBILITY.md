# Fresh successor wallet investigation

Status: blocked before submission; no external completion claimed.

Ready X 5.33.9 returned `[0, 0, 0, 7, 10]` during simulated preparation
for a newly activated external successor. The released client and relayer
accept only `[0, 7, 10]`. Both restrictions remain in place.

The pinned STRK20 reference, commit
`66e3caae8c0201227a6719696d004e30d90aea65`, defines:

- `OpenSubchannel`: writes `subchannel_tokens[subchannel_id]` as the two-field
  encrypted subchannel info, then `subchannel_exists[subchannel_marker]` as `true`.
- `CreateOpenNote`: writes the exact note, then emits `OpenNoteCreated`.
- `InvokeExternal`: invokes the application.

Sources: `starknet-privacy/packages/privacy/src/privacy.cairo`,
`objects.cairo`, `hashes.cairo`, and `sdk/src/internal/compiler.ts`.
The SDK automatically opens a missing token subchannel when preparing a note.
The encrypted subchannel record uses a fresh random salt, so a future supported
five-action binder must account for semantic equivalence across preparations.

This explains a possible five-action sequence, not the identity of the actual
external writes. Storage-map keys depend on private channel material; arbitrary
storage targets cannot be classified from action discriminants alone. Do not
accept arbitrary two-write prefixes or strip actions from a proof-bound call.

## Controlled diagnostic

Open the existing app with `?diagnoseExit=1`, restore the same successor key,
load the invitation, connect Ready X, and choose **Check preparation only — no
claim**. The handler refuses a retained pending exit and invokes only the
simulated prepare stage. It stops before application signing, final preparation,
relayer submission, or broadcast, even when the normal three-action form passes.

The local report includes action types, storage targets, value lengths, boolean
and nonzero checks, and whether each target matches the open-note storage slot.
It excludes raw write values, wallet keys, application signatures, note IDs,
and proof packages. Storage targets are pseudonymous metadata: share the report
privately, not in public issue comments. It is not sent to telemetry.

## Required before claiming compatibility

Capture and establish the actual setup writes' semantics in a controlled test;
update both browser and relayer validation under the same rule; retain exact
note, token, amount, contract, authorization, proof and live-state checks. Test
valid simulated/final pairs, setup randomness, altered/unrelated writes and
overlapping slots. Then require a successful external transaction receipt and
the successor's exact private-balance increase. Synthetic unit tests alone do
not prove external recovery.
