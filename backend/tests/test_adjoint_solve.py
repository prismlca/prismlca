"""The transposed solve behind every contribution tree shares the forward solve's factorisation.

pypardiso keeps ONE factorisation. Handed Aᵀ as a matrix of its own, the adjoint solve factorised it,
and the next forward solve factorised A again — about a second each on ecoinvent, twice per indicator
of every breakdown. Aᵀ handed over as CSC is A's own arrays, which pardiso solves transposed with the
factors it already holds. What has to hold: the numbers are the transposed system's, in both orders,
and neither direction throws the other's factorisation away.
"""
from __future__ import annotations

import numpy as np
import pytest
import scipy.sparse as sp
from scipy.sparse.linalg import spsolve as scipy_spsolve

pypardiso = pytest.importorskip("pypardiso")
from pypardiso import ps as pypardiso_solver  # noqa: E402

from prism_lca.engine import lca as lca_engine  # noqa: E402


class _Lca:
    """The two matrices `_adjoint_unit_impacts` reads, like a bw2calc LCA holds them (CSR)."""

    def __init__(self, technosphere: sp.csr_matrix, biosphere: sp.csr_matrix) -> None:
        self.technosphere_matrix = technosphere
        self.biosphere_matrix = biosphere


def _system(seed: int, n: int = 40, flows: int = 6) -> _Lca:
    rng = np.random.default_rng(seed)
    # Non-symmetric on purpose: for a symmetric A the transposed solve would pass with the wrong one.
    off = sp.random(n, n, density=0.15, random_state=rng, format="csr") * -0.3
    a = (sp.identity(n, format="csr") * 2.0 + off).tocsr()
    a.sort_indices()
    b = sp.random(flows, n, density=0.5, random_state=rng, format="csr")
    return _Lca(a, b)


@pytest.fixture
def factorisations(monkeypatch) -> list[int]:
    calls: list[int] = []
    real = pypardiso_solver.factorize

    def counting(matrix):
        calls.append(1)
        return real(matrix)

    monkeypatch.setattr(pypardiso_solver, "factorize", counting)
    return calls


def _expected(system: _Lca, cf: np.ndarray) -> np.ndarray:
    return scipy_spsolve(system.technosphere_matrix.T.tocsc(), system.biosphere_matrix.T.dot(cf))


def test_after_a_forward_solve_the_adjoint_reuses_its_factorisation(factorisations):
    system = _system(1)
    a = system.technosphere_matrix
    demand = np.zeros(a.shape[0])
    demand[0] = 1.0
    forward = pypardiso.spsolve(a, demand)  # what bw2calc's lci() does
    assert len(factorisations) == 1

    cfs = [np.linspace(0.5, 2.0, 6), np.arange(6, dtype=float)]
    u = lca_engine._adjoint_unit_impacts(system, [(("m", str(i)), cf) for i, cf in enumerate(cfs)])

    assert len(factorisations) == 1, "the adjoint solve factorised again"
    for j, cf in enumerate(cfs):
        np.testing.assert_allclose(u[:, j], _expected(system, cf), rtol=1e-10, atol=1e-12)
    # …and the forward factorisation is still the one the solver holds.
    np.testing.assert_allclose(pypardiso.spsolve(a, demand), forward, rtol=1e-12)
    assert len(factorisations) == 1


def test_an_adjoint_solve_first_leaves_factors_the_forward_solve_can_use(factorisations):
    """The other order: the solver held another matrix, the adjoint factorises — and a forward solve
    afterwards must read those factors as A's, not as Aᵀ's."""
    other = _system(7)
    pypardiso.spsolve(other.technosphere_matrix, np.ones(other.technosphere_matrix.shape[0]))
    system = _system(2)
    a = system.technosphere_matrix
    cf = np.linspace(1.0, 3.0, 6)

    u = lca_engine._adjoint_unit_impacts(system, [(("m",), cf)])
    np.testing.assert_allclose(u[:, 0], _expected(system, cf), rtol=1e-10, atol=1e-12)
    before = len(factorisations)

    demand = np.arange(a.shape[0], dtype=float)
    np.testing.assert_allclose(pypardiso.spsolve(a, demand), scipy_spsolve(a.tocsc(), demand), rtol=1e-10)
    assert len(factorisations) == before, "the forward solve factorised again"


def test_an_unsorted_wide_index_matrix_is_left_intact():
    """The solver sorts an unsorted matrix in place. On the transposed view SciPy may have narrowed
    int64 indices into a copy while sharing the values — sorting that view reordered A's values under
    A's own unchanged indices, and every later forward solve computed with a different matrix."""
    system = _system(4)
    a = system.technosphere_matrix
    for row in range(a.shape[0]):  # reverse every row: same matrix, unsorted storage
        start, end = a.indptr[row], a.indptr[row + 1]
        a.indices[start:end] = a.indices[start:end][::-1].copy()
        a.data[start:end] = a.data[start:end][::-1].copy()
    a.indices = a.indices.astype(np.int64)
    a.indptr = a.indptr.astype(np.int64)
    a.has_sorted_indices = False
    dense = a.toarray()
    cf = np.linspace(0.5, 1.5, 6)

    u = lca_engine._adjoint_unit_impacts(system, [(("m",), cf)])

    np.testing.assert_array_equal(a.toarray(), dense)
    np.testing.assert_allclose(u[:, 0], _expected(system, cf), rtol=1e-10, atol=1e-12)


def test_a_cached_column_is_not_solved_again(monkeypatch):
    system = _system(3)
    cf = np.ones(6)
    first = lca_engine._adjoint_unit_impacts(system, [(("m",), cf)])
    solves: list[int] = []
    real = pypardiso_solver.solve
    monkeypatch.setattr(pypardiso_solver, "solve", lambda *args: solves.append(1) or real(*args))
    again = lca_engine._adjoint_unit_impacts(system, [(("m",), cf)])
    np.testing.assert_array_equal(first, again)
    assert not solves
