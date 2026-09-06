# Afterlight

Afterlight is a private, bounded recovery reserve for Starknet self-custody wallets.

An owner privately funds a fixed reserve through STRK20 and remains in control through authenticated heartbeats and a veto window. If no authenticated heartbeat arrives during the configured interval, only the designated successor application key can authorize recovery to one exact private destination after the grace period.

[Open Afterlight](https://afterlight.dolepee.com) · [Mainnet evidence](docs/MAINNET.md) · [Deployed contract](https://starkscan.co/contract/0x06e8b6e49b4366e0dc6a35eee722b417c718988eca3f4a0c298bdf8785261c25)

Canonical hackathon listing: **`afterlight-recovery`** in the [official registry](https://github.com/starkience/strk20-hackathon/blob/main/registry.json).

[![CI](https://github.com/qdeeworld/afterlight/actions/workflows/ci.yml/badge.svg)](https://github.com/qdeeworld/afterlight/actions/workflows/ci.yml)

## Working on Mainnet

Two external users—an owner and a successor—completed a real recovery on
Starknet Mainnet using Afterlight. The successor confirmed receiving the
`1 STRK` reserve in their private account.

The September 5, 2026 recovery transaction succeeded, moved the reserve to
`CLAIMED`, and reduced its remaining liability to zero.

Afterlight’s public Recovery Drill demonstrates private funding, heartbeat,
recovery request, owner veto and successful private recovery. Five published
Mainnet transactions have passed the official validator’s checks.

The [Mainnet record](docs/MAINNET.md) contains the drill receipts and verification
details. The external recovery is a separate event, not one of those five hashes.

The public app provides Ready X connection, encrypted per-vault key backups, private funding, live reserve state, heartbeat and veto controls, private recovery, and post-claim balance reconciliation.

## Costs and availability

- The current reserve is `1 STRK`. The owner also pays Ready's quoted funding and any required wallet-setup costs; `1 STRK` is not an all-in cost.
- Eligible claim and cancellation fees are paid by the bounded sponsor while live capacity is available. A registered successor with zero private STRK can use [first-use token setup](docs/FRESH_WALLET_COMPATIBILITY.md) without a separate Shield deposit when that policy is advertised. Account deployment and private registration are separate prerequisites.
- Up to three isolated reserves can be admitted only when allowance, balance and the daily budget conservatively cover their exits. This is a policy ceiling, not a promise of three currently available slots or unlimited sponsorship.
- If the neutral control relay is unavailable, an explicit Ready X emergency path can submit heartbeat, request or veto, but publicly links that Ready address to the reserve. New sponsored private exits still require the sponsor's authorization; the browser can broadcast already-signed exits through a public RPC.

See [Ready X onboarding](docs/READY_X_ONBOARDING.md) for setup, backups and the ordinary owner/successor flow, and [relayer operations](relayer/OPERATIONS.md) for the sponsorship policy.

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

## Build on Afterlight

The same recovery primitives are available as **`@afterlight/recovery`**, a typed
ESM package with application keys, encrypted backups, authorization hashes,
STRK20 action builders and exit validation. Install it from the package archive;
no npm registry publication is assumed.

Start with the [SDK integration guide](docs/RECOVERY_SDK.md),
[separate installed-package example](examples/recovery-integration/README.md),
and public [`IAfterlight` Cairo interface](src/afterlight.cairo). The example runs
locally without a wallet or transaction. A live application still needs its own
supported wallet and relay arrangement; SDK installation does not grant access
to Afterlight's bounded sponsor.

## Design documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Ready X onboarding](docs/READY_X_ONBOARDING.md)
- [Mainnet release and evidence](docs/MAINNET.md)
- [Recovery SDK and Cairo integration](docs/RECOVERY_SDK.md)
- [Neutral relayer operations](relayer/OPERATIONS.md)

## Build and test

Prerequisites:

- Scarb `2.18.0` (the package dependencies resolve Cairo `2.17.0`)
- Starknet Foundry `0.62.1`
- Node.js `22.13.1`

These are the exact versions exercised by CI. The application packages and the
integration example have committed lockfiles and use `npm ci` for verification.

```bash
scarb build
snforge test
scarb --profile spike-inline-56 build

npm --prefix client ci
npm --prefix client run verify:locked-artifacts
npm --prefix client run verify:mainnet
npm --prefix client test
npm --prefix client run test:package

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
