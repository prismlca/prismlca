"""The Typst compiler runs in worker processes: offline, and within a time, memory and output budget."""
from __future__ import annotations

import os
import socket
import sys
import threading
import time

import pytest

from prism_lca.engine import typst_render, typst_worker
from prism_lca.errors import PrismError

_PROXY_VARIABLES = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")


@pytest.fixture
def fresh_workers():
    """Workers started for this test only, so a changed limit reaches them and leaves with them."""
    typst_worker.shutdown()
    yield
    typst_worker.shutdown()


def _refused_on_this_machine(exc: PrismError) -> None:
    """The compiler's own message under the refusal: the download ended at a loopback port that does not
    listen — not at a name lookup, and not at a server."""
    cause = str(exc.__cause__ or "").lower()
    assert "failed to download package" in cause
    assert "refused" in cause and "dns" not in cause, cause


@pytest.mark.parametrize(
    "line",
    [
        '#import "@preview/example:0.1.0": *',
        '#include "@preview/example:0.1.0"',
        '#let spec = "@pre" + "view/example:0.1.0"\n#import spec: *',
    ],
)
def test_a_package_import_is_refused_without_leaving_the_machine(line, fresh_workers):
    with pytest.raises(PrismError) as exc:
        typst_render.compile_pdf({"main.typ": line + "\nText.\n"})
    assert exc.value.code == "typst_package_import"
    assert "main.typ, line" in (exc.value.hint or "")
    _refused_on_this_machine(exc.value)


def test_a_theme_that_imports_a_package_is_refused_on_upload(client, token, project):
    source = '#import "@preview/example:0.1.0": *\n' + typst_render.default_template_source()
    r = client.post("/api/v1/report/templates", json={"name": "with-package", "source": source}, headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "typst_package_import"
    # The same theme without the import uploads (every shipped theme is validated in test_report_templates).
    source = typst_render.default_template_source()
    r = client.post("/api/v1/report/templates", json={"name": "without-package", "source": source}, headers=token)
    assert r.status_code == 200, r.text


def _example_package(root) -> None:
    """A package `@preview/example:0.1.0` as Typst lays one out on disk."""
    folder = root / "preview" / "example" / "0.1.0"
    folder.mkdir(parents=True)
    (folder / "typst.toml").write_text(
        '[package]\nname = "example"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n', encoding="utf-8"
    )
    (folder / "lib.typ").write_text("#let greeting = [Hello]\n", encoding="utf-8")


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="the XDG directories are Linux's")
def test_packages_in_the_users_typst_directories_are_not_used(tmp_path, monkeypatch, fresh_workers):
    import typst

    for kind in ("data", "cache"):
        _example_package(tmp_path / kind / "typst" / "packages")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    (tmp_path / "doc").mkdir()
    main = tmp_path / "doc" / "main.typ"
    main.write_text('#import "@preview/example:0.1.0": greeting\n#greeting\n', encoding="utf-8")

    # The fixture is a package Typst finds on its own: compiled directly, it resolves from those
    # directories. Proxies point at a closed loopback port meanwhile, so nothing could leave either way.
    closed = socket.socket()
    closed.bind(("127.0.0.1", 0))
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    for name in _PROXY_VARIABLES:
        monkeypatch.setenv(name, f"http://127.0.0.1:{closed.getsockname()[1]}")
    try:
        assert typst.compile(str(main), root=str(main.parent)).startswith(b"%PDF")
    finally:
        closed.close()

    with pytest.raises(PrismError) as exc:
        typst_render.compile_pdf({"main.typ": main.read_text(encoding="utf-8")})
    assert exc.value.code == "typst_package_import"


def test_the_backends_own_environment_is_left_as_it_was(fresh_workers):
    before = {name: os.environ.get(name) for name in (*_PROXY_VARIABLES, "NO_PROXY", "no_proxy")}
    assert typst_render.compile_pdf({"main.typ": "Text.\n"}).startswith(b"%PDF")
    assert {name: os.environ.get(name) for name in before} == before


def test_a_compile_over_its_time_limit_is_stopped_and_the_next_one_works(monkeypatch, fresh_workers):
    monkeypatch.setattr(typst_worker, "TIME_LIMIT_S", 1.0)
    started = time.monotonic()
    with pytest.raises(PrismError) as exc:
        typst_render.compile_pdf(
            {"main.typ": "#let s = 0\n#for i in range(100000) { for j in range(100000) { s += 1 } }\n#s\n"}
        )
    assert exc.value.code == "typst_timeout"
    assert time.monotonic() - started < 10
    assert typst_render.compile_pdf({"main.typ": "Text.\n"}).startswith(b"%PDF")


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads its memory from /proc")
def test_a_compile_over_its_memory_limit_is_stopped_and_the_next_one_works(monkeypatch, fresh_workers):
    monkeypatch.setattr(typst_worker, "MEMORY_LIMIT", 400 * 1024**2)
    with pytest.raises(PrismError) as exc:
        typst_render.compile_pdf(
            {"main.typ": '#let a = "x" * 268435456\n#let b = a + a\n#let c = b + b\n#c.len()\n'}
        )
    assert exc.value.code == "typst_out_of_memory"
    assert typst_render.compile_pdf({"main.typ": "Text.\n"}).startswith(b"%PDF")


def test_a_result_over_the_output_limit_is_refused(monkeypatch, fresh_workers):
    monkeypatch.setattr(typst_worker, "OUTPUT_LIMIT", 10_000)
    with pytest.raises(PrismError) as exc:
        typst_render.compile_png({"main.typ": "#for i in range(40) [Page #i #pagebreak()]\n"}, ppi=48)
    assert exc.value.code == "typst_output_too_large"


@pytest.mark.parametrize("message", ['"x" * 1000000', '"line\\n" * 200000'])
def test_a_compiler_error_comes_back_at_a_bounded_size_and_still_located(message, fresh_workers):
    started = time.monotonic()
    with pytest.raises(PrismError) as exc:
        typst_render.compile_pdf({"main.typ": f"= Results\n#panic({message})\n"})
    assert exc.value.code == "typst_compile_failed"
    assert len(exc.value.message) < 3000
    assert "main.typ, line 2" in exc.value.hint and "Results" in exc.value.hint
    assert time.monotonic() - started < 15
    assert typst_render.compile_pdf({"main.typ": "Text.\n"}).startswith(b"%PDF")


def test_compiles_run_side_by_side(fresh_workers):
    results: list[bytes] = []

    def one(n: int) -> None:
        results.append(typst_render.compile_pdf({"main.typ": f"Document {n}.\n"}))

    threads = [threading.Thread(target=one, args=(n,)) for n in range(typst_worker.WORKERS + 2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(results) == len(threads) and all(pdf.startswith(b"%PDF") for pdf in results)
