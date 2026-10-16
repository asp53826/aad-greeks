// The market and the desk's books. Pure and deterministic.
//
// Every random draw (the spot path, the vol regimes, the news, the clients)
// is generated from the seed before the first tick, and nothing the player
// does feeds back into it. A run is therefore fully described by
// (seed, action log), and `replay` re-derives its P&L from scratch. The
// leaderboard ranks replayed P&L, never the number a client claims.

import { analyticDigital, blackScholesCall, blackScholesPut } from "./engine.js";

export const TICKS_PER_DAY = 13;            // half-hours, 10:00 … 16:00
export const DAYS = 10;
export const N_TICKS = TICKS_PER_DAY * DAYS;
export const YEAR = 252 * TICKS_PER_DAY;     // ticks per year
export const DT = 1 / YEAR;
export const R = 0.03;
export const MULT = 100;                     // shares per option contract
export const HALF_SPREAD = 0.01;             // $ per share crossed
export const IMPACT = 2e-6;                  // $ per share², a 10k clip costs $300
export const RFQ_WINDOW = 3;                 // ticks a client waits for a quote
export const EDGE = { tight: 0.5, wide: 2.0 };  // vol points over/under mid
export const REGIMES = [
  { name: "calm", vol: 0.13 },
  { name: "normal", vol: 0.21 },
  { name: "stressed", vol: 0.36 },
];
export const SIM_VERSION = 1;

// ---------------------------------------------------------------------------
// seeded randomness
// ---------------------------------------------------------------------------

export function hashSeed(s) {
  let h = 0x811c9dc5;
  for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0;
  return h >>> 0;
}

