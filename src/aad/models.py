"""Pricers, written once so the same code can be evaluated or differentiated.

Each function is generic over its numeric type: pass floats and it prices, pass
`Var` and the tape records the whole computation. Nothing is written twice, so
the Greeks cannot drift from the price the way hand-coded derivatives do.
"""

from __future__ import annotations

import math

import numpy as np

from .tape import Var, _phi_cdf, _phi_pdf


def _exp(x):
    return x.exp() if isinstance(x, Var) else np.exp(x)


def _log(x):
    return x.log() if isinstance(x, Var) else np.log(x)


def _sqrt(x):
    return x.sqrt() if isinstance(x, Var) else np.sqrt(x)


def _cdf(x):
    return x.norm_cdf() if isinstance(x, Var) else _phi_cdf(x)


# ---------------------------------------------------------------------------
# closed form
# ---------------------------------------------------------------------------

def black_scholes_call(S, K, r, sigma, T):
    """Black-Scholes call. Differentiating this with AAD is checked against the
    hand-derived Greeks below, which is the machine-precision oracle."""
    sT = _sqrt(T)
    d1 = (_log(S / K) + (r + sigma * sigma * 0.5) * T) / (sigma * sT)
    d2 = d1 - sigma * sT
    return S * _cdf(d1) - K * _exp(-r * T) * _cdf(d2)


def analytic_greeks(S, K, r, sigma, T) -> dict[str, float]:
    """Textbook closed-form Greeks. Independent of the AD engine, which is the
    whole point — it is the oracle, so it must share no code with it."""
    sT = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * sT)
    d2 = d1 - sigma * sT
    Nd1, Nd2 = float(_phi_cdf(d1)), float(_phi_cdf(d2))
    nd1 = float(_phi_pdf(d1))
    disc = math.exp(-r * T)
    return {
        "S": Nd1,                                     # delta
        "sigma": S * nd1 * sT,                        # vega
        "r": K * T * disc * Nd2,                      # rho
        "T": S * nd1 * sigma / (2 * sT) + r * K * disc * Nd2,   # -theta
        "K": -disc * Nd2,                             # dual delta
    }


# ---------------------------------------------------------------------------
# Monte Carlo
# ---------------------------------------------------------------------------

def mc_call(S, K, r, sigma, T, z: np.ndarray):
    """European call by Monte Carlo, pathwise differentiable.

    `z` is a fixed array of standard normals. Holding it fixed across bumped
    revaluations is what makes finite differences comparable at all — with
    fresh draws the difference is dominated by sampling noise.
    """
    drift = (r - sigma * sigma * 0.5) * T
    diffusion = sigma * _sqrt(T)
    ST = S * _exp(drift + diffusion * z)
    payoff = (ST - K).relu() if isinstance(ST, Var) else np.maximum(ST - K, 0.0)
    disc = _exp(-r * T)
    return disc * (payoff.mean() if isinstance(payoff, Var) else payoff.mean())


def mc_digital(S, K, r, sigma, T, z: np.ndarray, smoothing: float = 0.0):
    """Cash-or-nothing digital: pays 1 if S_T > K.

    With `smoothing = 0` the payoff is a step function whose derivative is zero
    almost everywhere, so pathwise AAD reports a delta of exactly 0 — confidently,
    silently, and wrongly. `smoothing > 0` replaces the step with a call spread
    of that width, which is differentiable and converges to the true delta as
    the width shrinks (until variance takes over).
    """
    drift = (r - sigma * sigma * 0.5) * T
    ST = S * _exp(drift + sigma * _sqrt(T) * z)
    disc = _exp(-r * T)

    if smoothing <= 0:
        # step function: the value is right and the pathwise derivative is zero
        payoff = _step(ST, K) if isinstance(ST, Var) else (ST > K).astype(float)
    else:
        h = smoothing
        if isinstance(ST, Var):
            payoff = ((ST - (K - h)).relu() - (ST - (K + h)).relu()) * (1.0 / (2 * h))
        else:
            payoff = (np.maximum(ST - (K - h), 0) - np.maximum(ST - (K + h), 0)) / (2 * h)

    return disc * (payoff.mean() if isinstance(payoff, Var) else payoff.mean())


def _step(ST: Var, K):
    """1{S_T > K} on the tape, with the honest derivative: zero."""
    kv = K.value if isinstance(K, Var) else K
    v = (ST.value > kv).astype(float)
    return ST._op(v, [(ST.idx, np.zeros_like(ST.value))])


def mc_basket(weights, spots, K, r, sigma, T, z: np.ndarray):
    """Arithmetic basket call on `n` correlated-free assets.

    This is the case AAD exists for: the parameter count grows with the basket,
    so bumping costs 2n+1 pricings while the reverse sweep stays flat.
    """
    disc = _exp(-r * T)
    total = None
    for i, (w, S0) in enumerate(zip(weights, spots)):
        drift = (r - sigma * sigma * 0.5) * T
        ST = S0 * _exp(drift + sigma * _sqrt(T) * z[i])
        term = w * ST
        total = term if total is None else total + term
    payoff = (total - K).relu() if isinstance(total, Var) else np.maximum(total - K, 0.0)
    return disc * (payoff.mean() if isinstance(payoff, Var) else payoff.mean())
