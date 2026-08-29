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

The onchain STRK20 withdrawal event encrypts the originating user address from
public observers while exposing destination, token, amount, and timing. The
STRK20 auditor can decrypt that address, and Ready/paymaster/network
infrastructure may process correlating metadata. Afterlight therefore claims
public-onchain unlinkability only. It does not claim to hide amounts or timing,
make authorization keys invisible, prove that a hidden note belongs to a
precommitted wallet, provide privacy from protocol infrastructure, or automate
legal inheritance.

## Trust and dependency assumptions

- Ready X protects wallet and viewing-key material and correctly implements the advertised STRK20 Wallet API.
- The STRK20 auditor and Ready/paymaster infrastructure are trusted with the protocol metadata they necessarily process; they are outside the public-observer privacy claim.
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
| Tokens are donated directly to the helper | No administrative withdrawal exists; donated surplus remains inert and cannot change locked liabilities |
| Relayer drains sponsorship | Schema limits, expiry, validation before scarce per-vault rate limiting, separate control/exit daily caps, shared nonce serialization, and breach freeze |
| Prepared proof swaps the pool implementation or adds actions | Pinned live pool class plus an exact `WriteOnce → EmitOpenNoteCreated → Invoke` action sequence and canonical destination-note storage write |
| Ambiguous broadcast is retried or released | `SUBMITTED` retains its hash and reservation; duplicate/unknown RPC results reconcile without signing or rebroadcasting |
| Reserve demand exceeds current neutral-sponsor capacity | The supported UI and checkpoint route fail closed unless live allowance, balance, exit cap, health floor, liability and lease state reconcile. The permissionless contract checkpoint can still admit another fully backed vault outside that route, so sponsorship is explicitly capacity-limited and an exit may queue until capacity is restored; no vault can consume another vault's backing. |
| Application logs correlate a wallet or vault | Request bodies, signatures, IPs, wallet addresses, vault IDs, and fingerprints are excluded from application logs; infrastructure metadata remains a separate limit |

## Relayer and hosting metadata boundary

The application no-log policy means Afterlight's Worker code must not emit
request bodies, signatures, IP addresses, wallet addresses, application keys,
vault IDs, fingerprints, RPC authorization, or exact private-flow timing. The
relayer necessarily receives the signed public authorization fields needed for
contract submission, including a vault identifier; "not logged" does not mean
"not processed."

Cloudflare, DNS, network, and RPC infrastructure may transiently process source
IP, user agent, TLS, routing, request timing, relayer account, and transaction
metadata. The RPC provider also observes the relayer's public calls. Deployment
must disable or minimize request logging and analytics where configurable,
avoid payload capture, use the shortest operational retention available, and
never build an IP-to-vault or wallet-to-vault correlation store. These controls
reduce retained metadata; they cannot promise that hosting or network metadata
never exists. Public state-transition timing can still support correlation.

## Key separation

The owner and successor each generate a fresh application key per vault. The successor secret is generated and retained only by the successor. Ready account keys, application keys, destination notes, and the neutral relayer key remain separate.

Loss of an application secret can make its role unavailable. Compromise can authorize only operations within the signed domain and current contract state; it does not reveal a Ready seed or permit changing the exact destination of an already signed claim.

The contract has no administrative withdrawal path. Users should not send
donations to the helper expecting a refund; unaccounted surplus remains inert.

## Tested failure classes

The local suites cover caller, token, amount, mode, interval, key reuse, wrong-key, expiry, nonce, epoch, state, contract, chain, vault, destination, redirect, replay, double settlement, dust, surplus, liability isolation, timing boundaries, veto/claim races, and failed-transfer rollback.

Mainnet receipts now prove the neutral-sender control path, both STRK20 funding actions, exact-note cancellation, exact-note successor recovery, terminal states, and zero remaining liability. A fresh public E3 Recovery Drill completed through the canonical app; its succeeded claim moved the vault to `CLAIMED` and a fresh Ready X read proved the successor balance increased from `7 STRK` to `8 STRK`. The founder-controlled wallets share historical public funding correlation, so this is E3 product evidence, not proof of historically unrelated participants or E4 independent completion.
