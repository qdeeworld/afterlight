# Recovery SDK consumer example

This developer example installs the packed `@afterlight/recovery@0.1.0` SDK in a
temporary directory outside the checkout. It compiles against public exports,
builds a browser-compatible module, and checks application-key authorization
and calldata assembly using local synthetic fixtures.

Prerequisites: Node.js `22.13.1`, npm, and access to the npm registry or a populated
npm cache for the pinned example tools and SDK dependencies.

From the repository root, build a tarball and pass its exact path to the harness:

```sh
sdk_archive_dir="$(mktemp -d)"
(cd client && npm pack --pack-destination "$sdk_archive_dir")
node examples/recovery-integration/verify.mjs "$sdk_archive_dir/afterlight-recovery-0.1.0.tgz"
```

The harness verifies the archive's SHA-512 against the committed consumer lockfile,
installs its pinned dependency tree with `npm ci --ignore-scripts`, compiles strict TypeScript,
bundles the control helper for browsers, and runs Node tests. A failure exits
nonzero. It removes only the temporary consumer directory it created; the SDK
archive remains at the path supplied by the caller. The checked-in example
directory is a template for this isolated install, not an npm workspace.

Whenever SDK package contents change, including its packaged README, regenerate
the consumer lock against the final new archive before running verification:

```sh
node examples/recovery-integration/refresh-lock.mjs "$sdk_archive_dir/afterlight-recovery-0.1.0.tgz"
node examples/recovery-integration/verify.mjs "$sdk_archive_dir/afterlight-recovery-0.1.0.tgz"
git diff -- examples/recovery-integration/package-lock.json
```

Lock generation is an explicit maintainer action. It resolves a fresh dependency
tree in a temporary directory and updates only this example's `package-lock.json`;
review all transitive changes before committing it. Normal verification and CI
never regenerate or amend the lockfile. A tarball mismatch fails before installation.

[`src/prepare-control.ts`](src/prepare-control.ts) shows how a consumer combines a
vault snapshot and the designated local application key into a signed heartbeat,
recovery request or veto payload. Owner controls use the owner nonce; recovery
requests use the successor nonce. The payload binds state, epoch, nonce, expiry,
chain and contract. The helper returns the payload to its caller and makes no
network request. In a real integration, obtain a consistent accepted contract
snapshot, check current action eligibility, and handle stale state or receipt
ambiguity before requesting new authorization. The contract remains authoritative.

The local checks cover root/subpath package resolution, designated-role signatures,
state/epoch/nonce changes invalidating those signatures, expiry and contract-policy
rejection, funding action assembly, exact-note claim calldata and redirect rejection,
and encrypted backup restoration. Application keys are generated only in memory
and destroyed afterward; no key, password, backup, signature or payload is printed.
The fixture addresses and timestamps do not describe a Mainnet vault.

These tests establish package consumability and local integration behavior. They do
not execute the Cairo state machine, generate or authenticate a privacy proof,
test Ready permissions, fund a reserve, submit a claim, or establish independent
user completion. Browser bundling is a compatibility check, not a live browser
wallet test. Published Mainnet evidence belongs to the existing application release.

The hosted sponsor is allowlisted to the existing Afterlight app origins; importing
this SDK does not grant another site's relay admission or sponsorship. Setup consent
also pins the current sponsor, pool/class, Afterlight contract/class, chain and token.
A real external application needs an explicitly supported service arrangement or a
separately operated and reviewed relay configuration. Generic setup sponsorship and
automatic fee-free recovery are not SDK features.
