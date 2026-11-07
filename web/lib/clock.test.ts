import assert from "node:assert/strict";
import test from "node:test";
import { formatClock, preferSnapshot, presentedClock } from "./clock.ts";

const SECOND = 1_000_000_000n;

test("betting ending on the same round opens the reveal clock instead of sticking at 0:00", () => {
  const bettingEnd = 1_200n * SECOND;
  const revealEnd = bettingEnd + 600n * SECOND;
  const fetchedAtMs = 1_000_000;
  const base = {
    phase: "betting",
    bettingEndNs: bettingEnd,
    revealEndNs: revealEnd,
    nowNs: bettingEnd - 30n * SECOND,
    fetchedAtMs,
  };
  const before = presentedClock({ ...base, nowMs: fetchedAtMs });
  assert.equal(before.phase, "betting");
  assert.equal(before.caption, "Left in betting");
  assert.equal(formatClock(before.remainingMs), "0:30");

  const crossed = presentedClock({ ...base, nowMs: fetchedAtMs + 33_000 });
  assert.equal(crossed.phase, "reveal");
  assert.equal(crossed.caption, "Left in reveal");
  assert.equal(crossed.remainingMs, 597_000);
  assert.equal(formatClock(crossed.remainingMs), "9:57");
});

test("a chain phase that is already further along is not pulled backwards", () => {
  const bettingEnd = 1_200n * SECOND;
  const shown = presentedClock({
    phase: "reveal",
    bettingEndNs: bettingEnd,
    revealEndNs: bettingEnd + 600n * SECOND,
    nowNs: bettingEnd - 30n * SECOND,
    fetchedAtMs: 0,
    nowMs: 0,
  });
  assert.equal(shown.phase, "reveal");
  assert.equal(shown.caption, "Left in reveal");
});

test("after the reveal window the clock waits for settle", () => {
  const revealEnd = 1_800n * SECOND;
  const shown = presentedClock({
    phase: "reveal",
    bettingEndNs: 1_200n * SECOND,
    revealEndNs: revealEnd,
    nowNs: revealEnd,
    fetchedAtMs: 0,
    nowMs: 1_000,
  });
  assert.equal(shown.phase, "settling");
  assert.equal(shown.caption, "Waiting for settle");
  assert.equal(shown.remainingMs, 0);
});

test("a late view cannot rewind the round clock", () => {
  const current = { nowNs: 500n, roundId: 81 };
  assert.equal(preferSnapshot(current, { nowNs: 100n, roundId: 81 }), false);
  assert.equal(preferSnapshot(current, { nowNs: 100n, roundId: 80 }), false);
  assert.equal(preferSnapshot(current, { nowNs: 500n, roundId: 81 }), true);
  assert.equal(preferSnapshot(current, { nowNs: 900n, roundId: 81 }), true);
  assert.equal(preferSnapshot(current, { nowNs: 50n, roundId: 82 }), true);
  assert.equal(preferSnapshot(null, current), true);
});
