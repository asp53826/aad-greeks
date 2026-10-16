// A line-for-line port of src/aad/tape.py and src/aad/models.py.
//
// The game's risk screen runs on this, so it has to be the same engine and
// not a lookalike: tests/js/parity.test.mjs checks every price, every Greek
// and the tape length against the Python package, and fails CI if they drift.
//
// Values are numbers or Float64Arrays, so one tape covers every Monte Carlo
// path at once, exactly as numpy arrays do in the original. JavaScript has no
// operator overloading, so the pricers are written with the generic helpers
// at the bottom of this file instead of `+` and `*`.

const SQRT2PI = Math.sqrt(2.0 * Math.PI);

// ---------------------------------------------------------------------------
// elementwise arithmetic over number | Float64Array
// ---------------------------------------------------------------------------

const isArr = (x) => x instanceof Float64Array;

function ew(a, b, f) {
  if (!isArr(a) && !isArr(b)) return f(a, b);
  const n = isArr(a) ? a.length : b.length;
  const out = new Float64Array(n);
  if (isArr(a) && isArr(b)) for (let i = 0; i < n; i++) out[i] = f(a[i], b[i]);
  else if (isArr(a)) for (let i = 0; i < n; i++) out[i] = f(a[i], b);
  else for (let i = 0; i < n; i++) out[i] = f(a, b[i]);
  return out;
}

function map(a, f) {
  if (!isArr(a)) return f(a);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = f(a[i]);
  return out;
}

const vadd = (a, b) => ew(a, b, (x, y) => x + y);
const vmul = (a, b) => ew(a, b, (x, y) => x * y);

