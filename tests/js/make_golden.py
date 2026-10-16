"""Write or check golden.json: what Python computes for the JS port to match.

    uv run python tests/js/make_golden.py
    uv run python tests/js/make_golden.py --check

The checker accepts only a handful of floating-point ULPs. That keeps CI
portable across libm/NumPy builds without allowing a meaningful engine change
to hide behind a broad numerical tolerance.
"""

import argparse
import json
import math
from pathlib import Path
import sys

import numpy as np

from aad.models import (analytic_greeks, black_scholes_call, mc_call,
                        mc_digital)
from aad.tape import _phi_cdf, grad

GRID = [
    dict(S=100.0, K=100.0, r=0.03, sigma=0.20, T=1.0),
    dict(S=100.0, K=105.0, r=0.03, sigma=0.22, T=1.5),
    dict(S=80.0, K=120.0, r=0.01, sigma=0.45, T=0.25),
    dict(S=150.0, K=90.0, r=0.06, sigma=0.15, T=3.0),
    dict(S=100.0, K=100.0, r=0.00, sigma=0.05, T=0.05),
    dict(S=101.3, K=104.0, r=0.03, sigma=0.31, T=4 / 252),   # a game-like digital
]


def build_fixture():
    out = {"cdf": [], "bs": [], "mc_call": [], "mc_digital": []}

    for x in np.linspace(-9.0, 9.0, 181):
        out["cdf"].append([float(x), float(_phi_cdf(x))])
    for x in (-37.5, -12.0, -3.0000001, -2.9999999, 2.9999999, 3.0000001, 12.0):
        out["cdf"].append([x, float(_phi_cdf(x))])

    for p in GRID:
        price, g, tape = grad(black_scholes_call, p)
        out["bs"].append(dict(params=p, price=price, aad=g,
                              analytic=analytic_greeks(**p), tape_len=len(tape)))

    # the normals are part of the fixture so the two RNGs never have to agree
    z = np.random.default_rng(7).standard_normal(4000)
    out["z"] = [float(v) for v in z]
    for p in GRID[:3] + GRID[5:]:
        price, g, tape = grad(lambda **kw: mc_call(**kw, z=z), p)
        out["mc_call"].append(dict(params=p, price=price, aad=g, tape_len=len(tape)))
        for h in (0.0, 1.0, 0.25):
            price, g, tape = grad(lambda **kw: mc_digital(**kw, z=z, smoothing=h), p)
            out["mc_digital"].append(dict(params=p, smoothing=h, price=price,
                                          aad=g, tape_len=len(tape)))

    return out


def assert_equivalent(expected, actual, path="fixture"):
    if isinstance(expected, dict) and isinstance(actual, dict):
        if expected.keys() != actual.keys():
            raise AssertionError(f"{path}: keys differ")
        for key in expected:
            assert_equivalent(expected[key], actual[key], f"{path}.{key}")
        return

    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            raise AssertionError(
                f"{path}: length {len(actual)} != {len(expected)}"
            )
        for index, (want, got) in enumerate(zip(expected, actual)):
            assert_equivalent(want, got, f"{path}[{index}]")
        return

    if (
        isinstance(expected, (int, float))
        and not isinstance(expected, bool)
        and isinstance(actual, (int, float))
        and not isinstance(actual, bool)
    ):
        ulp_tolerance = 8 * sys.float_info.epsilon
        if not math.isclose(
            float(actual),
            float(expected),
            rel_tol=ulp_tolerance,
            abs_tol=ulp_tolerance,
        ):
            raise AssertionError(f"{path}: {actual!r} != {expected!r}")
        return

    if actual != expected:
        raise AssertionError(f"{path}: {actual!r} != {expected!r}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the committed fixture within an 8-ULP platform tolerance",
    )
    args = parser.parse_args()

    out = build_fixture()

    path = Path(__file__).with_name("golden.json")
    if args.check:
        committed = json.loads(path.read_text())
        assert_equivalent(committed, out)
        print(
            f"verified {path} "
            f"({len(out['bs'])} closed-form, "
            f"{len(out['mc_digital'])} digital cases)"
        )
        return

    path.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    print(f"wrote {path} ({len(out['bs'])} closed-form, {len(out['mc_digital'])} digital cases)")


if __name__ == "__main__":
    main()
