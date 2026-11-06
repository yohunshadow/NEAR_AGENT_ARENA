import Image from "next/image";
import { MOVE_NAMES } from "../lib/rules";

const PORTRAITS = ["/agents/momentum.jpg", "/agents/mean-reversion.jpg", "/agents/breakout.jpg"] as const;
const CODES = ["Mom", "Rev", "Out"] as const;
const ROLES = ["Press", "Counter", "Break"] as const;

export interface FighterView {
  id: number;
  name: string;
  tagline: string;
  subline?: string;
  treasury: string;
  ratio: number;
  wins: number;
  fought: number;
  status: "in" | "waiting" | "retired";
  stake: string;
  poolOnAgent?: string;
  move: string | null;
  reasoning: string | null;
  highlight: boolean;
  backLabel: string;
  backDisabled: boolean;
  onBack: () => void;
  fundLabel: string;
  fundDisabled: boolean;
  onFund: () => void;
  showActions: boolean;
}

export interface HistoryView {
  id: number;
  winnerId: number | null;
  winnerName: string;
  pool: string;
  detail: string;
  moves: (number | null)[];
  scores: (number | null)[] | null | undefined;
  reasons: (string | null)[];
}

export interface ArenaFrameProps {
  mode: "demo" | "live" | "setup";
  accountLabel?: string;
  onConnect?: () => void;
  notice?: string;
  error?: string;
  roundLabel?: string;
  phase: "betting" | "reveal" | "settling" | "idle";
  countdown?: string;
  urgent?: boolean;
  poolLabel?: string;
  roundNote?: string;
  onAdvance?: () => void;
  fighters: FighterView[];
  amount?: string;
  onAmount?: (value: string) => void;
  amountId?: string;
  amountHint?: string;
  onClaim?: () => void;
  claimDisabled?: boolean;
  claimNote?: string;
  history: HistoryView[];
  log?: string[];
  footnote?: string;
  loading?: boolean;
}

const PHASES = [
  { id: "betting", label: "Betting" },
  { id: "reveal", label: "Reveal" },
  { id: "settling", label: "Settling" },
] as const;

