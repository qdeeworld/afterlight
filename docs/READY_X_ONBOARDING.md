# Ready X onboarding

## Evidence and release status

This is the intended Ready X flow for the **E1, pre-deployment** Afterlight
implementation. It documents prerequisites and the user boundary; it is not a
live-product runbook and is not an instruction to fund or sign today. There is
no deployed Afterlight contract, public product UI, or E2 mainnet lifecycle yet.

## Accounts and STRK20 prerequisites

Afterlight requires two genuinely separate Ready X accounts:

- the owner uses an owner Ready account for private funding and, if needed, a
  private cancellation/refund;
- the successor uses a different Ready account for the final private recovery;
- the same Ready account must not perform both roles merely through two
  application keys.

Before a live lifecycle, each account must be deployed on Starknet Mainnet,
registered with the live STRK20 pool, and able to read its shielded balance and
prepare an open note. The owner needs sufficient shielded STRK for the fixed
reserve. Each payer also needs sufficient public or shielded funds for the
then-current account, registration, protocol-fee, and gas route. Fees and
account state must be freshly quoted in Ready X; this document deliberately
does not present an old estimate as a funding instruction.

Keep the Ready account key, the Afterlight application key, and destination
note material separate. Never paste a Ready seed or private key into Afterlight,
the relayer, a repository, or an evidence file.

## Per-vault application keys

The owner generates a fresh owner application key locally for each vault. The
successor independently generates a fresh successor application key locally for
that vault and gives the owner only its public key. The owner must never create,
receive, store, or derive the successor secret.

Application keys authorize Afterlight state transitions; they are not Ready
accounts and do not own the destination note. Reusing an application key across
vaults would create avoidable public correlation and is unsupported onboarding.

The current client library can export a key only through the explicit
`serializeBackup` confirmation and can restore it with `LocalStarkKey.restore`.
That JSON contains the application private key and is **not encrypted by the
library**. Treat it like a signing secret: encrypt it with a user-controlled
method, store it offline, test restoration before funding, and never upload it
to the relayer. A production UI must make backup/import and this plaintext
library boundary explicit.

## Planned owner journey

1. Connect the owner Ready X account and verify Starknet Mainnet, deployment,
   STRK20 registration, and balances.
2. Generate and back up a new owner application key on the owner's device.
3. Receive only the successor's fresh per-vault public key.
4. Choose a permitted vault mode, fixed denomination, inactivity interval, and
   grace interval.
5. Save the vault/recovery package and verify that the application-key backup
   can be imported before moving value.
6. Review and confirm the Ready X private `FUND` action. A successful receipt
   must touch both the canonical STRK20 pool and the deployed Afterlight helper
   and must reconcile to one exact liability increase.
7. While active, sign `HEARTBEAT` or `VETO` with the owner application key and
   send only the bounded signed request to the neutral relayer. Do not submit
   these controls from the ordinary owner Ready address.
8. To cancel, have Ready X prepare a new owner destination open note, bind the
   authorization to that exact note, token, amount, vault, epoch, and nonce,
   and privately execute `CANCEL_REFUND` through STRK20.

## Planned successor journey

1. Generate and back up a fresh successor application key on the successor's
   own device; share only its public key with the owner.
2. Import the vault package and connect the separate successor Ready X account.
3. After no authenticated heartbeat has arrived for the configured interval,
   sign `REQUEST` with the successor application key and send the bounded signed
   request through the neutral relayer. The contract, not the relayer, decides
   whether the request is valid.
4. Observe the public grace period. A valid owner veto returns the vault to
   active state and requires another full no-heartbeat interval and request.
5. After grace, ask Ready X to prepare a fresh successor destination open note.
   Bind `CLAIM` to the resolved note ID, token, amount, vault, state, epoch, and
   successor nonce.
6. The E1 preflight validates the prepared call, proof envelope, exact note, and
   accepted base-block identity without submitting. Ready normally recompiles a
   fee-bearing proof for submission rather than consuming that prepared proof.
   If an intervening wallet action changes the destination note index, the
   recomputed note differs and the exact-note application signature must make
   the onchain helper fail closed.
7. Treat recovery as complete only after the mainnet receipt succeeds, the
   Afterlight liability is reduced exactly once, and the successor's shielded
   balance shows the returned note.

Both private exits use exact destination notes. The contract does not prove
that a hidden note belongs to a precommitted wallet address; only the designated
successor application key can authorize the private recovery to the exact note
that is signed.

## Relayed controls and metadata

`HEARTBEAT`, `REQUEST`, and `VETO` contain signed public authorization material
and are designed for a neutral, submitter-agnostic relayer. The relayer holds no
owner or successor application secret and cannot override contract validation.
It necessarily processes the vault request long enough to validate and submit
it. Afterlight application logging excludes payloads, signatures, IPs, Ready
addresses, application keys, vault IDs, and fingerprints, while hosting and RPC
providers may still transiently process connection, timing, routing, relayer
account, and transaction metadata. See the [threat model](THREAT_MODEL.md#relayer-and-hosting-metadata-boundary).