export class Rng {
  constructor(seed) {
    this.s = (typeof seed === "number" ? seed : hashSeed(seed)) >>> 0 || 1;
    this.spare = null;
  }
  u() {  // mulberry32
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  n() {  // Box-Muller, both halves used
    if (this.spare !== null) { const v = this.spare; this.spare = null; return v; }
    let u1 = this.u();
    while (u1 <= 1e-300) u1 = this.u();
    const rad = Math.sqrt(-2 * Math.log(u1)), th = 2 * Math.PI * this.u();
    this.spare = rad * Math.sin(th);
    return rad * Math.cos(th);
  }
  pick(a) { return a[Math.floor(this.u() * a.length)]; }
}

/** Fixed standard normals for the risk screen's Monte Carlo digital. Common
 *  random numbers: the same draws every tick, as the repo's benchmark does. */
export function normals(n, seed = "short-gamma-paths") {
  const r = new Rng(seed), z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = r.n();
  return z;
}

// ---------------------------------------------------------------------------
// the clock
// ---------------------------------------------------------------------------

/** Tick 0 is Day 1 09:30, the open. Ticks 1…13 are 10:00…16:00. The step
 *  into the first tick of each later day carries the overnight gap. */
export function clock(k) {
  if (k <= 0) return { day: 1, label: "09:30", overnightNext: false };
  const day = Math.floor((k - 1) / TICKS_PER_DAY) + 1;
  const slot = (k - 1) % TICKS_PER_DAY;
  const mins = 600 + 30 * slot;
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return { day, label: `${hh}:${mm}`, overnightNext: slot === TICKS_PER_DAY - 1 };
}

export const dayOf = (k) => clock(k).day;

// ---------------------------------------------------------------------------
// the market, generated whole from the seed
// ---------------------------------------------------------------------------

const EVENT_NAMES = [
  "CPI print", "FOMC minutes", "Non-farm payrolls", "Index heavyweight earnings",
  "30-year auction", "ECB press conference", "Retail sales", "PMI flash",
];
const SURPRISES = [
  "Headline: export controls widened", "Headline: ratings agency puts sovereign on watch",
  "Headline: large fund liquidating", "Headline: merger talks collapse",
];

export function makeMarket(seed) {
  const rng = new Rng(seed);

  // hidden realized-vol regime, one per day, a sticky random walk
  const regime = [rng.u() < 0.6 ? 1 : rng.u() < 0.5 ? 0 : 2];
  for (let d = 1; d < DAYS; d++) {
    const prev = regime[d - 1];
    if (rng.u() < 0.55) regime.push(prev);
    else if (prev === 0) regime.push(1);
    else if (prev === 2) regime.push(1);
    else regime.push(rng.u() < 0.5 ? 0 : 2);
  }

  // two scheduled macro events, announced a day ahead, and maybe a surprise
  const names = [...EVENT_NAMES];
  const events = [];
  for (const [lo, hi] of [[2, 4], [5, 8]]) {
    const day = lo + Math.floor(rng.u() * (hi - lo + 1));
    const tick = (day - 1) * TICKS_PER_DAY + 1 + Math.floor(rng.u() * 4);
    const name = names.splice(Math.floor(rng.u() * names.length), 1)[0];
    events.push({ tick, name, sigma: 0.01 + 0.012 * rng.u(), announce: Math.max(0, tick - TICKS_PER_DAY), scheduled: true });
  }
  if (rng.u() < 0.6) {
    const tick = 20 + Math.floor(rng.u() * 100);
    if (!events.some((e) => Math.abs(e.tick - tick) < 4))
      events.push({ tick, name: rng.pick(SURPRISES), sigma: 0.012 + 0.01 * rng.u(), announce: tick, scheduled: false });
  }
  events.sort((a, b) => a.tick - b.tick);

  // spot path
  const S = new Float64Array(N_TICKS + 1);
  const jump = new Float64Array(N_TICKS + 1);
  S[0] = 100;
  for (let k = 0; k < N_TICKS; k++) {
    const vol = REGIMES[regime[dayOf(k + 1) - 1]].vol;
    let variance = vol * vol * DT;
    if (k > 0 && clock(k).overnightNext) variance *= 2.5;     // close-to-open gap
    let x = (R - 0.5 * variance / DT) * DT + Math.sqrt(variance) * rng.n();
    const ev = events.find((e) => e.tick === k + 1);
    if (ev) { jump[k + 1] = ev.sigma * rng.n(); x += jump[k + 1]; }
    S[k + 1] = S[k] * Math.exp(x);
  }

  // implied vol: chases the regime with a lag, carries a variance premium,
  // bids up into a scheduled event and crushes after it
  const iv = new Float64Array(N_TICKS + 1);
  const target = (k) => {
    let t = REGIMES[regime[dayOf(k) - 1]].vol * 1.06 + 0.03;   // gap-adjusted, plus premium
    if (events.some((e) => e.scheduled && e.tick > k && e.tick - k <= TICKS_PER_DAY)) t += 0.035;
    return t;
  };
  iv[0] = target(0) + 0.01;
  for (let k = 1; k <= N_TICKS; k++) {
    let v = iv[k - 1] + 0.18 * (target(k) - iv[k - 1]) + 0.004 * rng.n();
    if (jump[k] !== 0) v += 0.8 * Math.abs(jump[k]);
    iv[k] = Math.min(0.9, Math.max(0.08, v));
  }

  // clients asking for quotes; about a third know where vol is going
  const rfqs = [];
  let t = 4 + Math.floor(rng.u() * 6);
  while (t < N_TICKS - 12 && rfqs.length < 8) {
    const expiry = rng.u() < 0.55 ? N_TICKS : N_TICKS + 20 * TICKS_PER_DAY;
    const type = rng.u() < 0.5 ? "call" : "put";
    const K = Math.round(S[t]) + rng.pick([-4, -2, 0, 0, 2, 4]);
    const qty = rng.pick([10, 20, 25, 40, 50]);
    const end = Math.min(expiry, N_TICKS);
    let ss = 0;
    for (let j = t; j < end; j++) ss += Math.log(S[j + 1] / S[j]) ** 2;
    const realized = Math.sqrt(ss / Math.max(1, end - t) / DT);
    const informed = rng.u() < 0.35;
    const coin = rng.u() < 0.5;
    const side = informed ? (realized > iv[t] ? "buy" : "sell") : coin ? "buy" : "sell";
    rfqs.push({ id: rfqs.length, tick: t, type, K, expiry, qty, side, informed, realized,
                reservation: 0.3 + 2.7 * rng.u() });
    t += 9 + Math.floor(rng.u() * 9);
  }

  return { seed: String(seed), regime, events, S, iv, jump, rfqs };
}

// ---------------------------------------------------------------------------
// pricing used for marks and settlement (closed form: the honest mark)
// ---------------------------------------------------------------------------

export function payoff(pos, S) {
  if (pos.type === "call") return Math.max(S - pos.K, 0);
  if (pos.type === "put") return Math.max(pos.K - S, 0);
  return S > pos.K ? 1 : 0;
}

export function unitPrice(pos, S, sigma, ticksLeft) {
  if (ticksLeft <= 0) return payoff(pos, S);
  const p = { S, K: pos.K, r: R, sigma, T: ticksLeft / YEAR };
  if (pos.type === "call") return blackScholesCall(p);
  if (pos.type === "put") return blackScholesPut(p);
  return analyticDigital(p).price;
}

// ---------------------------------------------------------------------------
// the desk
// ---------------------------------------------------------------------------

export const DIGITAL_PAYOUT = 25000;

function initialBook() {
  return [
    { label: "100 call", type: "call", K: 100, expiry: N_TICKS, qty: -40, mult: MULT },
    { label: "100 put", type: "put", K: 100, expiry: N_TICKS, qty: -40, mult: MULT },
    { label: "95 put · 30d", type: "put", K: 95, expiry: N_TICKS + 20 * TICKS_PER_DAY, qty: -25, mult: MULT },
    { label: "104 digital", type: "digital", K: 104, expiry: N_TICKS, qty: -DIGITAL_PAYOUT, mult: 1 },
  ];
}

export class Sim {
  constructor(seed, market = null) {
    this.m = market || makeMarket(seed);
    this.k = 0;
    this.cash = 0;
    this.shares = 0;
    this.hedgeCash = 0;        // -Σ q·S over share trades, excluding costs
    this.tcost = 0;
    this.interest = 0;
    this.log = [];
    this.rfq = {};             // id -> result
    this.positions = [];
    this.done = false;
    for (const p of initialBook()) this._open({ ...p, src: "book" }, this.m.iv[0]);
    this.pnl = [this.equity()];
  }

