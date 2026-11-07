"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import "@near-wallet-selector/modal-ui/styles.css";
import "./wallet-modal.css";
import { useSearchParams } from "next/navigation";
import {
  advance,
  backAgent,
  BETTING_MS,
  fundAgent,
  initialDemo,
  tickDemo,
  type DemoState,
} from "../lib/demo";
import { claimErrorText, claimPresentation } from "../lib/claim";
import { formatClock, preferSnapshot, presentedClock, type SnapshotMark } from "../lib/clock";
import { formatMicro, formatYocto, parseNearToYocto } from "../lib/format";
import { describeSettledRound } from "../lib/outcome";
import {
  contractId,
  fetchArena,
  fetchUserBet,
  nearNetwork,
  type Arena,
  type UserBet,
} from "../lib/near";
import type { WalletModuleFactory } from "@near-wallet-selector/core";
import { AGENT_BLURBS, MOVE_NAMES } from "../lib/rules";
import { ArenaFrame, type FighterView, type HistoryView } from "./ArenaFrame";

const NAMES = ["Momentum", "Mean-Reversion", "Breakout"] as const;

function telemetry(mode: "demo" | "live" | "setup", round: string) {
  return {
    network: nearNetwork(),
    contract: contractId() || "unset",
    round,
    mode,
  };
}

function ratios(values: bigint[]): number[] {
  const max = values.reduce((best, value) => (value > best ? value : best), 0n);
  if (max === 0n) return values.map(() => 0);
  return values.map((value) => Number((value * 1000n) / max) / 1000);
}

function idleFighters(): FighterView[] {
  return NAMES.map((name, id) => ({
    id,
    name,
    tagline: AGENT_BLURBS[id],
    treasury: "—",
    ratio: 0.35,
    wins: 0,
    fought: 0,
    status: "waiting",
    stake: "—",
    move: null,
    reasoning: null,
    highlight: false,
    backed: false,
    backLabel: `Back ${name}`,
    backDisabled: true,
    onBack: () => undefined,
    fundLabel: "Fund",
    fundDisabled: true,
    onFund: () => undefined,
    showActions: false,
  }));
}

function DemoView() {
  const [state, setState] = useState<DemoState>(() => initialDemo());
  const [amount, setAmount] = useState("4");

  useEffect(() => {
    const timer = setInterval(() => {
      setState((current) => tickDemo(current, 250));
    }, 250);
    return () => clearInterval(timer);
  }, [state.roundId, state.phase]);

  const bars = ratios(state.agents.map((agent) => agent.treasury));
  const last = state.history[0];
  const fighters: FighterView[] = state.agents.map((agent) => {
    const choice = state.choices[agent.id];
    return {
      id: agent.id,
      name: agent.name,
      tagline: agent.blurb,
      treasury: `${formatMicro(agent.treasury)} NEAR`,
      ratio: bars[agent.id],
      wins: agent.wins,
      fought: agent.roundsFought,
      status: agent.retired ? "retired" : state.alive[agent.id] ? "in" : "waiting",
      stake: `${formatMicro(state.userStakes[agent.id])} NEAR`,
      move: choice ? MOVE_NAMES[choice.move] : null,
      reasoning: choice?.reasoning ?? null,
      highlight: last?.winner === agent.id,
      backed: state.userStakes[agent.id] > 0n,
      backLabel: `Back ${agent.name}`,
      backDisabled: state.phase !== "betting" || !state.alive[agent.id],
      onBack: () => setState((current) => backAgent(current, agent.id, amount)),
      fundLabel: agent.retired ? "Revive with 2 NEAR" : "Fund 2 NEAR",
      fundDisabled: false,
      onFund: () => setState((current) => fundAgent(current, agent.id)),
      showActions: true,
    };
  });

  return (
    <ArenaFrame
      mode="demo"
      notice={
        state.banner
          ? `${state.banner} Nothing on this page is signed.`
          : "Nothing is signed. This browser runs the same winner rule as the contract, on a fast clock."
      }
      roundLabel={`Round ${state.roundId}`}
      phase={state.phase}
      countdown={formatClock(state.msLeft)}
      clockCaption={state.phase === "betting" ? "Left in betting" : "Left in reveal"}
      phaseNote="Advance phase skips the clock in this browser. The status labels are not buttons."
      urgent={state.msLeft < 3000}
      poolLabel={`${formatMicro(state.pool)} NEAR`}
      roundNote={`Your balance ${formatMicro(state.userBalance)} NEAR`}
      onAdvance={() => setState((current) => advance(current))}
      fighters={fighters}
      amount={amount}
      onAmount={setAmount}
      amountId="demo-stake"
      amountHint="Demo upkeep is 0.50 NEAR each round. A treasury at zero is retired."
      history={state.history.map((row) => historyFromDemo(row, state))}
      log={state.log}
      footnote={`Each betting window lasts ${BETTING_MS / 1000} seconds unless you advance it.`}
      telemetry={telemetry("demo", String(state.roundId))}
    />
  );
}

