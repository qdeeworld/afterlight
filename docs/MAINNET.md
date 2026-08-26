# Mainnet release and evidence

## Current evidence level

Afterlight is **E1 and pre-deployment**. The entries below separate locked local
artifacts and public dependencies from evidence that does not exist yet. Empty
transaction slots are intentional; they must not be replaced by simulated,
prepared, reverted, or unrelated pool transactions.

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
| Sierra class hash | `0x066654717cccb9875687a1abc8defe640f08f709c01715ea828f14c1ec5c7f25` | Locked locally; not declared |
| CASM/compiled class hash | `0x05a3c0719b75e0c4655f707f95c7930b1b72291261138337b5b5ca0f3019e3b7` | Locked locally; not declared |
| Afterlight contract | — | Not deployed |
| Surplus administrator | — | Not selected onchain; constructor value pending deployment |
| Production neutral relayer | — | Not deployed or funded |

Run `scarb --profile spike-inline-56 build` and
`npm --prefix client run verify:locked-artifacts` to recompute the exact hashes.
A different source, dependency resolution, compiler, profile, constructor, or
deployer must be treated as a different release and re-verified.

## Qualifying lifecycle transactions

Each eventual hash must be a successful Starknet Mainnet receipt that touches
the live STRK20 pool and runs through or emits from the declared Afterlight
contract. Plain Shield transactions and failed attempts do not fill these slots.

| Required branch | Mainnet transaction hash | Validator result |
|---|---|---|
| `FUND` Vault A | — | Not run |
| `CANCEL_REFUND` Vault A | — | Not run |
| `FUND` Vault B | — | Not run |
| `CLAIM` Vault B | — | Not run |

There is therefore no E2 exact-note recovery, shielded-balance increase,
liability reconciliation, deployed demo URL, or submission-ready mainnet
evidence in this release.