export function ArenaFrame(props: ArenaFrameProps) {
  const setup = props.mode === "setup";
  return (
    <main className="shell">
      <header className="top">
        <a className="brand" href={props.mode === "demo" ? "/?demo=1" : "/"}>
          <span className="mark" aria-hidden="true">N</span>
          <span>
            <strong>NEAR Agent Arena</strong>
            <small>{props.mode === "demo" ? "Demo clock" : "Testnet arena"}</small>
          </span>
        </a>
        <div className="nav">
          {props.mode === "live" ? <span className="pill">testnet</span> : null}
          {props.mode === "demo" ? <span className="pill mint">Demo</span> : null}
          {props.onConnect ? (
            <button className="pill account" type="button" onClick={props.onConnect}>
              {props.accountLabel || "Connect wallet"}
            </button>
          ) : null}
          {props.mode === "demo" ? (
            <a className="pill" href="/">Leave demo</a>
          ) : (
            <a className="pill" href="/?demo=1">Demo</a>
          )}
        </div>
      </header>

      <section className="hero">
        <div className="hero-frame">
          <Image
            src="/agents/lineup.jpg"
            alt="Momentum, Mean-Reversion, and Breakout"
            fill
            priority
            sizes="(max-width: 1120px) 100vw, 1120px"
          />
        </div>
        <div className="hero-copy">
          <h1>Three fighters. One pool.</h1>
          <p className="lede">Back a fighter with testnet NEAR. The contract scores the round.</p>
        </div>
      </section>

      {props.notice ? (
        <p className="notice">
          <strong>{props.mode === "demo" ? "Simulated round. " : ""}</strong>
          {props.notice}
        </p>
      ) : null}
      {props.error ? <p className="error">{props.error}</p> : null}

      {setup ? (
        <section className="round">
          <p className="lede" style={{ margin: 0 }}>
            This build has no contract id. Open the demo to run the same winner rule in the browser, or set{" "}
            <code>NEXT_PUBLIC_CONTRACT_ID</code> for testnet.
          </p>
          <div className="actions">
            <a className="btn mint" href="/?demo=1">Open demo mode</a>
          </div>
        </section>
      ) : (
        <section className="round" aria-label="Current round">
          <div className="round-main">
            <div>
              <p className="kicker">{props.roundLabel || (props.loading ? "Syncing" : "Round")}</p>
              <p className={`clock${props.urgent ? " urgent" : ""}`} aria-live="polite">
                {props.countdown || "—"}
              </p>
              <p className="pool-line">
                <span>Pool</span>
                <b>{props.poolLabel || "—"}</b>
              </p>
              {props.roundNote ? <p className="hint">{props.roundNote}</p> : null}
            </div>
            <div className="phases" aria-label="Round phase">
              {PHASES.map((phase) => (
                <div key={phase.id} className={`phase ${props.phase === phase.id ? "on" : ""}`}>
                  {phase.label}
                </div>
              ))}
            </div>
          </div>
          {props.onAdvance ? (
            <div className="actions">
              <button className="btn mint" type="button" onClick={props.onAdvance}>
                Advance phase
              </button>
            </div>
          ) : null}
          {props.onAmount ? (
            <div className="wager">
              <label htmlFor={props.amountId || "stake"}>Stake (NEAR)</label>
              <input
                id={props.amountId || "stake"}
                inputMode="decimal"
                value={props.amount || ""}
                onChange={(event) => props.onAmount?.(event.target.value)}
              />
              {props.onClaim ? (
                <button className="btn ghost" type="button" disabled={props.claimDisabled} onClick={props.onClaim}>
                  Claim last round
                </button>
              ) : null}
              {props.claimNote ? <span className="hint">{props.claimNote}</span> : null}
              {props.amountHint ? <span className="hint">{props.amountHint}</span> : null}
            </div>
          ) : null}
        </section>
      )}

      <section className="fighters">
        {props.fighters.map((fighter) => (
          <article
            key={fighter.id}
            className={`fighter ${fighter.highlight ? "winner" : ""} ${fighter.status === "retired" ? "retired" : ""}`}
          >
            <div className="stage">
              <Image
                src={PORTRAITS[fighter.id]}
                alt={`${fighter.name}, ${ROLES[fighter.id].toLowerCase()} fighter`}
                fill
                sizes="(max-width: 900px) 100vw, 360px"
                priority={fighter.id === 0}
              />
              {fighter.status === "retired" ? <span className="stamp">RETIRED</span> : null}
            </div>
            <div className="card-body">
              <p className="role">{ROLES[fighter.id]}</p>
              <h2>{fighter.name}</h2>
              <p className="tagline">{fighter.tagline}</p>
              {fighter.subline ? <p className="subline">{fighter.subline}</p> : null}
              <p className="treasury">
                <span>Treasury</span>
                <b>{fighter.treasury}</b>
              </p>
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${Math.max(0, Math.min(1, fighter.ratio)) * 100}%` }} />
              </div>
              <div className="meta-grid">
                <span>
                  Wins <b>{fighter.wins}</b>
                </span>
                <span>
                  Fought <b>{fighter.fought}</b>
                </span>
                <span>
                  Status <b>{fighter.status === "in" ? "In round" : fighter.status === "waiting" ? "Waiting" : "Out"}</b>
                </span>
                <span>
                  Your stake <b>{fighter.stake}</b>
                </span>
                {fighter.poolOnAgent ? (
                  <span>
                    In the pool <b>{fighter.poolOnAgent}</b>
                  </span>
                ) : null}
              </div>
              <p className="speech">
                {fighter.move || fighter.reasoning ? (
                  <>
                    {fighter.move ? <em>{fighter.move}. </em> : null}
                    {fighter.reasoning}
                  </>
                ) : (
                  <span className="hint">Move stays hidden until the reveal.</span>
                )}
              </p>
              {fighter.showActions ? (
                <div className="actions">
                  <button className="btn mint" type="button" disabled={fighter.backDisabled} onClick={fighter.onBack}>
                    {fighter.backLabel}
                  </button>
                  <button className="btn ghost" type="button" disabled={fighter.fundDisabled} onClick={fighter.onFund}>
                    {fighter.fundLabel}
                  </button>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </section>

      <section className="history">
        <h2 className="section-title">Recent rounds</h2>
        {props.history.length === 0 ? (
          <p className="hint">No settled rounds yet. The first reveal writes the board.</p>
        ) : (
          <div className="rounds">
            {props.history.map((row) => (
              <article key={row.id} className="round-card">
                {row.winnerId === null ? (
                  <div className="thumb empty">None</div>
                ) : (
                  <div className="thumb">
                    <Image
                      src={PORTRAITS[row.winnerId]}
                      alt=""
                      fill
                      sizes="72px"
                    />
                  </div>
                )}
                <div>
                  <h3>Round {row.id}</h3>
                  <p className="winner-line">{row.winnerName}</p>
                  <p>{row.pool}</p>
                  {row.detail ? <p>{row.detail}</p> : null}
                  <div className="chips">
                    {row.moves.map((move, index) => (
                      <span key={CODES[index]} className={`chip ${move === null || move === undefined ? "empty" : ""}`}>
                        <i>{CODES[index]}</i>
                        {move === null || move === undefined ? "No reveal" : MOVE_NAMES[move]}
                      </span>
                    ))}
                  </div>
                  {row.scores && row.scores.some((score) => score !== null && score !== undefined) ? (
                    <p>
                      Scores{" "}
                      {row.scores.map((score) => (score === null || score === undefined ? "—" : String(score))).join(" / ")}
                    </p>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {props.log && props.log.length > 0 ? (
        <section className="tape">
          <h2 className="section-title">Latest</h2>
          <ul>
            {props.log.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="rules">
        <summary>How a winner is chosen</summary>
        <p>
          Aggressive beats Defensive, Defensive beats Balanced, and Balanced beats Aggressive. Each fighter scores 2
          for a win and 1 for a tie against the others who revealed. The settle block&apos;s random seed breaks ties by
          less than one matchup point. Equal scores go to the lowest agent id. An empty pool does not cancel a reveal:
          if anyone showed a move, the highest score still wins. Nobody revealed means the round has no winner.
        </p>
      </details>
      {props.footnote ? <p className="hint">{props.footnote}</p> : null}
    </main>
  );
}
