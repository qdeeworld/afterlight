# Afterlight client and local operator primitives (E1)

This package contains deterministic application-key, authorization, relay-schema,
STRK20 action, structural prepared-exit envelope validation, read-only quote, and explicit local
operator primitives. It has no public product UI or production storage. Its
quote, preflight, and operator tools can read Mainnet; only the explicitly labelled
operator buttons can request a wallet declaration or deployment, and each still
requires a visible Ready X confirmation. No mainnet deployment is claimed.

```sh
npm ci
npm test
```

The tested toolchain is Node.js `22.13.1` with the committed npm lockfile.

The live exit canary is intentionally strict: `CANCEL_REFUND` and `CLAIM` give
Ready exactly an `OPEN` transfer followed by the helper invoke. They never add a
public self-withdraw. Ready adds its own private paymaster-fee withdrawal during
submission. A successful mainnet Wrenchless claim demonstrates this app-action
shape ([source](https://github.com/Timidan/wrenchless/blob/b61e989ad9f24d9ba4803bf28b796564579bd220/packages/canary-core/src/refill-claim.ts),
[mainnet receipt](https://voyager.online/tx/0x02e969f712d5ff8f3091bd42b06978c285c8ad221081da5f575afbc72f87888e)),
but Afterlight must still reproduce it with its own helper before promotion.

Application secrets are held by `LocalStarkKey`; ordinary serialization exposes only the public key. Raw secret export requires the explicitly named backup method and confirmation constant. Relayer requests contain only signed public calldata for `HEARTBEAT`, `REQUEST`, or `VETO`.

The hash fixtures in `test/messages-keys.test.ts` freeze the operation tags and element order for Cairo parity tests. A prepared STRK20 call is assembly evidence only, not proof of a successful or refused mainnet transition.

`validatePreparedExitProofEnvelope` is structural, no-submit validation.
`bindDappSubmittedPreparedExit` and `assertExactDappSubmittedPreparedExit` apply
only to the alternative route where a dApp/paymaster submits the exact
`wallet_strk20PrepareInvoke` response itself. They do not constrain normal
Ready `wallet_strk20InvokeTransaction`, which accepts actions and generates a
separate fee-bearing proof.

`assertManagedReadyExitEvidence` is the independent post-receipt gate for that
normal Ready route. It parses the actual outer transaction, rejects either
Ready role account as sender, locks the observed Ready sponsor
forwarder/selector, exact pool call, signed note and Afterlight calldata, and
then requires a succeeded receipt plus exact reserve-minus-fee shielded-balance
and liability deltas. A prepared action or wallet review cannot satisfy it.

The mainnet quote tool is simulation-only. It has no signing or submission
method. Build the selected Scarb profile first, then set a deployed public
account as the intended deployer to derive its exact UDC address:

```sh
scarb --profile spike-inline-56 build
npm run verify:locked-artifacts
AFTERLIGHT_COMPILER_PROFILE=spike-inline-56 \
AFTERLIGHT_SIMULATION_SENDER=0x... \
npm run quote:mainnet
```

The tool prints the full constructor calldata so the eventual wallet review can
be reconciled field-for-field. The contract has no surplus administrator or
administrative withdrawal path.

## Local mainnet operator

`tools/mainnet-operator.html` is an explicit, local-only declaration and
deployment operator. It does not auto-sign or auto-submit. Before enabling its
two wallet-impacting buttons it recomputes the Sierra and CASM hashes, derives
the exact UDC address, verifies Mainnet, checks the intended deployer, and reads
whether the class and contract already exist. Once deployed, the same read-only
refresh fails closed unless Mainnet returns the locked class hash and all ten
constructor-derived configuration fields exactly.

Copy `tools/mainnet-operator-config.example.json` to the ignored
`tools/mainnet-operator-config.local.json`, fill it from the private locked
deployment manifest, build the selected Scarb profile, and run:

```sh
npm run operator:build
python3 -m http.server 43118 --bind 127.0.0.1 --directory ..
```

Open `http://127.0.0.1:43118/client/tools/mainnet-operator.html` in the Chrome
profile containing Ready X. A declaration or deployment still requires a
separate, visible Ready wallet confirmation.

## Local private-exit preflight

`tools/private-exit-preflight.html` is an E1-only, no-submit check for
`CANCEL_REFUND` and `CLAIM`. It reads the currently selected Ready account
directly and silently before and after each Prepare call, enforces the
operation's plausible state/epoch/nonce and 900-second authorization window,
binds the resolved destination note, and structurally validates the returned
proof envelope against accepted Mainnet block data from declared-independent
RPC operators. Each read has a 12-second abort deadline so a stalled provider
cannot wedge the local flow. It does not cryptographically verify the opaque
proof, execute the helper, sign a wallet transaction, or broadcast anything.

The selected JSON is read with `File.text()` and must live outside the HTTP
document root. It is never fetched by URL. From `client/`, run:

```sh
npm run preflight:build
python3 -m http.server 43119 --bind 127.0.0.1 --directory tools
```

Open `http://127.0.0.1:43119/private-exit-preflight.html`, select the private
configuration with the file picker, and connect the exact Ready recipient. A
normal Ready submission later recompiles the fee-bearing proof; it does not
consume this preflight proof. The exact-note application signature makes any
intervening note-index drift fail closed onchain, and only a successful receipt
can establish E2 execution evidence.
