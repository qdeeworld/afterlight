# @afterlight/recovery

Typed ESM primitives for Afterlight recovery: application keys and backups,
Cairo-compatible authorization hashes, STRK20 funding and exit actions, relay
payloads, and structural exit preflight. Version `0.1.0` packages the existing
client implementation without changing its behavior.

## Install from a local package

From the repository's `client/` directory, using Node.js `22.13.1` or newer:

```sh
npm ci
npm pack
```

Then, in a separate ESM application:

```sh
npm install --ignore-scripts /absolute/path/to/afterlight-recovery-0.1.0.tgz
```

The package is installable from its tarball; these instructions do not assume an
npm registry publication. `npm pack` builds only the SDK. The tarball contains
compiled JavaScript, TypeScript declarations, this README, the package manifest,
and the MIT license. It has no install-time hooks, operator tools, tests, local
configuration, or credentials.

```ts
import { felt, type FeltInput } from "@afterlight/recovery";
import { setupAuthorizationHash } from "@afterlight/recovery/setup-authorization";

const vaultId: FeltInput = 123n;
console.log(felt(vaultId)); // "0x7b"
// Synthetic digest: demonstrates the pinned setup-consent hash only.
console.log(setupAuthorizationHash("00".repeat(32)));
```

All exports are available from `@afterlight/recovery`. Narrow imports are also
available at `/actions`, `/encoding`, `/exit-preflight`, `/keys`, `/messages`,
`/relay`, and `/setup-authorization`. ESM JavaScript and TypeScript are supported;
there is no CommonJS entrypoint. Runtime dependencies are pinned to
`starknet@10.7.0` and `@starknet-io/types-js@0.10.4-beta.2`. Browser bundlers can use
the same modules; key generation and encrypted backups require secure-context
Web Crypto (`crypto.getRandomValues` and `crypto.subtle`).

See the repository's [integration guide](https://github.com/qdeeworld/afterlight/blob/main/docs/RECOVERY_SDK.md)
and [installed consumer example](https://github.com/qdeeworld/afterlight/tree/main/examples/recovery-integration)
for the contract interface and local integration checks.

## Integration limits

These primitives assemble and validate data. Installing or importing the package
does not connect a wallet, submit a transaction, or grant sponsorship. The caller
supplies wallet and RPC ports to `PrivateExitPreflight`; invoking those ports can
contact the caller's configured services. Structural proof-envelope validation
does not cryptographically verify a proof or establish a successful transaction.

The setup-authorization hash is tied to Afterlight's pinned Mainnet deployment,
sponsor, pool and STRK token. It is not a configurable consent domain for another
deployment. The hosted sponsor applies its own origin and policy allowlists;
another application needs an explicitly supported relay arrangement. Ordinary
signature checks, fresh contract state, wallet confirmation, fees, and successful
receipts remain necessary for live recovery. The local consumer example is
synthetic integration evidence, not an independently completed live recovery.

## Repository development

The sections below describe tools available in a repository checkout, not in the
installed SDK tarball. To run the local checks from `client/`:

```sh
npm ci
npm test
npm run test:package
```

`npm run build:sdk` emits only the public modules into `dist/sdk/`. The existing
`npm run build` also builds the repository's unit-test targets into `dist/`.

### Local operator primitives

The repository also contains deterministic application-key, authorization, relay-schema,
STRK20 action, structural prepared-exit envelope validation, read-only quote, and explicit local
operator primitives. It has no public product UI or production storage. Its
quote, preflight, and operator tools can read Mainnet; only the explicitly labelled
operator buttons can request a wallet declaration or deployment, and each still
requires a visible Ready X confirmation. The deployed Mainnet release and its
five qualifying receipts are recorded in [Mainnet release documentation](https://github.com/qdeeworld/afterlight/blob/main/docs/MAINNET.md).

```sh
npm ci
npm test
```

The tested toolchain is Node.js `22.13.1` with the committed npm lockfile.

The live exit canary is intentionally strict: `CANCEL_REFUND` and `CLAIM` give
Ready exactly an `OPEN` transfer followed by the helper invoke. They never add a
public self-withdraw. Ready adds its own private paymaster-fee withdrawal during
submission. Afterlight reproduced this exact-note route through its own helper
for both `CANCEL_REFUND` and `CLAIM` on Mainnet. The contract states, liability,
pool allowance, exact destination notes, and five qualifying receipts reconcile;
fresh Ready reads proved the E2 and public E3 shielded-balance increases.

Run `npm run verify:mainnet` for a read-only check of the five qualifying
receipts, deployed class and configuration, neutral control senders, terminal
vault states, and zero locked liability.

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

`tools/private-exit-preflight.html` is a no-submit structural check for
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
