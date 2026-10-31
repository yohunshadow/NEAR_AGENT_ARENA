import type { SignerConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

export function loadTickConfig(): {
  networkId: string;
  rpcUrl: string;
  contractId: string;
  agents: SignerConfig[];
  settler: SignerConfig;
  stateDir: string;
} {
  const agents = [0, 1, 2].map((id) => ({
    accountId: required(`AGENT_${id}_ACCOUNT_ID`),
    privateKey: required(`AGENT_${id}_PRIVATE_KEY`),
  }));
  const settlerId = process.env.SETTLER_ACCOUNT_ID?.trim();
  const settlerKey = process.env.SETTLER_PRIVATE_KEY?.trim();
  const settler =
    settlerId && settlerKey ? { accountId: settlerId, privateKey: settlerKey } : agents[0];
  return {
    networkId: process.env.NEAR_NETWORK_ID?.trim() || "testnet",
    rpcUrl: process.env.NEAR_RPC_URL?.trim() || "https://rpc.testnet.near.org",
    contractId: required("CONTRACT_ID"),
    agents,
    settler,
    stateDir: process.env.STATE_DIR?.trim() || ".state",
  };
}
