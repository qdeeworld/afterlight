# Fresh token-channel compatibility reproduction

Status: reproduced locally; Ready X compatibility and external recovery remain unverified.

This directory contains a test-only patch for the official
[starknet-privacy source at 66e3caae8c0201227a6719696d004e30d90aea65](https://github.com/starkware-libs/starknet-privacy/tree/66e3caae8c0201227a6719696d004e30d90aea65).
It contains only synthetic test identities and values. It does not contain the
external tester's storage addresses, keys, invitation or proof package.

## Results — September 5, 2026

Five SDK Mocknet tests and three added Cairo contract tests passed:

| Condition | Result |
| --- | --- |
| Registered user and self-channel; missing token subchannel | SDK adds `OpenSubchannel`; Cairo produces `[0,0,0,7,10]`. |
| Same token subchannel initialized separately; no private notes | SDK and Cairo produce the ordinary `[0,7,10]`. |
| Positive self-deposit | SDK Mocknet initializes the token subchannel, then produces the ordinary plan. No Ready fee model tested. |
| Zero closed self-transfer | Pinned SDK rejects it. It is not a supported free setup workaround. |
| Existing token-A subchannel; setup for token B plus an A open note | Both SDK Mocknet and Cairo accept this operation sequence with the same five-action shape. |

The Cairo tests also apply the actions and verify the exact open-note token and
amount using the upstream echo depositor. This is **not** the Afterlight contract
or a Mainnet claim. The upstream test helpers supply mock funds and cheat proof
facts. No authentic cryptographic proof was generated or verified.

Mocknet returns client-action labels rather than serialized Cairo ServerActions.
The SDK test explicitly labels its numeric expansion as a source-derived mapping;
the Cairo tests independently assert the actual serialized enum discriminants.

The unrelated-token case means widths, boolean values, stable targets and an
intact destination note are insufficient to establish that extra setup belongs
to that note. It demonstrates unwanted sponsor-policy expansion, not theft from
an Afterlight reserve. Both production validators remain restricted to three
actions. Never remove writes from a real proof-bound response.

## Reproduce

Use a separate checkout of the exact upstream pin, not the application checkout
or a user's wallet environment. Apply `reproduction.patch` there with `git apply`.
No test below needs an RPC endpoint, browser extension, Mainnet wallet or secret.

From the upstream `sdk` directory:

```sh
npm install --ignore-scripts --no-audit --no-fund
npx vitest run --coverage.enabled=false tests/internal/afterlight-fresh-wallet.test.ts
```

From the upstream repository root:

```sh
snforge test -p privacy test_afterlight_
```

Observed environment: SDK 0.14.3-rc.5, Vitest 4.0.17, Scarb/Cairo 2.18.0,
snforge 0.62.1. The upstream manifest specifies snforge_std 0.59.0 and Starknet
2.17.0; the runner warned about the snforge_std version mismatch. These results
are investigation evidence, not a release certification under a matched toolchain.
The existing upstream `test_execute_open_subchannel` also passed.

At this pin `npm ci --ignore-scripts` failed because the upstream lockfile was
inconsistent (`Missing: sdk@0.14.3-rc.5 from lock file`). `npm install` was used only
in the isolated reproduction checkout. No Afterlight dependencies were changed.

## Remaining release gate

1. Establish the supported Ready X first-use setup flow on a controlled wallet.
2. Quote and approve any real setup fees before spending; do not treat a pool
   fee constant or Mocknet deposit as a complete Ready/network quote.
3. Verify subsequent **simulated and final** preparation passes both unchanged
   Afterlight validators.
4. Complete an authorized external claim and verify transaction success, CLAIMED
   state, reserve liability reduction and the exact private-balance increase.

A successful simulation, fee estimate, support acknowledgement, or these local
tests does not satisfy the external recovery gate.
