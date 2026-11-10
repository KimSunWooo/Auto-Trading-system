"""Versioned local datasets — builtin synthetic + uploaded catalog entries."""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Tuple

from .dataset_catalog import BUILTIN, DatasetCatalog, DatasetSpec

# Back-compat alias for older imports.
DATASETS = BUILTIN

_catalog: Optional[DatasetCatalog] = None


def configure_catalog(
    store_root: Path | str,
    *,
    purge_temps: str = "ttl",
) -> DatasetCatalog:
    """Bind catalog to store root.

    purge_temps:
      - "force": delete all datasets/tmp (gRPC server boot — orphans from prior death)
      - "ttl": delete only temps older than TEMP_TTL_MS
      - "none": leave temps alone (workers must not wipe a live server upload)
    """
    global _catalog
    _catalog = DatasetCatalog(Path(store_root))
    if purge_temps == "force":
        _catalog.purge_stale_temps(force=True)
    elif purge_temps == "ttl":
        _catalog.purge_stale_temps()
    elif purge_temps != "none":
        raise ValueError(f"unknown purge_temps={purge_temps}")
    return _catalog


def get_catalog() -> DatasetCatalog:
    if _catalog is None:
        return configure_catalog(Path(__file__).resolve().parents[2] / ".bus" / "jobs")
    return _catalog


def resolve_dataset(dataset_id: str) -> Tuple[DatasetSpec, List[float], List[float], List[float]]:
    return get_catalog().load_ohlcv(dataset_id)


def list_dataset_ids() -> List[str]:
    return get_catalog().list_ids()
