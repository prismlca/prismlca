"""The inventory step of the ecoinvent import: reading, linking and writing the datasets, with a count
and a way to stop.

bw2io's ``Ecospold2DataExtractor.extract`` reads the files in a process pool as well, but it reports
only to a terminal progress bar, waits on its workers without a limit and cannot be stopped: a worker
that never reaches its task leaves the import waiting forever. ``SingleOutputEcospold2Importer`` takes
its extractor as a parameter, so :func:`reader` hands it a subclass that replaces ``extract`` and
nothing else — reading one file stays bw2io's ``extract_activity``. :func:`import_inventory` then
applies the importer's strategies one at a time, so a cancel also lands between them; the write itself
runs to its end once begun.
"""

from __future__ import annotations

import multiprocessing
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path

from prism_lca.engine.bootstrap import get_bd, get_bi
from prism_lca.errors import PrismError

#: Without one finished dataset for this long, the workers are taken as stuck. Reading one file takes
#: well under a second; the first result also waits for the workers to start, which on Windows means
#: a fresh process that loads bw2io.
STALL_SECONDS = 300.0


class ImportCancelled(Exception):
    """The user stopped the import before anything was written."""


def worker_count() -> int:
    """One core stays free for the window and the server. Capped at eight: every worker is a process
    with its own copy of the libraries, and a large machine would otherwise pay that many times."""
    return max(1, min(8, (os.cpu_count() or 2) - 1))


def prepare_worker() -> None:
    """Pool initializer for workers that load bw2io. A fresh worker (``spawn``: always on Windows and
    macOS) starts in bw2data's ``default`` workspace, and importing bw2io creates that workspace's
    ``unlinked`` folder by checking first and creating after: two workers starting together can both find
    it missing, and the second one crashes with ``FileExistsError``. Here a folder that already exists is
    fine, so creating it first takes the race away."""
    (get_bd().projects.dir / "unlinked").mkdir(exist_ok=True)


def dataset_files(dirpath: Path) -> list[str]:
    """The ``.spold`` files of a ``datasets`` folder, sorted so every run reads them in one order."""
    files = sorted(
        entry.name
        for entry in os.scandir(dirpath)
        if entry.is_file() and entry.name.lower().endswith(".spold")
    )
    if not files:
        raise PrismError(
            f"No ecoSpold-2 datasets (.spold files) in {dirpath}.",
            code="no_datasets",
            hint="Choose the extracted release folder or the 'datasets' folder inside it. The "
            "downloaded .7z archive has to be extracted first.",
        )
    return files


#: Files per task. One file per task would send 26 000 messages each way; a batch also keeps the
#: count moving in steps small enough to watch.
BATCH = 16


class _Unreadable(Exception):
    """A file a worker could not read, named, so the error can say which one."""


def _read_one(job: tuple[str, str, str, bool, bool]) -> dict:
    """One file. Module level, so a spawned worker can import it."""
    get_bi()  # the data directory is set before bw2data loads, in the worker as in the server
    from bw2io.extractors.ecospold2 import Ecospold2DataExtractor

    dirpath, filename, db_name, cache, collapse_comments = job
    return Ecospold2DataExtractor.extract_activity(
        dirpath, filename, db_name, cache=cache, collapse_comments=collapse_comments
    )


def _read_batch(batch: list[tuple[str, str, str, bool, bool]]) -> list[dict]:
    """One task of the pool: a few files in order."""
    out = []
    for job in batch:
        try:
            out.append(_read_one(job))
        except Exception as exc:
            raise _Unreadable(f"{job[1]}: {type(exc).__name__}: {exc}") from None
    return out


def _unreadable(exc: Exception) -> PrismError:
    return PrismError(
        f"Could not read {exc}",
        code="dataset_unreadable",
        hint="Nothing was written. The file may be damaged — extract the release again and repeat "
        "the import.",
    )


