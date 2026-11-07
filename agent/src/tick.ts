import { commitmentHex, randomSalt } from "./hash.js";
import { chooseMove } from "./llm.js";
import { AGENT_NAMES, historyFacts, MOVE_NAMES, type HistoryRound } from "./rules.js";
import { RevealStore } from "./state.js";
import type { Chain } from "./chain.js";
import type { Arena, SettledRound, SignerConfig } from "./types.js";

export interface TickConfig {
  agents: SignerConfig[];
  settler: SignerConfig;
  stateDir: string;
}

const REVEAL_PASSES = 2;

export function historyFrom(rounds: SettledRound[]): HistoryRound[] {
  return rounds.map((round) => ({
    id: round.id,
    winner: round.winner,
    moves: round.moves,
  }));
}

export function commitmentMatches(localHex: string, chainHex: string | null | undefined): boolean {
  if (!chainHex) return false;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/^0x/, "");
  return normalize(localHex) === normalize(chainHex);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commitFailure(error: unknown): "already" | "closed" | "other" {
  const text = errorText(error);
  if (text.includes("already committed")) return "already";
  if (text.includes("commit during betting only") || text.includes("betting is closed")) return "closed";
  return "other";
}

function revealFailure(error: unknown): "done" | "closed" | "mismatch" | "retry" {
  const text = errorText(error);
  if (text.includes("already revealed") || text.includes("settle already begun")) return "done";
  if (text.includes("reveal during the reveal window")) return "closed";
  if (text.includes("commitment mismatch") || text.includes("nothing to reveal")) return "mismatch";
  return "retry";
}

function moveLabel(move: number | null): string | null {
  if (move !== 0 && move !== 1 && move !== 2) return null;
  return MOVE_NAMES[move];
}

function contextFor(arena: Arena, agentId: number, history: HistoryRound[]): string {
  const agent = arena.agents[agentId];
  const facts = historyFacts({ agentId, roundId: arena.current.id, history });
  return JSON.stringify({
    facts,
    round_id: arena.current.id,
    phase: arena.current.phase,
    your_id: agentId,
    your_name: agent?.name ?? AGENT_NAMES[agentId],
    your_treasury_yocto: agent?.treasury,
    your_wins: agent?.wins,
    alive: arena.current.alive,
    treasuries: arena.agents.map((item) => ({
      id: item.id,
      name: item.name,
      treasury: item.treasury,
      retired: item.retired,
      wins: item.wins,
    })),
    recent_rounds: history.slice(0, 8).map((round) => ({
      id: round.id,
      winner: round.winner === null || round.winner === undefined ? null : (AGENT_NAMES[round.winner] ?? round.winner),
      no_winner: round.winner === null || round.winner === undefined,
      moves: {
        Momentum: moveLabel(round.moves[0] ?? null),
        MeanReversion: moveLabel(round.moves[1] ?? null),
        Breakout: moveLabel(round.moves[2] ?? null),
      },
    })),
  });
}

export async function tick(chain: Chain, config: TickConfig): Promise<number> {
  const store = new RevealStore(config.stateDir);
  let arena = await chain.viewArena();
  let history = historyFrom(arena.recent_rounds);
  try {
    const recent = await chain.viewRecentRounds(20);
    if (recent.length > 0) history = historyFrom(recent);
  } catch (error) {
    console.error(`get_recent_rounds failed (${errorText(error)}); using the rounds on get_arena`);
  }
  let failures = 0;
  const roundId = arena.current.id;
  console.log(
    `round ${roundId} phase=${arena.current.phase} ready_to_settle=${arena.current.ready_to_settle} ready_to_finalize=${arena.current.ready_to_finalize} pool=${arena.current.pool}`,
  );

  if (arena.current.phase === "betting") {
    const closedEarly = await commitAlive(chain, config, store, arena, history);
    failures += closedEarly.failures;
    arena = await chain.viewArena();
  }

  // A commit that blocks on RPC can still be in betting when the tick starts
  // and in reveal (or already settle) when it returns. Reveal before settle,
  // and retry while the reveal window is open.
  if (arena.current.phase === "reveal" || arena.current.phase === "settle") {
    const revealed = await revealReady(chain, config, store, arena);
    failures += revealed.failures;
    arena = revealed.arena;
  }

  try {
    arena = await chain.viewArena();
    if (arena.current.ready_to_finalize) {
      await chain.callAs(config.settler, "finalize_settle", {});
      const after = await chain.viewArena();
      const settled = after.recent_rounds[0];
      console.log(
        `finalized round ${settled?.id} winner=${settled?.winner ?? "none"} next=${after.current.id}`,
      );
    } else if (arena.current.phase === "reveal" && unrevealed(arena, store, false).ready.length > 0) {
      console.log("reveal window still open; not settling until the saved preimages are in");
      failures += 1;
    } else if (arena.current.ready_to_settle) {
      await chain.callAs(config.settler, "begin_settle", {});
      console.log(`began settle for round ${arena.current.id}; finalize on a later block`);
    } else {
      console.log("not ready to settle");
    }
  } catch (error) {
    const kind = revealFailure(error);
    if (kind === "done" || errorText(error).includes("settle already begun")) {
      console.log("settle step already done");
    } else {
      failures += 1;
      console.error(`settle step failed: ${errorText(error)}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

async function commitAlive(
  chain: Chain,
  config: TickConfig,
  store: RevealStore,
  arena: Arena,
  history: HistoryRound[],
): Promise<{ failures: number }> {
  let failures = 0;
  const roundId = arena.current.id;
  for (let agentId = 0; agentId < 3; agentId += 1) {
    if (!arena.current.alive[agentId]) {
      console.log(`agent ${agentId} is not in this round`);
      continue;
    }
    if (arena.current.committed[agentId]) {
      noteCommitment(store, arena, agentId);
      continue;
    }
    const existing = store.get(roundId, agentId);
    let commitment = existing?.commitmentHex;
    if (!existing) {
      const agentName = arena.agents[agentId]?.name ?? AGENT_NAMES[agentId];
      const { choice, source } = await chooseMove({
        agentId,
        agentName,
        roundId,
        history,
        context: contextFor(arena, agentId, history),
      });
      const salt = randomSalt();
      const saltHex = Buffer.from(salt).toString("hex");
      commitment = commitmentHex(choice.move, salt, choice.reasoning);
      store.save(roundId, agentId, {
        move: choice.move,
        saltHex,
        reasoning: choice.reasoning,
        commitmentHex: commitment,
      });
      console.log(`agent ${agentId} ${source} chose ${MOVE_NAMES[choice.move]}: ${choice.reasoning}`);
    }
    try {
      await chain.callAs(config.agents[agentId], "commit", {
        round_id: String(roundId),
        commitment_hex: commitment,
      });
      console.log(`agent ${agentId} committed ${commitment}`);
    } catch (error) {
      const kind = commitFailure(error);
      if (kind === "closed") {
        console.error(`agent ${agentId} commit missed the betting window; revealing whoever got in`);
        failures += 1;
        break;
      }
      if (kind === "already") {
        const fresh = await chain.viewArena();
        const chainHex = fresh.current.commitment_hex[agentId];
        const pending = store.get(roundId, agentId);
        if (pending && commitmentMatches(pending.commitmentHex, chainHex)) {
          console.log(`agent ${agentId} commitment already on chain`);
        } else if (chainHex) {
          console.error(
            `agent ${agentId} on-chain commitment does not match this worker's preimage; it cannot reveal`,
          );
          store.forget(roundId, agentId);
          failures += 1;
        } else {
          console.log(`agent ${agentId} commit landed; the view has not caught up`);
        }
        continue;
      }
      failures += 1;
      console.error(`agent ${agentId} commit failed: ${errorText(error)}`);
    }
  }
  return { failures };
}

