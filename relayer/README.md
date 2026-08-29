# Afterlight neutral relayer

This directory contains the tested neutral control-plane relayer implementation.
It consumes the canonical `afterlight-relay/1` control schema from `../client`,
accepts `HEARTBEAT`, `REQUEST`, and `VETO`, and includes a fail-closed Starknet
v3 signer/RPC adapter. It also accepts a strict `afterlight-prepared-neutral-exit/1`
package for public `CLAIM` or `CANCEL_REFUND` settlement. The production Worker is deployed and
funded; a separate submission-disabled configuration remains available for
inert packaging and health tests.

## Proven locally

- Strict method, route, origin, content type, intent header, JSON shape, operation, contract, token, amount, expiry, state, and 2,048-byte limits.
- Mainnet chain configuration is explicit in every relay plan; Cairo signatures independently bind the chain.
- Bounded streaming body read; an advertised or observed oversized body is rejected.
- Cloudflare Rate Limiting bindings for both per-vault/operation and global abuse control. Keys are hashes, never client IP addresses.
- A deterministic fee policy that caps each transaction and the daily exposure. It reserves the transaction maximum, not the optimistic quote. Control calls and private exits have separate daily ledgers while sharing one serialized account-nonce lane.
- One deployment-wide SQLite Durable Object. Semantic operation identities survive UTC rollover while reserve/spend totals remain day-bucketed.
- Separate semantic and exact-call fingerprints: changing only expiry or signature cannot create a second operation, while simulation, submission, and receipts must still match the exact calldata.
- Atomic `RESERVED → SUBMITTED(tx hash) → COMMITTED | REVERTED | BREACHED` reconciliation. Simulation failure spends nothing; a proven pre-submit failure releases; ambiguous receipt state remains submitted with its hash; reverted transactions remain terminal.
- Accepted fees above their reservation are recorded in full and atomically freeze all new sponsorship as an accounting invariant breach.
- No owner or successor application secret, Ready address, wallet address, client IP, payload, signature, or vault identifier is emitted by application logging.
- Health exposes only readiness booleans and a balance threshold state, never the relayer address, exact balance, RPC endpoint, secret material, request fingerprint, or request data.
- The Cairo contract remains authoritative: the executor simulates the exact call, atomically reserves its maximum fee, and only then signs with the neutral relayer account.
- Starknet v3 simulation freezes the nonce and exact resource bounds. The budget reserves a larger policy maximum; signing reuses the frozen bounds without estimating again and rejects encoded exposure above the reservation.
- Submitted and mined account transactions are reconciled against the neutral account and exact Cairo execute calldata before the receipt is accepted.
- `POST /v1/checkpoint` builds the permissionless `sync_funding_checkpoint` call with no request body, wallet, vault, note, or signature identifier. A global 15-second idempotency bucket and dedicated rate limiter bound sponsorship. The browser keeps one opaque admission token in session storage across reloads and ambiguous responses, and the deployment-wide Durable Object atomically grants that owner one ten-minute funding-admission lease before the checkpoint is submitted; an explicit rejection cannot be replaced with another user's public checkpoint event. An exact retry bypasses the owner-blind public health preflight, but the checkpoint endpoint repeats the authoritative owner-aware capacity check. If it adopts its own expired hashless reservation, that check excludes only the adopted exact fingerprint and atomically renews the same admission owner before broadcast. The release pins the deployed contract's five-minute checkpoint lifetime: observed liability consumes the lease, while an abandoned lease cannot expire until the checkpoint has been unusable for a further five-minute safety interval. This serializes the supported public route only; it is not a contract-wide admission authorization.
- `POST /v1/exit` accepts only a designated successor-key `CLAIM` or designated owner-key `CANCEL_REFUND` package from the configured product origin. It locks the exact three-action pool call (`WriteOnce`, `EmitOpenNoteCreated`, `Invoke`), canonical note storage write, proof data/output/facts, pinned pool class, application signature, destination note, live vault state, allowance, balance, resource quote, and outer transaction hash before one broadcast.
- Exit requests first consume a global ingress limit. The scarce per-vault/action quota is consumed only after the RPC simulation has authenticated the proof and designated application-key signature; structurally valid forgeries cannot exhaust a victim vault's quota. Receipt-only reconciliation bypasses that scarce quota.
- `SUBMIT_ENABLED=false` disables checkpoint, control, and exit broadcasts. A retry of a stored `SUBMITTED` transaction only reconciles its existing hash. A `RESERVED` control or prepared exit whose exact signed artifact was durably stored remains fenced to its live owner for two minutes; only an atomic stale-owner takeover may rebroadcast that byte-equivalent artifact while submission remains enabled. This prevents an overlapping retry from landing the same nonce and then letting the original owner release its accepted exposure. The browser retains an ambiguous cancellation or claim package in session storage and resubmits that exact package for receipt reconciliation; it does not prepare another note or authorization. The artifact is deleted after terminal reconciliation or a proven pre-acceptance release. Duplicate and unknown RPC errors remain ambiguous and keep the reservation locked.
- `/health` exposes collapsed exit and funding states inside `claimCapacity`. Both the browser and the neutral checkpoint route refuse new funding unless the observed live neutral balance and exact `12 STRK` allowance can cover one bounded claim or cancellation, the health floor, neither control nor exit has an active shared-nonce reservation, the exit ledger has no same-day spend, sponsorship is unfrozen, the contract has zero outstanding liability, and no funding-admission lease is active. The checkpoint route performs this fresh read and atomically acquires the lease immediately before sponsorship, closing stale-tab and concurrent ordinary-client admission. A direct caller can still use the deployed contract's permissionless checkpoint and create another fully collateralized liability outside this supported route; this cannot consume another vault's backing, but its sponsored exit may queue until capacity is restored. A successful exit consumes `6 STRK` of allowance and exhausts capacity until a reviewed replenishment on a later UTC day.