  get S() { return this.m.S[this.k]; }
  get iv() { return this.m.iv[this.k]; }

  _open(pos, sigma) {
    const px = unitPrice(pos, this.S, sigma, pos.expiry - this.k);
    pos.id = this.positions.length;
    pos.entry = px;
    pos.flow = -pos.qty * pos.mult * px;          // cash received (+) or paid (-)
    pos.settled = null;
    this.cash += pos.flow;
    this.positions.push(pos);
    return pos;
  }

  live() { return this.positions.filter((p) => p.settled === null); }

  mark(pos) {
    if (pos.settled !== null) return 0;
    return pos.qty * pos.mult * unitPrice(pos, this.S, this.iv, pos.expiry - this.k);
  }

  equity() {
    let e = this.cash + this.shares * this.S;
    for (const p of this.positions) e += this.mark(p);
    return e;
  }

  /** Trade q shares at the current spot. Positive buys. */
  trade(q) {
    q = Math.round(q);
    if (!Number.isFinite(q) || q === 0 || this.done || Math.abs(q) > 1e6) return 0;
    const cost = Math.abs(q) * HALF_SPREAD + IMPACT * q * q;
    this.cash -= q * this.S + cost;
    this.hedgeCash -= q * this.S;
    this.shares += q;
    this.tcost += cost;
    this.log.push([this.k, "B", q]);
    return q;
  }

