# Afterlight neutral relayer — Phase A

This directory is a no-deploy, no-funds proof of the neutral control-plane relayer. It consumes the canonical `afterlight-relay/1` schema from `../client`, accepts only `HEARTBEAT`, `REQUEST`, and `VETO`, and includes an inert Starknet v3 signer/RPC adapter that remains unreachable until every production setting and secret is present and `SUBMIT_ENABLED=true`.

## Proven locally

- Strict method, route, origin, content type, intent header, JSON shape, operation, contract, token, amount, expiry, state, and 2,048-byte limits.
- Mainnet chain configuration is explicit in every relay plan; Cairo signatures independently bind the chain.
- Bounded streaming body read; an advertised or observed oversized body is rejected.
- Cloudflare Rate Limiting bindings for both per-vault/operation and global abuse control. Keys are hashes, never client IP addresses.
- A deterministic fee policy that caps each transaction and the daily exposure. It reserves the transaction maximum, not the optimistic quote.
- One deployment-wide SQLite Durable Object. Semantic operation identities survive UTC rollover while reserve/spend totals remain day-bucketed.
- Separate semantic and exact-call fingerprints: changing only expiry or signature cannot create a second operation, while simulation, submission, and receipts must still match the exact calldata.
- Atomic `RESERVED → SUBMITTED(tx hash) → COMMITTED | REVERTED | BREACHED` reconciliation. Simulation failure spends nothing; a proven pre-submit failure releases; ambiguous receipt state remains submitted with its hash; reverted transactions remain terminal.
- Accepted fees above their reservation are recorded in full and atomically freeze all new sponsorship as an accounting invariant breach.
- No owner or successor application secret, Ready address, wallet address, client IP, payload, signature, or vault identifier is logged.
- Health exposes only readiness booleans and a balance threshold state, never the relayer address, exact balance, RPC endpoint, secret material, request fingerprint, or request data.
- The Cairo contract remains authoritative: the executor simulates the exact call, atomically reserves its maximum fee, and only then signs with the neutral relayer account.
- Starknet v3 simulation freezes the nonce and exact resource bounds. The budget reserves a larger policy maximum; signing reuses the frozen bounds without estimating again and rejects encoded exposure above the reservation.
- Submitted and mined account transactions are reconciled against the neutral account and exact Cairo execute calldata before the receipt is accepted.
- `POST /v1/checkpoint` builds the permissionless `sync_funding_checkpoint` call with no request body, wallet, vault, note, or signature identifier. A global 15-second idempotency bucket and dedicated rate limiter bound sponsorship.

## Production blockers (intentional)

Do not set `SUBMIT_ENABLED=true` on this Phase A Worker. The adapter exists for static review and local tests, but the checked-in configuration is deliberately non-executable. Before funded Phase B:

1. Replace `DEPLOYMENT_ID`, stage, contract, origin, RPC URL, relayer account, and both rate-limit namespace IDs with deployment-specific values.
2. Install `RELAYER_ACCOUNT_PRIVATE_KEY` and `STARKNET_RPC_AUTH_TOKEN` through `wrangler secret put`; never put their values in source, config, logs, or client variables.
3. Independently review the concrete `StarknetV3RelayAdapter` and exercise its exact nonce, resource-bound, signed calldata, sender, receipt, and fee-unit checks against the deployment account.
4. Exercise the Durable Object migration, RPC provider, account nonce, balance alert, checkpoint route, receipt timeout/reconciliation runbook, and rollback under a non-funded staging profile.
5. Confirm the ordinary owner Ready address never submits the public checkpoint; only the neutral relayer may call it immediately before a private FUND.
6. Only then install the secrets and enable submission in a reviewed promotion commit. A flag without complete configuration still fails closed.

Run `npm install`, `npm run types`, then `npm run check`. `npm run dry-run` only bundles locally; nothing is deployed.

Production enablement, monitoring, receipt recovery, and rollback are defined in [`OPERATIONS.md`](./OPERATIONS.md).
