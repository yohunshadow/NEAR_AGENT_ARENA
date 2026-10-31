import { AGENT_BLURBS, decide, demoSeed, MOVE_NAMES, offlineChoice } from "./rules";

export const MICRO = 1_000_000n;
export const BETTING_MS = 12_000;
export const REVEAL_MS = 6_000;
const UPKEEP = 500_000n;
const MIN_TREASURY = 500_000n;
const FEE_BPS = 500n;
const NAMES = ["Momentum", "Mean-Reversion", "Breakout"] as const;

export interface DemoChoice {
  move: number;
  reasoning: string;
}

export interface DemoAgent {
  id: number;
  name: string;
  blurb: string;
  treasury: bigint;
  retired: boolean;
  wins: number;
  roundsFought: number;
}

export interface HistoryRow {
  id: number;
  winner: number | null;
  pool: bigint;
  moves: (number | null)[];
  reasonings: (string | null)[];
  scores: (number | null)[];
  note: string;
}

export interface DemoState {
  roundId: number;
  phase: "betting" | "reveal";
  msLeft: number;
  alive: [boolean, boolean, boolean];
  pool: bigint;
  backed: [bigint, bigint, bigint];
  userBalance: bigint;
  userStakes: [bigint, bigint, bigint];
  agents: [DemoAgent, DemoAgent, DemoAgent];
  choices: [DemoChoice | null, DemoChoice | null, DemoChoice | null];
  lastWinnerMove: number | null;
  history: HistoryRow[];
  log: string[];
  banner: string;
}

function agent(id: number, treasury: bigint): DemoAgent {
  return {
    id,
    name: NAMES[id],
    blurb: AGENT_BLURBS[id],
    treasury,
    retired: false,
    wins: 0,
    roundsFought: 0,
  };
}

function pushLog(state: DemoState, line: string): DemoState {
  return { ...state, log: [line, ...state.log].slice(0, 8) };
}

export function initialDemo(): DemoState {
  const treasury = 1_500_000n;
  return {
    roundId: 0,
    phase: "betting",
    msLeft: BETTING_MS,
    alive: [true, true, true],
    pool: 0n,
    backed: [0n, 0n, 0n],
    userBalance: 30n * MICRO,
    userStakes: [0n, 0n, 0n],
    agents: [agent(0, treasury), agent(1, treasury), agent(2, treasury)],
    choices: [null, null, null],
    lastWinnerMove: null,
    history: [],
    log: ["Demo round 0 is open. Back a fighter, then advance."],
    banner: "",
  };
}

export function backAgent(state: DemoState, agentId: number, amountNear: string): DemoState {
  if (state.phase !== "betting") return { ...state, banner: "Betting is closed for this round." };
  if (!state.alive[agentId]) return { ...state, banner: "That agent is not in this round." };
  if (!/^\d+(\.\d{1,2})?$/.test(amountNear.trim())) {
    return { ...state, banner: "Enter an amount like 4 or 4.50." };
  }
  const [whole, frac = ""] = amountNear.trim().split(".");
  const amount = BigInt(whole) * MICRO + BigInt(frac.padEnd(6, "0"));
  if (amount <= 0n) return { ...state, banner: "Bet more than zero." };
  if (amount > state.userBalance) return { ...state, banner: "Not enough demo NEAR." };
  const backed = [...state.backed] as [bigint, bigint, bigint];
  const userStakes = [...state.userStakes] as [bigint, bigint, bigint];
  backed[agentId] += amount;
  userStakes[agentId] += amount;
  return pushLog(
    {
      ...state,
      banner: "",
      pool: state.pool + amount,
      backed,
      userStakes,
      userBalance: state.userBalance - amount,
    },
    `You backed ${NAMES[agentId]} with ${whole}${frac ? `.${frac}` : ""} NEAR.`,
  );
}

