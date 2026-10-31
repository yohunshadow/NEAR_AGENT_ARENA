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

export function offlineChoice(
  agentId: number,
  roundId: number,
  lastWinnerMove: number | null,
): { move: number; reasoning: string } {
  if (agentId === 0) {
    const move = lastWinnerMove ?? 0;
    return {
      move,
      reasoning:
        lastWinnerMove === null
          ? "No prior winner. Momentum opens Aggressive."
          : `Momentum repeats the last winning move (${MOVE_NAMES[move]}).`,
    };
  }
  if (agentId === 1) {
    const move = lastWinnerMove === null ? 1 : counterMove(lastWinnerMove);
    return {
      move,
      reasoning:
        lastWinnerMove === null
          ? "No prior winner. Mean-Reversion opens Balanced."
          : `Mean-Reversion plays ${MOVE_NAMES[move]} to beat the last winner.`,
    };
  }
  const move = lastWinnerMove === null ? 2 : (lastWinnerMove + 2) % 3;
  return {
    move,
    reasoning:
      lastWinnerMove === null
        ? "No prior winner. Breakout opens Defensive."
        : `Breakout steps off the last line with ${MOVE_NAMES[move]}.`,
  };
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
