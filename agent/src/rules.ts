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

/** One settled round, newest first, as returned by `get_recent_rounds`. */
export interface HistoryRound {
  id: number;
  winner: number | null;
  moves: (number | null)[];
}

export interface PriorWinner {
  roundId: number;
  agentId: number;
  move: number;
  /** How many newer settled rounds had no usable winner. */
  skipped: number;
}

export interface StrategyInput {
  agentId: number;
  roundId: number;
  /** Newest first. Empty when the arena has not settled a round yet. */
  history: HistoryRound[];
}

/**
 * Newest settled round that actually has a winner and a revealed move.
 * A no-winner round (nobody revealed) does not erase the one before it.
 */
export function priorWinner(history: HistoryRound[]): PriorWinner | null {
  for (let index = 0; index < history.length; index += 1) {
    const round = history[index];
    if (round.winner === null || round.winner === undefined) continue;
    const move = round.moves[round.winner];
    if (move !== 0 && move !== 1 && move !== 2) continue;
    return { roundId: round.id, agentId: round.winner, move, skipped: index };
  }
  return null;
}

function historySentence(prior: PriorWinner): string {
  const who = AGENT_NAMES[prior.agentId] ?? `Agent ${prior.agentId}`;
  const played = MOVE_NAMES[prior.move];
  if (prior.skipped === 0) return `Round ${prior.roundId} winner ${who} played ${played}.`;
  const noun = prior.skipped === 1 ? "round" : "rounds";
  return `Round ${prior.roundId} winner ${who} played ${played}. ${prior.skipped} newer ${noun} had no winner.`;
}

/** Deterministic personality used when NEAR_AI_API_KEY is unset or the model fails. */
export function offlineChoice(input: StrategyInput): Choice {
  const name = AGENT_NAMES[input.agentId] ?? `Agent ${input.agentId}`;
  const prior = priorWinner(input.history);
  if (!prior) {
    const move = input.agentId === 1 ? 1 : input.agentId === 2 ? 2 : 0;
    return {
      move,
      reasoning: `No winner in recent rounds before round ${input.roundId}. ${name} opens ${MOVE_NAMES[move]}.`,
    };
  }
  const context = historySentence(prior);
  if (input.agentId === 0) {
    return {
      move: prior.move,
      reasoning: `${context} Momentum repeats ${MOVE_NAMES[prior.move]}.`,
    };
  }
  if (input.agentId === 1) {
    const move = counterMove(prior.move);
    return {
      move,
      reasoning: `${context} Mean-Reversion plays ${MOVE_NAMES[move]} to beat it.`,
    };
  }
  const move = (prior.move + 2) % 3;
  return {
    move,
    reasoning: `${context} Breakout steps off that line with ${MOVE_NAMES[move]}.`,
  };
}

/** This agent's newest revealed move, skipping rounds where it did not reveal. */
export function previousOwnMove(
  history: HistoryRound[],
  agentId: number,
): { roundId: number; move: number } | null {
  for (const round of history) {
    const move = round.moves[agentId];
    if (move === 0 || move === 1 || move === 2) return { roundId: round.id, move };
  }
  return null;
}

/** Plain-language chain facts the model is not allowed to contradict. */
export function historyFacts(input: StrategyInput): string {
  const name = AGENT_NAMES[input.agentId] ?? `Agent ${input.agentId}`;
  const prior = priorWinner(input.history);
  const own = previousOwnMove(input.history, input.agentId);
  const expected = MOVE_NAMES[offlineChoice(input).move];
  const lines = [
    prior
      ? `Newest winner: round ${prior.roundId}, ${AGENT_NAMES[prior.agentId] ?? `Agent ${prior.agentId}`} played ${MOVE_NAMES[prior.move]}.`
      : "No settled round in this history has a winner. Do not invent one.",
  ];
  if (prior && prior.skipped > 0) {
    const noun = prior.skipped === 1 ? "round" : "rounds";
    lines.push(
      `${prior.skipped} newer settled ${noun} had no winner. That is not a draw, a stalemate, or "no prior winner".`,
    );
  }
  lines.push(
    own
      ? `Your previous revealed move: ${MOVE_NAMES[own.move]} in round ${own.roundId}. Do not claim a different one.`
      : "You have no revealed move in this history. Do not claim one.",
  );
  lines.push(`The move that matches ${name}'s strategy this round: ${expected}.`);
  return lines.join(" ");
}

function claimsChosenMove(reasoning: string, moveName: string): boolean {
  return new RegExp(
    `\\b(?:play|plays|playing|choose|chooses|chose|pick|picks|picked|counter with)\\s+${moveName}\\b`,
    "i",
  ).test(reasoning);
}

function claimsOwnPastMove(reasoning: string, moveName: string): boolean {
  return (
    new RegExp(`\\b(?:i|my)\\b[^.]{0,40}\\b(?:played|chose|opened)\\b[^.]{0,24}\\b${moveName}\\b`, "i").test(
      reasoning,
    ) || new RegExp(`\\bmy last(?: move)?\\b[^.]{0,24}\\b${moveName}\\b`, "i").test(reasoning)
  );
}

/** True when the model text disagrees with chain history or with this agent's strategy. */
export function reasoningContradicts(input: StrategyInput, reasoning: string): boolean {
  const prior = priorWinner(input.history);
  const expected = MOVE_NAMES[offlineChoice(input).move];
  for (const name of MOVE_NAMES) {
    if (name !== expected && claimsChosenMove(reasoning, name)) return true;
  }
  const own = previousOwnMove(input.history, input.agentId);
  if (own) {
    for (const name of MOVE_NAMES) {
      if (name !== MOVE_NAMES[own.move] && claimsOwnPastMove(reasoning, name)) return true;
    }
  } else if (claimsOwnPastMove(reasoning, "Aggressive") || claimsOwnPastMove(reasoning, "Balanced") || claimsOwnPastMove(reasoning, "Defensive")) {
    return true;
  }
  if (prior) {
    if (/\bno\b[^.]{0,24}\bwinner\b/i.test(reasoning)) return true;
    if (/\b(?:draw|stalemate)\b/i.test(reasoning)) return true;
    return false;
  }
  if (/\bwinner\b/i.test(reasoning) && !/\bno\b[^.]{0,24}\bwinner\b/i.test(reasoning)) return true;
  return false;
}

/**
 * Keep a model choice only when its move matches the strategy and its sentence
 * matches chain history. Otherwise commit the deterministic line.
 */
export function acceptModelChoice(input: StrategyInput, model: Choice): Choice {
  const grounded = offlineChoice(input);
  if (model.move !== grounded.move || reasoningContradicts(input, model.reasoning)) return grounded;
  return model;
}
