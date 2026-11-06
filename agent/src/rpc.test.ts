import assert from "node:assert/strict";
import test from "node:test";
import { postJsonRpc, RpcRejected, rpcEndpoints } from "./rpc.js";

test("testnet RPC list keeps the configured URL first and adds a fallback", () => {
  assert.deepEqual(rpcEndpoints("https://rpc.testnet.near.org", "testnet"), [
    "https://rpc.testnet.near.org",
    "https://test.rpc.fastnear.com",
  ]);
  assert.deepEqual(rpcEndpoints("https://custom.example/rpc/", "testnet", "https://extra.example"), [
    "https://custom.example/rpc",
    "https://extra.example",
    "https://rpc.testnet.near.org",
    "https://test.rpc.fastnear.com",
  ]);
});

test("sandbox RPC does not fall through to public testnet", () => {
  assert.deepEqual(rpcEndpoints("http://127.0.0.1:3030", "sandbox", "https://rpc.testnet.near.org"), [
    "http://127.0.0.1:3030",
  ]);
  assert.deepEqual(rpcEndpoints("https://rpc.testnet.near.org", "testnet", "off"), [
    "https://rpc.testnet.near.org",
  ]);
});

test("postJsonRpc moves to the next endpoint after a timeout", async () => {
  const calls: string[] = [];
  const result = await postJsonRpc(["https://dead.example", "https://ok.example"], "query", { ok: 1 }, {
    timeoutMs: 20,
    attempts: 2,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("dead")) {
        throw Object.assign(new Error("read ETIMEDOUT"), { name: "FetchError" });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { status: 200 });
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["https://dead.example", "https://ok.example"]);
});

test("a contract error is not retried on another endpoint", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      postJsonRpc(["https://a.example", "https://b.example"], "query", {}, {
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "Server error", data: "wasm execution failed" },
            }),
            { status: 200 },
          );
        },
      }),
    (error: unknown) => error instanceof RpcRejected && String(error.message).includes("wasm execution failed"),
  );
  assert.deepEqual(calls, ["https://a.example"]);
});

test("HTTP 503 tries the fallback", async () => {
  const calls: string[] = [];
  const result = await postJsonRpc(["https://a.example", "https://b.example"], "status", [], {
    attempts: 1,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("a.example")) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { syncing: false } }), { status: 200 });
    },
  });
  assert.deepEqual(result, { syncing: false });
  assert.deepEqual(calls, ["https://a.example", "https://b.example"]);
});
