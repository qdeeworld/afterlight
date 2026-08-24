# Afterlight neutral relayer — Phase A

This directory is a no-deploy, no-funds proof of the neutral control-plane relayer. It consumes the canonical `afterlight-relay/1` schema from `../client`, accepts only `HEARTBEAT`, `REQUEST`, and `VETO`, builds one exact Afterlight call, and deliberately has no concrete signer or broadcast adapter.

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
- The Cairo contract remains authoritative: a future executor must simulate the exact call, atomically reserve its maximum fee, and only then sign with the neutral relayer account.

## Production blockers (intentional)

Do not set `SUBMIT_ENABLED=true` on this Phase A Worker. `executorReadiness()` is deliberately non-executable and `createStarknetRelayAdapter()` always fails with `signer_adapter_unavailable`. Before funded Phase B:

1. Replace `DEPLOYMENT_ID`, stage, contract, origin, RPC URL, relayer account, and both rate-limit namespace IDs with deployment-specific values.
2. Install `RELAYER_ACCOUNT_PRIVATE_KEY` and `STARKNET_RPC_AUTH_TOKEN` through `wrangler secret put`; never put their values in source, config, logs, or client variables.
3. Implement and independently review the concrete `StarknetRelayAdapter`; it must bind its simulation, signed call, submitted transaction, and receipt to the exact plan fingerprint and maximum fee.
4. Exercise the Durable Object migration, RPC provider, account nonce, balance alert, receipt timeout/reconciliation runbook, and rollback under a non-funded staging profile.
5. Add a neutral, no-wallet/no-vault-payload route for the permissionless `sync_funding_checkpoint` call immediately before a private FUND. The ordinary owner Ready address must never submit that public checkpoint.
6. Only then make readiness executable in a reviewed promotion commit. Setting the flag or adding secrets alone cannot activate this Phase A tree.

Run `npm install`, `npm run types`, then `npm run check`. `npm run dry-run` only bundles locally; nothing is deployed.
