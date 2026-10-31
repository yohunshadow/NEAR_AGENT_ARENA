import assert from "node:assert/strict";
import test from "node:test";
import { configFromKeysJson } from "./config.js";

test("NEAR_AGENT_KEYS_JSON supplies the contract, settler, and three agents", () => {
  const cfg = configFromKeysJson(
    JSON.stringify({
      contractId: "arena.testnet",
      networkId: "testnet",
      settlerAccountId: "arena.testnet",
      settlerPrivateKey: "ed25519:settler",
      agents: [
        { accountId: "momentum.arena.testnet", privateKey: "ed25519:a" },
        { accountId: "mean-reversion.arena.testnet", privateKey: "ed25519:b" },
        { accountId: "breakout.arena.testnet", privateKey: "ed25519:c" },
      ],
    }),
    ".state",
  );
  assert.equal(cfg.contractId, "arena.testnet");
  assert.equal(cfg.settler.accountId, "arena.testnet");
  assert.equal(cfg.agents[1].accountId, "mean-reversion.arena.testnet");
  assert.equal(cfg.rpcUrl, "https://rpc.testnet.near.org");
});