def reader(
    on_progress: Callable[[int, int], None],
    cancelled: threading.Event,
    stall_seconds: float = STALL_SECONDS,
) -> type:
    """An extractor class for ``SingleOutputEcospold2Importer(extractor=…)``: it calls
    ``on_progress(done, total)`` as datasets come in and raises :class:`ImportCancelled` within about a
    second of ``cancelled`` being set."""
    from bw2io.extractors.ecospold2 import Ecospold2DataExtractor

    class Reader(Ecospold2DataExtractor):
        @classmethod
        def extract(cls, dirpath, db_name, use_mp=True, cache=False, collapse_comments=True):
            files = dataset_files(Path(dirpath))
            total = len(files)
            on_progress(0, total)
            jobs = [(str(dirpath), name, db_name, cache, collapse_comments) for name in files]
            batches = [jobs[i : i + BATCH] for i in range(0, total, BATCH)]
            data: list[dict] = []
            if not use_mp:
                for batch in batches:
                    if cancelled.is_set():
                        raise ImportCancelled
                    try:
                        data += _read_batch(batch)
                    except _Unreadable as exc:
                        raise _unreadable(exc) from exc
                    on_progress(len(data), total)
                return data
            # Leaving the block terminates the pool, so a cancel or an error stops every worker.
            # imap with the default chunk size of one is the form whose next() takes a timeout.
            with multiprocessing.Pool(processes=worker_count(), initializer=prepare_worker) as pool:
                results = pool.imap(_read_batch, batches)
                last = time.monotonic()
                while len(data) < total:
                    if cancelled.is_set():
                        raise ImportCancelled
                    try:
                        data += results.next(timeout=1.0)
                    except multiprocessing.TimeoutError:
                        if time.monotonic() - last > stall_seconds:
                            raise PrismError(
                                f"Reading the datasets stalled: none finished for "
                                f"{stall_seconds / 60:.0f} minutes ({len(data):,} of {total:,} read).",
                                code="import_stalled",
                                hint="Nothing was written. Start the import again; if it stalls "
                                "again, report it together with the PrismLCA log.",
                            ) from None
                        continue
                    except _Unreadable as exc:
                        raise _unreadable(exc) from exc
                    last = time.monotonic()
                    on_progress(len(data), total)
            return data

    return Reader


def import_inventory(
    ecospold2_dir: Path,
    database: str,
    *,
    biosphere: str,
    complete_key: str,
    use_mp: bool,
    cancelled: threading.Event,
    update: Callable[..., None],
    begin_writing: Callable[..., None],
) -> int:
    """Read, link and write ``database`` from the release's ``datasets`` folder; returns how many
    activities it holds. ``update`` receives the status fields to set while reading and linking;
    ``begin_writing`` sets them as the write begins and raises :class:`ImportCancelled` if a cancel came
    in first — one decision, so a cancel is never accepted and then ignored. Progress runs from 0.05 to
    0.78 of the whole job."""
    if cancelled.is_set():  # clicked while the biosphere was built
        raise ImportCancelled
    bd, bi = get_bd(), get_bi()

    def reading(done: int, total: int) -> None:
        update(detail=f"Reading datasets: {done:,} of {total:,}", progress=0.05 + 0.55 * done / max(total, 1))

    importer = bi.SingleOutputEcospold2Importer(
        str(ecospold2_dir),
        database,
        biosphere_database_name=biosphere,
        use_mp=use_mp,
        extractor=reader(reading, cancelled),
    )
    strategies = list(importer.strategies)
    for i, strategy in enumerate(strategies, 1):
        if cancelled.is_set():
            raise ImportCancelled
        update(
            detail=f"Linking datasets: step {i} of {len(strategies)}",
            progress=0.60 + 0.15 * i / len(strategies),
        )
        importer.apply_strategy(strategy, verbose=False)
    if not importer.all_linked:
        unlinked = importer.statistics()[2]
        raise PrismError(
            f"{unlinked} unlinked exchanges — nothing was written.",
            code="inventory_unlinked",
            hint="The datasets and the flow list must come from the same ecoinvent release.",
        )
    begin_writing(
        step="writing",
        detail=f"Writing {len(importer.data):,} datasets — a write cannot be cancelled…",
        progress=0.78,
    )
    importer.write_database(searchable=False)  # PrismLCA has its own index — see engine/hygiene.py
    bd.databases[database][complete_key] = True
    bd.databases.flush()
    return len(bd.Database(database))
