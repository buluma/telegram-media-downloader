from __future__ import annotations

import base64
import json
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, status
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field, model_validator

from . import __version__

_RUNTIME_ERROR: str | None = None
_THREAD_POOL_CREATED = False

try:
    import immich_ml.main as _ml_runtime
    from immich_ml.config import settings as _ml_settings
    from immich_ml.schemas import ModelTask, ModelType
except Exception as exc:  # pragma: no cover - exercised in non-ml-runtime dev envs
    _ml_runtime = None  # type: ignore[assignment]
    _ml_settings = None  # type: ignore[assignment]
    ModelTask = None  # type: ignore[assignment]
    ModelType = None  # type: ignore[assignment]
    _RUNTIME_ERROR = f"ml runtime import failed: {type(exc).__name__}: {exc}"


DEFAULT_CLIP_MODEL = "ViT-B-32__openai"
DEFAULT_FACE_MODEL = "buffalo_l"
DEFAULT_OCR_MODEL = "PP-OCRv5_mobile"


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip() or default


def _clip_model() -> str:
    return _env("TGDL_ML_CLIP_MODEL", _env("MACHINE_LEARNING_CLIP_MODEL", DEFAULT_CLIP_MODEL))


def _face_model() -> str:
    return _env("TGDL_ML_FACE_MODEL", _env("MACHINE_LEARNING_FACE_MODEL", DEFAULT_FACE_MODEL))


def _ocr_model() -> str:
    return _env("TGDL_ML_OCR_MODEL", _env("MACHINE_LEARNING_OCR_MODEL", DEFAULT_OCR_MODEL))


def _allow_roots() -> list[Path]:
    raw = os.environ.get("TGDL_ML_ALLOW_ROOTS") or os.environ.get("TGDL_FACES_ALLOW_ROOTS") or ""
    roots: list[Path] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        roots.append(Path(item).expanduser().resolve())
    return roots


def _is_allowed(path: Path) -> bool:
    roots = _allow_roots()
    if not roots:
        return False
    try:
        resolved = path.expanduser().resolve()
    except OSError:
        return False
    return any(resolved == root or root in resolved.parents for root in roots)


def _error(message: str, code: str, status_code: int) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": message, "code": code})


def _embedding_from_wire(value: Any) -> list[float]:
    if isinstance(value, str):
        value = json.loads(value)
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, list) or not value:
        raise ValueError("embedding is missing or empty")
    return [float(x) for x in value]


def _jsonable(value: Any) -> Any:
    if hasattr(value, "tolist"):
        return value.tolist()
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


class ImageRequest(BaseModel):
    path: str | None = Field(default=None, description="Absolute path to image on disk.")
    image_b64: str | None = Field(default=None, description="Base64-encoded image bytes.")

    @model_validator(mode="after")
    def _validate_source(self) -> ImageRequest:
        if (self.path is None) == (self.image_b64 is None):
            raise ValueError("exactly one of path or image_b64 must be set")
        return self


class EmbedTextRequest(BaseModel):
    text: str = Field(..., description="Natural-language query text.")
    language: str | None = Field(default=None, description="Optional language code for multilingual CLIP models.")


class DetectRequest(ImageRequest):
    min_score: float = 0.7
    min_box_px: int = 0
    ar_range: tuple[float, float] | None = None


class BatchDetectRequest(BaseModel):
    files: list[str] = Field(default_factory=list)
    min_score: float = 0.7
    min_box_px: int = 0
    ar_range: tuple[float, float] | None = None


class OcrRequest(ImageRequest):
    language: str | None = None
    min_detection_score: float = 0.5
    min_recognition_score: float = 0.8
    max_resolution: int = 736


async def _load_image(body: ImageRequest) -> Image.Image:
    try:
        if body.path:
            p = Path(body.path)
            if not _is_allowed(p):
                raise PermissionError(f"path is outside TGDL_ML_ALLOW_ROOTS: {body.path}")
            image = Image.open(p)
        else:
            assert body.image_b64 is not None
            raw = base64.b64decode(body.image_b64, validate=True)
            image = Image.open(BytesIO(raw))
        image.load()
        if image.mode != "RGB":
            image = image.convert("RGB")
        return image
    except PermissionError:
        raise
    except FileNotFoundError:
        raise
    except (UnidentifiedImageError, ValueError, OSError) as exc:
        raise ValueError(f"image decode failed: {exc}") from exc


def _runtime_ready() -> bool:
    return _ml_runtime is not None and ModelTask is not None and ModelType is not None


