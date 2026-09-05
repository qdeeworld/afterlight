# Ready X onboarding

## Evidence and release status

This is the Ready X flow implemented by the public Afterlight interface and
exercised by the deployed Mainnet mechanism. The contract and a complete
founder-operated E3 lifecycle through the public interface exist. The unrelated
owner-successor E4 claim also succeeded on Mainnet on September 5, 2026; its
CLAIMED state and liability settlement were independently verified. The external
private-wallet balance delta was not independently read. Nothing here is a
standing instruction to fund or sign; users must review the live wallet request
and current fees.

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

Private activation is separate from shielding a token. An account can be
registered and still have zero private STRK and an uninitialized STRK
subchannel. Do not repeat activation or recommend a Shield deposit merely
because Afterlight rejects a prepared-action shape. The versioned
[first-use compatibility policy](FRESH_WALLET_COMPATIBILITY.md) sponsors
that token setup alongside recovery when the live sponsor advertises support.
The E4 claim confirms the onchain exit for the reported activated/zero-balance
case. Always confirm the private-wallet balance separately; local tests and a
proof-preparation approval are not a receipt or a balance confirmation.

Afterlight labels Ready's destination preparation and final proof preparation
separately. If first-use token setup is present, an in-page approval appears
between them; dismissing it signs nothing. A wallet/key/invitation change cancels
pending consent. The app then shows sponsor, submission and confirmation stages.
Keep the tab open, and do not restart recovery while it is processing. A confirmed
Mainnet recovery remains complete even while Ready's private balance refresh is
pending. New-reserve capacity is checked before users need to pay setup costs.

The public app requires the Ready X desktop browser extension at `5.33.9` or a
later compatible Ready `5.x` release and verifies the Wallet API capabilities
it uses. Mobile Ready and Braavos do not expose the STRK20 browser API required
by this release. An incompatible major release fails closed with the detected
version instead of silently attempting a transaction.

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

The public client exports new application-key backups only after a password is
entered and confirmed. The backup uses PBKDF2 with 600,000 SHA-256 iterations
and AES-256-GCM authenticated encryption. Encryption and restoration happen in
the browser; the password and decrypted key never reach the relayer. Store the
file and password separately and test restoration before funding. Existing
version 1 plaintext backups remain importable only for migration and must be
replaced with the encrypted format before funding.

## Owner journey

1. Connect the owner Ready X account and verify Starknet Mainnet, deployment,
   STRK20 registration, and balances.
2. Generate and back up a new owner application key on the owner's device.
3. Receive only the successor's fresh per-vault public key.
4. Choose a permitted vault mode, fixed denomination, inactivity interval, and
   grace interval.
5. Verify that the application-key backup can be imported before moving value.
   After the neutral checkpoint succeeds, the browser saves the exact recovery
   invitation locally before Ready X can accept the private funding action. It
   downloads the same invitation as JSON after Mainnet confirmation.
6. Review and confirm the Ready X private `FUND` action. A successful receipt
   must touch both the canonical STRK20 pool and the deployed Afterlight helper
   and must reconcile to one exact liability increase.
7. While active, sign `HEARTBEAT` or `VETO` with the owner application key and
   use the neutral relay for the privacy-first route. If that relay is
   unavailable, the explicit Ready X emergency route restores control but
   publicly links the Ready address to the vault.
8. To cancel, have Ready X prepare a new owner destination open note, bind the
   authorization to that exact note, token, amount, vault, epoch, and nonce,
   and privately execute `CANCEL_REFUND` through STRK20.

## Successor journey

1. Generate and back up a fresh successor application key on the successor's
   own device; share only its public key with the owner.
2. Import the invitation JSON file (or paste its contents), verify the live
   Mainnet vault and terms, then connect the separate successor Ready X account.
3. After no authenticated heartbeat has arrived for the configured interval,
   sign `REQUEST` with the successor application key and send the bounded signed
   request through the neutral relayer. The contract, not the relayer, decides
   whether the request is valid.
4. Observe the public grace period. A valid owner veto returns the vault to
   active state and requires another full no-heartbeat interval and request.
5. After grace, ask Ready X to prepare a fresh successor destination open note.
   Bind `CLAIM` to the resolved note ID, token, amount, vault, state, epoch, and
   successor nonce.
6. Afterlight validates the prepared call, proof envelope, exact note, and
   accepted base-block identity, then submits the locked package through the
   bounded neutral sponsor. If an intervening wallet action changes the
   destination note index, the exact-note application signature makes the
   onchain helper fail closed.
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
