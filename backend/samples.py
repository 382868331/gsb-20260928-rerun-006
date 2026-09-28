from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

from .imaging import import_manifest


def _save_phantom(
    source_dir: Path,
    *,
    missing_slice: bool = False,
    conflict: bool = False,
    recreate: bool = False,
) -> Path:
    source_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = source_dir / "manifest.json"
    if recreate and (source_dir / "slices").exists():
        shutil.rmtree(source_dir / "slices")
    if recreate and manifest_path.exists():
        manifest_path.unlink()
    slices_dir = source_dir / "slices"
    slices_dir.mkdir(exist_ok=True)
    shape = (9, 13, 17)
    spacing = (1.5, 2.0, 2.5)
    origin = (3.0, -2.0, 1.0)
    direction = [
        [-1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, -1.0],
    ]
    grid = np.indices(shape[1:], dtype=float)
    yy = (grid[0] - shape[1] / 2) * spacing[1]
    xx = (grid[1] - shape[2] / 2) * spacing[2]
    ellipse = ((xx / 8.0) ** 2 + (yy / 6.0) ** 2) <= 1.0
    cavity = ((xx / 3.2) ** 2 + (yy / 2.2) ** 2) <= 1.0
    manifest_slices = []
    for k in range(shape[0]):
        z_physical = (k - shape[0] / 2) * spacing[0]
        axial = np.full(shape[1:], 18, dtype=np.uint8)
        axial[ellipse] = 150
        axial[np.abs(z_physical) < 4.8] += 35
        axial[cavity] = 5
        axial += ((grid[0] + grid[1] + k) % 7).astype(np.uint8)
        file_name = f"slices/slice_{k:03d}.png"
        Image.fromarray(axial, mode="L").save(source_dir / file_name)
        per_slice_direction = direction
        if conflict and k == shape[0] // 2:
            per_slice_direction = [
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, -1.0],
            ]
        manifest_slices.append(
            {
                "index": k,
                "file": file_name,
                "direction_xyz_from_ijk": per_slice_direction,
            }
        )
    if missing_slice and manifest_slices:
        missing = manifest_slices.pop(shape[0] // 2)
        (source_dir / missing["file"]).unlink()
    manifest = {
        "image_id": "synthetic-cavity-flipped-aniso-001",
        "name": "人工空腔各向异性翻转模体",
        "shape": list(shape),
        "voxel_spacing_mm": list(spacing),
        "origin_mm": list(origin),
        "direction_xyz_from_ijk": direction,
        "slices": manifest_slices,
        "synthetic": True,
    }
    (source_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return source_dir

def create_valid_sample(data_root: Path, *, recreate: bool = False) -> dict:
    data_root = Path(data_root)
    source_dir = data_root / "sample_sources" / "valid_phantom"
    if recreate and source_dir.exists():
        shutil.rmtree(source_dir)
    if not (source_dir / "manifest.json").exists():
        _save_phantom(source_dir)
    volume = import_manifest(source_dir, data_root / "volumes")
    return volume.identity

def create_invalid_samples(data_root: Path) -> dict[str, Path]:
    root = Path(data_root) / "sample_sources"
    missing = _save_phantom(root / "missing_slice", missing_slice=True, recreate=True)
    conflict = _save_phantom(root / "orientation_conflict", conflict=True, recreate=True)
    return {"missing_slice": missing, "orientation_conflict": conflict}
