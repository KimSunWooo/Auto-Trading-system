"""Versioned local datasets only — no arbitrary filesystem paths."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

from .optimizer import synthetic_series


@dataclass(frozen=True)
class DatasetSpec:
    dataset_id: str
    data_version: str
    description: str
    bars: int


# Fixed catalog. Clients must pass dataset_id from this set.
DATASETS: Dict[str, DatasetSpec] = {
    "synthetic-v0": DatasetSpec(
        dataset_id="synthetic-v0",
        data_version="synthetic-v0",
        description="Deterministic synthetic OHLCV for MA research (local fixture)",
        bars=120,
    ),
    "synthetic-v0-short": DatasetSpec(
        dataset_id="synthetic-v0-short",
        data_version="synthetic-v0-short",
        description="Shorter synthetic series for fast smoke jobs",
        bars=60,
    ),
}


def resolve_dataset(dataset_id: str) -> Tuple[DatasetSpec, List[float], List[float], List[float]]:
    spec = DATASETS.get(dataset_id)
    if spec is None:
        known = ", ".join(sorted(DATASETS))
        raise KeyError(f"unknown_dataset_id:{dataset_id}; allowed=[{known}]")
    closes, opens, lows = synthetic_series(spec.bars)
    return spec, closes, opens, lows


def list_dataset_ids() -> List[str]:
    return sorted(DATASETS)
