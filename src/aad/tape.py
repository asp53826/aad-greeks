"""Reverse-mode automatic differentiation on a tape.

The point of adjoint AD for pricing is the cost model. A bumped finite
difference needs one revaluation per input — 2N+1 pricings for N parameters
with central differences. One reverse sweep produces *every* partial derivative
at a small constant multiple of the forward cost, regardless of N.

Values are numpy arrays, so a single tape covers every Monte Carlo path at
once. A scalar is just an array of shape ().
"""

from __future__ import annotations

import math

import numpy as np

_TAPE: "Tape | None" = None


class Tape:
    """Records operations, then replays them in reverse to accumulate adjoints."""

    def __init__(self):
        self.values: list[np.ndarray] = []
        # parents[i] = list of (parent_index, local_partial). The local partial
        # is d(node_i)/d(parent), evaluated at the forward values.
        self.parents: list[list[tuple[int, np.ndarray]]] = []

    def __enter__(self):
        global _TAPE
        self._prev = _TAPE
        _TAPE = self
        return self

    def __exit__(self, *_):
        global _TAPE
        _TAPE = self._prev

    def push(self, value, parents=()) -> int:
        self.values.append(np.asarray(value, dtype=float))
        self.parents.append(list(parents))
        return len(self.values) - 1

    def __len__(self) -> int:
        return len(self.values)

    def nbytes(self) -> int:
        v = sum(x.nbytes for x in self.values)
        p = sum(np.asarray(d).nbytes for ps in self.parents for _, d in ps)
        return v + p

    def backward(self, idx: int) -> list[np.ndarray]:
        """Adjoints of every node with respect to node `idx`.

        One reverse pass. Nodes are appended in evaluation order, so iterating
        backwards guarantees a node's adjoint is complete before it is used.
        """
        adj = [None] * len(self.values)
        adj[idx] = np.ones_like(self.values[idx])
        for i in range(idx, -1, -1):
            a = adj[i]
            if a is None:
                continue
            for p, local in self.parents[i]:
                contrib = _unbroadcast(a * local, self.values[p].shape)
                adj[p] = contrib if adj[p] is None else adj[p] + contrib
        return [np.zeros_like(v) if a is None else a for a, v in zip(adj, self.values)]


def _unbroadcast(x: np.ndarray, shape: tuple) -> np.ndarray:
    """Sum an adjoint back down to the shape of the node that produced it.

    A scalar input broadcast across 100,000 paths receives the sum of all
    100,000 path adjoints; without this the shapes silently disagree and the
    gradient is wrong rather than an error.
    """
    x = np.asarray(x, dtype=float)
    while x.ndim > len(shape):
        x = x.sum(axis=0)
    for ax, n in enumerate(shape):
        if n == 1 and x.shape[ax] != 1:
            x = x.sum(axis=ax, keepdims=True)
    return x


class Var:
    __slots__ = ("tape", "idx")
    __array_priority__ = 100.0     # so ndarray.__mul__ defers to Var.__rmul__

    def __init__(self, tape: Tape, idx: int):
        self.tape = tape
        self.idx = idx

    @property
    def value(self) -> np.ndarray:
        return self.tape.values[self.idx]

    def __repr__(self):
        return f"Var({self.value})"

    # -- construction --------------------------------------------------------

    @staticmethod
    def constant(x, tape: Tape | None = None) -> "Var":
        t = tape or _TAPE
        return Var(t, t.push(x))

    def _lift(self, other) -> "Var":
        return other if isinstance(other, Var) else Var(self.tape, self.tape.push(other))

    def _op(self, value, parents) -> "Var":
        return Var(self.tape, self.tape.push(value, parents))

    # -- arithmetic ----------------------------------------------------------

    def __add__(self, o):
        o = self._lift(o)
        return self._op(self.value + o.value,
                        [(self.idx, 1.0), (o.idx, 1.0)])

    __radd__ = __add__

    def __neg__(self):
        return self._op(-self.value, [(self.idx, -1.0)])

    def __sub__(self, o):
        o = self._lift(o)
        return self._op(self.value - o.value, [(self.idx, 1.0), (o.idx, -1.0)])

    def __rsub__(self, o):
        return self._lift(o) - self

    def __mul__(self, o):
        o = self._lift(o)
        return self._op(self.value * o.value,
                        [(self.idx, o.value), (o.idx, self.value)])

    __rmul__ = __mul__

    def __truediv__(self, o):
        o = self._lift(o)
        v = self.value / o.value
        return self._op(v, [(self.idx, 1.0 / o.value),
                            (o.idx, -self.value / (o.value ** 2))])

    def __rtruediv__(self, o):
        return self._lift(o) / self

    def __pow__(self, k: float):
        return self._op(self.value ** k, [(self.idx, k * self.value ** (k - 1))])

    # -- transcendental ------------------------------------------------------

    def exp(self):
        v = np.exp(self.value)
        return self._op(v, [(self.idx, v)])

    def log(self):
        return self._op(np.log(self.value), [(self.idx, 1.0 / self.value)])

    def sqrt(self):
        v = np.sqrt(self.value)
        return self._op(v, [(self.idx, 0.5 / v)])

    def norm_cdf(self):
        """Standard normal CDF. d/dx Phi(x) = phi(x)."""
        v = _phi_cdf(self.value)
        return self._op(v, [(self.idx, _phi_pdf(self.value))])

    # -- payoff / reduction --------------------------------------------------

    def relu(self):
        """max(x, 0).

        The derivative is the indicator 1{x>0}, which is where pathwise
        differentiation of a *discontinuous* payoff goes wrong — see
        `bench/digital.py`. For a continuous payoff like a vanilla call this is
        correct almost everywhere, and the kink at x=0 has measure zero.
        """
        v = np.maximum(self.value, 0.0)
        return self._op(v, [(self.idx, (self.value > 0).astype(float))])

    def mean(self):
        n = self.value.size
        return self._op(self.value.mean(), [(self.idx, np.full(self.value.shape, 1.0 / n))])

    def sum(self):
        return self._op(self.value.sum(), [(self.idx, np.ones_like(self.value))])


def _phi_cdf(x):
    return 0.5 * (1.0 + np.vectorize(math.erf)(np.asarray(x, dtype=float) / math.sqrt(2.0)))


def _phi_pdf(x):
    return np.exp(-0.5 * np.asarray(x, dtype=float) ** 2) / math.sqrt(2.0 * math.pi)


def grad(f, inputs: dict[str, float]):
    """Evaluate `f(**vars)` and return (value, {name: d value / d input}).

    One forward evaluation and one reverse sweep, whatever len(inputs) is.
    """
    tape = Tape()
    with tape:
        vars_ = {k: Var.constant(v, tape) for k, v in inputs.items()}
        out = f(**vars_)
        if not isinstance(out, Var):
            raise TypeError("function must return a Var")
        adj = tape.backward(out.idx)
    return float(out.value), {k: float(adj[v.idx]) for k, v in vars_.items()}, tape
