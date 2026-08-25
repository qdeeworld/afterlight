# Neutral relayer operations

This runbook applies only after Afterlight passes its E2 spike and build gate. The checked-in configuration is intentionally inert and must not be enabled as a shortcut.

## Hosting boundary

- Runtime: direct Cloudflare Worker with the `RelayBudget` SQLite Durable Object and three Rate Limiting bindings.
- Public product hostname: `afterlight.dolepee.com` on Cloudflare Pages through the existing external DNS zone.
- Relayer exposure: bind the relayer Worker privately to the Pages application and proxy only `/v1/relay`, `/v1/checkpoint`, and `/health` through the product origin. Disable the relayer's public `workers.dev` route after the service binding is verified.
- Do not migrate the `dolepee.com` authoritative nameservers merely to attach a Worker Custom Domain. Any zone migration is a separate, explicitly approved operation.
- Connect Windscribe before every direct Cloudflare CLI or dashboard operation and disconnect it afterward.

## Required production values

Replace every inert value and verify it against the exact released contract:

- deployment stage and unique deployment ID;
- Afterlight contract, Starknet chain ID, STRK token, and fixed reserve amount;
- relayer account address and Cairo account version;
- production RPC URL;
- product origin;
- per-call fee cap, daily sponsorship budget, balance alert threshold, and fee margin;
- deployment-specific namespaces for relay, global, and checkpoint rate limits.

The account's Cloudflare plan rejects custom Worker CPU limits, so the release
uses the platform CPU default. Preserve the explicit application-level payload,
rate, sponsorship, transaction-fee, and receipt bounds, and re-run the startup
profile before every production deployment.

Install `RELAYER_ACCOUNT_PRIVATE_KEY` and `STARKNET_RPC_AUTH_TOKEN` only with `wrangler secret put`. Never place values in source, configuration, client variables, logs, shell history, or this document.

## Promotion sequence

1. Run `npm ci`, `npm run types`, `npm run check`, and `npm audit` on the exact commit.
2. Keep `SUBMIT_ENABLED=false`; deploy the Worker and Durable Object migration.
3. Verify `/health` reports submission disabled and exposes no address, endpoint, balance, secret state, wallet, vault, or request identifier.
4. Verify the Pages service binding and same-origin proxy with empty or invalid requests only.
5. Fund the bounded relayer account within the approved spike cap.
6. Install secrets, verify configuration readiness, and obtain fresh no-submit quotes.
7. Enable submission only for the bounded mainnet spike.
8. Run one checkpoint and one signed control canary; reconcile their hashes, exact calldata, sender, actual FRI fee, and Durable Object totals.
9. Confirm direct `workers.dev` access is disabled and the public product route remains healthy.

## Nonce and receipt discipline

- One relayer account has one active nonce lane. A `RESERVED` or `SUBMITTED` operation blocks a different sponsored operation until it is released or finalized.
- A timed-out receipt remains `SUBMITTED`; its full maximum stays reserved.
- Retry only the exact original request. The executor reuses its stored transaction hash and reconciles the receipt without simulating, signing, or broadcasting again.
- A request with the same semantic operation but different signature, expiry, or exact fingerprint cannot reconcile the submitted transaction.
- Never release a submitted reservation based only on an RPC timeout. Confirm the transaction or account nonce before any manual recovery.
- A receipt fee above its reservation records the full spend and freezes all new sponsorship.

## Monitoring and alerts

The public repository's `Inert relayer staging health` workflow checks the
provider-only Phase A endpoint every 30 minutes while submission is disabled.
It verifies the fail-closed executor state, privacy response, and security
headers. Replace that staging check with production health and alerting during
promotion; a green inert check is never production readiness evidence.

Monitor through at least 2026-09-04:

- `/health` availability and collapsed balance status;
- relayer public STRK balance below the configured threshold;
- Durable Object sponsorship freeze state;
- reservations remaining `RESERVED` or `SUBMITTED` beyond the receipt window;
- RPC error rate and checkpoint/control success rate without payload logging;
- Worker and Pages deployment versions matching the recorded release commit.

Do not log request bodies, signatures, IP addresses, wallet addresses, application keys, vault IDs, transaction fingerprints, RPC authorization, or exact private-flow timing correlations.

## Rollback

1. Set `SUBMIT_ENABLED=false` and deploy the exact configuration-only rollback.
2. Leave `/health` and read-only reconciliation available; do not delete the Durable Object or reservations.
3. Preserve transaction hashes and budget totals outside public logs.
4. Diagnose against the exact release commit. Any runtime fix creates a new release requiring the full test, deployment, lifecycle, and parity gates.
5. Re-enable only after every submitted transaction is reconciled and the sponsorship ledger is consistent.

Deletion of the Worker, Durable Object, DNS record, or prior healthy deployment is not a rollback mechanism.