function vsum(a) {
  if (!isArr(a)) return a;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

const onesLike = (a) => (isArr(a) ? new Float64Array(a.length).fill(1) : 1);
const zerosLike = (a) => (isArr(a) ? new Float64Array(a.length) : 0);

/** Sum an adjoint back down to the shape of the node that produced it.
 *  A scalar broadcast across N paths receives the sum of N path adjoints. */
function unbroadcast(x, like) {
  return !isArr(like) && isArr(x) ? vsum(x) : x;
}

// ---------------------------------------------------------------------------
// standard normal
// ---------------------------------------------------------------------------

export function phiPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

/** Standard normal CDF to ~1e-16 absolute. Marsaglia's Taylor series in the
 *  body, the Laplace continued fraction for the Mills ratio in the tails. */
export function phiCdf(x) {
  if (Number.isNaN(x)) return NaN;
  const ax = Math.abs(x);
  if (ax < 3) {
    const x2 = x * x;
    let s = x, t = x;
    for (let n = 3; n < 400; n += 2) {
      t *= x2 / n;
      const s2 = s + t;
      if (s2 === s) break;
      s = s2;
    }
    return 0.5 + s * phiPdf(x);
  }
  if (ax > 38) return x > 0 ? 1 : 0;
  let f = ax;
  for (let k = 400; k >= 1; k--) f = ax + k / f;
  const tail = phiPdf(ax) / f;
  return x > 0 ? 1 - tail : tail;
}

// ---------------------------------------------------------------------------
// the tape
// ---------------------------------------------------------------------------

let CURRENT = null;

export class Tape {
  constructor() {
    this.values = [];
    // parents[i] = [[parentIndex, localPartial], ...], d(node_i)/d(parent)
    this.parents = [];
    // Not in the Python original: an op label per node, so the game can draw
    // the tape. It changes nothing about the arithmetic.
    this.ops = [];
  }

  push(value, parents = [], op = "const") {
    this.values.push(value);
    this.parents.push(parents);
    this.ops.push(op);
    return this.values.length - 1;
  }

  get length() {
    return this.values.length;
  }

  nbytes() {
    const sz = (v) => (isArr(v) ? v.byteLength : 8);
    let b = 0;
    for (const v of this.values) b += sz(v);
    for (const ps of this.parents) for (const [, d] of ps) b += sz(d);
    return b;
  }

  /** Adjoints of every node with respect to node `idx`, in one reverse pass.
   *  Nodes are appended in evaluation order, so walking backwards guarantees
   *  a node's adjoint is complete before it is propagated. */
  backward(idx) {
    const adj = new Array(this.values.length).fill(null);
    adj[idx] = onesLike(this.values[idx]);
    for (let i = idx; i >= 0; i--) {
      const a = adj[i];
      if (a === null) continue;
      for (const [p, local] of this.parents[i]) {
        const contrib = unbroadcast(vmul(a, local), this.values[p]);
        adj[p] = adj[p] === null ? contrib : vadd(adj[p], contrib);
      }
    }
    return adj.map((a, i) => (a === null ? zerosLike(this.values[i]) : a));
  }
}

export class Var {
  constructor(tape, idx) {
    this.tape = tape;
    this.idx = idx;
  }

  get value() {
    return this.tape.values[this.idx];
  }

  static constant(x, tape = null, op = "const") {
    const t = tape || CURRENT;
    return new Var(t, t.push(x, [], op));
  }

  _lift(o) {
    return o instanceof Var ? o : new Var(this.tape, this.tape.push(o));
  }

  _op(value, parents, op) {
    return new Var(this.tape, this.tape.push(value, parents, op));
  }

  // -- arithmetic ------------------------------------------------------------

  add(o) {
    o = this._lift(o);
    return this._op(vadd(this.value, o.value), [[this.idx, 1.0], [o.idx, 1.0]], "+");
  }

  neg() {
    return this._op(map(this.value, (v) => -v), [[this.idx, -1.0]], "neg");
  }

  sub(o) {
    o = this._lift(o);
    return this._op(ew(this.value, o.value, (x, y) => x - y),
                    [[this.idx, 1.0], [o.idx, -1.0]], "−");
  }

  rsub(o) {
    return this._lift(o).sub(this);
  }

  mul(o) {
    o = this._lift(o);
    return this._op(vmul(this.value, o.value), [[this.idx, o.value], [o.idx, this.value]], "×");
  }

  div(o) {
    o = this._lift(o);
    const v = ew(this.value, o.value, (x, y) => x / y);
    return this._op(v, [[this.idx, map(o.value, (y) => 1.0 / y)],
                        [o.idx, ew(this.value, o.value, (x, y) => -x / (y ** 2))]], "÷");
  }

  rdiv(o) {
    return this._lift(o).div(this);
  }

  pow(k) {
    return this._op(map(this.value, (v) => v ** k),
                    [[this.idx, map(this.value, (v) => k * v ** (k - 1))]], "pow");
  }

  // -- transcendental --------------------------------------------------------

  exp() {
    const v = map(this.value, Math.exp);
    return this._op(v, [[this.idx, v]], "exp");
  }

  log() {
    return this._op(map(this.value, Math.log), [[this.idx, map(this.value, (v) => 1.0 / v)]], "ln");
  }

  sqrt() {
    const v = map(this.value, Math.sqrt);
    return this._op(v, [[this.idx, map(v, (s) => 0.5 / s)]], "√");
  }

  normCdf() {
    return this._op(map(this.value, phiCdf), [[this.idx, map(this.value, phiPdf)]], "Φ");
  }

  // -- payoff / reduction ----------------------------------------------------

  /** max(x, 0), with derivative 1{x>0}. Correct almost everywhere for a
   *  continuous payoff; see mcDigital for where pathwise AAD goes wrong. */
  relu() {
    return this._op(map(this.value, (v) => Math.max(v, 0.0)),
                    [[this.idx, map(this.value, (v) => (v > 0 ? 1.0 : 0.0))]], "relu");
  }

  mean() {
    const v = this.value;
    const n = isArr(v) ? v.length : 1;
    return this._op(vsum(v) / n, [[this.idx, isArr(v) ? new Float64Array(n).fill(1.0 / n) : 1.0]], "mean");
  }

  sum() {
    return this._op(vsum(this.value), [[this.idx, onesLike(this.value)]], "sum");
  }
}

/** Evaluate f(vars) and return [value, {name: dvalue/dinput}, tape].
 *  One forward evaluation and one reverse sweep, whatever the input count. */
export function grad(f, inputs) {
  const tape = new Tape();
  const prev = CURRENT;
  CURRENT = tape;
  try {
    const vars = {};
    for (const [k, v] of Object.entries(inputs)) vars[k] = Var.constant(v, tape, k);
    const out = f(vars);
    if (!(out instanceof Var)) throw new TypeError("function must return a Var");
    const adj = tape.backward(out.idx);
    const g = {};
    for (const [k, v] of Object.entries(vars)) g[k] = Number(adj[v.idx]);
    return [Number(out.value), g, tape, out.idx, adj];
  } finally {
    CURRENT = prev;
  }
}

// ---------------------------------------------------------------------------
// generic helpers: numbers, arrays and Vars alike
// ---------------------------------------------------------------------------

const V = (x) => x instanceof Var;

export const add = (a, b) => (V(a) ? a.add(b) : V(b) ? b.add(a) : vadd(a, b));
export const sub = (a, b) => (V(a) ? a.sub(b) : V(b) ? b.rsub(a) : ew(a, b, (x, y) => x - y));
export const mul = (a, b) => (V(a) ? a.mul(b) : V(b) ? b.mul(a) : vmul(a, b));
export const div = (a, b) => (V(a) ? a.div(b) : V(b) ? b.rdiv(a) : ew(a, b, (x, y) => x / y));
export const neg = (a) => (V(a) ? a.neg() : map(a, (v) => -v));
export const exp = (a) => (V(a) ? a.exp() : map(a, Math.exp));
export const log = (a) => (V(a) ? a.log() : map(a, Math.log));
export const sqrt = (a) => (V(a) ? a.sqrt() : map(a, Math.sqrt));
export const cdf = (a) => (V(a) ? a.normCdf() : map(a, phiCdf));
export const relu = (a) => (V(a) ? a.relu() : map(a, (v) => Math.max(v, 0.0)));
export const mean = (a) => (V(a) ? a.mean() : isArr(a) ? vsum(a) / a.length : a);

// ---------------------------------------------------------------------------
// pricers, written once (models.py)
// ---------------------------------------------------------------------------

/** Black-Scholes call. Same operations, same order, as models.py, so the
 *  tape has the same number of nodes as the Python one. */
export function blackScholesCall({ S, K, r, sigma, T }) {
  const sT = sqrt(T);
  const d1 = div(add(log(div(S, K)), mul(add(r, mul(mul(sigma, sigma), 0.5)), T)), mul(sigma, sT));
  const d2 = sub(d1, mul(sigma, sT));
  return sub(mul(S, cdf(d1)), mul(mul(K, exp(mul(neg(r), T))), cdf(d2)));
}

/** Put by parity, on the tape: P = C - S + K e^{-rT}. Not in the Python
 *  package; its Greeks are checked against parity applied to the oracle. */
export function blackScholesPut({ S, K, r, sigma, T }) {
  const c = blackScholesCall({ S, K, r, sigma, T });
  return add(sub(c, S), mul(K, exp(mul(neg(r), T))));
}

/** Textbook closed-form call Greeks, sharing no code with the tape. */
export function analyticGreeks({ S, K, r, sigma, T }) {
  const sT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * sT);
  const d2 = d1 - sigma * sT;
  const Nd1 = phiCdf(d1), Nd2 = phiCdf(d2), nd1 = phiPdf(d1);
  const disc = Math.exp(-r * T);
  return {
    S: Nd1,
    sigma: S * nd1 * sT,
    r: K * T * disc * Nd2,
    T: (S * nd1 * sigma) / (2 * sT) + r * K * disc * Nd2,
    K: -disc * Nd2,
  };
}

