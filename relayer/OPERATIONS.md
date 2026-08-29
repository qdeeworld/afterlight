# Neutral relayer operations

This runbook applies to the E2-passed production relayer and its inert staging profile.

## Hosting boundary

- Runtime: direct Cloudflare Worker with the `RelayBudget` SQLite Durable Object and four Rate Limiting bindings.
- Public product hostname: `afterlight.dolepee.com` on Cloudflare Pages through the existing external DNS zone.
- Relayer exposure: the current Worker remains on its stable provider hostname with strict product-origin CORS. A future same-origin proxy may expose only `/v1/relay`, `/v1/checkpoint`, `/v1/exit`, and `/health`; disable the public route only after that proxy is verified.
- Do not migrate the `dolepee.com` authoritative nameservers merely to attach a Worker Custom Domain. Any zone migration is a separate, explicitly approved operation.
- Use Wrangler on the normal network. Use Windscribe only if a required Cloudflare-owned dashboard or OAuth page will not open, and disconnect it immediately after that browser sequence.

## Required production values

Replace every inert value and verify it against the exact released contract:

- deployment stage and unique deployment ID;
- Afterlight contract, Starknet chain ID, STRK token, and fixed reserve amount;
- relayer account address and Cairo account version;
- production RPC URL;
- product origin;
- per-call fee cap, daily sponsorship budget, balance alert threshold, and fee margin;
- deployment-specific namespaces for relay, global, checkpoint, and exit rate limits.

The account's Cloudflare plan rejects custom Worker CPU limits, so the release
uses the platform CPU default. Preserve the explicit application-level payload,
rate, sponsorship, transaction-fee, and receipt bounds, and re-run the startup
profile before every production deployment.

Install `RELAYER_ACCOUNT_PRIVATE_KEY` and `STARKNET_RPC_AUTH_TOKEN` only with `wrangler secret put`. Never place values in source, configuration, client variables, logs, shell history, or this document.

## Promotion sequence

1. Run `npm ci`, `npm run types`, `npm run check`, and `npm audit` on the exact commit.
2. For a new environment, keep `SUBMIT_ENABLED=false`; deploy the Worker and Durable Object migration.
3. Verify `/health` reports the intended submission state and collapsed claim-capacity state, while exposing no address, endpoint, exact balance, secret state, wallet, vault, or request identifier.
4. Verify the configured-origin preflight and each route with empty or invalid requests only.
5. Fund the bounded relayer account within the approved spike cap.
6. Install secrets, verify configuration readiness, and obtain fresh no-submit quotes.
7. Enable submission only within the bounded production sponsorship policy.
8. Run one checkpoint and one signed control canary; reconcile their hashes, exact calldata, sender, actual FRI fee, and Durable Object totals.
9. Confirm the stable Worker URL and public product route remain healthy, and that strict origin checks reject every unlisted site. Disable direct `workers.dev` access only after a verified same-origin proxy replaces it.

## Nonce and receipt discipline

- One relayer account has one active nonce lane. A `RESERVED` or `SUBMITTED` operation blocks a different sponsored operation until it is released or finalized.
- A timed-out receipt remains `SUBMITTED`; its full maximum stays reserved.
- Retry only the exact original request. The executor reuses its stored transaction hash and reconciles the receipt without simulating, signing, or broadcasting again.
- RPC duplicate and unknown-result errors are transport-ambiguous, never proof of rejection. Keep their reservations locked until receipt and nonce evidence resolves them.
- A request with the same semantic operation but different signature, expiry, or exact fingerprint cannot reconcile the submitted transaction.
- Never release a submitted reservation based only on an RPC timeout. Confirm the transaction or account nonce before any manual recovery.
- A receipt fee above its reservation records the full spend and freezes all new sponsorship.
- Never rotate `DEPLOYMENT_ID` to bypass a `SUBMITTED` or otherwise ambiguous reservation. A new ledger namespace is permitted only after independent transaction, nonce, contract-state, allowance and balance checks prove that no broadcast occurred. Record the abandoned namespace, rebaseline the actual funded balance, use a unique deployment ID, and retain a hard balance floor and one-attempt exit cap in the replacement release.
- E3 namespace `afterlight-mainnet-e3-20260829-v5` is abandoned after a transport-ambiguous broadcast call. More than 70 subsequent Mainnet blocks plus both latest and pre-confirmed nonce reads proved neutral nonce `34` unchanged; vault state, successor nonce, liability, allowance and neutral balance were also byte-for-byte unchanged. Namespace `afterlight-mainnet-e3-20260829-v6` is its one-attempt replacement. This recorded recovery does not permit reuse of v5 or rotation after any accepted or still-ambiguous submission.