## Production configuration

The checked-in production profile describes the deployed release but contains
no secret values. A fresh deployment is executable only when its two required
Cloudflare secrets already exist and `SUBMIT_ENABLED=true`. Before changing the
release:

1. Replace `DEPLOYMENT_ID`, stage, contract, origin, RPC URL, relayer account, and both rate-limit namespace IDs with deployment-specific values.
2. Install `RELAYER_ACCOUNT_PRIVATE_KEY` and `STARKNET_RPC_AUTH_TOKEN` through `wrangler secret put`; never put their values in source, config, logs, or client variables.
3. Independently review the concrete `StarknetV3RelayAdapter` and exercise its exact nonce, resource-bound, signed calldata, sender, receipt, and fee-unit checks against the deployment account.
4. Exercise the Durable Object migration, RPC provider, account nonce, balance alert, checkpoint route, receipt timeout/reconciliation runbook, and rollback under a non-funded staging profile.
5. Confirm the ordinary owner Ready address never submits the public checkpoint; only the neutral relayer may call it immediately before a private FUND.
6. Only then install or retain the secrets and enable submission in a reviewed release. A flag without complete configuration still fails closed.

Run `npm ci`, then `npm run check`. The tested toolchain is Node.js `22.13.1`
with the committed npm lockfile and Wrangler `4.127.1`. `npm run dry-run` only
bundles locally; nothing is deployed.

`wrangler.staging.jsonc` is a separate inert deployment profile. It deliberately
omits both production secrets, uses a zero relayer address and invalid RPC, and
keeps submission disabled. It exists only to verify Cloudflare packaging,
bindings, migration, health behavior, and rollback without creating a signing
or broadcast path. Both staging and production use the account's platform CPU
default because the Free plan rejects custom CPU limits. Application-level
payload, rate, sponsorship, transaction-fee, and receipt bounds remain
explicit. Production deployment must use `wrangler.jsonc` and satisfy its
required-secret gate.

Production enablement, monitoring, receipt recovery, and rollback are defined in [`OPERATIONS.md`](./OPERATIONS.md).

## Metadata limit

The no-log rule applies to Afterlight application logging. The Worker must
process signed public authorization fields, and Cloudflare, DNS, network, and
RPC infrastructure may transiently process connection, routing, timing,
relayer-account, and transaction metadata. Production must disable or minimize
request logging and analytics where configurable, prohibit payload capture,
retain only the minimum operational data, and never join an IP or wallet to a
vault. This reduces retained correlations but does not make hosting metadata
nonexistent. See the [threat model](../docs/THREAT_MODEL.md#relayer-and-hosting-metadata-boundary).
