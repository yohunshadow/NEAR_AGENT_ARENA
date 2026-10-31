import { connect, keyStores, KeyPair, type Near } from "near-api-js";
import type { Arena, SignerConfig } from "./types.js";

export interface Chain {
  near: Near;
  viewArena: () => Promise<Arena>;
  callAs: (
    signer: SignerConfig,
    methodName: string,
    args: Record<string, unknown>,
    depositYocto?: string,
  ) => Promise<void>;
}

export async function connectChain(opts: {
  networkId: string;
  rpcUrl: string;
  contractId: string;
  signers: SignerConfig[];
}): Promise<Chain> {
  const keyStore = new keyStores.InMemoryKeyStore();
  for (const signer of opts.signers) {
    const key = KeyPair.fromString(signer.privateKey);
    await keyStore.setKey(opts.networkId, signer.accountId, key);
  }
  const near = await connect({
    networkId: opts.networkId,
    nodeUrl: opts.rpcUrl,
    keyStore,
    headers: {},
  });
  return {
    near,
    async viewArena() {
      const account = await near.account(opts.signers[0].accountId);
      return (await account.viewFunction({
        contractId: opts.contractId,
        methodName: "get_arena",
        args: {},
      })) as Arena;
    },
    async callAs(signer, methodName, args, depositYocto = "0") {
      const account = await near.account(signer.accountId);
      await account.functionCall({
        contractId: opts.contractId,
        methodName,
        args,
        gas: "80000000000000",
        attachedDeposit: depositYocto,
      });
    },
  };
}
