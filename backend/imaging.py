from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from pydantic import BaseModel, Field


class SliceReference(BaseModel):
    index: int = Field(ge=0)
    file: str
    direction_xyz_from_ijk: list[list[float]] | None = None


class ImageManifest(BaseModel):
    image_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    shape: tuple[int, int, int] = Field(min_length=3, max_length=3)
    voxel_spacing_mm: tuple[float, float, float]
    origin_mm: tuple[float, float, float] = (0.0, 0.0, 0.0)
    direction_xyz_from_ijk: list[list[float]]
    slices: list[SliceReference]
    synthetic: bool = True

class VoxelPoint(BaseModel):
    ijk: tuple[int, int, int]

class MeasurementRequest(BaseModel):
    label: str = "空间距离"
    point_a: VoxelPoint
    point_b: VoxelPoint

@dataclass(frozen=True)
class Volume:
    identity: dict[str, Any]
    affine_ijk_to_xyz: np.ndarray
    data: np.ndarray

    @property
    def shape(self) -> tuple[int, int, int]:
        return tuple(int(v) for v in self.data.shape)

    @property
    def spacing(self) -> tuple[float, float, float]:
        return tuple(float(v) for v in self.identity["voxel_spacing_mm"])

class ImportError(ValueError):
    pass

def direction_to_affine(
    shape: tuple[int, int, int],
    spacing: tuple[float, float, float],
    origin_xyz: tuple[float, float, float],
    direction_xyz_from_ijk: np.ndarray,
) -> np.ndarray:
    if any(v <= 0 for v in shape):
        raise ImportError("影像维度必须为正数")
    if any(v <= 0 for v in spacing):
        raise ImportError("体素间距必须为正数")
    d = np.asarray(direction_xyz_from_ijk, dtype=float)
    if d.shape != (3, 3):
        raise ImportError("方向矩阵必须是 3×3")
    if not np.allclose(d @ d.T, np.eye(3), atol=1e-5):
        raise ImportError("方向矩阵必须正交")
    nonzero = d[np.abs(d) > 1e-8]
    if nonzero.size != 3 or not np.allclose(np.abs(nonzero), 1.0, atol=1e-5):
        raise ImportError("方向矩阵必须是带符号的轴排列")
    affine = np.eye(4)
    affine[:3, :3] = d @ np.diag(np.asarray(spacing, dtype=float))
    affine[:3, 3] = np.asarray(origin_xyz, dtype=float)
    return affine

def _nearly_equal_matrix(a: Any, b: np.ndarray) -> bool:
    if a is None:
        return False
    return np.allclose(np.asarray(a, dtype=float), b, atol=1e-5)

def import_manifest(source_dir: Path, destination_root: Path) -> Volume:
    source_dir = Path(source_dir)
    manifest_path = source_dir / "manifest.json"
    if not manifest_path.is_file():
        raise ImportError("缺少 manifest.json")
    try:
        manifest = ImageManifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ImportError(f"影像资料清单无效: {exc}") from exc

    shape = tuple(manifest.shape)
    spacing = tuple(float(v) for v in manifest.voxel_spacing_mm)
    direction = np.asarray(manifest.direction_xyz_from_ijk, dtype=float)
    affine = direction_to_affine(shape, spacing, tuple(manifest.origin_mm), direction)

    expected = {slice_item.index: slice_item for slice_item in manifest.slices}
    if set(expected) != set(range(shape[0])):
        raise ImportError("层片编号缺失、重复或超出范围，已阻止拼装")
    planes: list[np.ndarray] = []
    for index in range(shape[0]):
        item = expected[index]
        if (
            item.direction_xyz_from_ijk is not None
            and not _nearly_equal_matrix(item.direction_xyz_from_ijk, direction)
        ):
            raise ImportError(f"第 {index} 层方向资料与影像组方向冲突，已阻止拼装")
        path = source_dir / item.file
        if not path.is_file():
            raise ImportError(f"缺少层片文件: {item.file}")
        try:
            image = Image.open(path)
            array = np.asarray(image, dtype=np.uint8)
        except Exception as exc:
            raise ImportError(f"第 {index} 层无法读取") from exc
        if array.shape != shape[1:]:
            raise ImportError(f"第 {index} 层尺寸与清单不一致，已阻止拼装")
        planes.append(array)

    volume_data = np.stack(planes, axis=0).astype(np.uint8)
    safe_id = uuid.uuid5(uuid.NAMESPACE_URL, f"synthetic-imaging:{manifest.image_id}").hex
    target_dir = Path(destination_root) / safe_id
    target_dir.mkdir(parents=True, exist_ok=True)
    identity = {
        "image_id": safe_id,
        "source_image_id": manifest.image_id,
        "name": manifest.name,
        "shape": list(shape),
        "voxel_spacing_mm": list(spacing),
        "origin_mm": list(manifest.origin_mm),
        "direction_xyz_from_ijk": direction.tolist(),
        "affine_ijk_to_xyz": affine.tolist(),
        "synthetic": manifest.synthetic,
        "content_domain": "synthetic research phantom",
        "diagnostic_conclusions": [],
    }
    np.savez_compressed(target_dir / "volume.npz", data=volume_data)
    (target_dir / "identity.json").write_text(
        json.dumps(identity, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return Volume(identity=identity, affine_ijk_to_xyz=affine, data=volume_data)

def load_volume(root: Path, image_id: str) -> Volume:
    path = Path(root) / image_id
    identity = json.loads((path / "identity.json").read_text(encoding="utf-8"))
    data = np.load(path / "volume.npz")["data"]
    affine = np.asarray(identity["affine_ijk_to_xyz"], dtype=float)
    return Volume(identity=identity, affine_ijk_to_xyz=affine, data=data)

def list_volumes(root: Path) -> list[dict[str, Any]]:
    root = Path(root)
    if not root.is_dir():
        return []
    result = []
    for path in sorted(root.iterdir()):
        identity_path = path / "identity.json"
        if identity_path.is_file():
            result.append(json.loads(identity_path.read_text(encoding="utf-8")))
    return result

def validate_ijk(volume: Volume, ijk: tuple[int, int, int]) -> None:
    if any(value < 0 or value >= bound for value, bound in zip(ijk, volume.shape)):
        raise IndexError("点超出影像边界")

def ijk_to_xyz(affine: np.ndarray, ijk: tuple[int, int, int]) -> tuple[float, float, float]:
    point = affine @ np.asarray([*ijk, 1.0], dtype=float)
    return tuple(float(v) for v in point[:3])

def distance_mm(volume: Volume, a: tuple[int, int, int], b: tuple[int, int, int]) -> dict[str, Any]:
    validate_ijk(volume, a)
    validate_ijk(volume, b)
    pa = np.asarray(ijk_to_xyz(volume.affine_ijk_to_xyz, a))
    pb = np.asarray(ijk_to_xyz(volume.affine_ijk_to_xyz, b))
    return {
        "point_a_ijk": list(a),
        "point_b_ijk": list(b),
        "point_a_xyz_mm": [round(v, 6) for v in pa.tolist()],
        "point_b_xyz_mm": [round(v, 6) for v in pb.tolist()],
        "distance_mm": round(float(np.linalg.norm(pb - pa)), 6),
    }

def slice_plane(volume: Volume, axis: int, index: int) -> np.ndarray:
    if axis not in (0, 1, 2):
        raise IndexError("切片轴必须是 0、1 或 2")
    if index < 0 or index >= volume.shape[axis]:
        raise IndexError("切片索引超出范围")
    return np.asarray(volume.data.take(index, axis=axis), dtype=np.uint8)
