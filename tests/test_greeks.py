import math

import numpy as np
import pytest

from aad.models import (analytic_greeks, black_scholes_call, mc_basket, mc_call,
                        mc_digital)
from aad.tape import Tape, Var, grad

GRID = [
    dict(S=100.0, K=100.0, r=0.03, sigma=0.20, T=1.0),
    dict(S=100.0, K=105.0, r=0.03, sigma=0.22, T=1.5),
    dict(S=80.0, K=120.0, r=0.01, sigma=0.45, T=0.25),   # deep out of the money
    dict(S=150.0, K=90.0, r=0.06, sigma=0.15, T=3.0),    # deep in the money
    dict(S=100.0, K=100.0, r=0.00, sigma=0.05, T=0.05),  # short dated, low vol
]


# ---------------------------------------------------------------------------
# the oracle: AAD through the closed form vs hand-derived Greeks
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("p", GRID)
def test_aad_matches_analytic_greeks_to_machine_precision(p):
    """The analytic Greeks share no code with the AD engine, so agreement to
    1e-12 is evidence about the engine rather than a tautology."""
    val, g, _ = grad(black_scholes_call, p)
    a = analytic_greeks(**p)
    assert val == pytest.approx(black_scholes_call(**p), rel=1e-14)
    for k, expected in a.items():
        assert g[k] == pytest.approx(expected, rel=1e-12, abs=1e-12), k


def test_one_reverse_sweep_produces_every_greek():
    """The cost claim: five partials, one backward pass, one tape."""
    p = dict(S=100.0, K=105.0, r=0.03, sigma=0.22, T=1.5)
    tape = Tape()
    with tape:
        vs = {k: Var.constant(v, tape) for k, v in p.items()}
        out = black_scholes_call(**vs)
        nodes_before = len(tape)
        adj = tape.backward(out.idx)
    assert len(tape) == nodes_before          # backward allocates no new nodes
    assert sum(1 for v in vs.values() if adj[v.idx] is not None) == 5


# ---------------------------------------------------------------------------
# engine mechanics
# ---------------------------------------------------------------------------

def test_scalar_broadcast_adjoint_is_summed_over_paths():
    """A scalar used across N paths must receive the sum of N path adjoints.
    Getting this wrong yields a gradient off by a factor of N, silently."""
    z = np.arange(1.0, 6.0)
    tape = Tape()
    with tape:
        s = Var.constant(3.0, tape)
        out = (s * z).sum()
        adj = tape.backward(out.idx)
    assert float(adj[s.idx]) == pytest.approx(z.sum())


def test_mean_and_sum_agree_up_to_n():
    z = np.array([1.0, 2.0, 3.0, 4.0])
    tape = Tape()
    with tape:
        s = Var.constant(2.0, tape)
        m = (s * z).mean()
        adj = tape.backward(m.idx)
    assert float(adj[s.idx]) == pytest.approx(z.mean())


def test_division_and_power_partials():
    tape = Tape()
    with tape:
        x = Var.constant(3.0, tape)
        y = Var.constant(2.0, tape)
        out = (x / y) + x ** 3
        adj = tape.backward(out.idx)
    assert float(adj[x.idx]) == pytest.approx(1 / 2 + 3 * 9)
    assert float(adj[y.idx]) == pytest.approx(-3 / 4)


def test_reverse_ops_on_the_left():
    tape = Tape()
    with tape:
        x = Var.constant(4.0, tape)
        out = 10.0 - x + 2.0 / x
        adj = tape.backward(out.idx)
    assert float(adj[x.idx]) == pytest.approx(-1 - 2 / 16)


def test_shared_subexpression_accumulates_both_paths():
    """x appears twice; the adjoint must add, not overwrite."""
    tape = Tape()
    with tape:
        x = Var.constant(5.0, tape)
        out = x * x
        adj = tape.backward(out.idx)
    assert float(adj[x.idx]) == pytest.approx(10.0)


def test_non_var_return_is_rejected():
    with pytest.raises(TypeError, match="must return a Var"):
        grad(lambda x: 1.0, {"x": 1.0})


# ---------------------------------------------------------------------------
# Monte Carlo
# ---------------------------------------------------------------------------

def _z(n=200_000, seed=0):
    return np.random.default_rng(seed).standard_normal(n)


def test_mc_price_converges_to_black_scholes():
    p = dict(S=100.0, K=100.0, r=0.03, sigma=0.20, T=1.0)
    mc = mc_call(**p, z=_z())
    assert mc == pytest.approx(black_scholes_call(**p), rel=2e-3)


