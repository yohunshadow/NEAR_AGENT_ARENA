import type { SignerConfig } from "./types.js";

export interface TickEnv {
  networkId: string;
  rpcUrl: string;
  contractId: string;
  agents: SignerConfig[];
  settler: SignerConfig;
  stateDir: string;
}

interface KeysFile {
  contractId?: string;
  rpcUrl?: string;
  networkId?: string;
  settlerAccountId?: string;
  settlerPrivateKey?: string;
  settler?: SignerConfig;
  agents?: SignerConfig[];
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

export function configFromKeysJson(raw: string, stateDir: string): TickEnv {
  const parsed = JSON.parse(raw) as KeysFile;
  if (!parsed.contractId) throw new Error("NEAR_AGENT_KEYS_JSON is missing contractId");
  if (!parsed.agents || parsed.agents.length !== 3) {
    throw new Error("NEAR_AGENT_KEYS_JSON needs exactly 3 agents");
  }
  const settler = parsed.settler ?? {
    accountId: parsed.settlerAccountId ?? "",
    privateKey: parsed.settlerPrivateKey ?? "",
  };
  if (!settler.accountId || !settler.privateKey) {
    throw new Error("NEAR_AGENT_KEYS_JSON is missing the settler key");
  }
  return {
    networkId: parsed.networkId || "testnet",
    rpcUrl: parsed.rpcUrl || "https://rpc.testnet.near.org",
    contractId: parsed.contractId,
    agents: parsed.agents,
    settler,
    stateDir,
  };
}

export function loadTickConfig(): TickEnv {
  const stateDir = process.env.STATE_DIR?.trim() || ".state";
  const packed = process.env.NEAR_AGENT_KEYS_JSON?.trim();
  if (packed) return configFromKeysJson(packed, stateDir);
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
    stateDir,
  };
}
