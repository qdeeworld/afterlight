# Mainnet release and evidence

## Current evidence level

Afterlight has a deployed public Mainnet Recovery Drill and five
validator-qualified STRK20 receipts. It is classified **E3 public completion**.
A fresh Recovery
Drill completed through the canonical app, and an approved Ready X
`wallet_strk20Balances` read showed the successor increase from `7 STRK` to
`8 STRK` after its exact-note claim. Prepared, simulated, reverted, and
unrelated pool transactions are not counted as successful evidence.

## Pinned Starknet Mainnet dependencies

| Item | Pinned value | Status |
|---|---|---|
| Chain ID | `0x534e5f4d41494e` (`SN_MAIN`) | Locked in authorization and proof validation |
| Canonical STRK20 pool | `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a` | Public dependency; not an Afterlight deployment |
| Current pool class | `0x067dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d` | Pinned by the exact prepared-exit binder |
| STRK token | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` | Constructor and action lock |

The STRK20 source at commit
`66e3caae8c0201227a6719696d004e30d90aea65` is an exact-ABI semantic
reference for the current integration. It is not claimed as a reproducible
artifact-identity proof for the live pool class.

## Locked Afterlight artifacts

| Item | Value | Mainnet status |
|---|---|---|
| Compiler profile | `spike-inline-56` | Reproduces locally and in CI |
| Sierra class hash | `0x05da9866f62cc6dd1e380e8d9206e78a752b460abdb802070e0be1208ec7b1a6` | Declared on Mainnet |
| CASM/compiled class hash | `0x055ba10e36aac8e21b3437f1413f009f6b17d3633c307941a4412ce73566251` | Declaration lock |
| Afterlight contract | [`0x06e8…61c25`](https://starkscan.co/contract/0x06e8b6e49b4366e0dc6a35eee722b417c718988eca3f4a0c298bdf8785261c25) | Deployed on Mainnet |
| Neutral relayer account | `0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46` | Deployed; public E3 controls complete |

Run `scarb --profile spike-inline-56 build` and
`npm --prefix client run verify:locked-artifacts` to recompute the exact hashes.
A read-only live release verification is available as
`npm --prefix client run verify:mainnet`.
A different source, dependency resolution, compiler, profile, constructor, or
deployer must be treated as a different release and re-verified.

## Qualifying lifecycle transactions

Each hash below is a successful Starknet Mainnet receipt that touches
the live STRK20 pool and runs through or emits from the declared Afterlight
contract. Plain Shield transactions and failed attempts do not fill these slots.

| Required branch | Mainnet transaction hash | Validator result |
|---|---|---|
| `FUND` Vault A | [`0x030ea1…21722`](https://starkscan.co/tx/0x030ea14ac22e5806e382658971b686692af280bf2f02173a430f572921121722) | PASS |
| `CANCEL_REFUND` Vault A | [`0x69e234…c0fb`](https://starkscan.co/tx/0x69e2345ae8816986a709de84f0dcb571b5d092400d6c53bf90197480102c0fb) | PASS |
| `FUND` Vault B | [`0x036e00…0682a`](https://starkscan.co/tx/0x036e003396fe360ae7fe4766646f493c0eb579d82509652559d40e460770682a) | PASS |
| `CLAIM` Vault B | [`0x11c990…c8098`](https://starkscan.co/tx/0x11c990aea864e755630d41fd1292620c313b3f64407fc0b3a902544c67c8098) | PASS |
| Public E3 `CLAIM` | [`0x722033…f5c1b6`](https://starkscan.co/tx/0x722033f7fd0397ff4d3845428c98cad885b6a63824f7c78a2b7e1d7d6f5c1b6) | PASS |

The official hub validator's exact success, pool-touch, and declared-contract
ownership checks pass for all five. At the terminal E2 checkpoint, Vault A was
`CANCELLED`, Vault B was `CLAIMED`, total locked liability was zero, and the
neutral pool allowance was zero. Exact-note settlement is proven onchain. The
wallet's post-finality
reconciliation is `6 STRK -> 7 STRK`: the exact `+1 STRK` recovery output was
added to the beneficiary while the neutral sponsor paid the separate `6 STRK`
pool fee. The public E3 vault is also `CLAIMED`; its immediate Ready X
reconciliation is `7 STRK -> 8 STRK`. Final video production remains pending.

The public E3 lifecycle was founder-operated. An unrelated owner-successor E4
completion is not claimed. After that lifecycle, the neutral sponsor allowance
was deliberately restored to exactly `12 STRK`. The hardened policy accepts a
positive allowance only in exact `6 STRK` fee increments, caps it at `60 STRK`,
and admits at most three outstanding vaults. New funding is allowed beside an
existing isolated liability only when the current allowance, sponsor balance,
retained floor, daily budget, reservation state and lease can conservatively
cover every admitted exit. A successful claim or cancellation consumes exactly
`6 STRK` of allowance.

The sponsor returns the exact signed private-exit transaction to the browser,
which broadcasts it through an independent public RPC and then asks the service
to reconcile the receipt. Heartbeat, request and veto retain the privacy-first
neutral route. A user can explicitly submit any of those controls from Ready X
if the relay is unavailable, with a mandatory warning that this emergency route
publicly links the Ready address to the vault. The relayer still provides gas
sponsorship and signing availability, but it no longer has exclusive control of
the final broadcast or the owner's control transaction.

Historical identifiers such as the `spike-inline-56` compiler profile and the
relayer's `phase-a` hostname are pinned release identifiers. They do not mean
the deployed public release is still an inert preparation environment; changing
them would break reproducibility or the stable public endpoint.