def test_mc_pathwise_delta_matches_analytic():
    p = dict(S=100.0, K=100.0, r=0.03, sigma=0.20, T=1.0)
    z = _z()
    _, g, _ = grad(lambda **kw: mc_call(**kw, z=z), p)
    assert g["S"] == pytest.approx(analytic_greeks(**p)["S"], rel=3e-3)
    assert g["sigma"] == pytest.approx(analytic_greeks(**p)["sigma"], rel=1e-2)


def test_mc_aad_matches_bumped_finite_difference():
    """Same normals on both sides. With fresh draws per bump the difference is
    sampling noise, not a derivative."""
    p = dict(S=100.0, K=100.0, r=0.03, sigma=0.20, T=1.0)
    z = _z()
    _, g, _ = grad(lambda **kw: mc_call(**kw, z=z), p)

    h = 1e-4 * p["S"]
    up = mc_call(**{**p, "S": p["S"] + h}, z=z)
    dn = mc_call(**{**p, "S": p["S"] - h}, z=z)
    assert g["S"] == pytest.approx((up - dn) / (2 * h), rel=1e-5)


def test_basket_deltas_match_bumping():
    n = 5
    w = [1.0 / n] * n
    spots = [95.0, 100.0, 105.0, 110.0, 90.0]
    z = np.random.default_rng(1).standard_normal((n, 50_000))
    base = dict(K=100.0, r=0.03, sigma=0.2, T=1.0)

    def f(**kw):
        sp = [kw[f"S{i}"] for i in range(n)]
        return mc_basket(w, sp, kw["K"], kw["r"], kw["sigma"], kw["T"], z)

    params = {f"S{i}": s for i, s in enumerate(spots)} | base
    _, g, _ = grad(f, params)

    for i in range(n):
        h = 1e-4 * spots[i]
        up = dict(params); up[f"S{i}"] += h
        dn = dict(params); dn[f"S{i}"] -= h
        fd = (f(**{k: v for k, v in up.items()}) - f(**{k: v for k, v in dn.items()})) / (2 * h)
        assert g[f"S{i}"] == pytest.approx(fd, rel=1e-4), i


# ---------------------------------------------------------------------------
# where pathwise AAD is wrong
# ---------------------------------------------------------------------------

def _digital_delta(S, K, r, sigma, T):
    d2 = (math.log(S / K) + (r - 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
    return math.exp(-r * T) * math.exp(-0.5 * d2**2) / math.sqrt(2 * math.pi) / (
        S * sigma * math.sqrt(T))


def test_pathwise_aad_reports_zero_delta_for_a_digital():
    """The headline failure. The payoff is a step function, its derivative is
    zero almost everywhere, and AAD dutifully returns exactly 0 — no warning,
    no NaN, just a confidently wrong number. Bumping gets it roughly right."""
    p = dict(S=100.0, K=100.0, r=0.03, sigma=0.20, T=1.0)
    z = _z()
    _, g, _ = grad(lambda **kw: mc_digital(**kw, z=z, smoothing=0.0), p)

    assert g["S"] == 0.0
    true = _digital_delta(**p)
    assert true > 0.015                       # the real delta is not small
    h = 0.5
    up = mc_digital(**{**p, "S": p["S"] + h}, z=z, smoothing=0.0)
    dn = mc_digital(**{**p, "S": p["S"] - h}, z=z, smoothing=0.0)
    assert (up - dn) / (2 * h) == pytest.approx(true, rel=0.05)


def test_smoothing_recovers_the_digital_delta():
    """The standard fix: replace the step with a call spread of width h, which
    is differentiable and converges as h shrinks."""
    p = dict(S=100.0, K=100.0, r=0.03, sigma=0.20, T=1.0)
    z = _z()
    _, g, _ = grad(lambda **kw: mc_digital(**kw, z=z, smoothing=1.0), p)
    assert g["S"] == pytest.approx(_digital_delta(**p), rel=0.05)


def test_smoothed_digital_price_is_unbiased_enough():
    p = dict(S=100.0, K=100.0, r=0.03, sigma=0.20, T=1.0)
    z = _z()
    sharp = mc_digital(**p, z=z, smoothing=0.0)
    smooth = mc_digital(**p, z=z, smoothing=1.0)
    assert smooth == pytest.approx(sharp, abs=5e-3)
