export interface AgentView {
  id: number;
  name: string;
  account_id: string;
  treasury: string;
  retired: boolean;
  wins: number;
  rounds_fought: number;
  upkeep_paid: string;
  alive_this_round: boolean;
}

export interface CurrentRound {
  id: number;
  phase: "betting" | "reveal" | "settle" | string;
  ready_to_settle: boolean;
  betting_end_ns: string;
  reveal_end_ns: string;
  pool: string;
  backed: string[];
  alive: boolean[];
  committed: boolean[];
  commitment_hex: (string | null)[];
  moves: (number | null)[];
  reasonings: (string | null)[];
}

export interface SettledRound {
  id: number;
  winner: number | null;
  refund: boolean;
  pool: string;
  fee: string;
  distributable: string;
  winner_stake: string;
  moves: (number | null)[];
  reasonings: (string | null)[];
  matchups: (number | null)[];
  entropies: (number | null)[];
  scores: (number | null)[];
  seed_hex: string;
  upkeep_charged: string[];
  settled_at_ns: string;
}

export interface Arena {
  version: string;
  owner_id: string;
  now_ns: string;
  protocol_treasury: string;
  agents: AgentView[];
  current: CurrentRound;
  recent_rounds: SettledRound[];
}

export interface SignerConfig {
  accountId: string;
  privateKey: string;
}
