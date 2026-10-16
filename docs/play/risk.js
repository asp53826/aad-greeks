// The risk screen: every Greek on it comes off a tape.
//
// Vanillas go through the closed form on the tape (27 nodes for a call, the
// same count as the Python package). The digital goes through the Monte Carlo
// pricer on the tape, which is where pathwise AAD reports a delta of exactly
// zero for the sharp payoff. The desk's screen shows that zero unless the
// player switches the digital to call-spread smoothing.

import { blackScholesCall, blackScholesPut, grad, mcDigital } from "./engine.js";
import { MULT, R, YEAR, Sim, N_TICKS, normals } from "./sim.js";

export const PATHS = 16384;
let Z = null;
export const paths = (n = PATHS) => (Z && Z.length === n ? Z : (Z = normals(n)));

const pricerFor = (pos, digital, z) => {
  if (pos.type === "call") return (v) => blackScholesCall(v);
  if (pos.type === "put") return (v) => blackScholesPut(v);
  const h = digital.mode === "smooth" ? digital.h : 0;
  return (v) => mcDigital(v, z, h);
};

/** Price and first-order Greeks of one unit, from one reverse sweep. Gamma is
 *  a bump of the adjoint (two more sweeps): the repo does not claim second
 *  order from a single sweep, so neither does the game. */
export function unitRisk(pos, S, sigma, k, digital = { mode: "sharp", h: 1 }, z = paths()) {
  const ticksLeft = pos.expiry - k;
  if (ticksLeft <= 0) return null;
  const p = { S, K: pos.K, r: R, sigma, T: ticksLeft / YEAR };
  const f = pricerFor(pos, digital, z);
  const [price, g, tape, outIdx, adj] = grad(f, p);
  const hS = 0.005 * S;
  const [, gu] = grad(f, { ...p, S: S + hS });
  const [, gd] = grad(f, { ...p, S: S - hS });
  return {
    price, delta: g.S, vega: g.sigma, rho: g.r, dT: g.T, dK: g.K,
    gamma: (gu.S - gd.S) / (2 * hS),
    tape, outIdx, adj, sweeps: 3,
  };
}

/** Risk for the whole book in shares and dollars. */
export function bookRisk(sim, digital, z = paths()) {
  const rows = [];
  let delta = sim.shares, gamma = 0, vega = 0, theta = 0, sweeps = 0, nodes = 0;
  for (const pos of sim.live()) {
    const u = unitRisk(pos, sim.S, sim.iv, sim.k, digital, z);
    if (!u) continue;
    const n = pos.qty * pos.mult;
    const row = {
      pos, unit: u,
      delta: n * u.delta + 0,           // shares (+0 so a zero never prints as -0)
      gamma: n * u.gamma,               // shares per $1 move
      vega: (n * u.vega) / 100,         // $ per vol point
      theta: (-n * u.dT) / 252,         // $ per day
      value: n * u.price,
    };
    rows.push(row);
    delta += row.delta; gamma += row.gamma; vega += row.vega; theta += row.theta;
    sweeps += u.sweeps; nodes += u.tape.length;
  }
  return { rows, delta, gamma, vega, theta, sweeps, nodes, greeks: rows.length * 5 };
}

/** Central differences on every input of one position: 2n+1 = 11 pricings.
 *  The player's audit tool, and the repo's baseline. */
export function bumpCheck(pos, S, sigma, k, digital, z = paths()) {
  const ticksLeft = pos.expiry - k;
  if (ticksLeft <= 0) return null;
  const p = { S, K: pos.K, r: R, sigma, T: ticksLeft / YEAR };
  const f = pricerFor(pos, { mode: "sharp", h: 0 }, z);
  const val = (q) => Number(f(q));
  const bumps = { S: 0.5, K: 0.5, r: 1e-4, sigma: 1e-3, T: 1 / YEAR / 4 };
  const fd = {};
  let pricings = 1;
  val(p);
  for (const [key, h] of Object.entries(bumps)) {
    fd[key] = (val({ ...p, [key]: p[key] + h }) - val({ ...p, [key]: p[key] - h })) / (2 * h);
    pricings += 2;
  }
  const [, aad] = grad(pricerFor(pos, digital, z), p);
  return { fd, aad, pricings };
}

// ---------------------------------------------------------------------------
// bots: the same market, three ways of trusting the screen
// ---------------------------------------------------------------------------

export const BOTS = [
  { id: "idle", name: "Did nothing", blurb: "Sold the book, went to lunch." },
  { id: "aad", name: "Trusted the tape", blurb: "Delta-hedged every tick with pathwise AAD, digital and all." },
  { id: "smooth", name: "Smoothed the digital", blurb: "Same hedger, call-spread h = 1 on the digital." },
];

export function runBot(seed, botId, market = null, z = paths(4096)) {
  const sim = new Sim(seed, market);
  const digital = botId === "smooth" ? { mode: "smooth", h: 1 } : { mode: "sharp", h: 0 };
  for (let k = 0; k <= N_TICKS; k++) {
    if (botId !== "idle" && !sim.done) {
      const risk = bookRisk(sim, digital, z);
      if (Math.abs(risk.delta) > 250) sim.trade(-risk.delta);
    }
    for (const q of sim.activeRfqs()) sim.answer(q.id, "pass");
    if (k < N_TICKS) sim.step();
  }
  return sim;
}

export { MULT };
