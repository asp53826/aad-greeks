// The game's engine against the Python package it claims to be.
//
//   node --test tests/js/
//
// golden.json is written by make_golden.py from src/aad. Every number the
// risk screen shows comes from docs/play/engine.js, so this file is what makes
// "the Greeks in the game are the repo's Greeks" a checked claim.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  analyticDigital, analyticGreeks, blackScholesCall, blackScholesPut, grad,
  mcCall, mcDigital, phiCdf,
} from "../../docs/play/engine.js";

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url)));
const z = Float64Array.from(golden.z);

function close(actual, expected, rel, abs, what) {
  const tol = Math.max(abs, rel * Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: ${actual} vs ${expected} (|diff| ${Math.abs(actual - expected)} > ${tol})`);
}

test("normal CDF matches math.erf to 1e-15 absolute across [-9, 9] and the tails", () => {
  for (const [x, expected] of golden.cdf) close(phiCdf(x), expected, 0, 1e-15, `Phi(${x})`);
});

test("Black-Scholes price and all five AAD Greeks match Python to 1e-12", () => {
  for (const c of golden.bs) {
    const [price, g] = grad(blackScholesCall, c.params);
    close(price, c.price, 1e-12, 1e-12, "price");
    for (const k of Object.keys(c.aad)) close(g[k], c.aad[k], 1e-12, 1e-12, `d/d${k}`);
  }
});

test("the JS tape records the same program: identical node count", () => {
  for (const c of golden.bs) {
    const [, , tape] = grad(blackScholesCall, c.params);
    assert.equal(tape.length, c.tape_len);
  }
  for (const c of golden.mc_digital) {
    const [, , tape] = grad((v) => mcDigital(v, z, c.smoothing), c.params);
    assert.equal(tape.length, c.tape_len, `digital h=${c.smoothing}`);
  }
});

test("JS analytic oracle agrees with the Python oracle", () => {
  for (const c of golden.bs) {
    const a = analyticGreeks(c.params);
    for (const k of Object.keys(c.analytic)) close(a[k], c.analytic[k], 1e-12, 1e-12, `analytic ${k}`);
  }
});

test("put on the tape satisfies parity against the independent call oracle", () => {
  for (const c of golden.bs) {
    const p = c.params;
    const [, g] = grad(blackScholesPut, p);
    const a = analyticGreeks(p);
    const disc = Math.exp(-p.r * p.T);
    close(g.S, a.S - 1, 1e-12, 1e-12, "put delta");
    close(g.sigma, a.sigma, 1e-12, 1e-12, "put vega");
    close(g.K, a.K + disc, 1e-12, 1e-12, "put dual delta");
    close(g.r, a.r - p.K * p.T * disc, 1e-12, 1e-12, "put rho");
    close(g.T, a.T - p.r * p.K * disc, 1e-12, 1e-12, "put -theta");
  }
});

test("Monte Carlo call: same normals, same price and Greeks as numpy", () => {
  for (const c of golden.mc_call) {
    const [price, g] = grad((v) => mcCall(v, z), c.params);
    close(price, c.price, 1e-12, 1e-14, "mc price");
    for (const k of Object.keys(c.aad)) close(g[k], c.aad[k], 1e-11, 1e-13, `mc d/d${k}`);
  }
});

test("digital: the sharp payoff's pathwise delta is exactly zero, as in Python", () => {
  for (const c of golden.mc_digital) {
    const [price, g] = grad((v) => mcDigital(v, z, c.smoothing), c.params);
    close(price, c.price, 1e-12, 1e-14, `digital price h=${c.smoothing}`);
    for (const k of Object.keys(c.aad)) close(g[k], c.aad[k], 1e-11, 1e-13, `digital d/d${k} h=${c.smoothing}`);
    if (c.smoothing === 0) assert.equal(g.S, 0);
  }
});

test("smoothing recovers the true digital delta the sharp payoff hides", () => {
  const p = golden.mc_digital.find((c) => c.smoothing === 1.0).params;
  const truth = analyticDigital(p).delta;
  const [, sharp] = grad((v) => mcDigital(v, z, 0), p);
  const [, smooth] = grad((v) => mcDigital(v, z, 1.0), p);
  assert.equal(sharp.S, 0);
  // 4,000 paths carry roughly 10% sampling error on a digital delta, plus the
  // smoothing bias; the point is "recovers the right order", not "exact".
  close(smooth.S, truth, 0.2, 0, "smoothed delta vs closed form");
});
