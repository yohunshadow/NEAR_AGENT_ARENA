// Winner rule shared with contract/src/game.rs. Keep the two in sync.
// Move 0 Aggressive beats 2 Defensive.
// Move 2 Defensive beats 1 Balanced.
// Move 1 Balanced beats 0 Aggressive.
// a beats b iff (a + 2) % 3 == b.

export const MOVE_NAMES = ["Aggressive", "Balanced", "Defensive"] as const;
export const AGENT_NAMES = ["Momentum", "Mean-Reversion", "Breakout"] as const;
export const MAX_REASONING_BYTES = 280;

export function beats(a: number, b: number): boolean {
  return (a + 2) % 3 === b;
}

export function counterMove(move: number): number {
  return (move + 1) % 3;
}

export interface Decision {
  winner: number | null;
  matchups: (number | null)[];
  entropies: (number | null)[];
  scores: (number | null)[];
}

export function decide(moves: (number | null)[], seed: Uint8Array): Decision {
  const matchups: (number | null)[] = [null, null, null];
  const entropies: (number | null)[] = [null, null, null];
  const scores: (number | null)[] = [null, null, null];
  const eligible = [0, 1, 2].filter((i) => moves[i] !== null && moves[i] !== undefined);
  for (const i of eligible) {
    const mine = moves[i] as number;
    let matchup = 0;
    for (const j of eligible) {
      if (i === j) continue;
      const theirs = moves[j] as number;
      if (mine === theirs) matchup += 1;
      else if (beats(mine, theirs)) matchup += 2;
    }
    const entropy = seed[i] ?? 0;
    matchups[i] = matchup;
    entropies[i] = entropy;
    scores[i] = matchup * 256 + entropy;
  }
  let winner: number | null = null;
  for (const i of eligible) {
    const score = scores[i] as number;
    if (winner === null || score > (scores[winner] as number)) winner = i;
  }
  return { winner, matchups, entropies, scores };
}

export function preimage(moveId: number, salt: Uint8Array, reasoning: string): Uint8Array {
  const text = new TextEncoder().encode(reasoning);
  const out = new Uint8Array(1 + salt.length + text.length);
  out[0] = moveId;
  out.set(salt, 1);
  out.set(text, 1 + salt.length);
  return out;
}

export function mulDivFloor(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom === 0n) throw new Error("mul_div denom is zero");
  return (a * b) / denom;
}

export interface Choice {
  move: number;
  reasoning: string;
}

export interface StrategyInput {
  agentId: number;
  roundId: number;
  lastWinnerMove: number | null;
}

/** Deterministic personality used when NEAR_AI_API_KEY is unset or the model fails. */
export function offlineChoice(input: StrategyInput): Choice {
  const last = input.lastWinnerMove;
  if (input.agentId === 0) {
    const move = last ?? 0;
    return {
      move,
      reasoning:
        last === null
          ? "No prior winner. Momentum opens Aggressive."
          : `Momentum repeats the last winning move (${MOVE_NAMES[move]}).`,
    };
  }
  if (input.agentId === 1) {
    const move = last === null ? 1 : counterMove(last);
    return {
      move,
      reasoning:
        last === null
          ? "No prior winner. Mean-Reversion opens Balanced."
          : `Mean-Reversion plays ${MOVE_NAMES[move]} to beat the last winner.`,
    };
  }
  const move = last === null ? 2 : (last + 2) % 3;
  return {
    move,
    reasoning:
      last === null
        ? "No prior winner. Breakout opens Defensive."
        : `Breakout steps off the last line with ${MOVE_NAMES[move]}.`,
  };
}
