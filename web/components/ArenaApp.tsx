"use client";

import { useEffect, useMemo, useState } from "react";
import "@near-wallet-selector/modal-ui/styles.css";
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

function formatMs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
      countdown={formatMs(state.msLeft)}
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

function chainCountdown(arena: Arena, fetchedAt: number): number {
  const end =
    arena.current.phase === "betting" ? BigInt(arena.current.betting_end_ns) : BigInt(arena.current.reveal_end_ns);
  const now = BigInt(arena.now_ns) + BigInt(Date.now() - fetchedAt) * 1_000_000n;
  const left = end > now ? end - now : 0n;
  return Number(left / 1_000_000n);
}

function livePhase(phase: string): "betting" | "reveal" | "settling" {
  if (phase === "betting") return "betting";
  if (phase === "reveal") return "reveal";
  return "settling";
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
    const load = async () => {
      try {
        const next = await fetchArena();
        if (cancelled) return;
        setArena(next);
        setFetchedAt(Date.now());
        setError("");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

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
      const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/modal-ui"),
        import("@near-wallet-selector/my-near-wallet"),
      ]);
      const nextSelector = await setupWalletSelector({
        network: nearNetwork() as "testnet",
        modules: [setupMyNearWallet()],
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

  const countdown = useMemo(() => (arena ? chainCountdown(arena, fetchedAt) : 0), [arena, fetchedAt, now]);

  async function send(methodName: string, args: Record<string, unknown>, deposit: string) {
    if (!selector || !accountId) {
      modal?.show();
      return;
    }
    setBusy(true);
    setError("");
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
      setArena(next);
      setFetchedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
  const phase = arena ? livePhase(arena.current.phase) : "idle";
  const treasuries = arena ? arena.agents.map((agent) => BigInt(agent.treasury || "0")) : [];
  const bars = ratios(treasuries);
  const fighters: FighterView[] = arena
    ? arena.agents.map((agent) => {
        const reasoning = last?.reasonings?.[agent.id] || arena.current.reasonings[agent.id];
        const move = last?.moves?.[agent.id] ?? arena.current.moves[agent.id];
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
          highlight: last?.winner === agent.id,
          backed: userStake ? BigInt(userStake) > 0n : false,
          backLabel: `Back ${agent.name}`,
          backDisabled: busy || arena.current.phase !== "betting" || !arena.current.alive[agent.id],
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

  return (
    <ArenaFrame
      mode="live"
      accountLabel={accountId || "Connect wallet"}
      onConnect={() => modal?.show()}
      error={error || undefined}
      loading={!arena}
      roundLabel={arena ? `Round ${arena.current.id}` : "Round"}
      phase={phase}
      countdown={arena ? (phase === "settling" ? "Settle" : formatMs(countdown)) : "—"}
      urgent={Boolean(arena) && phase !== "settling" && countdown < 15_000}
      poolLabel={arena ? `${formatYocto(arena.current.pool)} NEAR` : "—"}
      roundNote={roundNote}
      fighters={fighters}
      amount={amount}
      onAmount={setAmount}
      amountId="live-stake"
      onClaim={
        arena
          ? () => void send("claim", { round_id: String(Math.max(0, arena.current.id - 1)) }, "0")
          : undefined
      }
      claimDisabled={busy || !accountId || !arena}
      claimNote={
        last && last.winner === null && !last.refund
          ? "The last round has nothing to claim."
          : bet
            ? `This round ${bet.stakes.map((stake) => formatYocto(stake)).join(" / ")} NEAR${bet.settled ? ` · payout ${formatYocto(bet.payout)}` : ""}${bet.claimed ? " · claimed" : ""}`
            : undefined
      }
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
