import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";

delete process.env.NEAR_AI_API_KEY;
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Near } from "near-api-js";
import type { Chain } from "./chain.js";
import { RevealStore } from "./state.js";
import { tick } from "./tick.js";
import type { Arena, SettledRound } from "./types.js";

function settled(id: number, winner: number | null, move: number | null): SettledRound {
  return {
    id,
    winner,
    refund: false,
    pool: "0",
    fee: "0",
    distributable: "0",
    winner_stake: "0",
    moves: winner === null ? [null, null, null] : [move, move === 0 ? 1 : 0, 2],
    reasonings: [null, null, null],
    matchups: [null, null, null],
    entropies: [null, null, null],
    scores: [null, null, null],
    seed_hex: "00",
    upkeep_charged: ["0", "0", "0"],
    settled_at_ns: "0",
  };
}

interface Fake {
  phase: string;
  committed: boolean[];
  commitmentHex: (string | null)[];
  moves: (number | null)[];
  settleBegun: boolean;
  calls: string[];
  revealErrors: number;
}

function arenaOf(fake: Fake, history: SettledRound[]): Arena {
  const revealOpen = fake.phase === "reveal";
  const windowOver = fake.phase === "settle";
  const everyCommitRevealed = [0, 1, 2].every((i) => !fake.committed[i] || fake.moves[i] !== null);
  return {
    version: "0.2.0",
    owner_id: "owner.testnet",
    now_ns: "0",
    protocol_treasury: "0",
    agents: [0, 1, 2].map((id) => ({
      id,
      name: ["Momentum", "Mean-Reversion", "Breakout"][id],
      account_id: `agent${id}.testnet`,
      treasury: "1000",
      retired: false,
      wins: 0,
      rounds_fought: 0,
      upkeep_paid: "0",
      alive_this_round: true,
    })),
    current: {
      id: 75,
      phase: fake.phase,
      ready_to_settle: (windowOver || (revealOpen && everyCommitRevealed)) && !fake.settleBegun,
      ready_to_finalize: fake.phase === "finalize",
      settle_begun: fake.settleBegun,
      settle_height: fake.settleBegun ? "10" : null,
      block_height: fake.phase === "finalize" ? "11" : "10",
      betting_end_ns: "1",
      reveal_end_ns: "2",
      pool: "0",
      backed: ["0", "0", "0"],
      alive: [true, true, true],
      committed: fake.committed,
      commitment_hex: fake.commitmentHex,
      moves: fake.moves,
      reasonings: [null, null, null],
    },
    recent_rounds: history,
  };
}

function chainFor(fake: Fake, history: SettledRound[], onCommit?: () => void): Chain {
  return {
    near: {} as Near,
    async viewArena() {
      return arenaOf(fake, history);
    },
    async viewRecentRounds() {
      return history;
    },
    async callAs(signer, method, args) {
      fake.calls.push(method);
      const agentId = Number(signer.accountId.match(/agent(\d)/)?.[1] ?? "0");
      if (method === "commit") {
        if (fake.phase !== "betting") {
          throw new Error("Smart contract panicked: commit during betting only");
        }
        fake.committed[agentId] = true;
        fake.commitmentHex[agentId] = String(args.commitment_hex);
        onCommit?.();
      }
      if (method === "reveal") {
        if (fake.revealErrors > 0) {
          fake.revealErrors -= 1;
          throw new Error("read ETIMEDOUT");
        }
        if (fake.phase !== "reveal" && fake.phase !== "settle") {
          throw new Error("Smart contract panicked: reveal during the reveal window");
        }
        fake.moves[agentId] = Number(args.move_id);
      }
      if (method === "begin_settle") {
        fake.settleBegun = true;
        fake.phase = "finalize";
      }
    },
  };
}

const signers = [0, 1, 2].map((id) => ({ accountId: `agent${id}.testnet`, privateKey: "ed25519:key" }));

test("reasoning uses an older winner when the newest rounds have none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-tick-"));
  const history = [settled(74, null, null), settled(73, null, null), settled(71, 0, 0)];
  const fake: Fake = {
    phase: "betting",
    committed: [false, false, false],
    commitmentHex: [null, null, null],
    moves: [null, null, null],
    settleBegun: false,
    calls: [],
    revealErrors: 0,
  };
  const code = await tick(chainFor(fake, history), {
    agents: signers,
    settler: signers[0],
    stateDir: dir,
  });
  assert.equal(code, 0);
  assert.deepEqual(fake.calls, ["commit", "commit", "commit"]);
  const store = new RevealStore(dir);
  const momentum = store.get(75, 0);
  assert.ok(momentum);
  assert.match(momentum.reasoning, /Round 71/);
  assert.doesNotMatch(momentum.reasoning, /No winner in recent rounds/);
  assert.equal(momentum.move, 0);
});

test("a commit that slips past betting still reveals before settle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-tick-"));
  const fake: Fake = {
    phase: "betting",
    committed: [false, false, false],
    commitmentHex: [null, null, null],
    moves: [null, null, null],
    settleBegun: false,
    calls: [],
    revealErrors: 0,
  };
  const code = await tick(
    chainFor(fake, [settled(70, null, null), settled(69, 0, 0)], () => {
      fake.phase = "reveal";
    }),
    { agents: signers, settler: signers[0], stateDir: dir },
  );
  assert.equal(code, 1);
  assert.equal(fake.calls[0], "commit");
  assert.ok(fake.calls.includes("reveal"));
  assert.ok(fake.calls.indexOf("reveal") < fake.calls.indexOf("begin_settle"));
  assert.equal(fake.calls.at(-1), "begin_settle");
  assert.equal(fake.moves[0], 0);
});

test("a timed-out reveal is retried inside the window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-tick-"));
  const store = new RevealStore(dir);
  for (let agentId = 0; agentId < 3; agentId += 1) {
    store.save(75, agentId, {
      move: agentId,
      saltHex: "ab".repeat(32),
      reasoning: "held",
      commitmentHex: "cd".repeat(32),
    });
  }
  const fake: Fake = {
    phase: "reveal",
    committed: [true, true, true],
    commitmentHex: ["cd".repeat(32), "cd".repeat(32), "cd".repeat(32)],
    moves: [null, null, null],
    settleBegun: false,
    calls: [],
    revealErrors: 1,
  };
  const code = await tick(chainFor(fake, []), {
    agents: signers,
    settler: signers[0],
    stateDir: dir,
  });
  assert.equal(code, 0);
  const reveals = fake.calls.filter((name) => name === "reveal");
  assert.equal(reveals.length, 4);
  assert.equal(fake.calls.at(-1), "begin_settle");
  assert.deepEqual(fake.moves, [0, 1, 2]);
});
