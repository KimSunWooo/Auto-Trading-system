"""Builtin + uploaded dataset catalog (file-backed under store/datasets)."""

from __future__ import annotations

import json
import os
import shutil
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .optimizer import synthetic_series
from .upload_limits import TEMP_TTL_MS


@dataclass(frozen=True)
class DatasetSpec:
    dataset_id: str
    data_version: str
    description: str
    bars: int
    source: str = "builtin"  # builtin | upload
    ticker: str = ""
    interval: str = ""
    content_hash: str = ""
    start_t_ms: int = 0
    end_t_ms: int = 0
    path: str = ""  # relative bars jsonl for uploads


BUILTIN: Dict[str, DatasetSpec] = {
    "synthetic-v0": DatasetSpec(
        dataset_id="synthetic-v0",
        data_version="synthetic-v0",
        description="Deterministic synthetic OHLCV for MA research (local fixture)",
        bars=120,
        source="builtin",
    ),
    "synthetic-v0-short": DatasetSpec(
        dataset_id="synthetic-v0-short",
        data_version="synthetic-v0-short",
        description="Shorter synthetic series for fast smoke jobs",
        bars=60,
        source="builtin",
    ),
}


class DatasetCatalog:
    def __init__(self, root: Path):
        self.root = root
        self.datasets_dir = root / "datasets"
        self.active_dir = self.datasets_dir / "active"
        self.temp_dir = self.datasets_dir / "tmp"
        self.index_path = self.datasets_dir / "catalog.json"
        self.hash_index_path = self.datasets_dir / "by-hash.json"
        self.datasets_dir.mkdir(parents=True, exist_ok=True)
        self.active_dir.mkdir(exist_ok=True)
        self.temp_dir.mkdir(exist_ok=True)
        if not self.index_path.exists():
            self._save_json(self.index_path, {})
        if not self.hash_index_path.exists():
            self._save_json(self.hash_index_path, {})

    @staticmethod
    def _save_json(path: Path, obj: Any) -> None:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(obj, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, path)

    def _load_json(self, path: Path) -> Any:
        return json.loads(path.read_text(encoding="utf-8"))

    def purge_stale_temps(self, now_ms: Optional[int] = None, *, force: bool = False) -> List[str]:
        """Remove incomplete upload sessions older than TEMP_TTL_MS (or all if force)."""
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        removed: List[str] = []
        if not self.temp_dir.exists():
            return removed
        for child in list(self.temp_dir.iterdir()):
            try:
                if not force:
                    meta_path = child / "session.json"
                    if meta_path.exists():
                        meta = self._load_json(meta_path)
                        created = int(meta.get("created_at_unix_ms") or 0)
                        if created and now - created < TEMP_TTL_MS:
                            continue
                shutil.rmtree(child, ignore_errors=True)
                removed.append(child.name)
            except OSError:
                continue
        return removed

    def list_ids(self) -> List[str]:
        uploaded = self._load_json(self.index_path)
        return sorted(set(BUILTIN) | set(uploaded))

    def get(self, dataset_id: str) -> DatasetSpec:
        if dataset_id in BUILTIN:
            return BUILTIN[dataset_id]
        uploaded = self._load_json(self.index_path)
        if dataset_id not in uploaded:
            raise KeyError(
                f"unknown_dataset_id:{dataset_id}; allowed=[{', '.join(self.list_ids())}]"
            )
        raw = uploaded[dataset_id]
        return DatasetSpec(**raw)

    def find_by_hash(self, content_hash: str) -> Optional[DatasetSpec]:
        by_hash = self._load_json(self.hash_index_path)
        dataset_id = by_hash.get(content_hash)
        if not dataset_id:
            return None
        try:
            return self.get(dataset_id)
        except KeyError:
            return None

    def register_upload(self, spec: DatasetSpec, bars_path: Path) -> DatasetSpec:
        """Atomically promote bars into active catalog. Idempotent on content_hash."""
        existing = self.find_by_hash(spec.content_hash) if spec.content_hash else None
        if existing is not None:
            return existing

        dest_dir = self.active_dir / spec.dataset_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_bars = dest_dir / "bars.jsonl"
        if bars_path.resolve() != dest_bars.resolve():
            shutil.copyfile(bars_path, dest_bars)
        final = DatasetSpec(
            dataset_id=spec.dataset_id,
            data_version=spec.data_version,
            description=spec.description,
            bars=spec.bars,
            source="upload",
            ticker=spec.ticker,
            interval=spec.interval,
            content_hash=spec.content_hash,
            start_t_ms=spec.start_t_ms,
            end_t_ms=spec.end_t_ms,
            path=str(dest_bars.relative_to(self.root)),
        )
        uploaded = self._load_json(self.index_path)
        uploaded[final.dataset_id] = asdict(final)
        self._save_json(self.index_path, uploaded)
        by_hash = self._load_json(self.hash_index_path)
        by_hash[final.content_hash] = final.dataset_id
        self._save_json(self.hash_index_path, by_hash)
        return final

    def load_ohlcv(self, dataset_id: str) -> Tuple[DatasetSpec, List[float], List[float], List[float]]:
        spec = self.get(dataset_id)
        if spec.source == "builtin":
            closes, opens, lows = synthetic_series(spec.bars)
            return spec, closes, opens, lows
        bars_path = self.root / spec.path if spec.path else self.active_dir / dataset_id / "bars.jsonl"
        opens: List[float] = []
        highs_unused: List[float] = []
        lows: List[float] = []
        closes: List[float] = []
        with bars_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                opens.append(float(row["open"]))
                highs_unused.append(float(row["high"]))
                lows.append(float(row["low"]))
                closes.append(float(row["close"]))
        return spec, closes, opens, lows


# Back-compat module-level helpers used by older imports.
DATASETS = BUILTIN


def list_dataset_ids(catalog: Optional[DatasetCatalog] = None) -> List[str]:
    if catalog is None:
        return sorted(BUILTIN)
    return catalog.list_ids()
