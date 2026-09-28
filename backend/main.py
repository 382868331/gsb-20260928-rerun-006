from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import zipfile
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .imaging import (
    ImportError,
    MeasurementRequest,
    distance_mm,
    import_manifest,
    list_volumes,
    load_volume,
    slice_plane,
)
from .samples import create_invalid_samples, create_valid_sample

DATA_ROOT = Path(os.environ.get("IMAGING_DATA_ROOT", Path(__file__).resolve().parent.parent / "data"))
VOLUME_ROOT = DATA_ROOT / "volumes"
SESSION_ROOT = DATA_ROOT / "sessions"
VOLUME_ROOT.mkdir(parents=True, exist_ok=True)
SESSION_ROOT.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="人工医学影像研究工作站", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SessionPayload(BaseModel):
    image_id: str
    state: dict


def _png_base64(array: np.ndarray) -> str:
    from PIL import Image

    buffer = io.BytesIO()
    Image.fromarray(array, mode="L").save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "content_domain": "synthetic research phantom"}


@app.post("/api/samples/valid")
def import_built_in_valid_sample() -> dict:
    return create_valid_sample(DATA_ROOT)


@app.get("/api/samples/invalid/checks")
def check_invalid_samples() -> dict:
    paths = create_invalid_samples(DATA_ROOT)
    checks = {}
    for name, path in paths.items():
        try:
            import_manifest(path, VOLUME_ROOT)
            checks[name] = {"accepted": True, "message": "错误：异常资料被接受"}
        except ImportError as exc:
            checks[name] = {"accepted": False, "message": str(exc)}
    return checks


@app.get("/api/images")
def images() -> list[dict]:
    return list_volumes(VOLUME_ROOT)


@app.get("/api/images/{image_id}")
def image_detail(image_id: str) -> dict:
    try:
        volume = load_volume(VOLUME_ROOT, image_id)
    except (FileNotFoundError, KeyError) as exc:
        raise HTTPException(status_code=404, detail="影像不存在") from exc
    return volume.identity


@app.post("/api/import/zip")
async def import_zip(archive: UploadFile) -> dict:
    if not archive.filename or not archive.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="请上传包含 manifest.json 的 ZIP 影像组")
    with tempfile.TemporaryDirectory(dir=DATA_ROOT) as temp_name:
        temp_dir = Path(temp_name)
        zip_path = temp_dir / "upload.zip"
        zip_path.write_bytes(await archive.read())
        extract_dir = temp_dir / "extracted"
        try:
            with zipfile.ZipFile(zip_path) as archive_file:
                for member in archive_file.infolist():
                    member_path = Path(member.filename)
                    if member_path.is_absolute() or ".." in member_path.parts:
                        raise HTTPException(status_code=400, detail="ZIP 包含不安全路径")
                archive_file.extractall(extract_dir)
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="ZIP 文件无法读取") from exc
        candidates = [extract_dir]
        candidates.extend(path for path in extract_dir.iterdir() if path.is_dir())
        for candidate in candidates:
            if (candidate / "manifest.json").is_file():
                try:
                    volume = import_manifest(candidate, VOLUME_ROOT)
                except ImportError as exc:
                    raise HTTPException(status_code=422, detail=str(exc)) from exc
                return volume.identity
    raise HTTPException(status_code=422, detail="ZIP 内未找到 manifest.json")


@app.get("/api/images/{image_id}/slice/{axis}/{index}")
def get_slice(image_id: str, axis: int, index: int) -> dict:
    try:
        volume = load_volume(VOLUME_ROOT, image_id)
        array = slice_plane(volume, axis, index)
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (FileNotFoundError, KeyError) as exc:
        raise HTTPException(status_code=404, detail="影像不存在") from exc
    return {
        "image_id": image_id,
        "axis": axis,
        "index": index,
        "width": int(array.shape[1]),
        "height": int(array.shape[0]),
        "png_base64": _png_base64(array),
    }


@app.post("/api/images/{image_id}/measurements")
def create_measurement(image_id: str, request: MeasurementRequest) -> dict:
    try:
        volume = load_volume(VOLUME_ROOT, image_id)
        return distance_mm(volume, tuple(request.point_a.ijk), tuple(request.point_b.ijk))
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (FileNotFoundError, KeyError) as exc:
        raise HTTPException(status_code=404, detail="影像不存在") from exc


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str) -> dict:
    path = SESSION_ROOT / f"{session_id}.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="会话不存在")
    return json.loads(path.read_text(encoding="utf-8"))


@app.put("/api/sessions/{session_id}")
def save_session(session_id: str, payload: SessionPayload) -> dict:
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    if not session_id or any(char not in allowed for char in session_id):
        raise HTTPException(status_code=400, detail="会话编号只能包含字母、数字、-、_")
    try:
        load_volume(VOLUME_ROOT, payload.image_id)
    except (FileNotFoundError, KeyError) as exc:
        raise HTTPException(status_code=404, detail="无法保存到未知影像身份") from exc
    document = {"session_id": session_id, "image_id": payload.image_id, "state": payload.state}
    path = SESSION_ROOT / f"{session_id}.json"
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    return document
