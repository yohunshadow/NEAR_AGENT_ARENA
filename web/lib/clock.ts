export type ShownPhase = "betting" | "reveal" | "settling";

export interface ClockInput {
  /** Phase string from the contract view. */
  phase: string;
  bettingEndNs: bigint;
  revealEndNs: bigint;
  nowNs: bigint;
  fetchedAtMs: number;
  nowMs: number;
}

export interface PresentedClock {
  phase: ShownPhase;
  remainingMs: number;
  caption: string;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function phaseRank(phase: ShownPhase): number {
  if (phase === "betting") return 0;
  if (phase === "reveal") return 1;
  return 2;
}

function chainPhase(phase: string): ShownPhase | null {
  if (phase === "betting") return "betting";
  if (phase === "reveal") return "reveal";
  if (phase === "settle" || phase === "finalize") return "settling";
  return null;
}

/**
 * The clock and the phase chip share one answer.
 * Local time moves the chip when a window ends, so the UI does not sit on
 * "Betting 0:00" until the next poll and then jump to the reveal window.
 * A chain phase that is already further along still wins.
 */
export function presentedClock(input: ClockInput): PresentedClock {
  const elapsedMs = Math.max(0, input.nowMs - input.fetchedAtMs);
  const nowNs = input.nowNs + BigInt(elapsedMs) * 1_000_000n;
  let phase: ShownPhase;
  if (nowNs >= input.revealEndNs) phase = "settling";
  else if (nowNs >= input.bettingEndNs) phase = "reveal";
  else phase = "betting";
  const reported = chainPhase(input.phase);
  if (reported && phaseRank(reported) > phaseRank(phase)) phase = reported;

  if (phase === "settling") {
    return { phase, remainingMs: 0, caption: "Waiting for settle" };
  }
  const end = phase === "betting" ? input.bettingEndNs : input.revealEndNs;
  const left = end > nowNs ? end - nowNs : 0n;
  return {
    phase,
    remainingMs: Number(left / 1_000_000n),
    caption: phase === "betting" ? "Left in betting" : "Left in reveal",
  };
}

export interface SnapshotMark {
  nowNs: bigint;
  roundId: number;
}

/** Drop a late RPC view that would rewind the same round's clock. */
export function preferSnapshot(previous: SnapshotMark | null, next: SnapshotMark): boolean {
  if (!previous) return true;
  if (next.roundId > previous.roundId) return true;
  if (next.roundId < previous.roundId) return false;
  return next.nowNs >= previous.nowNs;
}
