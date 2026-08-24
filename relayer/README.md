# Afterlight neutral relayer — Phase A

This directory is a no-deploy, no-funds proof of the neutral control-plane relayer. It consumes the canonical `afterlight-relay/1` schema from `../client`, accepts only `HEARTBEAT`, `REQUEST`, and `VETO`, builds one exact Afterlight call, and deliberately has no signer or broadcast path.

## Proven locally

- Strict method, route, origin, content type, intent header, JSON shape, operation, contract, token, amount, expiry, state, and 2,048-byte limits.
- Mainnet chain configuration is explicit in every relay plan; Cairo signatures independently bind the chain.
- Bounded streaming body read; an advertised or observed oversized body is rejected.
- Cloudflare Rate Limiting bindings for both per-vault/operation and global abuse control. Keys are hashes, never client IP addresses.
- A deterministic fee policy that caps each transaction and the daily exposure. It reserves the transaction maximum, not the optimistic quote.
- No owner or successor application secret, Ready address, wallet address, client IP, payload, signature, or vault identifier is logged.
- Health exposes only operational configuration and confirms submission remains disabled.
- The Cairo contract remains authoritative: a future executor must simulate the exact call, atomically reserve its maximum fee, and only then sign with the neutral relayer account.

## Production blockers (intentional)

Do not set `SUBMIT_ENABLED=true` on this Phase A Worker. Before funded Phase B, add a separate signer/executor with:

1. The neutral account key stored with `wrangler secret put` or a Secrets Store binding; never in source, config, logs, or client variables.
2. Contract simulation before gas payment.
3. Exact atomic daily-budget reservation and request-fingerprint idempotency (a Durable Object is appropriate). Cloudflare Rate Limiting is permissive and eventually consistent, so it is abuse control, not financial accounting.
4. Fee estimation followed by `authorizeSponsorship`, with the returned maximum used as the signed transaction cap.
5. Receipt reconciliation, bounded account funding, health/balance alerts, and a tested rollback to a previous Worker version.
6. Replacement of the local placeholder contract/origin and both rate-limit namespace IDs with deployment-specific, account-unique values.

Run `npm install`, `npm run types`, then `npm run check`. `npm run dry-run` only bundles locally; nothing is deployed.
