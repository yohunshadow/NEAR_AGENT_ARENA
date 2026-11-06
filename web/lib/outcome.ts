import { formatYocto } from "./format";
import { MOVE_NAMES } from "./rules";

export interface OutcomeInput {
  winner: number | null;
  refund: boolean;
  pool: bigint;
  fee?: bigint;
  moves: (number | null)[];
  scores?: (number | null)[] | null;
  agentName: (id: number) => string;
  /** Demo balances are micro-NEAR. Live balances are yoctoNEAR. */
  formatAmount?: (value: bigint) => string;
}

export function describeSettledRound(input: OutcomeInput): { winner: string; detail: string } {
  const format = input.formatAmount ?? ((value: bigint) => `${formatYocto(value)} NEAR`);
  const revealed = input.moves.filter((move) => move !== null && move !== undefined).length;
  const scores = scoreText(input.scores);
  if (input.winner === null || input.winner === undefined) {
    if (input.refund || input.pool > 0n) {
      return {
        winner: "No winner",
        detail: `No agent revealed.${scores} Stakes can be claimed back.`,
      };
    }
    return {
      winner: "No winner",
      detail:
        revealed === 0
          ? `No agent revealed, and nobody bet.${scores}`
          : `No winner.${scores}`,
    };
  }
  const name = input.agentName(input.winner);
  const move = input.moves[input.winner];
  const moveLabel = move === 0 || move === 1 || move === 2 ? `${MOVE_NAMES[move]}. ` : "";
  if (input.pool === 0n) {
    return {
      winner: name,
      detail: `${moveLabel}Won on score. No bets were placed.${scores}`,
    };
  }
  const fee = input.fee ?? 0n;
  return {
    winner: name,
    detail: `${moveLabel}Fee ${format(fee)} to the winner's treasury.${scores}`,
  };
}

function scoreText(scores: (number | null)[] | null | undefined): string {
  if (!scores) return "";
  const parts = scores.map((score) => (score === null || score === undefined ? "—" : String(score)));
  if (parts.every((part) => part === "—")) return "";
  return ` Scores ${parts.join(" / ")}.`;
}