export function fundAgent(state: DemoState, agentId: number): DemoState {
  const amount = 2n * MICRO;
  if (state.userBalance < amount) return { ...state, banner: "Not enough demo NEAR to fund." };
  const agents = state.agents.map((item) => ({ ...item })) as DemoState["agents"];
  agents[agentId].treasury += amount;
  let revived = false;
  const alive = [...state.alive] as [boolean, boolean, boolean];
  if (agents[agentId].retired && agents[agentId].treasury >= MIN_TREASURY) {
    agents[agentId].retired = false;
    revived = true;
    if (state.phase === "betting") alive[agentId] = true;
  }
  return pushLog(
    {
      ...state,
      banner: revived ? `${NAMES[agentId]} is back in the arena.` : "",
      agents,
      alive,
      userBalance: state.userBalance - amount,
    },
    `You funded ${NAMES[agentId]} with 2 NEAR.`,
  );
}

function settle(state: DemoState): DemoState {
  const moves = state.choices.map((choice) => choice?.move ?? null);
  const decision = decide(moves, demoSeed(state.roundId));
  const agents = state.agents.map((item) => ({ ...item })) as DemoState["agents"];
  let userBalance = state.userBalance;
  let note = "No reveal, so backers are refunded.";
  if (decision.winner === null) {
    const refund = state.userStakes.reduce((sum, stake) => sum + stake, 0n);
    userBalance += refund;
  } else {
    const winner = decision.winner;
    note = `${NAMES[winner]} wins with ${MOVE_NAMES[moves[winner] ?? 0]}.`;
    if (state.pool > 0n && state.backed[winner] === 0n) {
      agents[winner].treasury += state.pool;
    } else if (state.pool > 0n) {
      const fee = (state.pool * FEE_BPS) / 10_000n;
      const distributable = state.pool - fee;
      agents[winner].treasury += fee;
      const payout = (state.userStakes[winner] * distributable) / state.backed[winner];
      userBalance += payout;
    }
    agents[winner].wins += 1;
  }
  for (let i = 0; i < 3; i += 1) {
    if (!state.alive[i]) continue;
    agents[i].roundsFought += 1;
    const charged = agents[i].treasury < UPKEEP ? agents[i].treasury : UPKEEP;
    agents[i].treasury -= charged;
    if (agents[i].treasury === 0n) agents[i].retired = true;
  }
  const history: HistoryRow = {
    id: state.roundId,
    winner: decision.winner,
    pool: state.pool,
    moves,
    reasonings: state.choices.map((choice) => choice?.reasoning ?? null),
    scores: decision.scores,
    note,
  };
  const alive: [boolean, boolean, boolean] = [
    !agents[0].retired,
    !agents[1].retired,
    !agents[2].retired,
  ];
  const next = state.roundId + 1;
  return pushLog(
    {
      ...state,
      roundId: next,
      phase: "betting",
      msLeft: BETTING_MS,
      alive,
      pool: 0n,
      backed: [0n, 0n, 0n],
      userStakes: [0n, 0n, 0n],
      userBalance,
      agents,
      choices: [null, null, null],
      lastWinnerMove: decision.winner === null ? state.lastWinnerMove : moves[decision.winner],
      history: [history, ...state.history].slice(0, 8),
      banner: note,
    },
    `Round ${state.roundId} settled. ${note}`,
  );
}

export function advance(state: DemoState): DemoState {
  if (state.phase === "betting") {
    const choices = [0, 1, 2].map((agentId) =>
      state.alive[agentId]
        ? offlineChoice(agentId, state.roundId, state.lastWinnerMove)
        : null,
    ) as DemoState["choices"];
    const lines = choices
      .map((choice, agentId) =>
        choice ? `${NAMES[agentId]} reveals ${MOVE_NAMES[choice.move]}.` : `${NAMES[agentId]} sits out.`,
      )
      .join(" ");
    return pushLog(
      { ...state, phase: "reveal", msLeft: REVEAL_MS, choices, banner: "" },
      lines,
    );
  }
  return settle(state);
}

export function tickDemo(state: DemoState, elapsedMs: number): DemoState {
  const msLeft = state.msLeft - elapsedMs;
  if (msLeft > 0) return { ...state, msLeft };
  return advance({ ...state, msLeft: 0 });
}

export { MOVE_NAMES };
