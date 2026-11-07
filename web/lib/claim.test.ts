import assert from "node:assert/strict";
import test from "node:test";
import { claimErrorText, claimPresentation } from "./claim.ts";

const payout = 2n * 10n ** 24n;

test("claim stays quiet until there is something the wallet can pay", () => {
  const connect = claimPresentation({
    accountConnected: false,
    previousRoundId: 80,
    bet: undefined,
    pending: false,
  });
  assert.equal(connect.action, "connect");
  assert.equal(connect.enabled, true);
  assert.match(connect.note, /Connect a wallet/);

  const checking = claimPresentation({
    accountConnected: true,
    previousRoundId: 80,
    bet: undefined,
    pending: false,
  });
  assert.equal(checking.enabled, false);
  assert.match(checking.note, /Checking round 80/);

  const missing = claimPresentation({
    accountConnected: true,
    previousRoundId: 80,
    currentRoundId: 81,
    bet: null,
    pending: false,
  });
  assert.equal(missing.action, "none");
  assert.match(missing.note, /No bet on round 80/);
  assert.match(missing.note, /Round 81 is still open/);

  const empty = claimPresentation({
    accountConnected: true,
    previousRoundId: 80,
    bet: { settled: true, claimed: false, payoutYocto: 0n },
    pending: false,
  });
  assert.equal(empty.enabled, false);
  assert.match(empty.note, /nothing to claim/);

  const done = claimPresentation({
    accountConnected: true,
    previousRoundId: 80,
    bet: { settled: true, claimed: true, payoutYocto: payout },
    pending: false,
  });
  assert.match(done.note, /already claimed/);
  assert.equal(done.enabled, false);
});

test("a payable round opens the wallet and a pending claim stays visible", () => {
  const ready = claimPresentation({
    accountConnected: true,
    previousRoundId: 80,
    bet: { settled: true, claimed: false, payoutYocto: payout },
    pending: false,
  });
  assert.equal(ready.action, "claim");
  assert.equal(ready.enabled, true);
  assert.equal(ready.payoutYocto, payout);
  assert.match(ready.note, /wallet has to approve/);

  const pending = claimPresentation({
    accountConnected: true,
    previousRoundId: 80,
    bet: { settled: true, claimed: false, payoutYocto: payout },
    pending: true,
    waitNote: "Still waiting for the wallet. Approve the claim there if it opened.",
  });
  assert.equal(pending.enabled, false);
  assert.equal(pending.label, "Opening wallet…");
  assert.match(pending.note, /Still waiting/);
});

test("wallet panics become a short claim error", () => {
  assert.equal(claimErrorText(new Error("no bet")), "No bet on that round to claim.");
  assert.equal(claimErrorText(new Error("nothing to claim")), "That round has nothing to claim.");
  assert.equal(claimErrorText(new Error("User rejected the transaction")), "The wallet request was declined.");
  assert.equal(claimErrorText("already claimed"), "That round is already claimed.");
});
