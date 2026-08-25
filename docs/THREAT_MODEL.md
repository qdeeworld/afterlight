# Afterlight threat model

## Security goals

Afterlight aims to ensure that:

1. only the canonical STRK20 pool can create or settle a private vault action;
2. only the owner application key can heartbeat, veto, or cancel;
3. only the designated successor application key can request and authorize private recovery;
4. a claim is bound to one vault, token, amount, nonce, epoch, contract, chain, and destination note;
5. locked liabilities never exceed held assets and cannot be consumed by another vault;
6. cancellation or claim can settle once, with replay and redirection rejected.

## Privacy goals

The design aims to keep these relationships unlinked onchain:

- funding Ready wallet to Afterlight vault;
- successor Ready wallet to recovery settlement;
- per-vault application keys to ordinary wallet addresses;
- later shielded-note activity to the public settlement transaction.

The following remain public:

- the Afterlight contract, token, and fixed denomination;
- vault activity, timing, application public keys, and state transitions;
- neutral-relayer and helper transactions;
- the fact that an exact open note was created.

Afterlight does not claim to hide amounts or timing, make authorization keys invisible, prove that a hidden note belongs to a precommitted wallet, or automate legal inheritance.

## Trust and dependency assumptions

- Ready X protects wallet and viewing-key material and correctly implements the advertised STRK20 Wallet API.
- The live STRK20 pool verifies proofs, charges its configured fee, and applies actions atomically.
- Starknet provides transaction ordering and state rollback on revert.
- The user's device protects the per-vault owner or successor secret and its backup.
- The relayer may censor or go offline, but cannot forge authorization or redirect settlement.

Relayer availability is operationally important but not trusted for correctness. A different submitter can relay the same still-valid signed request.

## Threats and controls

| Threat | Control |
|---|---|
| Direct helper call bypasses STRK20 | `privacy_invoke` accepts only the canonical pool caller |
| Wrong token or denomination | Immutable configured token and fixed-amount checks |
| Vault funded twice | Unique vault ID and terminal state checks |
| Donated/dusted tokens block users | Exact locked-liability accounting; surplus is separate |
| One vault consumes another's backing | Funding requires unencumbered balance above existing liabilities |
| Relayer impersonates a role | Contract verifies the per-vault Stark signature |
| Cross-chain or cross-contract replay | Chain ID and contract address are signed |
| Stale state authorization | Expected state, epoch, nonce, and expiry are signed |
| Redirected private exit | Exact destination open-note ID is signed and revalidated |
| Double claim or replay | Role nonce consumption and terminal vault state |
| Owner veto races a mature claim | First valid included transition wins; the other sees changed state |
| Failed token/pool settlement leaves false state | Cairo transaction rollback restores state and liability |
| Relayer drains sponsorship | Schema limits, expiry, rate limits, per-call cap, daily budget, nonce serialization, and breach freeze |
| Logs correlate a wallet or vault | Request bodies, signatures, IPs, wallet addresses, vault IDs, and fingerprints are excluded from logs |

## Key separation

The owner and successor each generate a fresh application key per vault. The successor secret is generated and retained only by the successor. Ready account keys, application keys, destination notes, and the neutral relayer key remain separate.

Loss of an application secret can make its role unavailable. Compromise can authorize only operations within the signed domain and current contract state; it does not reveal a Ready seed or permit changing the exact destination of an already signed claim.

## Tested failure classes

The local suites cover caller, token, amount, mode, interval, key reuse, wrong-key, expiry, nonce, epoch, state, contract, chain, vault, destination, redirect, replay, double settlement, dust, surplus, liability isolation, timing boundaries, veto/claim races, and failed-transfer rollback.

Mainnet privacy and availability claims remain unproven until a live Ready/STRK20 lifecycle produces reconciled receipts and balance changes.
