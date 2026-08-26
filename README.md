# Afterlight

Afterlight is a private, bounded recovery reserve for Starknet self-custody wallets.

An owner privately funds a fixed reserve through STRK20 and remains in control through authenticated heartbeats and a veto window. If no authenticated heartbeat arrives during the configured interval, only the designated successor application key can authorize recovery to one exact private destination after the grace period.

## Current status

**Evidence level: E1 (locally repeatable implementation evidence).** The recovery contract, application-key client, structural prepared-exit envelope validator, and neutral-relayer boundary have deterministic local test and build coverage. The locked deployment artifacts also reproduce locally.

**Release status: pre-deployment and not user-ready.** The Afterlight class and contract are not declared or deployed, no funded mainnet lifecycle has run, no qualifying transaction hashes exist, and no E2 mainnet result is claimed. The public relayer endpoint is an inert, submission-disabled packaging and health check; it is not a live recovery service.

## Recovery flow

```text
ACTIVE
  |-- heartbeat --------------------------> ACTIVE
  |-- private cancellation/refund --------> CANCELLED
  `-- no authenticated heartbeat
      for the configured interval
      + successor request ----------------> GRACE
                                                |-- owner veto --> ACTIVE
                                                `-- private claim -> CLAIMED
```

The contract binds signed actions to their version, expiry, expected state, epoch, nonce, chain, contract, vault, token, amount, and—when applicable—the exact destination note. Owner and successor nonces are separate.

## Privacy boundary

STRK20 is used for private funding, private cancellation/refund, and private recovery. Heartbeat, request, and veto are signed with per-vault application keys and are designed for submission by a neutral relayer.

Public information includes the Afterlight contract, token and fixed denomination, vault activity, timing, application public keys, and state transitions. The design aims to keep the application keys unlinked from the owner and successor Ready wallet addresses, and to keep the funding-wallet and recovery-wallet relationships private from public onchain observers.

Afterlight does not claim legal inheritance, invisible authorization keys, proof that a hidden note belongs to a precommitted wallet address, or privacy from the STRK20 auditor and wallet/paymaster infrastructure.

## Repository layout

- `src/` — Cairo recovery state machine and STRK20 helper boundary
- `tests/` — Cairo unit and integration tests
- `client/` — application keys, typed authorization messages, Ready/STRK20 action assembly
- `relayer/` — fail-closed neutral-relayer implementation and operational controls
- `docs/ARCHITECTURE.md` — component boundaries, action routing, state and accounting model
- `docs/THREAT_MODEL.md` — protected assets, trust assumptions, privacy limits, and failure handling
- `docs/READY_X_ONBOARDING.md` — pre-deployment Ready X prerequisites and planned owner/successor flow
- `docs/MAINNET.md` — pinned Mainnet dependencies, locked artifacts, and intentionally empty evidence slots

## Design documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Ready X onboarding](docs/READY_X_ONBOARDING.md)
- [Mainnet release and evidence](docs/MAINNET.md)
- [Neutral relayer operations](relayer/OPERATIONS.md)

## Build and test

Prerequisites:

- Scarb `2.18.0` (the package dependencies resolve Cairo `2.17.0`)
- Starknet Foundry `0.62.1`
- Node.js `22.13.1`

These are the exact versions exercised by CI. Both npm packages have committed
lockfiles and must be installed with `npm ci`, not `npm install`.

```bash
scarb build
snforge test
scarb --profile spike-inline-56 build

npm --prefix client ci
npm --prefix client run verify:locked-artifacts
npm --prefix client test

npm --prefix relayer ci
npm --prefix relayer run check
```

The public CI workflow also rebuilds the locked `spike-inline-56` deployment
profile and verifies its exact Sierra and compiled class hashes before running
the Cairo, client, and relayer tests. It audits both npm trees, checks relayer
types and lint rules, and builds a submission-disabled Cloudflare Worker dry
run.

No wallet seed, application private key, or relayer secret belongs in source control. The relayer remains unable to submit transactions unless its complete production configuration is installed and its explicit submission switch is enabled.

## License

MIT. See [LICENSE](LICENSE).
