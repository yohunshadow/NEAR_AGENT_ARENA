import assert from "node:assert/strict";
import test from "node:test";
import { commitmentHex } from "./hash.js";
import { choiceFromMessage, parseModelChoice } from "./llm.js";
import { acceptModelChoice, decide, historyFacts, offlineChoice } from "./rules.js";

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

test("mean-reversion cannot call a counter the same move as the winner", () => {
  const history = [{ id: 87, winner: 0, moves: [0, 0, 2] }];
  const input = { agentId: 1, roundId: 88, history };
  const model = {
    move: 0,
    reasoning:
      "Momentum won the last round with Aggressive (0), so I will counter with Aggressive (0) to beat its previous move.",
  };
  const grounded = acceptModelChoice(input, model);
  assert.equal(grounded.move, 1);
  assert.match(grounded.reasoning, /Round 87/);
  assert.match(grounded.reasoning, /Balanced/);
  assert.doesNotMatch(grounded.reasoning, /counter with Aggressive|plays Aggressive/i);
});

test("a no-winner round is not a draw and does not erase the previous winner", () => {
  const history = [
    { id: 86, winner: null, moves: [null, null, null] },
    { id: 85, winner: 1, moves: [0, 0, 2] },
  ];
  const input = { agentId: 1, roundId: 87, history };
  const model = {
    move: 0,
    reasoning: "The last round was a draw. I will play Aggressive to break the stalemate and gain momentum.",
  };
  const grounded = acceptModelChoice(input, model);
  assert.equal(grounded.move, 1);
  assert.match(grounded.reasoning, /Round 85/);
  assert.match(grounded.reasoning, /1 newer round had no winner/);
  assert.doesNotMatch(grounded.reasoning, /draw|stalemate|No prior winner/i);
  assert.match(historyFacts(input), /Your previous revealed move: Aggressive in round 85/);
});

test("a faithful model line is kept, and a false prior move or winner is not", () => {
  const history = [{ id: 87, winner: 0, moves: [0, 1, 2] }];
  const input = { agentId: 1, roundId: 88, history };
  const faithful = {
    move: 1,
    reasoning: "Round 87 winner Momentum played Aggressive. Mean-Reversion plays Balanced to beat it.",
  };
  assert.equal(acceptModelChoice(input, faithful), faithful);
  const lied = acceptModelChoice(input, {
    move: 1,
    reasoning: "I played Defensive last time, so I play Balanced now.",
  });
  assert.match(lied.reasoning, /Round 87/);
  assert.doesNotMatch(lied.reasoning, /Defensive/);
  const invented = acceptModelChoice(
    { agentId: 1, roundId: 1, history: [] },
    { move: 1, reasoning: "Round 4 winner Momentum played Aggressive." },
  );
  assert.match(invented.reasoning, /No winner in recent rounds/);
  const opened = {
    move: 1,
    reasoning: "No winner in recent rounds before round 1. Mean-Reversion opens Balanced.",
  };
  assert.equal(acceptModelChoice({ agentId: 1, roundId: 1, history: [] }, opened), opened);
});

test("model JSON is parsed and junk falls through", () => {
  assert.deepEqual(parseModelChoice('sure {"move":2,"reasoning":"shell up"} thanks'), {
    move: 2,
    reasoning: "shell up",
  });
  assert.equal(parseModelChoice("I like paper"), null);
  assert.equal(parseModelChoice('{"move":7,"reasoning":"no"}'), null);
});

test("reasoning models can put the move beside an empty content field", () => {
  assert.deepEqual(
    choiceFromMessage({
      content: "",
      reasoning: 'thinking\n{"move":1,"reasoning":"fade the last line"}',
    }),
    { move: 1, reasoning: "fade the last line" },
  );
  assert.deepEqual(
    choiceFromMessage({
      content: null,
      reasoning_content: '{"move":0,"reasoning":"press"}',
    }),
    { move: 0, reasoning: "press" },
  );
  assert.equal(choiceFromMessage({ content: "", reasoning: "no json here" }), null);
  assert.deepEqual(choiceFromMessage({ content: '{"move":2,"reasoning":"shell"}', reasoning: "ignore" }), {
    move: 2,
    reasoning: "shell",
  });
});
