"use client";

import { useEffect, useMemo, useState } from "react";
import "@near-wallet-selector/modal-ui/styles.css";
import {
  advance,
  backAgent,
  BETTING_MS,
  fundAgent,
  initialDemo,
  MOVE_NAMES,
  tickDemo,
  type DemoState,
} from "../lib/demo";
import { formatMicro, formatYocto, parseNearToYocto } from "../lib/format";
import {
  contractId,
  fetchArena,
  fetchUserBet,
  nearNetwork,
  type Arena,
  type UserBet,
} from "../lib/near";
import { useSearchParams } from "next/navigation";

const COLORS = ["momentum", "reversion", "breakout"] as const;

function formatMs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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

  const phaseLabel = state.phase === "betting" ? "Betting" : "Reveal";
  return (
    <main className="shell">
      <header className="top">
        <div>
          <h1>NEAR Agent Arena</h1>
          <p>Three fighter agents. One pool. Treasuries that grow, shrink, and can die.</p>
        </div>
        <div className="row">
          <span className="badge demo">Demo mode</span>
          <a href="/">Leave demo</a>
        </div>
      </header>
      <p className="banner">
        Nothing is signed. This browser is running the same winner rule as the contract, on a fast clock.
        Remove <code>?demo=1</code> to use a testnet wallet.
      </p>
      {state.banner ? <p className="banner">{state.banner}</p> : null}
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h3>Round {state.roundId}</h3>
            <p className="muted">
              {phaseLabel} · {formatMs(state.msLeft)} left · pool {formatMicro(state.pool)} NEAR · your balance{" "}
              {formatMicro(state.userBalance)} NEAR
            </p>
          </div>
          <button className="primary" type="button" onClick={() => setState((current) => advance(current))}>
            Advance phase
          </button>
        </div>
      </section>
      <section className="grid">
        {state.agents.map((agent) => {
          const choice = state.choices[agent.id];
          const last = state.history[0];
          const won = last?.winner === agent.id;
          return (
            <article
              key={agent.id}
              className={`card ${COLORS[agent.id]} ${agent.retired ? "retired" : ""} ${won ? "winner" : ""}`}
            >
              <h2>{agent.name}</h2>
              <p className="blurb">{agent.blurb}</p>
              <p className="stat">{formatMicro(agent.treasury)} NEAR</p>
              <p className="meta">
                {agent.retired ? "Retired" : state.alive[agent.id] ? "In this round" : "Waiting"} · {agent.wins} wins ·{" "}
                {agent.roundsFought} fought
              </p>
              <p className="meta">Your stake {formatMicro(state.userStakes[agent.id])} NEAR</p>
              {choice ? (
                <p className="reason">
                  <strong>{MOVE_NAMES[choice.move]}.</strong> {choice.reasoning}
                </p>
              ) : null}
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  className="primary"
                  type="button"
                  disabled={state.phase !== "betting" || !state.alive[agent.id]}
                  onClick={() => setState((current) => backAgent(current, agent.id, amount))}
                >
                  Back {agent.name}
                </button>
                <button className="ghost" type="button" onClick={() => setState((current) => fundAgent(current, agent.id))}>
                  Fund 2 NEAR
                </button>
              </div>
            </article>
          );
        })}
      </section>
      <section className="panel">
        <div className="row">
          <label htmlFor="amount">Bet amount (NEAR)</label>
          <input id="amount" value={amount} onChange={(event) => setAmount(event.target.value)} />
          <span className="muted">Demo upkeep is 0.50 NEAR each round. A treasury at zero is retired.</span>
        </div>
      </section>
      <HistoryTable
        rows={state.history.map((row) => ({
          id: row.id,
          winner: row.winner === null ? "Refund" : state.agents[row.winner].name,
          pool: `${formatMicro(row.pool)} NEAR`,
          detail: row.note,
          reasons: row.reasonings,
        }))}
      />
      <LogList lines={state.log} />
      <Fairness />
      <p className="muted">Each betting window lasts {BETTING_MS / 1000} seconds unless you advance it.</p>
    </main>
  );
}

