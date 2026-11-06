import { connect, keyStores, KeyPair, providers, type Near } from "near-api-js";
import { TypedError } from "@near-js/types";
import { getErrorTypeFromErrorMessage, parseRpcError } from "@near-js/utils";
import { postJsonRpc, rpcEndpoints, RpcRejected, type RpcCallOptions, type RpcErrorBody } from "./rpc.js";
import type { Arena, SettledRound, SignerConfig } from "./types.js";

export interface Chain {
  near: Near;
  viewArena: () => Promise<Arena>;
  viewRecentRounds: (limit: number) => Promise<SettledRound[]>;
  callAs: (
    signer: SignerConfig,
    methodName: string,
    args: Record<string, unknown>,
    depositYocto?: string,
  ) => Promise<void>;
}

class FailoverRpcProvider extends providers.JsonRpcProvider {
  constructor(
    private readonly urls: string[],
    private readonly rpcOptions?: RpcCallOptions,
  ) {
    super({ url: urls[0] ?? "" });
  }

  override async sendJsonRpc<T>(method: string, params: object): Promise<T> {
    try {
      return (await postJsonRpc(this.urls, method, params, this.rpcOptions)) as T;
    } catch (error) {
      if (error instanceof RpcRejected) throw typedRpcError(error.body);
      throw error;
    }
  }
}

export async function connectChain(opts: {
  networkId: string;
  rpcUrl: string;
  rpcUrls?: string[];
  contractId: string;
  signers: SignerConfig[];
}): Promise<Chain> {
  const urls = opts.rpcUrls?.length ? opts.rpcUrls : rpcEndpoints(opts.rpcUrl, opts.networkId);
  const keyStore = new keyStores.InMemoryKeyStore();
  for (const signer of opts.signers) {
    const key = KeyPair.fromString(signer.privateKey);
    await keyStore.setKey(opts.networkId, signer.accountId, key);
  }
  const near = await connect({
    networkId: opts.networkId,
    nodeUrl: urls[0],
    keyStore,
    headers: {},
  });
  // Connection.provider is readonly in the type, and writable on the object.
  (near.connection as { provider: providers.Provider }).provider = new FailoverRpcProvider(urls);
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
    async viewRecentRounds(limit: number) {
      const account = await near.account(opts.signers[0].accountId);
      return (await account.viewFunction({
        contractId: opts.contractId,
        methodName: "get_recent_rounds",
        args: { limit },
      })) as SettledRound[];
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

function typedRpcError(body: RpcErrorBody): Error {
  if (body.data && typeof body.data === "object") {
    const data = body.data as { error_message?: unknown; error_type?: unknown };
    if (typeof data.error_message === "string" && typeof data.error_type === "string") {
      return new TypedError(data.error_message, data.error_type);
    }
    return parseRpcError(body.data as Record<string, unknown>);
  }
  const data = typeof body.data === "string" ? body.data : "";
  const message = `[${body.code ?? ""}] ${body.message ?? ""}: ${data}`;
  if (data === "Timeout" || message.includes("Timeout error") || message.includes("query has timed out")) {
    return new TypedError(message, "TimeoutError");
  }
  return new TypedError(message, getErrorTypeFromErrorMessage(data, body.name ?? ""));
}
