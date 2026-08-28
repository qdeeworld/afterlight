# Afterlight

Afterlight is a private, bounded recovery reserve for Starknet self-custody wallets.

An owner privately funds a fixed reserve through STRK20 and remains in control through authenticated heartbeats and a veto window. If no authenticated heartbeat arrives during the configured interval, only the designated successor application key can authorize recovery to one exact private destination after the grace period.

## Current status

**Evidence level: E2 observable replay.** The complete two-branch recovery mechanism has run on Starknet Mainnet. Four successful transactions touch both the canonical STRK20 pool and Afterlight, including exact-note private cancellation and successor recovery. After L1 finality, a fresh Ready X read showed the successor's shielded balance increase from `6 STRK` to `7 STRK`, reconciling the exact `1 STRK` recovery output while the neutral sponsor paid the separate pool fee.

**Release status: deployed mechanism and public-product candidate; fresh E3 pending.** Afterlight is [deployed on Mainnet](https://starkscan.co/contract/0x06e8b6e49b4366e0dc6a35eee722b417c718988eca3f4a0c298bdf8785261c25). Vault A completed `FUND -> CANCEL_REFUND`; Vault B completed early refusal, heartbeat, request, veto, second request, and `CLAIM`. The bounded neutral relayer executed the control path without using either Ready role as the outer sender. The public app now supports real Ready X connection, local per-vault keys, private funding, live state, relayed controls, exact-note recovery, and post-claim balance reconciliation. It is not classified E3 until a fresh user completes that path through the deployed interface.

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
- `web/` — user-first owner and successor journeys for the deployed Mainnet release
- `docs/ARCHITECTURE.md` — component boundaries, action routing, state and accounting model
- `docs/THREAT_MODEL.md` — protected assets, trust assumptions, privacy limits, and failure handling
- `docs/READY_X_ONBOARDING.md` — Ready X prerequisites and owner/successor flow
- `docs/MAINNET.md` — pinned Mainnet dependencies, deployed artifacts, and transaction evidence

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

npm --prefix web ci
npm --prefix web run build
```

The public CI workflow also rebuilds the locked `spike-inline-56` deployment
profile and verifies its exact Sierra and compiled class hashes before running
the Cairo, client, relayer, and web checks. It audits every npm tree, checks
relayer types and lint rules, builds both Worker configurations without
submitting, and compiles the production web bundle.

No wallet seed, application private key, or relayer secret belongs in source control. The relayer remains unable to submit transactions unless its complete production configuration is installed and its explicit submission switch is enabled.

## License

MIT. See [LICENSE](LICENSE).
