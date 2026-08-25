# Afterlight Phase A client core

This package contains only deterministic wallet/authorization primitives for the bounded spike. It has no UI, storage, network calls, relayer server, or deployment code.

```sh
npm install
npm test
```

The live exit canary is intentionally strict: `CANCEL_REFUND` and `CLAIM` build exactly an `OPEN` transfer followed by the helper invoke. They never add a public self-withdraw. Ready must prove that this two-action form can source the protocol fee before Afterlight can promote.

Application secrets are held by `LocalStarkKey`; ordinary serialization exposes only the public key. Raw secret export requires the explicitly named backup method and confirmation constant. Relayer requests contain only signed public calldata for `HEARTBEAT`, `REQUEST`, or `VETO`.

The hash fixtures in `test/messages-keys.test.ts` freeze the operation tags and element order for Cairo parity tests. A prepared STRK20 call is assembly evidence only, not proof of a successful or refused mainnet transition.

The mainnet quote tool is simulation-only. It has no signing or submission
method. Build the selected Scarb profile first, then set a deployed public
account as the intended deployer to derive its exact UDC address:

```sh
AFTERLIGHT_COMPILER_PROFILE=spike-inline-56 \
AFTERLIGHT_SIMULATION_SENDER=0x... \
npm run quote:mainnet
```

`AFTERLIGHT_SURPLUS_ADMIN` defaults to that same public address and may be set
separately. The tool prints the full constructor calldata so the eventual
wallet review can be reconciled field-for-field.
