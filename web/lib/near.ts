export interface AgentView {
  id: number;
  name: string;
  account_id: string;
  treasury: string;
  retired: boolean;
  wins: number;
  rounds_fought: number;
  alive_this_round: boolean;
}

export interface SettledRound {
  id: number;
  winner: number | null;
  refund: boolean;
  pool: string;
  fee: string;
  moves: (number | null)[];
  reasonings: (string | null)[];
  scores: (number | null)[];
}

export interface Arena {
  now_ns: string;
  agents: AgentView[];
  current: {
    id: number;
    phase: string;
    ready_to_settle: boolean;
    betting_end_ns: string;
    reveal_end_ns: string;
    pool: string;
    backed: string[];
    alive: boolean[];
    moves: (number | null)[];
    reasonings: (string | null)[];
  };
  recent_rounds: SettledRound[];
}

export interface UserBet {
  stakes: string[];
  claimed: boolean;
  settled: boolean;
  payout: string;
}

const network = process.env.NEXT_PUBLIC_NEAR_NETWORK || "testnet";
const rpcUrl = process.env.NEXT_PUBLIC_NEAR_RPC_URL || "https://rpc.testnet.near.org";

export function contractId(): string {
  return process.env.NEXT_PUBLIC_CONTRACT_ID?.trim() || "";
}

export function nearNetwork(): string {
  return network;
}

async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "arena",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId(),
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = (await response.json()) as {
    result?: { result?: number[] };
    error?: { message?: string; data?: string };
  };
  if (!body.result?.result) {
    throw new Error(body.error?.data || body.error?.message || "RPC view failed");
  }
  const text = String.fromCharCode(...body.result.result);
  return JSON.parse(text) as T;
}

export function fetchArena(): Promise<Arena> {
  return view<Arena>("get_arena", {});
}

export function fetchUserBet(accountId: string, roundId: number): Promise<UserBet | null> {
  return view<UserBet | null>("get_user_bet", {
    account_id: accountId,
    round_id: String(roundId),
  });
}
