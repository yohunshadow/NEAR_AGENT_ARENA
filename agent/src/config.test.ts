import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configFromKeysJson, loadTickConfig } from "./config.js";

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

test("NEAR_AGENT_KEYS_FILE is read when the inline JSON env is unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-keys-"));
  const file = join(dir, "keys.json");
  writeFileSync(
    file,
    JSON.stringify({
      contractId: "near-agent-arena-97b380.testnet",
      settler: { accountId: "near-agent-arena-97b380.testnet", privateKey: "ed25519:settler" },
      agents: [
        { accountId: "momentum.near-agent-arena-97b380.testnet", privateKey: "ed25519:a" },
        { accountId: "mean-reversion.near-agent-arena-97b380.testnet", privateKey: "ed25519:b" },
        { accountId: "breakout.near-agent-arena-97b380.testnet", privateKey: "ed25519:c" },
      ],
    }),
  );
  const previousFile = process.env.NEAR_AGENT_KEYS_FILE;
  const previousJson = process.env.NEAR_AGENT_KEYS_JSON;
  delete process.env.NEAR_AGENT_KEYS_JSON;
  process.env.NEAR_AGENT_KEYS_FILE = file;
  try {
    const cfg = loadTickConfig();
    assert.equal(cfg.contractId, "near-agent-arena-97b380.testnet");
    assert.equal(cfg.agents[2].privateKey, "ed25519:c");
  } finally {
    if (previousFile === undefined) delete process.env.NEAR_AGENT_KEYS_FILE;
    else process.env.NEAR_AGENT_KEYS_FILE = previousFile;
    if (previousJson === undefined) delete process.env.NEAR_AGENT_KEYS_JSON;
    else process.env.NEAR_AGENT_KEYS_JSON = previousJson;
  }
});
