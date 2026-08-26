# Afterlight architecture

Afterlight separates private value movement, application authorization, and transaction submission. No wallet address is treated as the owner or successor authority.

## Components

| Component | Responsibility | Must not hold |
|---|---|---|
| Ready X and STRK20 | Shielded balances, private invocation, proof preparation, and exact open-note settlement | Owner or successor application secrets outside the user's device |
| Afterlight Cairo contract | Vault state, signed authorization, liabilities, timing, exact-note binding, and terminal settlement | Ready wallet identity assumptions |
| Client library | Per-vault key generation, typed authorization hashes, STRK20 action assembly, and E1 proof-envelope/call binding | Relayer account key |
| Neutral relayer | Submit bounded `HEARTBEAT`, `REQUEST`, `VETO`, and checkpoint transactions from one neutral account | Owner/successor secrets, Ready addresses, or authority over contract state |

## Action routing

`FUND`, `CANCEL_REFUND`, and `CLAIM` enter through the canonical STRK20 pool and the contract's `privacy_invoke` entrypoint. The contract rejects any other caller.

`HEARTBEAT`, `REQUEST`, and `VETO` are public state transitions authorized by per-vault Stark signatures. Any submitter may relay a valid authorization; the submitter is never the authority.

```text
Ready X + STRK20 pool
  |-- FUND ------------------------------> Afterlight liability + ACTIVE vault
  |-- CANCEL_REFUND ---------------------> exact private note + CANCELLED
  `-- CLAIM -----------------------------> exact private note + CLAIMED

Owner/successor device --> signed bounded request --> neutral relayer --> Afterlight
```

## State machine

```text
ACTIVE(epoch, last_heartbeat)
  |-- HEARTBEAT --------------------------> ACTIVE (timer reset)
  |-- CANCEL_REFUND ----------------------> CANCELLED
  `-- REQUEST after no authenticated
      heartbeat for the configured
      interval ---------------------------> GRACE(requested_at, claim_after)
                                               |-- VETO ------> ACTIVE (new epoch)
                                               `-- CLAIM -----> CLAIMED
```

At or after `claim_after`, a valid veto and valid claim race. The first successful transaction changes the state; the other then fails against the new state or epoch.

## Authorization domain

Every signed operation binds:

- a versioned operation tag and expiry;
- expected state, epoch, and the role-specific nonce;
- Starknet chain ID and Afterlight contract;
- vault ID, token, fixed amount, and signer application key;
- the exact destination open-note ID for private exits.

Owner and successor nonces are independent. Every successful authorization consumes its nonce. A veto increments the vault epoch and invalidates stale successor authorizations.

## Funding and liabilities

The helper does not claim that a balance increase alone proves which private invocation supplied it. Funding therefore uses a public neutral checkpoint followed by an exact-liability rule:

```text
held token balance >= existing locked liabilities + new fixed reserve
```

Only the configured reserve becomes a vault liability. Donated surplus neither blocks funding nor creates a claim. Claim and cancellation reduce the liability exactly once; failed settlement reverts the state change.

The constructor assigns a public `surplus_admin`. That address may transfer only
the amount strictly above total locked liabilities; it cannot use the surplus
path to withdraw a vault reserve, change a vault, or change protocol
configuration. This is nevertheless an administrative trust boundary: the
admin chooses the public recipient of unaccounted donations, and an accidental
donor has no protocol-level right to reclaim them. A compromised admin can take
available surplus, while the contract's liability check is the control that
protects accounted user reserves.

## Vault modes

`NORMAL` enforces production-oriented inactivity and grace bounds. `FAST_DEMO` permits short intervals while preserving the same signatures, accounting, caller restrictions, exact-note binding, and replay protection. The mode is immutable per vault and caps the principal at 10 STRK.

## Current release boundary

The repository currently proves the design through deterministic local tests. Contract addresses and mainnet transaction evidence will be published only after a complete live lifecycle succeeds; until then they are intentionally absent.
