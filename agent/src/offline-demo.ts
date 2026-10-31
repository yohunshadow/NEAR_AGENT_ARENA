import { decide, MOVE_NAMES, offlineChoice, type Choice } from "./rules.js";

// A chain-free loop so `npm run demo:offline` shows the economy with no API key
// and no RPC. The score rule matches the contract. The seed here is a stand-in
// for env::random_seed(); on chain the settle block supplies the real seed.

const UPKEEP = 1_000_000n;
const FEE_BPS = 500n;
const START = 2_000_000n;

function demoSeed(roundId: number): Uint8Array {
  const seed = new Uint8Array(32);
  let x = (roundId + 1) * 0x9e3779b1;
  for (let i = 0; i < 32; i += 1) {
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    x ^= x >>> 16;
    seed[i] = x & 0xff;
  }
  return seed;
}

let treasuries = [START, START, START];
let retired = [false, false, false];
let lastWinnerMove: number | null = null;

for (let roundId = 0; roundId < 4; roundId += 1) {
  const alive = retired.map((flag) => !flag);
  const choices: (Choice | null)[] = [null, null, null];
  for (let agentId = 0; agentId < 3; agentId += 1) {
    if (!alive[agentId]) continue;
    choices[agentId] = offlineChoice({ agentId, roundId, lastWinnerMove });
  }
  const moves = choices.map((choice) => choice?.move ?? null);
  const decision = decide(moves, demoSeed(roundId));
  console.log(`\nround ${roundId}`);
  for (let agentId = 0; agentId < 3; agentId += 1) {
    const choice = choices[agentId];
    if (!choice) {
      console.log(`  agent ${agentId} retired`);
      continue;
    }
    console.log(
      `  agent ${agentId} ${MOVE_NAMES[choice.move]} (offline): ${choice.reasoning}`,
    );
  }
  console.log(
    `  scores=${decision.scores.join(",")} winner=${decision.winner ?? "none"}`,
  );
  if (decision.winner !== null) {
    const pool = 0n;
    const fee = (pool * FEE_BPS) / 10_000n;
    treasuries[decision.winner] += fee;
    lastWinnerMove = moves[decision.winner];
  }
  for (let agentId = 0; agentId < 3; agentId += 1) {
    if (!alive[agentId]) continue;
    const charged = treasuries[agentId] < UPKEEP ? treasuries[agentId] : UPKEEP;
    treasuries[agentId] -= charged;
    if (treasuries[agentId] === 0n) retired[agentId] = true;
  }
  console.log(
    `  treasuries=${treasuries.map(String).join(",")} retired=${retired.join(",")}`,
  );
}

console.log("\noffline demo finished (no RPC, no API key)");
