# Mainnet release and evidence

## Current evidence level

Afterlight has a complete deployed Mainnet mechanism and four validator-qualified
STRK20 receipts. It is classified **E2 observable replay**. After L1 finality,
a fresh approved Ready X `wallet_strk20Balances` read showed the successor at
`7 STRK`, compared with the verified `6 STRK` pre-claim balance. Prepared,
simulated, reverted, and unrelated pool transactions are not counted as
successful evidence.

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
| Neutral relayer account | `0x05b0b8cbda8eca89b88ae6975c80a880b0164a853c6ed881a56e39e4622edd46` | Deployed; spike controls complete |

Run `scarb --profile spike-inline-56 build` and
`npm --prefix client run verify:locked-artifacts` to recompute the exact hashes.
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

The official hub validator's exact success, pool-touch, and declared-contract
ownership checks pass for all four. Vault A is `CANCELLED`, Vault B is
`CLAIMED`, total locked liability is zero, and the neutral pool allowance is
zero. Exact-note settlement is proven onchain. The wallet's post-finality
reconciliation is `6 STRK -> 7 STRK`: the exact `+1 STRK` recovery output was
added to the beneficiary while the neutral sponsor paid the separate `6 STRK`
pool fee. A fresh E3 public-interface lifecycle and final video remain pending.
