# Afterlight

Afterlight is a private, bounded recovery reserve for Starknet self-custody wallets.

An owner privately funds a fixed reserve through STRK20 and remains in control through authenticated heartbeats and a veto window. If the owner becomes inactive, only the designated successor application key can authorize recovery to one exact private destination.

## Current status

Afterlight is under active development for the STRK20 Private Sprint. The recovery contract, application-key client, and neutral-relayer boundary have deterministic local test coverage. Mainnet deployment and lifecycle evidence are not complete yet and are not claimed by this repository.

## Recovery flow

```text
ACTIVE
  |-- heartbeat --------------------------> ACTIVE
  |-- private cancellation/refund --------> CANCELLED
  `-- inactivity + successor request -----> GRACE
                                                |-- owner veto --> ACTIVE
                                                `-- private claim -> CLAIMED
```

The contract binds signed actions to their version, expiry, expected state, epoch, nonce, chain, contract, vault, token, amount, and—when applicable—the exact destination note. Owner and successor nonces are separate.

## Privacy boundary

STRK20 is used for private funding, private cancellation/refund, and private recovery. Heartbeat, request, and veto are signed with per-vault application keys and are designed for submission by a neutral relayer.

Public information includes the Afterlight contract, token and fixed denomination, vault activity, timing, application public keys, and state transitions. The design aims to keep the application keys unlinked from the owner and successor Ready wallet addresses, and to keep the funding-wallet and recovery-wallet relationships private.

Afterlight does not claim legal inheritance, invisible authorization keys, or proof that a hidden note belongs to a precommitted wallet address.

## Repository layout

- `src/` — Cairo recovery state machine and STRK20 helper boundary
- `tests/` — Cairo unit and integration tests
- `client/` — application keys, typed authorization messages, Ready/STRK20 action assembly
- `relayer/` — fail-closed neutral-relayer implementation and operational controls
- `docs/ARCHITECTURE.md` — component boundaries, action routing, state and accounting model
- `docs/THREAT_MODEL.md` — protected assets, trust assumptions, privacy limits, and failure handling

## Design documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Neutral relayer operations](relayer/OPERATIONS.md)

## Build and test

Prerequisites:

- Scarb compatible with Cairo `2.17.0`
- Starknet Foundry `0.62.1`
- Node.js 22 or later

```bash
scarb build
snforge test
scarb --profile spike-inline-56 build

npm --prefix client ci
npm --prefix client run verify:locked-artifacts
npm --prefix client test

npm --prefix relayer ci
npm --prefix relayer test
```

The public CI workflow also rebuilds the locked `spike-inline-56` deployment
profile and verifies its exact Sierra and compiled class hashes before running
the Cairo, client, and relayer tests. It audits both npm trees, checks relayer
types and lint rules, and builds a submission-disabled Cloudflare Worker dry
run.

No wallet seed, application private key, or relayer secret belongs in source control. The relayer remains unable to submit transactions unless its complete production configuration is installed and its explicit submission switch is enabled.

## License

MIT. See [LICENSE](LICENSE).
