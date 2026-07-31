# Design notes

## The oracle has to share no code with the thing it checks

`analytic_greeks()` is the textbook Black-Scholes formulas typed out by hand:
delta is `N(d1)`, vega is `S·φ(d1)·√T`, and so on. It does not call the AD
engine and the AD engine does not call it.

That separation is the only reason the agreement means anything. A test that
compared AAD against derivatives obtained *by* AAD would pass no matter how
broken the tape was. Measured across five parameter regimes — at the money,
deep in, deep out, long dated, short dated and low vol — every one of the five
first-order Greeks agrees to `1e-12` or better, and the at-the-money delta
agrees to `5.6e-16`, which is about two ulps.

That is the difference between differentiating the *function* and
differentiating the *program*: there is no truncation error to trade against
rounding error, because no difference is ever taken.

## Broadcast adjoints are where a hand-rolled tape goes wrong

A scalar input like `S` is used once in the program but participates in every
one of 200,000 paths. Its adjoint is the **sum** of the per-path adjoints, not
any single one and not their mean.

`_unbroadcast()` sums an adjoint back down to the shape of the node that
produced it. Get it wrong and the gradient is off by a factor of the path count
— a clean, plausible-looking number that is 200,000× too small or too large,
with no shape error to catch it. `test_scalar_broadcast_adjoint_is_summed_over_paths`
pins it with a five-element case where the correct answer can be computed by
hand.

The related trap is a shared subexpression: `x * x` reaches `x` by two routes
and the adjoints must accumulate rather than overwrite. That is why `backward()`
accumulates with `+=` semantics rather than assignment, and why there is a test
asserting `d(x²)/dx = 2x` rather than `x`.

## Comparing against finite differences fairly

Two decisions make the comparison honest rather than flattering:

**Common random numbers.** Every bumped revaluation reuses the same array of
normals. With fresh draws per bump, the difference between two Monte Carlo
prices is dominated by sampling noise and the FD "derivative" is mostly garbage
— which would make AAD look far better than it is. Fixing the draws is the
standard practice and it is the strongest version of the baseline.

**Reporting the constant factor, not just the speedup.** The headline number
(53× at 50 inputs) is a function of how many inputs were chosen. The column that
actually carries the argument is `AAD/price`, which stays between 1.65 and 2.11
while the input count moves 50×. A speedup with no invariant behind it is a
number about the benchmark, not the method.

## Where the method is wrong, kept in the repo rather than around it

Pathwise differentiation assumes the payoff is a.e. differentiable in the
parameter. A cash-or-nothing digital is a step function, so its derivative is
zero everywhere except a null set, and the reverse sweep propagates that
faithfully: delta `0.000000` against a true value of `0.019333`.

There is no error, no NaN, no warning. This is the failure mode that matters
most, because everything about the output looks fine.

`_step()` is written deliberately, with `np.zeros_like` as its local partial,
rather than being an accident of using a comparison operator. It is the honest
implementation of the mathematics, and the test asserting `g["S"] == 0.0`
documents the limitation as a property rather than a footnote.

Central differences with `h = 0.5` recover the delta to 0.1%, because a bump
large enough to move paths across the barrier does sample the discontinuity. The
crude method wins outright in this regime.

The production fix is smoothing the step into a call spread of width `h`, which
is differentiable and converges as `h → 0` — until variance takes over. The
benchmark sweeps `h` from 2.0 down to 0.25 so both ends of that trade are
visible rather than a single flattering choice.

## What is deliberately absent

**Second-order Greeks.** Gamma requires forward-over-reverse or differentiating
the adjoint, and the flat-cost property does not carry over to a Hessian — it
becomes one reverse sweep per row. Claiming AAD gives you "all the Greeks" at
constant cost is true only for the first-order ones, so only those are here.

**Checkpointing.** The tape is materialised in full: 96 bytes per path for the
European pricer, 48 MB at 500,000 paths. Real engines trade recomputation for
memory. Leaving it out keeps the memory cost visible in the benchmark instead of
hidden behind an optimisation.

**American exercise.** Longstaff-Schwartz introduces a regression whose
differentiation is a research topic in its own right, and pretending otherwise
would put an unmeasured approximation underneath every number in the README.
