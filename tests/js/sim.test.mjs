// The guarantees the leaderboard leans on: a run is (seed, action log), the
// replay reproduces it to the cent, and illegal actions can't buy a score.

import assert from "node:assert/strict";
import test from "node:test";

import { bookRisk, paths, runBot } from "../../docs/play/risk.js";
import { EDGE, N_TICKS, RFQ_WINDOW, Sim, makeMarket, replay } from "../../docs/play/sim.js";

test("the same seed generates the same market, a different one does not", () => {
  const a = makeMarket("2026-10-16"), b = makeMarket("2026-10-16"), c = makeMarket("2026-10-17");
  assert.deepEqual(Array.from(a.S), Array.from(b.S));
  assert.deepEqual(a.rfqs, b.rfqs);
  assert.notDeepEqual(Array.from(a.S), Array.from(c.S));
});

test("a game starts at zero P&L: the book is sold at its own mark", () => {
  assert.ok(Math.abs(new Sim("x").equity()) < 1e-6);
});

test("replay reproduces a played game exactly, trades and quotes included", () => {
  const live = new Sim("replay-me");
  for (let k = 0; k <= N_TICKS; k++) {
    if (k % 3 === 0) live.trade(k % 2 ? 700 : -450);
    for (const q of live.activeRfqs()) live.answer(q.id, q.id % 2 ? "tight" : "wide");
    if (k < N_TICKS) live.step();
  }
  const again = replay("replay-me", live.log);
  assert.equal(again.equity(), live.equity());
  assert.deepEqual(again.pnl, live.pnl);
});

test("P&L attribution adds up to equity", () => {
  const sim = runBot("attr", "smooth");
  const parts = Object.values(sim.attribution()).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(parts - sim.equity()) < 1e-6, `${parts} vs ${sim.equity()}`);
});

test("a forged log can't answer a client outside the quote window or twice", () => {
  const m = makeMarket("forge");
  const q = m.rfqs[0];
  const early = replay("forge", [[q.tick - 1, "Q", q.id, "tight"]], m);
  assert.equal(early.rfq[q.id].choice, "missed");
  const late = replay("forge", [[q.tick + RFQ_WINDOW, "Q", q.id, "tight"]], m);
  assert.equal(late.rfq[q.id].choice, "missed");
  const twice = replay("forge", [[q.tick, "Q", q.id, "pass"], [q.tick, "Q", q.id, "tight"]], m);
  assert.equal(twice.rfq[q.id].choice, "pass");
  assert.ok(!("bogus" in EDGE));
  const bogus = replay("forge", [[q.tick, "Q", q.id, "bogus"]], m);
  assert.equal(bogus.rfq[q.id].choice, "missed");
});

test("junk in a log is ignored, not executed", () => {
  const clean = replay("junk", []).equity();
  const dirty = replay("junk", [null, "x", [1.5, "B", 10], [3, "B", "NaN"], [4, "B", 5e9], [5, "Z", 1]]).equity();
  assert.equal(dirty, clean);
});

test("the risk screen's digital delta is zero until the player smooths it", () => {
  const sim = new Sim("digital");
  const sharp = bookRisk(sim, { mode: "sharp", h: 1 }, paths(4096));
  const smooth = bookRisk(sim, { mode: "smooth", h: 1 }, paths(4096));
  const dig = (r) => r.rows.find((x) => x.pos.type === "digital");
  assert.equal(dig(sharp).delta, 0);
  assert.ok(dig(smooth).delta < -100, `short digital should be short delta, got ${dig(smooth).delta}`);
});

test("bots are deterministic, so the end screen's comparison is reproducible", () => {
  assert.equal(runBot("bots", "aad").equity(), runBot("bots", "aad").equity());
});