## Monitoring and alerts

The public repository's `Inert relayer staging health` workflow checks the
provider-only inert staging endpoint every 30 minutes while submission is disabled.
It verifies the fail-closed executor state, privacy response, and security
headers. Replace that staging check with production health and alerting during
promotion; a green inert check is never production readiness evidence.

Monitor through at least 2026-09-04:

- `/health` availability and collapsed balance status;
- `/health.claimCapacity`; stop new reserves whenever `fundingStatus` is not `ready`. The browser checks this state and the checkpoint route freshly rechecks it immediately before sponsorship. The exact ready allowance is `12 STRK`, covering one claim or cancellation, and funding is ready only when observed total locked liability is zero, sponsorship is unfrozen, no reservation is active, and the exit ledger can still reserve the full `7.5 STRK` ceiling that UTC day. This is not an atomic contract-level serialization primitive, so monitor for simultaneous zero-liability admission attempts and disable submission if one is detected. After either exit, the remaining `6 STRK` allowance and same-day ledger spend intentionally exhaust capacity until a newly reviewed replenishment on a later UTC day.
- relayer public STRK balance below the configured threshold;
- Durable Object sponsorship freeze state;
- reservations remaining `RESERVED` or `SUBMITTED` beyond the receipt window;
- RPC error rate and checkpoint/control success rate without payload logging;
- Worker and Pages deployment versions matching the recorded release commit.

The completed bounded control lifecycle used two funding checkpoints plus
`HEARTBEAT`, two `REQUEST` calls, and `VETO`. The current control-plane ceiling
is `0.4 STRK` per call and `1.6 STRK` per UTC day. The exact-note exit has a
separate `7.5 STRK` full resource-bounds ceiling, a separate exact `6 STRK`
pool allowance, and a `1 STRK` post-spend balance floor. Replace any cap only
from fresh quotes; never enable exposure larger than the funded operational
bound.

Control and exit spend use separate UTC-day totals because their policy ceilings
are intentionally different. They still share the same reservation table and
single active nonce lane; splitting accounting does not permit concurrent
broadcasts from the neutral account.

Do not log request bodies, signatures, IP addresses, wallet addresses,
application keys, vault IDs, transaction fingerprints, RPC authorization, or
exact private-flow timing correlations. Disable or minimize Cloudflare request
logging and analytics where configurable, prohibit body capture, use the
shortest operational retention available, and never export a dataset that can
join connection metadata to a vault. Cloudflare, DNS, network, and RPC systems
may still transiently process routing, timing, connection, relayer-account, and
transaction metadata; the no-log policy does not claim otherwise.

## Rollback

1. Set `SUBMIT_ENABLED=false` and deploy the exact configuration-only rollback.
2. Leave `/health` and read-only reconciliation available; do not delete the Durable Object or reservations.
3. Preserve transaction hashes and budget totals outside public logs.
4. Diagnose against the exact release commit. Any runtime fix creates a new release requiring the full test, deployment, lifecycle, and parity gates.
5. Re-enable only after every submitted transaction is reconciled and the sponsorship ledger is consistent.

Deletion of the Worker, Durable Object, DNS record, or prior healthy deployment is not a rollback mechanism.
