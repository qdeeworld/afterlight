import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  RelayOperation,
  buildRelayRequest,
  encodeRelayRequest,
  type RelayRequest,
} from "../src/schema.js";

const origin = "https://afterlight.invalid";
const contract = "0x1234";
const token = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const amount = 10_000_000_000_000_000_000n;

describe("Afterlight Phase A relay Worker", () => {
  it("reports structured health without secret, wallet, IP or account material", async () => {
    const response = await exports.default.fetch("https://relay.invalid/health");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"status":"ok"');
    expect(body).toContain('"submission":"disabled"');
    expect(body).toContain('"payloadLogging":false');
    expect(body).not.toMatch(/private_key|wallet_address|ip_address|relayer_account/i);
    expect(body).not.toMatch(/secretConfigured|maxSponsoredFee|dailySponsorBudget|"limits"/i);
  });

  it.each([
    [RelayOperation.Heartbeat, 1n, "heartbeat"],
    [RelayOperation.Request, 1n, "request_recovery"],
    [RelayOperation.Veto, 2n, "veto"],
  ] as const)("assembles a bounded %s call but never broadcasts", async (operation, state, entrypoint) => {
    const payload = validPayload(operation, state);
    const response = await exports.default.fetch(
      new Request("https://relay.invalid/v1/relay", {
        method: "POST",
        headers: relayHeaders(),
        body: payload,
      }),
    );
    expect(response.status).toBe(202);
    const body = await response.json<{
      status: string;
      submission: string;
      plan: {
        operation: string;
        chainId: string;
        fingerprint: string;
        semanticKey: string;
        call: { contractAddress: string; entrypoint: string; calldata: string[] };
        requiresContractSimulation: boolean;
        contractVerificationAuthoritative: boolean;
        maxSponsoredFeeFri: string;
      };
    }>();
    expect(body.status).toBe("preflight_passed");
    expect(body.submission).toBe("disabled");
    expect(body.plan.operation).toBe(operation);
    expect(body.plan.chainId).toBe("0x534e5f4d41494e");
    expect(body.plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(body.plan.semanticKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.plan.call.contractAddress).toMatch(/^0x0+1234$/);
    expect(body.plan.call.entrypoint).toBe(entrypoint);
    expect(body.plan.call.calldata).toHaveLength(9);
    expect(body.plan.requiresContractSimulation).toBe(true);
    expect(body.plan.contractVerificationAuthoritative).toBe(true);
    expect(body.plan.maxSponsoredFeeFri).toBe("200000000000000000");
  });

  it("supports a bounded estimate-only relay route without signing or budget mutation", async () => {
    const payload = validPayload(RelayOperation.Request, 1n);
    const response = await exports.default.fetch(
      new Request("https://relay.invalid/v1/relay?mode=estimate", {
        method: "POST",
        headers: relayHeaders(),
        body: payload,
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", code: "executor_unavailable" });
  });

  it("rejects unknown relay query parameters", async () => {
    const response = await exports.default.fetch(
      new Request("https://relay.invalid/v1/relay?mode=estimate&broadcast=true", {
        method: "POST",
        headers: relayHeaders(),
        body: validPayload(RelayOperation.Request, 1n),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "error", code: "invalid_query" });
  });

  it("builds a payload-free neutral funding checkpoint without wallet or vault material", async () => {
    const response = await exports.default.fetch(
      new Request("https://relay.invalid/v1/checkpoint", {
        method: "POST",
        headers: {
          origin,
          "x-afterlight-intent": "funding-checkpoint",
        },
      }),
    );
    expect(response.status).toBe(202);
    const body = await response.json<{
      plan: {
        operation: string;
        semanticKey: string;
        call: { contractAddress: string; entrypoint: string; calldata: string[] };
      };
    }>();
    expect(body.plan.operation).toBe("CHECKPOINT");
    expect(body.plan.semanticKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.plan.call).toMatchObject({
      entrypoint: "sync_funding_checkpoint",
      calldata: [],
    });
    expect(JSON.stringify(body)).not.toMatch(/wallet|vault|signature|ready/i);
  });

  it("accepts a zero-byte streamed checkpoint body emitted by real HTTP clients", async () => {
    const response = await exports.default.fetch(
      new Request("https://relay.invalid/v1/checkpoint", {
        method: "POST",
        headers: {
          origin,
          "content-length": "0",
          "x-afterlight-intent": "funding-checkpoint",
        },
        body: "",
      }),
    );
    expect(response.status).toBe(202);
  });

  it("rejects checkpoint payloads and the control intent on the checkpoint route", async () => {
    const withPayload = await exports.default.fetch(
      new Request("https://relay.invalid/v1/checkpoint", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-afterlight-intent": "funding-checkpoint",
        },
        body: "{}",
      }),
    );
    expect(withPayload.status).toBe(400);

    const wrongIntent = await exports.default.fetch(
      new Request("https://relay.invalid/v1/checkpoint", {
        method: "POST",
        headers: { origin, "x-afterlight-intent": "relay-control" },
      }),
    );
    expect(wrongIntent.status).toBe(400);
  });

  it("allows only the configured browser origin and explicit non-simple intent", async () => {
    const allowed = await exports.default.fetch(
      new Request("https://relay.invalid/v1/relay", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-headers": "content-type, x-afterlight-intent",
        },
      }),
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);

    const denied = await exports.default.fetch(
      new Request("https://relay.invalid/v1/relay", {
        method: "POST",
        headers: { ...relayHeaders(), origin: "https://attacker.invalid" },
        body: validPayload(RelayOperation.Heartbeat, 1n),
      }),
    );
    expect(denied.status).toBe(403);

    const missingIntent = new Headers(relayHeaders());
    missingIntent.delete("x-afterlight-intent");
    const deniedIntent = await exports.default.fetch(
      new Request("https://relay.invalid/v1/relay", {
        method: "POST",
        headers: missingIntent,
        body: validPayload(RelayOperation.Heartbeat, 1n),
      }),
    );
    expect(deniedIntent.status).toBe(400);
  });

  it("derives exact fingerprints from normalized fields, not attacker-controlled JSON ordering", async () => {
    const canonical = buildRelayRequest(RelayOperation.Heartbeat, contract, {
      ...validArgs(1n),
      vault_id: "0xcafe",
    });
    const reordered = JSON.stringify({
      args: {
        sig_s: canonical.args.sig_s,
        sig_r: canonical.args.sig_r,
        valid_until: canonical.args.valid_until,
        expected_nonce: canonical.args.expected_nonce,
        expected_epoch: canonical.args.expected_epoch,
        expected_state: canonical.args.expected_state,
        amount: canonical.args.amount,
        token: canonical.args.token,
        vault_id: canonical.args.vault_id,
      },
      contract: canonical.contract,
      operation: canonical.operation,
      schema: canonical.schema,
    });
    const fingerprints: string[] = [];
    for (const payload of [encodeRelayRequest(canonical), reordered]) {
      const response = await exports.default.fetch(
        new Request("https://relay.invalid/v1/relay", {
          method: "POST",
          headers: relayHeaders(),
          body: payload,
        }),
      );
      expect(response.status).toBe(202);
      const body = await response.json<{ plan: { fingerprint: string } }>();
      fingerprints.push(body.plan.fingerprint);
    }
    expect(fingerprints[0]).toBe(fingerprints[1]);
  });

  it("keeps one semantic operation key across alternate signatures and expiries", async () => {
    const now = BigInt(Math.floor(Date.now() / 1_000));
    const first = buildRelayRequest(RelayOperation.Heartbeat, contract, {
      ...validArgs(1n),
      valid_until: (now + 300n).toString(),
      sig_r: "0x111",
      sig_s: "0x222",
    });
    const second = buildRelayRequest(RelayOperation.Heartbeat, contract, {
      ...first.args,
      valid_until: (now + 500n).toString(),
      sig_r: "0x333",
      sig_s: "0x444",
    });
    const plans: Array<{ fingerprint: string; semanticKey: string }> = [];
    for (const relay of [first, second]) {
      const response = await exports.default.fetch(
        new Request("https://relay.invalid/v1/relay", {
          method: "POST",
          headers: relayHeaders(),
          body: encodeRelayRequest(relay),
        }),
      );
      expect(response.status).toBe(202);
      const body = await response.json<{ plan: { fingerprint: string; semanticKey: string } }>();
      plans.push(body.plan);
    }
    expect(plans[0]?.semanticKey).toBe(plans[1]?.semanticKey);
    expect(plans[0]?.fingerprint).not.toBe(plans[1]?.fingerprint);
  });

  it("rejects malformed, oversized, expired, mismatched and unsupported payloads", async () => {
    const cases: Array<{ payload: string; status: number }> = [
      { payload: "{}", status: 422 },
      { payload: "x".repeat(2_049), status: 413 },
      {
        payload: encodeRelayRequest(
          buildRelayRequest(RelayOperation.Heartbeat, "0x999", validArgs(1n)),
        ),
        status: 422,
      },
      {
        payload: JSON.stringify({
          ...buildRelayRequest(RelayOperation.Heartbeat, contract, validArgs(1n)),
          operation: "CLAIM",
        }),
        status: 422,
      },
      {
        payload: JSON.stringify({
          ...buildRelayRequest(RelayOperation.Heartbeat, contract, validArgs(1n)),
          private_key: "0x1",
        }),
        status: 422,
      },
      {
        payload: encodeRelayRequest(
          buildRelayRequest(RelayOperation.Heartbeat, contract, {
            ...validArgs(1n),
            valid_until: (BigInt(Math.floor(Date.now() / 1_000)) - 1n).toString(),
          }),
        ),
        status: 422,
      },
      {
        payload: validPayload(RelayOperation.Veto, 1n),
        status: 422,
      },
    ];

    for (const testCase of cases) {
      const response = await exports.default.fetch(
        new Request("https://relay.invalid/v1/relay", {
          method: "POST",
          headers: relayHeaders(),
          body: testCase.payload,
        }),
      );
      expect(response.status).toBe(testCase.status);
    }
  });

  it("enforces the local per-vault/operation abuse limit", async () => {
    const payload = encodeRelayRequest(
      buildRelayRequest(RelayOperation.Request, contract, {
        ...validArgs(1n),
        vault_id: "0xdead",
      }),
    );
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await exports.default.fetch(
        new Request("https://relay.invalid/v1/relay", {
          method: "POST",
          headers: relayHeaders(),
          body: payload,
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 429]);
  });

  it("rejects the wrong route, method and media type", async () => {
    const missing = await exports.default.fetch("https://relay.invalid/nope");
    expect(missing.status).toBe(404);
    const wrongMethod = await exports.default.fetch(
      new Request("https://relay.invalid/v1/relay", { method: "GET" }),
    );
    expect(wrongMethod.status).toBe(405);
    const headers = relayHeaders();
    headers.set("content-type", "text/plain");
    const wrongType = await exports.default.fetch(
      new Request("https://relay.invalid/v1/relay", {
        method: "POST",
        headers,
        body: validPayload(RelayOperation.Heartbeat, 1n),
      }),
    );
    expect(wrongType.status).toBe(415);
  });
});

function validPayload(operation: RelayOperation, state: bigint): string {
  return encodeRelayRequest(buildRelayRequest(operation, contract, validArgs(state)));
}

function validArgs(expectedState: bigint): RelayRequest["args"] {
  return {
    vault_id: "0xabc",
    token,
    amount: amount.toString(),
    expected_state: expectedState.toString(),
    expected_epoch: "2",
    expected_nonce: "3",
    valid_until: (BigInt(Math.floor(Date.now() / 1_000)) + 600n).toString(),
    sig_r: "0x444",
    sig_s: "0x555",
  };
}

function relayHeaders(): Headers {
  return new Headers({
    origin,
    "content-type": "application/json",
    "x-afterlight-intent": "relay-control",
  });
}
