# Fresh successor wallet investigation

Status: the bounded compatibility policy is implemented and reviewed. Runtime
availability is advertised by `GET /health` under `setupSponsorship`. On September
5, 2026, the external E4 claim was independently confirmed SUCCEEDED on Mainnet,
with CLAIMED vault state and the 1 STRK liability settled. The external successor
reported prior private activation and zero private STRK without a Shield deposit.
Their private-wallet balance delta was not independently read by the building
agent. One completed claim is not a guarantee of all fresh-wallet variants.

## Authorization preflight

An external diagnostic subsequently stopped with `Not preauthorized`. In the
official public Argent X source at commit
`e3545daa417d6b60332b6112816d5e3b13c34358`,
`packages/extension/src/inpage/requestMessageHandlers/requestChainIdHandler.ts`
throws that exact error when `getIsPreauthorized()` is falsy. The helper in
`packages/extension/src/inpage/messaging.ts` also returns a falsy value after an
authorization-response timeout. It does not establish a gas or balance problem.
That public source does not include the installed 5.33.9 STRK20 handlers, so it
does not prove which request failed in the external browser.

Afterlight now labels account, network, balance, simulated preparation and final
preparation permission failures separately. User-triggered preparation requests
interactive account authorization first, checks the same selected account, then
checks Mainnet in sequence. It never automatically replays preparation or
submits a transaction to recover a permission error. A recognized permission
failure clears the in-memory wallet connection without clearing the loaded key,
invitation, or pending transaction data. A successful reconnection does not
establish five-action compatibility or a completed recovery.

## Prepared-action compatibility

Ready X 5.33.9 returned `[0, 0, 0, 7, 10]` during simulated preparation
for a newly activated external successor. The released client and relayer
accepted only `[0, 7, 10]` in the original release. That remains the generic
client/default validator policy. The versioned opt-in policy below handles
the five-action path only when the sponsor explicitly advertises support.

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

## Local reproduction now available

The [pinned SDK and Cairo reproduction](../investigations/ready-fresh-wallet/README.md)
passes five SDK Mocknet tests and three added Cairo tests. A missing token
subchannel produces the five-action sequence; initializing that subchannel
separately removes the prefix, even without a private token balance. A positive
deposit-to-self also initializes it in SDK Mocknet. Neither result verifies
Ready X's supported UI flow, fees or real preparation.

The Cairo tests also confirm that an unrelated token subchannel can be opened
alongside the intended note while preserving the five-action shape. The test
helpers use synthetic funds and cheat proof facts; they are not authentic-proof
verification. Both client and relayer retain rejection coverage for this shape.
Those reproduction tests alone establish neither live compatibility nor
external claim completion.

## Versioned role-bound setup policy

The released policy `afterlight-role-bound-setup/1` accepts exactly one
protocol-valid token subchannel setup alongside the exact private exit. This
deliberately does **not** assert that the encrypted setup belongs to the note's
token or recipient. One unrelated valid token setup is within the amended
sponsor policy; additional transfers, invocations, or setup pairs are not.

The browser and relayer require the precise five-action layout, a two-felt setup
record with nonzero salt, a single `true` marker, valid nonzero storage bases,
and disjoint occupied slots. Known public configuration slots are excluded.
These are structural checks, not proof of hashed storage namespace membership.
The note write, token, amount, helper call, role, state, epoch, nonce and deadline
remain exact. Simulated/final setup targets and the boolean cannot change;
setup encryption randomness may change before final authorization.

For this path only, the browser asks for per-attempt consent and creates an
`afterlight-prepared-neutral-exit/2` package. An additional local application-key
signature binds canonical SHA-256 of the entire final package, excluding only
the signature envelope itself and the derived locks. The signature domain pins
Mainnet, the sponsor, pool/class, Afterlight/class and STRK. Both digest halves
are retained. The relayer verifies against the designated key from the live
vault, not a key supplied by the requester. This signature authorizes exact
bytes; it does not authenticate their privacy proof.

Proof authentication uses Starknet's canonical Mainnet admission/consensus
boundary, as in the existing three-action route. The reviewed gateway verifies
the proof (or reuses already authenticated facts) before admission; protocol
prevalidation also checks the allowed program, version, base block and chain
configuration. Afterlight independently binds those facts to the exact actions
and pinned pool class. `starknet_estimateFee` is only execution simulation and a
fee quote, not proof verification. A PROOF0 estimate copy is never signed or
submitted in place of the untouched final PROOF1 facts.

The sponsor's V3 signature binds calldata, proof facts, chain, nonce and resource
bounds, not raw proof bytes. Replacing raw bytes cannot authorize different
effects: admission requires evidence of the same signed facts or a matching
trusted proof-cache entry. A separate local verifier cannot prevent post-signing
byte replacement or delayed submission. Admitted application failures can still
consume bounded gas; an exported signature remains reserved until canonical
resolution. A single node's rejection is not signature revocation. This is not
a promise that every malformed replacement is rejected (cached authenticated
facts are a relevant exception).

Primary references at sequencer revision
`16facd2c92f2bea99532717cbb2057ca0463d679`:
[gateway admission](https://github.com/starkware-libs/sequencer/blob/16facd2c92f2bea99532717cbb2057ca0463d679/crates/apollo_gateway/src/gateway.rs),
[transaction hash](https://github.com/starkware-libs/sequencer/blob/16facd2c92f2bea99532717cbb2057ca0463d679/crates/starknet_api/src/transaction_hash.rs),
[proof cache](https://github.com/starkware-libs/sequencer/blob/16facd2c92f2bea99532717cbb2057ca0463d679/crates/apollo_transaction_converter/src/transaction_converter.rs).
These document the reviewed implementation; they are not an independent
attestation of a particular node operator's live configuration. No independent
native proof-verifier service is required by this release. Rollout remains
explicitly gated, and already-signed exact packages can still be reconciled.

No sponsor fee caps, daily budgets, allowance limits, or reserve amount are
increased. No private balance minimum or separate Shield deposit is introduced.
Ready's one-time private registration is still a prerequisite; registration
and first use of a token subchannel are different protocol steps.

## Required before claiming compatibility

Capture and establish the actual setup writes' semantics in a controlled test;
update both browser and relayer validation under the same rule; retain exact
note, token, amount, contract, authorization, proof and live-state checks. Test
valid simulated/final pairs, setup randomness, altered/unrelated writes and
overlapping slots. Then require a successful external transaction receipt and
the successor's exact private-balance increase. Synthetic unit tests alone do
not prove external recovery.