function historyFromDemo(row: DemoState["history"][number], state: DemoState): HistoryView {
  const described = describeSettledRound({
    winner: row.winner,
    refund: row.winner === null && row.pool > 0n,
    pool: row.pool,
    moves: row.moves,
    scores: row.scores,
    agentName: (id) => state.agents[id]?.name ?? String(id),
  });
  return {
    id: row.id,
    winnerId: row.winner,
    winnerName: described.winner,
    pool: `${formatMicro(row.pool)} NEAR`,
    detail: row.note,
    moves: row.moves,
    scores: row.scores,
    reasons: row.reasonings,
  };
}

function LiveView() {
  const id = contractId();
  const [arena, setArena] = useState<Arena | null>(null);
  const [bet, setBet] = useState<UserBet | null>(null);
  const [error, setError] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [claimBet, setClaimBet] = useState<UserBet | null | undefined>(undefined);
  const [claimLookupError, setClaimLookupError] = useState("");
  const [claimNonce, setClaimNonce] = useState(0);
  const [waitNote, setWaitNote] = useState("");
  const [pendingKind, setPendingKind] = useState<"claim" | "other" | null>(null);
  const applied = useRef<SnapshotMark | null>(null);
  const requestId = useRef(0);
  const [modal, setModal] = useState<{ show: () => void } | null>(null);
  const [selector, setSelector] = useState<{
    wallet: () => Promise<{
      signAndSendTransaction: (args: {
        signerId?: string;
        receiverId: string;
        actions: {
          type: "FunctionCall";
          params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
        }[];
      }) => Promise<unknown>;
    }>;
  } | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const applyArena = (next: Arena) => {
      const mark = { nowNs: BigInt(next.now_ns), roundId: next.current.id };
      if (!preferSnapshot(applied.current, mark)) return;
      applied.current = mark;
      setArena(next);
      setFetchedAt(Date.now());
      setError("");
    };
    const load = async () => {
      const token = ++requestId.current;
      try {
        const next = await fetchArena();
        if (cancelled || token !== requestId.current) return;
        applyArena(next);
      } catch (err) {
        if (cancelled || token !== requestId.current) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

  const previousRoundId = arena && arena.current.id > 0 ? arena.current.id - 1 : null;

  useEffect(() => {
    if (!id || !accountId || previousRoundId === null) {
      setClaimBet(undefined);
      setClaimLookupError("");
      return;
    }
    let cancelled = false;
    setClaimBet(undefined);
    setClaimLookupError("");
    void fetchUserBet(accountId, previousRoundId)
      .then((value) => {
        if (!cancelled) setClaimBet(value);
      })
      .catch(() => {
        if (!cancelled) setClaimLookupError(`Could not read round ${previousRoundId}.`);
      });
    return () => {
      cancelled = true;
    };
  }, [id, accountId, previousRoundId, claimNonce]);

  useEffect(() => {
    if (!id || !accountId || !arena) return;
    let cancelled = false;
    void fetchUserBet(accountId, arena.current.id)
      .then((value) => {
        if (!cancelled) setBet(value);
      })
      .catch(() => {
        if (!cancelled) setBet(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, accountId, arena]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      const [{ setupWalletSelector }, { setupModal }, { testnetWalletModules }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/modal-ui"),
        import("../lib/wallets"),
      ]);
      const nextSelector = await setupWalletSelector({
        network: nearNetwork() as "testnet",
        modules: testnetWalletModules(id) as Array<WalletModuleFactory>,
      });
      const nextModal = setupModal(nextSelector, { contractId: id, theme: "dark" });
      const state = nextSelector.store.getState();
      if (!cancelled) {
        setSelector(nextSelector);
        setModal(nextModal);
        setAccountId(state.accounts[0]?.accountId ?? null);
      }
      nextSelector.store.observable.subscribe((value) => {
        setAccountId(value.accounts[0]?.accountId ?? null);
      });
    })().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const clock = useMemo(() => {
    if (!arena) return null;
    return presentedClock({
      phase: arena.current.phase,
      bettingEndNs: BigInt(arena.current.betting_end_ns),
      revealEndNs: BigInt(arena.current.reveal_end_ns),
      nowNs: BigInt(arena.now_ns),
      fetchedAtMs: fetchedAt,
      nowMs: now,
    });
  }, [arena, fetchedAt, now]);

  function applyArena(next: Arena) {
    const mark = { nowNs: BigInt(next.now_ns), roundId: next.current.id };
    if (!preferSnapshot(applied.current, mark)) return;
    applied.current = mark;
    setArena(next);
    setFetchedAt(Date.now());
  }

  async function send(methodName: string, args: Record<string, unknown>, deposit: string) {
    if (!selector || !accountId) {
      if (modal) modal.show();
      else setError("The wallet list is still loading.");
      return;
    }
    const kind = methodName === "claim" ? "claim" : "other";
    setBusy(true);
    setPendingKind(kind);
    setError("");
    setWaitNote(
      kind === "claim"
        ? "Opening your wallet. Approve the claim there."
        : "Opening your wallet. Approve the request there.",
    );
    const timer = window.setTimeout(() => {
      setWaitNote(
        kind === "claim"
          ? "Still waiting for the wallet. Approve the claim there if it opened."
          : "Still waiting for the wallet. Approve the request there if it opened.",
      );
    }, 8000);
    try {
      const wallet = await selector.wallet();
      await wallet.signAndSendTransaction({
        signerId: accountId,
        receiverId: id,
        actions: [
          {
            type: "FunctionCall",
            params: { methodName, args, gas: "80000000000000", deposit },
          },
        ],
      });
      const next = await fetchArena();
      applyArena(next);
      if (kind === "claim") setClaimNonce((value) => value + 1);
      setWaitNote("");
    } catch (err) {
      setWaitNote("");
      setError(kind === "claim" ? claimErrorText(err) : err instanceof Error ? err.message : String(err));
    } finally {
      window.clearTimeout(timer);
      setBusy(false);
      setPendingKind(null);
    }
  }

  if (!id) {
    return (
      <ArenaFrame
        mode="setup"
        phase="idle"
        fighters={idleFighters()}
        history={[]}
        telemetry={telemetry("setup", "—")}
      />
    );
  }

  const last = arena?.recent_rounds[0];
  const phase = clock?.phase ?? "idle";
  const treasuries = arena ? arena.agents.map((agent) => BigInt(agent.treasury || "0")) : [];
  const bars = ratios(treasuries);
  const fighters: FighterView[] = arena
    ? arena.agents.map((agent) => {
        const currentMove = arena.current.moves[agent.id];
        const revealedNow = currentMove !== null && currentMove !== undefined;
        const pastMove = last?.moves?.[agent.id];
        const pastReason = last?.reasonings?.[agent.id] ?? null;
        const move = revealedNow ? currentMove : (pastMove ?? null);
        const reasoning = revealedNow ? arena.current.reasonings[agent.id] : pastReason;
        const speechLabel = revealedNow
          ? "This round"
          : move !== null || reasoning
            ? last
              ? `Round ${last.id}`
              : null
            : null;
        const userStake = bet?.stakes?.[agent.id];
        return {
          id: agent.id,
          name: agent.name,
          tagline: AGENT_BLURBS[agent.id] || "",
          subline: agent.account_id,
          treasury: `${formatYocto(agent.treasury)} NEAR`,
          ratio: bars[agent.id] ?? 0,
          wins: agent.wins,
          fought: agent.rounds_fought,
          status: agent.retired ? "retired" : agent.alive_this_round ? "in" : "waiting",
          stake: userStake ? `${formatYocto(userStake)} NEAR` : "0 NEAR",
          poolOnAgent: `${formatYocto(arena.current.backed[agent.id] || "0")} NEAR`,
          move: move !== null && move !== undefined ? MOVE_NAMES[move] : null,
          reasoning: reasoning || null,
          speechLabel,
          highlight: last?.winner === agent.id,
          backed: userStake ? BigInt(userStake) > 0n : false,
          backLabel: `Back ${agent.name}`,
          backDisabled: busy || phase !== "betting" || !arena.current.alive[agent.id],
          onBack: () => {
            const deposit = parseNearToYocto(amount);
            if (deposit === null) {
              setError("Enter a NEAR amount like 1 or 0.5.");
              return;
            }
            void send("back_agent", { agent_id: agent.id }, deposit.toString());
          },
          fundLabel: agent.retired ? "Revive with 1 NEAR" : "Fund 1 NEAR",
          fundDisabled: busy,
          onFund: () => {
            const deposit = parseNearToYocto("1");
            void send("fund_agent", { agent_id: agent.id }, (deposit ?? 0n).toString());
          },
          showActions: true,
        };
      })
    : idleFighters();

  const history: HistoryView[] = arena
    ? arena.recent_rounds.map((row) => {
        const described = describeSettledRound({
          winner: row.winner,
          refund: row.refund,
          pool: BigInt(row.pool || "0"),
          fee: BigInt(row.fee || "0"),
          moves: row.moves,
          scores: row.scores,
          agentName: (agentId) => arena.agents[agentId]?.name || String(agentId),
        });
        return {
          id: row.id,
          winnerId: row.winner,
          winnerName: described.winner,
          pool: `${formatYocto(row.pool)} NEAR`,
          detail: described.detail,
          moves: row.moves,
          scores: row.scores,
          reasons: row.reasonings,
        };
      })
    : [];

  const roundNote = arena
    ? [
        arena.current.ready_to_settle ? "ready to settle" : "",
        last && last.winner === null
          ? `round ${last.id} had no winner${(last.moves ?? []).every((move) => move === null) ? " because no agent revealed" : ""}`
          : "",
      ]
        .filter(Boolean)
        .join(". ")
    : "reading testnet";

  const claim = claimPresentation({
    accountConnected: Boolean(accountId),
    previousRoundId,
    currentRoundId: arena?.current.id ?? null,
    bet:
      claimBet === undefined || claimBet === null
        ? claimBet
        : {
            settled: claimBet.settled,
            claimed: claimBet.claimed,
            payoutYocto: BigInt(claimBet.payout || "0"),
          },
    pending: pendingKind === "claim",
    waitNote: pendingKind === "claim" ? waitNote : undefined,
  });
  const claimNote = claimLookupError && accountId ? claimLookupError : claim.note;
  const claimLabel =
    claim.action === "claim" && claim.payoutYocto !== null
      ? `Claim ${formatYocto(claim.payoutYocto)} NEAR`
      : claim.label;

  return (
    <ArenaFrame
      mode="live"
      accountLabel={accountId || "Connect wallet"}
      onConnect={() => {
        if (!modal) {
          setError("The wallet list is still loading.");
          return;
        }
        setError("");
        modal.show();
      }}
      notice={pendingKind === "other" && waitNote ? waitNote : undefined}
      error={error || undefined}
      loading={!arena}
      roundLabel={arena ? `Round ${arena.current.id}` : "Round"}
      phase={phase}
      countdown={arena ? (phase === "settling" ? "Settle" : formatClock(clock?.remainingMs ?? 0)) : "—"}
      clockCaption={clock?.caption}
      phaseNote="The contract changes the phase. These labels are not buttons."
      urgent={Boolean(clock) && phase !== "settling" && (clock?.remainingMs ?? 0) < 15_000}
      poolLabel={arena ? `${formatYocto(arena.current.pool)} NEAR` : "—"}
      roundNote={roundNote}
      fighters={fighters}
      amount={amount}
      onAmount={setAmount}
      amountId="live-stake"
      onClaim={
        arena
          ? () => {
              if (claim.action === "connect") {
                if (!modal) {
                  setError("The wallet list is still loading.");
                  return;
                }
                setError("");
                modal.show();
                return;
              }
              if (claim.action !== "claim" || claim.roundId === null) return;
              void send("claim", { round_id: String(claim.roundId) }, "0");
            }
          : undefined
      }
      claimLabel={claimLabel}
      claimDisabled={!claim.enabled || busy || Boolean(claimLookupError && accountId)}
      claimNote={arena ? claimNote : undefined}
      history={history}
      telemetry={telemetry("live", arena ? String(arena.current.id) : "—")}
    />
  );
}

export function ArenaApp() {
  const params = useSearchParams();
  if (params.get("demo") === "1") return <DemoView />;
  return <LiveView />;
}
