"""What adjoint differentiation actually costs, and where it is wrong.

    uv run python bench/measure.py
"""

from __future__ import annotations

import math
import time

import numpy as np

from aad.models import (analytic_greeks, black_scholes_call, mc_basket, mc_call,
                        mc_digital)
from aad.tape import Tape, Var, grad

P = dict(S=100.0, K=100.0, r=0.03, sigma=0.20, T=1.0)


def timed(fn, repeat=5):
    best = float("inf")
    for _ in range(repeat):
        t0 = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - t0)
    return best


def section(title):
    print(f"\n=== {title} ===\n")


def cost_scaling():
    section("cost vs number of inputs: one basket, n assets")
    print("  AAD is one forward pass plus one reverse sweep whatever n is.")
    print("  Central differences need 2n+1 pricings.\n")
    print(f"  {'n assets':>9}{'price (ms)':>13}{'AAD (ms)':>11}{'bump (ms)':>12}"
          f"{'AAD/price':>11}{'bump/price':>12}{'speedup':>10}")
    print("  " + "-" * 78)

    paths = 40_000
    for n in (1, 2, 5, 10, 25, 50):
        w = [1.0 / n] * n
        spots = [100.0 + i for i in range(n)]
        z = np.random.default_rng(0).standard_normal((n, paths))

        def price(sp=spots):
            return mc_basket(w, sp, P["K"], P["r"], P["sigma"], P["T"], z)

        def f(**kw):
            sp = [kw[f"S{i}"] for i in range(n)]
            return mc_basket(w, sp, kw["K"], kw["r"], kw["sigma"], kw["T"], z)

        params = {f"S{i}": s for i, s in enumerate(spots)}
        params |= {k: P[k] for k in ("K", "r", "sigma", "T")}

        def bump():
            for key, v in params.items():
                h = 1e-4 * max(abs(v), 1.0)
                f(**{**params, key: v + h})
                f(**{**params, key: v - h})
            f(**params)

        t_price = timed(price)
        t_aad = timed(lambda: grad(f, params))
        t_bump = timed(bump)
        print(f"  {n:>9}{t_price*1e3:>13.1f}{t_aad*1e3:>11.1f}{t_bump*1e3:>12.1f}"
              f"{t_aad/t_price:>11.2f}{t_bump/t_price:>12.2f}{t_bump/t_aad:>9.1f}x")

    print("\n  'AAD/price' is the constant multiple AAD adds. 'bump/price' grows")
    print("  linearly with the parameter count, which is the entire argument.")


def accuracy_vs_bump():
    section("accuracy: bump size has a sweet spot, AAD does not")
    _, g, _ = grad(black_scholes_call, P)
    exact = analytic_greeks(**P)["S"]
    print(f"  analytic delta      {exact:.16f}")
    print(f"  AAD delta           {g['S']:.16f}   rel err {abs(g['S']-exact)/exact:.2e}\n")
    print(f"  {'bump h':>12}{'FD delta':>22}{'rel error':>13}")
    print("  " + "-" * 48)
    for e in range(1, 13):
        h = 10.0 ** (-e) * P["S"]
        up = black_scholes_call(**{**P, "S": P["S"] + h})
        dn = black_scholes_call(**{**P, "S": P["S"] - h})
        fd = (up - dn) / (2 * h)
        print(f"  {h:>12.2e}{fd:>22.16f}{abs(fd-exact)/exact:>13.2e}")
    print("\n  Truncation error falls as h shrinks until cancellation in the")
    print("  numerator takes over and it climbs again. AAD has neither term.")


def tape_cost():
    section("tape memory")
    print(f"  {'paths':>10}{'nodes':>8}{'tape MB':>11}{'bytes/path':>13}")
    print("  " + "-" * 42)
    for paths in (10_000, 50_000, 200_000, 500_000):
        z = np.random.default_rng(0).standard_normal(paths)
        _, _, tape = grad(lambda **kw: mc_call(**kw, z=z), P)
        print(f"  {paths:>10,}{len(tape):>8}{tape.nbytes()/1e6:>11.1f}"
              f"{tape.nbytes()/paths:>13.0f}")
    print("\n  The tape holds every intermediate and its local partial, so memory")
    print("  scales with paths x operations. This is AAD's real cost, and it is")
    print("  the reason production engines checkpoint rather than tape everything.")


def digital_failure():
    section("where pathwise AAD is simply wrong")
    z = np.random.default_rng(0).standard_normal(400_000)
    d2 = (math.log(P["S"] / P["K"]) + (P["r"] - 0.5 * P["sigma"]**2) * P["T"]) / (
        P["sigma"] * math.sqrt(P["T"]))
    true = math.exp(-P["r"] * P["T"]) * math.exp(-0.5 * d2**2) / math.sqrt(2 * math.pi) / (
        P["S"] * P["sigma"] * math.sqrt(P["T"]))

    _, g_sharp, _ = grad(lambda **kw: mc_digital(**kw, z=z, smoothing=0.0), P)
    h = 0.5
    fd = (mc_digital(**{**P, "S": P["S"] + h}, z=z, smoothing=0.0)
          - mc_digital(**{**P, "S": P["S"] - h}, z=z, smoothing=0.0)) / (2 * h)

    print("  Cash-or-nothing digital call, true delta = "
          f"{true:.6f}\n")
    print(f"  {'method':<34}{'delta':>12}{'rel error':>12}")
    print("  " + "-" * 58)
    print(f"  {'pathwise AAD, sharp payoff':<34}{g_sharp['S']:>12.6f}"
          f"{abs(g_sharp['S']-true)/true:>12.1%}")
    print(f"  {'central difference, h=0.5':<34}{fd:>12.6f}{abs(fd-true)/true:>12.1%}")
    for s in (2.0, 1.0, 0.5, 0.25):
        _, g, _ = grad(lambda **kw: mc_digital(**kw, z=z, smoothing=s), P)
        print(f"  {'AAD, call-spread smoothing h=' + str(s):<34}{g['S']:>12.6f}"
              f"{abs(g['S']-true)/true:>12.1%}")
    print("\n  The step payoff has zero derivative almost everywhere, so the")
    print("  reverse sweep returns exactly 0 with no warning. Smoothing trades")
    print("  a little price bias for a usable derivative; too little smoothing")
    print("  and variance takes over.")


if __name__ == "__main__":
    t0 = time.perf_counter()
    cost_scaling()
    accuracy_vs_bump()
    tape_cost()
    digital_failure()
    print(f"\ndone in {time.perf_counter()-t0:.1f}s\n")
