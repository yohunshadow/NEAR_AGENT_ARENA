import { commitmentHex, randomSalt } from "./hash.js";
import { chooseMove } from "./llm.js";
import { AGENT_NAMES, MOVE_NAMES } from "./rules.js";
import { RevealStore } from "./state.js";
import type { Chain } from "./chain.js";
import type { Arena, SettledRound, SignerConfig } from "./types.js";

export interface TickConfig {
  agents: SignerConfig[];
  settler: SignerConfig;
  stateDir: string;
}

function lastWinnerMove(arena: Arena): number | null {
  const last: SettledRound | undefined = arena.recent_rounds[0];
  if (!last || last.winner === null || last.winner === undefined) return null;
  return last.moves[last.winner] ?? null;
}

function contextFor(arena: Arena, agentId: number): string {
  const agent = arena.agents[agentId];
  const last = arena.recent_rounds[0];
  return JSON.stringify({
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
    last_round: last
      ? {
          winner: last.winner,
          moves: last.moves,
          scores: last.scores,
          reasonings: last.reasonings,
        }
      : null,
  });
}

export async function tick(chain: Chain, config: TickConfig): Promise<number> {
  const store = new RevealStore(config.stateDir);
  const arena = await chain.viewArena();
  const roundId = arena.current.id;
  let failures = 0;
  console.log(
    `round ${roundId} phase=${arena.current.phase} ready_to_settle=${arena.current.ready_to_settle} pool=${arena.current.pool}`,
  );

  if (arena.current.phase === "betting") {
    for (let agentId = 0; agentId < 3; agentId += 1) {
      if (!arena.current.alive[agentId]) {
        console.log(`agent ${agentId} is not in this round`);
        continue;
      }
      if (arena.current.committed[agentId]) {
        console.log(`agent ${agentId} already committed`);
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
          lastWinnerMove: lastWinnerMove(arena),
          context: contextFor(arena, agentId),
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
        console.log(
          `agent ${agentId} ${source} chose ${MOVE_NAMES[choice.move]}: ${choice.reasoning}`,
        );
      }
      try {
        await chain.callAs(config.agents[agentId], "commit", {
          round_id: String(roundId),
          commitment_hex: commitment,
        });
        console.log(`agent ${agentId} committed ${commitment}`);
      } catch (error) {
        failures += 1;
        console.error(`agent ${agentId} commit failed: ${String(error)}`);
      }
    }
  }

  if (arena.current.phase === "reveal") {
    for (let agentId = 0; agentId < 3; agentId += 1) {
      if (!arena.current.committed[agentId] || arena.current.moves[agentId] !== null) continue;
      const pending = store.get(roundId, agentId);
      if (!pending) {
        failures += 1;
        console.error(`agent ${agentId} has no saved preimage for round ${roundId}`);
        continue;
      }
      try {
        await chain.callAs(config.agents[agentId], "reveal", {
          round_id: String(roundId),
          move_id: pending.move,
          salt_hex: pending.saltHex,
          reasoning: pending.reasoning,
        });
        console.log(`agent ${agentId} revealed ${MOVE_NAMES[pending.move]}`);
      } catch (error) {
        failures += 1;
        console.error(`agent ${agentId} reveal failed: ${String(error)}`);
      }
    }
  }

  const fresh = await chain.viewArena();
  if (fresh.current.ready_to_settle) {
    try {
      await chain.callAs(config.settler, "settle", {});
      const after = await chain.viewArena();
      const settled = after.recent_rounds[0];
      console.log(
        `settled round ${settled?.id} winner=${settled?.winner ?? "none"} next=${after.current.id}`,
      );
    } catch (error) {
      failures += 1;
      console.error(`settle failed: ${String(error)}`);
    }
  } else {
    console.log("not ready to settle");
  }
  return failures === 0 ? 0 : 1;
}
