export interface ClaimBetView {
  settled: boolean;
  claimed: boolean;
  payoutYocto: bigint;
}

export interface ClaimPresentation {
  label: string;
  note: string;
  enabled: boolean;
  action: "connect" | "claim" | "none";
  roundId: number | null;
  payoutYocto: bigint | null;
}

export function claimPresentation(input: {
  accountConnected: boolean;
  previousRoundId: number | null;
  currentRoundId?: number | null;
  /** `undefined` while the view is in flight, `null` when the account has no bet. */
  bet: ClaimBetView | null | undefined;
  pending: boolean;
  waitNote?: string;
}): ClaimPresentation {
  const roundId = input.previousRoundId;
  if (input.pending) {
    return {
      label: "Opening wallet…",
      note: input.waitNote || "Opening your wallet. Approve the claim there.",
      enabled: false,
      action: "none",
      roundId,
      payoutYocto: input.bet?.payoutYocto ?? null,
    };
  }
  if (!input.accountConnected) {
    return {
      label: "Connect a wallet to claim",
      note: "Connect a wallet before claiming a payout.",
      enabled: true,
      action: "connect",
      roundId,
      payoutYocto: null,
    };
  }
  if (roundId === null) {
    return {
      label: "Claim last round",
      note: "No settled round yet.",
      enabled: false,
      action: "none",
      roundId,
      payoutYocto: null,
    };
  }
  if (input.bet === undefined) {
    return {
      label: "Claim last round",
      note: `Checking round ${roundId}…`,
      enabled: false,
      action: "none",
      roundId,
      payoutYocto: null,
    };
  }
  if (input.bet === null) {
    const open =
      input.currentRoundId !== null && input.currentRoundId !== undefined
        ? ` Round ${input.currentRoundId} is still open.`
        : "";
    return {
      label: "Claim last round",
      note: `No bet on round ${roundId} to claim.${open}`,
      enabled: false,
      action: "none",
      roundId,
      payoutYocto: null,
    };
  }
  if (!input.bet.settled) {
    return {
      label: "Claim last round",
      note: `Round ${roundId} is not settled yet.`,
      enabled: false,
      action: "none",
      roundId,
      payoutYocto: null,
    };
  }
  if (input.bet.claimed) {
    return {
      label: "Claim last round",
      note: `Round ${roundId} is already claimed.`,
      enabled: false,
      action: "none",
      roundId,
      payoutYocto: input.bet.payoutYocto,
    };
  }
  if (input.bet.payoutYocto <= 0n) {
    return {
      label: "Claim last round",
      note: `Round ${roundId} has nothing to claim.`,
      enabled: false,
      action: "none",
      roundId,
      payoutYocto: 0n,
    };
  }
  return {
    label: "Claim last round",
    note: `Round ${roundId} has a payout. The wallet has to approve it.`,
    enabled: true,
    action: "claim",
    roundId,
    payoutYocto: input.bet.payoutYocto,
  };
}

export function claimErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/user rejected|user cancel|rejected by user/i.test(text)) return "The wallet request was declined.";
  if (/no bet/i.test(text)) return "No bet on that round to claim.";
  if (/nothing to claim/i.test(text)) return "That round has nothing to claim.";
  if (/already claimed/i.test(text)) return "That round is already claimed.";
  if (/not settled/i.test(text)) return "That round is not settled yet.";
  const trimmed = text.trim();
  return trimmed || "The claim could not be sent.";
}