function noteCommitment(store: RevealStore, arena: Arena, agentId: number): void {
  const pending = store.get(arena.current.id, agentId);
  const chainHex = arena.current.commitment_hex[agentId];
  if (pending && chainHex && !commitmentMatches(pending.commitmentHex, chainHex)) {
    console.error(
      `agent ${agentId} saved preimage does not match the on-chain commitment; dropping it`,
    );
    store.forget(arena.current.id, agentId);
    return;
  }
  console.log(`agent ${agentId} already committed`);
}

function unrevealed(
  arena: Arena,
  store: RevealStore,
  report = true,
): { ready: number[]; missing: number } {
  const ready: number[] = [];
  let missing = 0;
  for (let agentId = 0; agentId < 3; agentId += 1) {
    if (!arena.current.alive[agentId] || !arena.current.committed[agentId]) continue;
    if (arena.current.moves[agentId] !== null && arena.current.moves[agentId] !== undefined) continue;
    const pending = store.get(arena.current.id, agentId);
    if (!pending) {
      missing += 1;
      if (report) console.error(`agent ${agentId} has no saved preimage for round ${arena.current.id}`);
      continue;
    }
    const chainHex = arena.current.commitment_hex[agentId];
    if (chainHex && !commitmentMatches(pending.commitmentHex, chainHex)) {
      if (report) {
        console.error(`agent ${agentId} saved preimage does not match the on-chain commitment; skipping reveal`);
      }
      store.forget(arena.current.id, agentId);
      missing += 1;
      continue;
    }
    ready.push(agentId);
  }
  return { ready, missing };
}

async function revealReady(
  chain: Chain,
  config: TickConfig,
  store: RevealStore,
  arena: Arena,
): Promise<{ arena: Arena; failures: number }> {
  let current = arena;
  let failures = 0;
  let unresolved = false;
  let closed = false;
  let countedMissing = false;
  for (let pass = 0; pass < REVEAL_PASSES; pass += 1) {
    if (current.current.phase !== "reveal" && current.current.phase !== "settle") break;
    const pending = unrevealed(current, store);
    if (!countedMissing) {
      failures += pending.missing;
      countedMissing = true;
    }
    if (pending.ready.length === 0) break;
    unresolved = false;
    closed = false;
    for (const agentId of pending.ready) {
      const saved = store.get(current.current.id, agentId);
      if (!saved) continue;
      try {
        await chain.callAs(config.agents[agentId], "reveal", {
          round_id: String(current.current.id),
          move_id: saved.move,
          salt_hex: saved.saltHex,
          reasoning: saved.reasoning,
        });
        console.log(`agent ${agentId} revealed ${MOVE_NAMES[saved.move]}`);
      } catch (error) {
        const kind = revealFailure(error);
        if (kind === "done") {
          console.log(`agent ${agentId} already revealed`);
          continue;
        }
        if (kind === "closed") {
          console.error(`agent ${agentId} reveal missed the window`);
          closed = true;
          break;
        }
        if (kind === "mismatch") {
          console.error(`agent ${agentId} reveal rejected: ${errorText(error)}`);
          store.forget(current.current.id, agentId);
          failures += 1;
          continue;
        }
        console.error(`agent ${agentId} reveal failed: ${errorText(error)}`);
        unresolved = true;
      }
    }
    current = await chain.viewArena();
    if (closed || !unresolved || current.current.phase !== "reveal") break;
    console.log(`retrying reveals for round ${current.current.id} while the window is open`);
  }
  if (unresolved || closed) failures += 1;
  return { arena: current, failures };
}
