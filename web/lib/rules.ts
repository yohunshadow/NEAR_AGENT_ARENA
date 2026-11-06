// Same winner rule as contract/src/game.rs and agent/src/rules.ts.
// a beats b when (a + 2) % 3 === b.

export const MOVE_NAMES = ["Aggressive", "Balanced", "Defensive"] as const;
export const AGENT_BLURBS = [
  "Presses the last winning stance.",
  "Plays the counter to the last winner.",
  "Steps off the line everyone just saw.",
] as const;

export function counterMove(move: number): number {
  return (move + 1) % 3;
}

export interface Decision {
  winner: number | null;
  scores: (number | null)[];
}

export function decide(moves: (number | null)[], seed: Uint8Array): Decision {
  const scores: (number | null)[] = [null, null, null];
  const eligible = [0, 1, 2].filter((i) => moves[i] !== null && moves[i] !== undefined);
  for (const i of eligible) {
    const mine = moves[i] as number;
    let matchup = 0;
    for (const j of eligible) {
      if (i === j) continue;
      const theirs = moves[j] as number;
      if (mine === theirs) matchup += 1;
      else if ((mine + 2) % 3 === theirs) matchup += 2;
    }
    scores[i] = matchup * 256 + (seed[i] ?? 0);
  }
  let winner: number | null = null;
  for (const i of eligible) {
    const score = scores[i] as number;
    if (winner === null || score > (scores[winner] as number)) winner = i;
  }
  return { winner, scores };
}

export interface HistoryRound {
  id: number;
  winner: number | null;
  moves: (number | null)[];
}

const AGENT_NAMES = ["Momentum", "Mean-Reversion", "Breakout"] as const;

function priorWinner(history: HistoryRound[]): { roundId: number; agentId: number; move: number; skipped: number } | null {
  for (let index = 0; index < history.length; index += 1) {
    const round = history[index];
    if (round.winner === null || round.winner === undefined) continue;
    const move = round.moves[round.winner];
    if (move !== 0 && move !== 1 && move !== 2) continue;
    return { roundId: round.id, agentId: round.winner, move, skipped: index };
  }
  return null;
}

export function offlineChoice(
  agentId: number,
  roundId: number,
  history: HistoryRound[],
): { move: number; reasoning: string } {
  const name = AGENT_NAMES[agentId] ?? `Agent ${agentId}`;
  const prior = priorWinner(history);
  if (!prior) {
    const move = agentId === 1 ? 1 : agentId === 2 ? 2 : 0;
    return {
      move,
      reasoning: `No winner in recent rounds before round ${roundId}. ${name} opens ${MOVE_NAMES[move]}.`,
    };
  }
  const who = AGENT_NAMES[prior.agentId] ?? `Agent ${prior.agentId}`;
  const context =
    prior.skipped === 0
      ? `Round ${prior.roundId} winner ${who} played ${MOVE_NAMES[prior.move]}.`
      : `Round ${prior.roundId} winner ${who} played ${MOVE_NAMES[prior.move]}. ${prior.skipped} newer ${prior.skipped === 1 ? "round" : "rounds"} had no winner.`;
  if (agentId === 0) {
    return { move: prior.move, reasoning: `${context} Momentum repeats ${MOVE_NAMES[prior.move]}.` };
  }
  if (agentId === 1) {
    const move = counterMove(prior.move);
    return { move, reasoning: `${context} Mean-Reversion plays ${MOVE_NAMES[move]} to beat it.` };
  }
  const move = (prior.move + 2) % 3;
  return { move, reasoning: `${context} Breakout steps off that line with ${MOVE_NAMES[move]}.` };
}

export function demoSeed(roundId: number): Uint8Array {
  const seed = new Uint8Array(32);
  let x = (roundId + 1) * 0x9e3779b1;
  for (let i = 0; i < 32; i += 1) {
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    x ^= x >>> 16;
    seed[i] = x & 0xff;
  }
  return seed;
}
