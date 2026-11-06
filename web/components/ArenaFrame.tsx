"use client";

import Image from "next/image";
import { motion, MotionConfig, useReducedMotion } from "motion/react";
import { MOVE_NAMES } from "../lib/rules";
import { AnimatedList } from "./ui/animated-list";
import { BorderBeam } from "./ui/border-beam";
import { DotPattern } from "./ui/dot-pattern";
import { Grain } from "./ui/grain";
import { Marquee } from "./ui/marquee";
import { NumberTicker } from "./ui/number-ticker";
import { Spotlight } from "./ui/spotlight";

const PORTRAITS = ["/agents/momentum.jpg", "/agents/mean-reversion.jpg", "/agents/breakout.jpg"] as const;
const CODES = ["Mom", "Rev", "Out"] as const;
const ROLES = ["Press", "Counter", "Break"] as const;
const INDEX = ["01", "02", "03"] as const;

const COVER = { objectFit: "cover" } as const;

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
  backed: boolean;
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
  telemetry: {
    network: string;
    contract: string;
    round: string;
    mode: string;
  };
}

const PHASES = [
  { id: "betting", label: "Betting" },
  { id: "reveal", label: "Reveal" },
  { id: "settling", label: "Settling" },
] as const;

export function ArenaFrame(props: ArenaFrameProps) {
  const reduce = useReducedMotion() === true;
  const setup = props.mode === "setup";
  const pool = splitAmount(props.poolLabel || "—");
  const tape = tapeLines(props.history);
  return (
    <MotionConfig reducedMotion="user">
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

        <motion.section
          className="hero"
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className="hero-visual">
            <div className="triptych">
              {props.fighters.map((fighter) => (
                <figure className="crop" key={fighter.id}>
                  <Image
                    src={PORTRAITS[fighter.id] ?? PORTRAITS[0]}
                    alt=""
                    fill
                    priority
                    quality={90}
                    sizes="(max-width: 960px) 34vw, 440px"
                    style={{ ...COVER, objectPosition: "center center" }}
                  />
                  <figcaption className="crop-label">
                    <i>{INDEX[fighter.id]}</i>
                    <span className="crop-short">{CODES[fighter.id]}</span>
                    <span className="crop-full">{fighter.name}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
            <Spotlight />
            <DotPattern />
            <Grain />
          </div>
          <div className="hero-copy">
            <h1>
              <span>Three fighters.</span>
              <span>One pool.</span>
            </h1>
            <p className="lede">Back a fighter with testnet NEAR and let the contract score the round.</p>
          </div>
          <div className="hero-tape">
            <p className="sr-only">{tape.join(". ")}</p>
            <Marquee duration={36} className="tape-marquee">
              {tape.map((line, index) => (
                <span className="tape-item" key={`${line}-${index}`}>
                  {line}
                </span>
              ))}
            </Marquee>
          </div>
        </motion.section>

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
            <div className="round-actions">
              <a className="btn mint" href="/?demo=1">Open demo mode</a>
            </div>
          </section>
        ) : (
          <section className="round" aria-label="Current round">
            <div className="round-main">
              <div className="figures">
                <div className="figure">
                  <p className="kicker">{props.roundLabel || (props.loading ? "Syncing" : "Round")}</p>
                  <p className={`clock${props.urgent ? " urgent" : ""}`}>
                    <span className="sr-only">{props.countdown || "—"}</span>
                    <NumberTicker className="clock-num" value={props.countdown || "—"} />
                  </p>
                </div>
                <div className="figure">
                  <p className="kicker">Pool</p>
                  <p className="pool">
                    <span className="sr-only">{props.poolLabel || "—"}</span>
                    <NumberTicker className="pool-num" value={pool.num} />
                    {pool.unit ? <span className="pool-unit">{pool.unit}</span> : null}
                  </p>
                </div>
              </div>
              <div className="round-side">
                <PhaseTrack phase={props.phase} reduce={reduce} />
                {props.onAdvance ? (
                  <button className="btn mint" type="button" onClick={props.onAdvance}>
                    Advance phase
                  </button>
                ) : null}
              </div>
            </div>
            {props.roundNote ? <p className="hint round-note">{props.roundNote}</p> : null}
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

        <section className="fighters" aria-label="Fighters">
          {props.fighters.map((fighter) => (
            <FighterCard key={fighter.id} fighter={fighter} />
          ))}
        </section>

        <section className="history">
          <h2 className="section-title">
            <span>02</span>Recent rounds
          </h2>
          {props.history.length === 0 ? (
            <p className="hint">No settled rounds yet. The first reveal writes the board.</p>
          ) : (
            <>
              <p className="sr-only">
                {props.history
                  .map((row) => `Round ${row.id}, ${row.winnerName}, ${row.pool}. ${row.detail}`)
                  .join(" ")}
              </p>
              <Marquee duration={52} pauseOnHover className="chip-marquee">
                {repeatTo(props.history, 4).map((row, index) => (
                  <RoundChip key={`${row.id}-${index}`} row={row} />
                ))}
              </Marquee>
            </>
          )}
        </section>

        {props.log && props.log.length > 0 ? (
          <section className="tape">
            <h2 className="section-title">
              <span>03</span>Latest
            </h2>
            <AnimatedList items={props.log} />
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
        {props.footnote ? <p className="hint footnote">{props.footnote}</p> : null}

        <footer className="telemetry" aria-label="Arena telemetry">
          <span>
            network <b>{props.telemetry.network}</b>
          </span>
          <span>
            contract <b>{props.telemetry.contract}</b>
          </span>
          <span>
            round <b>{props.telemetry.round}</b>
          </span>
          <span>
            mode <b>{props.telemetry.mode}</b>
          </span>
        </footer>
      </main>
    </MotionConfig>
  );
}

function PhaseTrack({ phase, reduce }: { phase: ArenaFrameProps["phase"]; reduce: boolean }) {
  return (
    <div className="phase-track" role="group" aria-label="Round phase">
      {PHASES.map((item) => {
        const on = phase === item.id;
        return (
          <div key={item.id} className={`phase-slot${on ? " on" : ""}`} aria-current={on ? "step" : undefined}>
            {on ? (
              reduce ? (
                <span className="phase-pill" />
              ) : (
                <motion.span
                  layoutId="phase-pill"
                  className="phase-pill"
                  transition={{ type: "spring", bounce: 0, duration: 0.45 }}
                />
              )
            ) : null}
            <span className="phase-label">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function FighterCard({ fighter }: { fighter: FighterView }) {
  const treasury = splitAmount(fighter.treasury);
  const stake = splitAmount(fighter.stake);
  return (
    <article className={`fighter${fighter.backed ? " backed" : ""}${fighter.status === "retired" ? " retired" : ""}`}>
      {fighter.backed ? <BorderBeam /> : null}
      <div className="stage">
        <Image
          src={PORTRAITS[fighter.id] ?? PORTRAITS[0]}
          alt={`${fighter.name}, ${ROLES[fighter.id].toLowerCase()} fighter`}
          fill
          quality={90}
          sizes="(max-width: 900px) 100vw, 420px"
          style={{ ...COVER, objectPosition: "center center" }}
          className="portrait"
        />
        {fighter.status === "retired" ? <span className="stamp">RETIRED</span> : null}
        <div className="stage-caption">
          <p className="crop-kicker">
            <i>{INDEX[fighter.id]}</i>
            {ROLES[fighter.id]}
          </p>
          <h2>{fighter.name}</h2>
        </div>
      </div>
      <div className="card-body">
        <div className="stats">
          <p className="stat">
            <b>
              {treasury.num}
              {treasury.unit ? <small>{treasury.unit}</small> : null}
            </b>
            <span>Treasury</span>
          </p>
          <p className="stat">
            <b>{fighter.wins}</b>
            <span>Wins</span>
          </p>
          <p className="stat">
            <b>
              {stake.num}
              {stake.unit ? <small>{stake.unit}</small> : null}
            </b>
            <span>Your stake</span>
          </p>
        </div>
        <div className="bar" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(1, fighter.ratio)) * 100}%` }} />
        </div>
        <p className="meta-line">
          <span>Fought {fighter.fought}</span>
          <span>{statusLabel(fighter.status)}</span>
          {fighter.poolOnAgent ? <span>Pool {fighter.poolOnAgent}</span> : null}
          {fighter.highlight ? <span className="meta-win">Last round</span> : null}
        </p>
        <p className="tagline">{fighter.tagline}</p>
        {fighter.subline ? <p className="subline">{fighter.subline}</p> : null}
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
            <button className="btn solid" type="button" disabled={fighter.backDisabled} onClick={fighter.onBack}>
              {fighter.backLabel}
            </button>
            <button className="btn quiet" type="button" disabled={fighter.fundDisabled} onClick={fighter.onFund}>
              {fighter.fundLabel}
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function RoundChip({ row }: { row: HistoryView }) {
  const moves = row.moves
    .map((move, index) => `${CODES[index]} ${move === null || move === undefined ? "—" : MOVE_NAMES[move]}`)
    .join(" · ");
  const scores =
    row.scores && row.scores.some((score) => score !== null && score !== undefined) && !row.detail.includes("Scores")
      ? row.scores.map((score) => (score === null || score === undefined ? "—" : String(score))).join(" / ")
      : "";
  return (
    <article className="round-chip">
      {row.winnerId === null ? (
        <div className="thumb empty">—</div>
      ) : (
        <div className="thumb">
          <Image
            src={PORTRAITS[row.winnerId]}
            alt=""
            fill
            sizes="52px"
            style={{ ...COVER, objectPosition: "center top" }}
          />
        </div>
      )}
      <div className="chip-copy">
        <p className="chip-kicker">Round {row.id}</p>
        <p className="chip-title">{row.winnerName}</p>
        <p className="chip-detail">{row.detail || row.pool}</p>
        <p className="chip-moves">
          {row.pool}
          {moves ? ` · ${moves}` : ""}
          {scores ? ` · ${scores}` : ""}
        </p>
      </div>
    </article>
  );
}

function statusLabel(status: FighterView["status"]): string {
  if (status === "in") return "In round";
  if (status === "waiting") return "Waiting";
  return "Out";
}

function splitAmount(value: string): { num: string; unit: string } {
  const trimmed = value.trim();
  if (!trimmed) return { num: "—", unit: "" };
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2 && parts[parts.length - 1] === "NEAR") {
    return { num: parts.slice(0, -1).join(" "), unit: "NEAR" };
  }
  return { num: trimmed, unit: "" };
}

function tapeLines(history: HistoryView[]): string[] {
  const lines = history.map((row) => `Round ${row.id}  ·  ${row.winnerName}  ·  ${row.pool}`);
  const source = lines.length > 0 ? lines : ["Round open  ·  waiting on the first reveal"];
  const out = [...source];
  while (out.length < 8) out.push(...source);
  return out;
}

function repeatTo<T>(items: T[], min: number): T[] {
  if (items.length === 0 || items.length >= min) return items;
  const out = [...items];
  while (out.length < min) out.push(...items);
  return out;
}
