import assert from "node:assert/strict";
import { test } from "node:test";

import {
  readJsonRpc,
  type JsonRpcFetch,
} from "../tools/read-only-json-rpc.js";

test("read-only RPC aborts a stalled provider and a subsequent request recovers", async () => {
  let aborted = false;
  const stalled: JsonRpcFetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });

  await assert.rejects(
    readJsonRpc("https://rpc.invalid", "starknet_chainId", [], {
      fetcher: stalled,
      timeoutMs: 20,
    }),
    /timed out/,
  );
  assert.equal(aborted, true);

  const recovered: JsonRpcFetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x534e5f4d41494e" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  assert.equal(
    await readJsonRpc<string>("https://rpc.invalid", "starknet_chainId", [], {
      fetcher: recovered,
      timeoutMs: 20,
    }),
    "0x534e5f4d41494e",
  );
});