/** Cash-or-nothing digital, closed form: e^{-rT} N(d2), and its true delta. */
export function analyticDigital({ S, K, r, sigma, T }) {
  const sT = Math.sqrt(T);
  const d2 = (Math.log(S / K) + (r - 0.5 * sigma ** 2) * T) / (sigma * sT);
  const disc = Math.exp(-r * T);
  return { price: disc * phiCdf(d2), delta: (disc * phiPdf(d2)) / (S * sigma * sT) };
}

/** European call by Monte Carlo, pathwise differentiable. */
export function mcCall({ S, K, r, sigma, T }, z) {
  const drift = mul(sub(r, mul(mul(sigma, sigma), 0.5)), T);
  const diffusion = mul(sigma, sqrt(T));
  const ST = mul(S, exp(add(drift, mul(diffusion, z))));
  const payoff = relu(sub(ST, K));
  const disc = exp(mul(neg(r), T));
  return mul(disc, mean(payoff));
}

/** Cash-or-nothing digital by Monte Carlo.
 *
 *  smoothing = 0: the payoff is a step whose derivative is zero almost
 *  everywhere, so pathwise AAD reports delta = 0 — confidently, silently,
 *  wrongly. smoothing > 0 swaps the step for a call spread of that width. */
export function mcDigital({ S, K, r, sigma, T }, z, smoothing = 0.0) {
  const drift = mul(sub(r, mul(mul(sigma, sigma), 0.5)), T);
  const ST = mul(S, exp(add(drift, mul(mul(sigma, sqrt(T)), z))));
  const disc = exp(mul(neg(r), T));
  let payoff;
  if (smoothing <= 0) {
    payoff = V(ST) ? step(ST, K) : map(sub(ST, K), (v) => (v > 0 ? 1.0 : 0.0));
  } else {
    const h = smoothing;
    payoff = mul(sub(relu(sub(ST, sub(K, h))), relu(sub(ST, add(K, h)))), 1.0 / (2 * h));
  }
  return mul(disc, mean(payoff));
}

/** 1{S_T > K} on the tape, with the honest derivative: zero. */
function step(ST, K) {
  const kv = V(K) ? K.value : K;
  const v = ew(ST.value, kv, (s, k) => (s > k ? 1.0 : 0.0));
  return ST._op(v, [[ST.idx, zerosLike(ST.value)]], "step");
}
