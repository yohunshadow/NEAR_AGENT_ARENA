import assert from "node:assert/strict";
import test from "node:test";
import { commitmentHex } from "./hash.js";
import { parseModelChoice } from "./llm.js";
import { decide, offlineChoice } from "./rules.js";

test("commitment preimage matches the contract vector", () => {
  const salt = new Uint8Array(32).fill(0x11);
  assert.equal(
    commitmentHex(0, salt, "hold"),
    "16594f519d35ce091c78f92496d035a657d018a79b21e03f5a053a71a33a82d7",
  );
});

test("equal scores break toward the lowest agent id", () => {
  const decision = decide([1, 1, 1], new Uint8Array(32));
  assert.deepEqual(decision.scores, [512, 512, 512]);
  assert.equal(decision.winner, 0);
});

test("a matchup lead beats maximum entropy", () => {
  const seed = new Uint8Array(32);
  seed[0] = 255;
  seed[1] = 255;
  const decision = decide([0, 0, 1], seed);
  assert.equal(decision.winner, 2);
  assert.deepEqual(decision.matchups, [1, 1, 4]);
});

test("offline strategies are stable personalities", () => {
  assert.equal(offlineChoice({ agentId: 0, roundId: 3, history: [] }).move, 0);
  assert.equal(
    offlineChoice({ agentId: 1, roundId: 3, history: [{ id: 2, winner: 0, moves: [0, 1, 2] }] }).move,
    1,
  );
  assert.equal(
    offlineChoice({ agentId: 2, roundId: 3, history: [{ id: 2, winner: 0, moves: [0, 1, 2] }] }).move,
    2,
  );
  const again = offlineChoice({
    agentId: 1,
    roundId: 9,
    history: [{ id: 8, winner: 2, moves: [0, 1, 2] }],
  });
  assert.equal(again.move, 0);
  assert.match(again.reasoning, /Mean-Reversion/);
  assert.match(again.reasoning, /Round 8/);
});

test("offline strategy keeps the last real winner across no-winner rounds", () => {
  const history = [
    { id: 74, winner: null, moves: [null, null, null] },
    { id: 73, winner: null, moves: [null, null, null] },
    { id: 71, winner: 0, moves: [0, 1, 2] },
  ];
  const momentum = offlineChoice({ agentId: 0, roundId: 75, history });
  assert.equal(momentum.move, 0);
  assert.match(momentum.reasoning, /Round 71/);
  assert.doesNotMatch(momentum.reasoning, /No winner in recent rounds/);
  assert.match(momentum.reasoning, /2 newer rounds had no winner/);
  const opened = offlineChoice({ agentId: 2, roundId: 1, history: [] });
  assert.match(opened.reasoning, /No winner in recent rounds/);
  assert.match(opened.reasoning, /Defensive/);
});

test("model JSON is parsed and junk falls through", () => {
  assert.deepEqual(parseModelChoice('sure {"move":2,"reasoning":"shell up"} thanks'), {
    move: 2,
    reasoning: "shell up",
  });
  assert.equal(parseModelChoice("I like paper"), null);
  assert.equal(parseModelChoice('{"move":7,"reasoning":"no"}'), null);
});