  activeRfqs() {
    return this.m.rfqs.filter((q) => this.k >= q.tick && this.k < q.tick + RFQ_WINDOW && !this.rfq[q.id]);
  }

  /** Answer a client: "tight", "wide" or "pass". Returns the result. */
  answer(id, choice) {
    const q = this.m.rfqs[id];
    if (!q || this.done || this.rfq[id] || this.k < q.tick || this.k >= q.tick + RFQ_WINDOW) return null;
    if (!(choice in EDGE) && choice !== "pass") return null;
    this.log.push([this.k, "Q", id, choice]);
    if (choice === "pass") return (this.rfq[id] = { choice, filled: false, tick: this.k });
    const edge = EDGE[choice];
    const fills = q.informed ? Math.abs(q.realized - this.iv) * 100 > edge : edge <= q.reservation;
    const sigma = Math.max(0.02, this.iv + (q.side === "buy" ? edge : -edge) / 100);
    const res = { choice, filled: fills, tick: this.k, sigma };
    if (fills) {
      const pos = this._open({
        label: `${q.K} ${q.type} · ${q.expiry > N_TICKS ? "30d" : "10d"}`, type: q.type, K: q.K,
        expiry: q.expiry, qty: q.side === "buy" ? -q.qty : q.qty, mult: MULT, src: "client", rfq: id,
      }, sigma);
      res.position = pos.id;
      res.price = pos.entry;
    }
    return (this.rfq[id] = res);
  }

  step() {
    if (this.done) return;
    const growth = Math.exp(R * DT) - 1;
    this.interest += this.cash * growth;
    this.cash += this.cash * growth;
    this.k += 1;
    for (const p of this.positions) {
      if (p.settled === null && p.expiry === this.k) {
        p.settled = p.qty * p.mult * payoff(p, this.S);
        this.cash += p.settled;
      }
    }
    for (const q of this.m.rfqs)
      if (!this.rfq[q.id] && this.k >= q.tick + RFQ_WINDOW) this.rfq[q.id] = { choice: "missed", filled: false };
    this.pnl.push(this.equity());
    if (this.k >= N_TICKS) this.done = true;
  }

  /** Where the money came from. The parts sum to equity(). */
  attribution() {
    const pos = (f) => this.positions.filter(f).reduce((a, p) => a + p.flow + (p.settled ?? this.mark(p)), 0);
    return {
      straddle: pos((p) => p.src === "book" && p.K === 100 && p.type !== "digital"),
      wing: pos((p) => p.src === "book" && p.K === 95),
      digital: pos((p) => p.type === "digital"),
      clients: pos((p) => p.src === "client"),
      hedge: this.hedgeCash + this.shares * this.S,
      costs: -this.tcost,
      interest: this.interest,
    };
  }

  /** Realized vol of the path so far, annualized. */
  realizedVol(from = 0, to = this.k) {
    let ss = 0, n = 0;
    for (let j = from; j < to; j++) { ss += Math.log(this.m.S[j + 1] / this.m.S[j]) ** 2; n++; }
    return n ? Math.sqrt(ss / n / DT) : 0;
  }
}

/** Re-run a game from its seed and action log. Actions that would not have
 *  been legal at their tick are dropped, exactly as the live game drops them. */
export function replay(seed, log, market = null) {
  const sim = new Sim(seed, market);
  const byTick = new Map();
  for (const a of Array.isArray(log) ? log : []) {
    if (!Array.isArray(a) || !Number.isInteger(a[0])) continue;
    if (!byTick.has(a[0])) byTick.set(a[0], []);
    byTick.get(a[0]).push(a);
  }
  for (let k = 0; k <= N_TICKS; k++) {
    for (const a of byTick.get(k) || []) {
      if (a[1] === "B") sim.trade(Number(a[2]));
      else if (a[1] === "Q") sim.answer(Number(a[2]), String(a[3]));
    }
    if (k < N_TICKS) sim.step();
  }
  return sim;
}

export const todaySeed = (d = new Date()) => d.toISOString().slice(0, 10);