function HistoryTable({
  rows,
}: {
  rows: { id: number; winner: string; pool: string; detail: string; reasons: (string | null)[] }[];
}) {
  return (
    <section className="panel">
      <h3>Round history</h3>
      {rows.length === 0 ? (
        <p className="muted">No settled rounds yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Round</th>
              <th>Winner</th>
              <th>Pool</th>
              <th>What the agents said</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>{row.winner}</td>
                <td>{row.pool}</td>
                <td>
                  {row.detail}
                  {row.reasons.some(Boolean) ? (
                    <div className="muted">
                      {row.reasons.map((reason, index) => (reason ? <div key={index}>{reason}</div> : null))}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function LogList({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <section className="panel">
      <h3>Latest</h3>
      <ul className="log">
        {lines.map((line, index) => (
          <li key={`${index}-${line}`}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

function Fairness() {
  return (
    <details>
      <summary>How a winner is chosen</summary>
      <p>
        Aggressive beats Defensive, Defensive beats Balanced, and Balanced beats Aggressive. Each fighter scores 2
        points for a win and 1 for a tie against the other fighters who revealed. The settle block&apos;s random seed
        adds a tie-break smaller than one matchup point. If the full scores are still equal, the lowest agent id wins.
        In this demo the seed is a local stand-in. On chain it is <code>env::random_seed()</code>.
      </p>
    </details>
  );
}

function chainCountdown(arena: Arena, fetchedAt: number): number {
  const end =
    arena.current.phase === "betting" ? BigInt(arena.current.betting_end_ns) : BigInt(arena.current.reveal_end_ns);
  const now = BigInt(arena.now_ns) + BigInt(Date.now() - fetchedAt) * 1_000_000n;
  const left = end > now ? end - now : 0n;
  return Number(left / 1_000_000n);
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
      const nextModal = setupModal(nextSelector, { contractId: id });
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
      <main className="shell">
        <header className="top">
          <div>
            <h1>NEAR Agent Arena</h1>
            <p>Three fighter agents. One pool. Treasuries that grow, shrink, and can die.</p>
          </div>
        </header>
        <p className="banner">
          No contract is configured. Set <code>NEXT_PUBLIC_CONTRACT_ID</code> for testnet, or open the simulated arena.
        </p>
        <p>
          <a href="/?demo=1">Open demo mode</a>
        </p>
        <Fairness />
      </main>
    );
  }

  const last = arena?.recent_rounds[0];
  return (
    <main className="shell">
      <header className="top">
        <div>
          <h1>NEAR Agent Arena</h1>
          <p>Back a fighter with testnet NEAR. The contract settles the round. Agents pay their own upkeep.</p>
        </div>
        <div className="row">
          <span className="badge">{nearNetwork()}</span>
          <button className="ghost" type="button" onClick={() => modal?.show()}>
            {accountId ? accountId : "Connect wallet"}
          </button>
          <a href="/?demo=1">Demo</a>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {!arena ? (
        <p>Reading the arena from testnet…</p>
      ) : (
        <>
          <section className="panel">
            <h3>Round {arena.current.id}</h3>
            <p className="muted">
              {arena.current.phase} · {formatMs(countdown)} left · pool {formatYocto(arena.current.pool)} NEAR
              {arena.current.ready_to_settle ? " · ready to settle" : ""}
            </p>
          </section>
          <section className="grid">
            {arena.agents.map((agent) => {
              const won = last?.winner === agent.id;
              const reasoning = last?.reasonings?.[agent.id] || arena.current.reasonings[agent.id];
              const move = last?.moves?.[agent.id] ?? arena.current.moves[agent.id];
              return (
                <article
                  key={agent.id}
                  className={`card ${COLORS[agent.id]} ${agent.retired ? "retired" : ""} ${won ? "winner" : ""}`}
                >
                  <h2>{agent.name}</h2>
                  <p className="blurb">{agent.account_id}</p>
                  <p className="stat">{formatYocto(agent.treasury)} NEAR</p>
                  <p className="meta">
                    {agent.retired ? "Retired" : agent.alive_this_round ? "In this round" : "Waiting"} · {agent.wins}{" "}
                    wins · {agent.rounds_fought} fought
                  </p>
                  <p className="meta">Backed this round {formatYocto(arena.current.backed[agent.id] || "0")} NEAR</p>
                  {reasoning ? (
                    <p className="reason">
                      {move !== null && move !== undefined ? <strong>{MOVE_NAMES[move]}. </strong> : null}
                      {reasoning}
                    </p>
                  ) : null}
                  <div className="row" style={{ marginTop: 12 }}>
                    <button
                      className="primary"
                      type="button"
                      disabled={busy || arena.current.phase !== "betting" || !arena.current.alive[agent.id]}
                      onClick={() => {
                        const deposit = parseNearToYocto(amount);
                        if (deposit === null) {
                          setError("Enter a NEAR amount like 1 or 0.5.");
                          return;
                        }
                        void send("back_agent", { agent_id: agent.id }, deposit.toString());
                      }}
                    >
                      Back {agent.name}
                    </button>
                    <button
                      className="ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const deposit = parseNearToYocto("1");
                        void send("fund_agent", { agent_id: agent.id }, (deposit ?? 0n).toString());
                      }}
                    >
                      Fund 1 NEAR
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
          <section className="panel">
            <div className="row">
              <label htmlFor="live-amount">Attach (NEAR)</label>
              <input id="live-amount" value={amount} onChange={(event) => setAmount(event.target.value)} />
              <button
                className="ghost"
                type="button"
                disabled={busy || !accountId}
                onClick={() => void send("claim", { round_id: String(Math.max(0, arena.current.id - 1)) }, "0")}
              >
                Claim last round
              </button>
              {bet ? (
                <span className="muted">
                  This round stake {bet.stakes.map((stake) => formatYocto(stake)).join(" / ")}
                  {bet.settled ? ` · payout ${formatYocto(bet.payout)}` : ""}
                  {bet.claimed ? " · claimed" : ""}
                </span>
              ) : null}
            </div>
          </section>
          <HistoryTable
            rows={arena.recent_rounds.map((row) => ({
              id: row.id,
              winner:
                row.winner === null
                  ? row.refund
                    ? "Refund"
                    : "No winner"
                  : arena.agents[row.winner]?.name || String(row.winner),
              pool: `${formatYocto(row.pool)} NEAR`,
              detail: row.refund ? "Bets refunded." : `Fee ${formatYocto(row.fee)} NEAR`,
              reasons: row.reasonings,
            }))}
          />
        </>
      )}
      <Fairness />
    </main>
  );
}

export function ArenaApp() {
  const params = useSearchParams();
  const demo = params.get("demo") === "1";
  if (demo) return <DemoView />;
  return <LiveView />;
}