def _entries(*, task: Any, detection: dict[str, Any] | None = None, recognition: dict[str, Any] | None = None,
             visual: dict[str, Any] | None = None, textual: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    without_deps: list[dict[str, Any]] = []
    with_deps: list[dict[str, Any]] = []
    if visual is not None:
        without_deps.append({"name": visual["modelName"], "task": task, "type": ModelType.VISUAL, "options": visual.get("options", {})})
    if textual is not None:
        without_deps.append({"name": textual["modelName"], "task": task, "type": ModelType.TEXTUAL, "options": textual.get("options", {})})
    if detection is not None:
        without_deps.append({"name": detection["modelName"], "task": task, "type": ModelType.DETECTION, "options": detection.get("options", {})})
    if recognition is not None:
        with_deps.append({"name": recognition["modelName"], "task": task, "type": ModelType.RECOGNITION, "options": recognition.get("options", {})})
    return without_deps, with_deps


async def _run(payload: Image.Image | str, entries: tuple[list[dict[str, Any]], list[dict[str, Any]]]) -> dict[Any, Any]:
    if not _runtime_ready():
        raise RuntimeError(_RUNTIME_ERROR or "ml runtime is not available")
    return await _ml_runtime.run_inference(payload, entries)  # type: ignore[union-attr]


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _THREAD_POOL_CREATED
    if _runtime_ready() and _ml_runtime.thread_pool is None:  # type: ignore[union-attr]
        threads = int(os.environ.get("TGDL_ML_REQUEST_THREADS") or _ml_settings.request_threads or 0)  # type: ignore[union-attr]
        if threads > 0:
            _ml_runtime.thread_pool = ThreadPoolExecutor(threads)  # type: ignore[union-attr]
            _THREAD_POOL_CREATED = True
    try:
        yield
    finally:
        if _THREAD_POOL_CREATED and _ml_runtime is not None and _ml_runtime.thread_pool is not None:
            _ml_runtime.thread_pool.shutdown()
            _ml_runtime.thread_pool = None


app = FastAPI(title="TGDL ML", version=__version__, lifespan=lifespan)


@app.get("/health")
def health() -> JSONResponse:
    ok = _runtime_ready()
    return JSONResponse(
        {
            "ok": ok,
            "version": __version__,
            "provider": "tgdl-ml",
            "ready": ok,
            "error": None if ok else _RUNTIME_ERROR,
            "clip_model": _clip_model(),
            "face_model": _face_model(),
            "ocr_model": _ocr_model(),
        }
    )


@app.get("/info")
def info() -> JSONResponse:
    providers: list[str] = []
    if _runtime_ready():
        try:
            from onnxruntime import get_available_providers

            providers = list(get_available_providers())
        except Exception:
            providers = []
    return JSONResponse(
        {
            "version": __version__,
            "provider": "tgdl-ml",
            "runtime_ready": _runtime_ready(),
            "runtime_error": _RUNTIME_ERROR,
            "models": {
                "clip": _clip_model(),
                "faces": _face_model(),
                "ocr": _ocr_model(),
            },
            "providers": providers,
            "endpoints": {
                "embed_image": True,
                "embed_text": True,
                "faces": True,
                "detect_batch": True,
                "ocr": True,
                "tag": False,
                "objects": False,
            },
        }
    )


@app.post("/embed-image")
async def embed_image(body: Annotated[ImageRequest, ...]) -> JSONResponse:
    try:
        image = await _load_image(body)
        data = await _run(
            image,
            _entries(task=ModelTask.SEARCH, visual={"modelName": _clip_model()}),
        )
        embedding = _embedding_from_wire(data[ModelTask.SEARCH])
        return JSONResponse({"embedding": embedding, "dim": len(embedding), "model": _clip_model()})
    except PermissionError as exc:
        return _error(str(exc), "path_not_allowed", status.HTTP_403_FORBIDDEN)
    except FileNotFoundError as exc:
        return _error(str(exc), "file_not_found", status.HTTP_404_NOT_FOUND)
    except ValueError as exc:
        return _error(str(exc), "image_decode_failed", status.HTTP_415_UNSUPPORTED_MEDIA_TYPE)
    except Exception as exc:
        return _error(f"embed_image failed: {type(exc).__name__}: {exc}", "embedding_failed", status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/embed-text")
async def embed_text(body: Annotated[EmbedTextRequest, ...]) -> JSONResponse:
    try:
        options = {"language": body.language} if body.language else {}
        data = await _run(
            body.text,
            _entries(task=ModelTask.SEARCH, textual={"modelName": _clip_model(), "options": options}),
        )
        embedding = _embedding_from_wire(data[ModelTask.SEARCH])
        return JSONResponse({"embedding": embedding, "dim": len(embedding), "model": _clip_model()})
    except Exception as exc:
        return _error(f"embed_text failed: {type(exc).__name__}: {exc}", "embedding_failed", status.HTTP_500_INTERNAL_SERVER_ERROR)


async def _detect_faces_for_image(image: Image.Image, min_score: float, min_box_px: int = 0) -> dict[str, Any]:
    data = await _run(
        image,
        _entries(
            task=ModelTask.FACIAL_RECOGNITION,
            detection={"modelName": _face_model(), "options": {"minScore": min_score}},
            recognition={"modelName": _face_model()},
        ),
    )
    faces = []
    for face in data.get(ModelTask.FACIAL_RECOGNITION, []):
        box = face.get("boundingBox", {})
        x1 = float(box.get("x1", 0))
        y1 = float(box.get("y1", 0))
        x2 = float(box.get("x2", 0))
        y2 = float(box.get("y2", 0))
        w = max(0.0, x2 - x1)
        h = max(0.0, y2 - y1)
        if min_box_px and (w < min_box_px or h < min_box_px):
            continue
        embedding = _embedding_from_wire(face.get("embedding", []))
        faces.append({"x": x1, "y": y1, "w": w, "h": h, "score": float(face.get("score", 0)), "embedding": embedding})
    return {"faces": faces, "image_w": data.get("imageWidth"), "image_h": data.get("imageHeight")}


@app.post("/detect")
async def detect(body: Annotated[DetectRequest, ...]) -> JSONResponse:
    try:
        image = await _load_image(body)
        return JSONResponse(await _detect_faces_for_image(image, body.min_score, body.min_box_px))
    except PermissionError as exc:
        return _error(str(exc), "path_not_allowed", status.HTTP_403_FORBIDDEN)
    except FileNotFoundError as exc:
        return _error(str(exc), "file_not_found", status.HTTP_404_NOT_FOUND)
    except ValueError as exc:
        return _error(str(exc), "image_decode_failed", status.HTTP_415_UNSUPPORTED_MEDIA_TYPE)
    except Exception as exc:
        return _error(f"detect failed: {type(exc).__name__}: {exc}", "detect_failed", status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/detect/batch")
async def detect_batch(body: Annotated[BatchDetectRequest, ...]) -> JSONResponse:
    results: list[dict[str, Any]] = []
    for file_path in body.files:
        item: dict[str, Any] = {"file": file_path, "faces": []}
        try:
            image = await _load_image(ImageRequest(path=file_path))
            item.update(await _detect_faces_for_image(image, body.min_score, body.min_box_px))
        except PermissionError:
            item["error"] = "path_not_allowed"
        except FileNotFoundError:
            item["error"] = "file_not_found"
        except ValueError:
            item["error"] = "decode_failed"
        except Exception as exc:
            item["error"] = f"detect_failed: {type(exc).__name__}: {exc}"
        results.append(item)
    return JSONResponse({"results": results})


@app.post("/detect-embed")
async def detect_embed(body: Annotated[DetectRequest, ...]) -> JSONResponse:
    return await detect(body)


@app.post("/ocr")
async def ocr(body: Annotated[OcrRequest, ...]) -> JSONResponse:
    try:
        image = await _load_image(body)
        data = await _run(
            image,
            _entries(
                task=ModelTask.OCR,
                detection={
                    "modelName": _ocr_model(),
                    "options": {"minScore": body.min_detection_score, "maxResolution": body.max_resolution},
                },
                recognition={"modelName": _ocr_model(), "options": {"minScore": body.min_recognition_score}},
            ),
        )
        raw = _jsonable(data.get(ModelTask.OCR, {}))
        texts = raw.get("text") if isinstance(raw, dict) else []
        scores = (raw.get("textScore") or raw.get("boxScore")) if isinstance(raw, dict) else []
        text = "\n".join([str(t) for t in texts if t]) if isinstance(texts, list) else ""
        confidence = None
        if isinstance(scores, list) and scores:
            confidence = sum(float(x or 0) for x in scores) / len(scores)
        return JSONResponse({"result": {"text": text, "language": body.language, "confidence": confidence}, "raw": raw})
    except PermissionError as exc:
        return _error(str(exc), "path_not_allowed", status.HTTP_403_FORBIDDEN)
    except FileNotFoundError as exc:
        return _error(str(exc), "file_not_found", status.HTTP_404_NOT_FOUND)
    except ValueError as exc:
        return _error(str(exc), "image_decode_failed", status.HTTP_415_UNSUPPORTED_MEDIA_TYPE)
    except Exception as exc:
        return _error(f"ocr failed: {type(exc).__name__}: {exc}", "ocr_failed", status.HTTP_500_INTERNAL_SERVER_ERROR)


@app.post("/tag")
def tag_not_supported() -> JSONResponse:
    return _error("/tag is not implemented in tgdl-ml yet", "not_implemented", status.HTTP_501_NOT_IMPLEMENTED)


@app.post("/detect-objects")
def objects_not_supported() -> JSONResponse:
    return _error("/detect-objects is not implemented in tgdl-ml yet", "not_implemented", status.HTTP_501_NOT_IMPLEMENTED)
