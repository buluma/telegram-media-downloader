"""WD14 tagger — multi-label classification trained on Danbooru/e621 tags.

Uses SmilingWolf's WD ONNX models from Hugging Face Hub. Returns
confidence scores for ~10,000 Danbooru-derived tags covering body parts,
poses, clothing, explicit acts, fetishes, and more — much more relevant
for adult/NSFW content than COCO object detection.

Default model: ``SmilingWolf/wd-vit-tagger-v3`` (ViT-Base, 448px, ~330 MB).
"""

from __future__ import annotations

import csv
import logging
import os
import threading
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from .insight import _resolve_providers

_LOG = logging.getLogger(__name__)

_MODEL_AVAILABLE = None
_MODEL_ERROR = None
_SESSION = None
_LABELS: list[str] | None = None
_INIT_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# Model definition
# ---------------------------------------------------------------------------

# WD ViT tagger v3 — publicly accessible, no auth required
_REPO = "SmilingWolf/wd-vit-tagger-v3"
_MODEL_FILE = "model.onnx"
_TAGS_FILE = "selected_tags.csv"

# Preprocessing params from the model's config.json
_INPUT_SIZE = 448
_MEAN = np.array([0.5, 0.5, 0.5], dtype=np.float32)
_STD = np.array([0.5, 0.5, 0.5], dtype=np.float32)

# ONNX input/output names — determined by inspecting the exported model.
# ViT tagger v3 uses the standard WD convention.
_INPUT_NAME = "input"  # will be probed at load time
_OUTPUT_NAME = "sigmoid"


def _download(repo: str, filename: str, cache_dir: Path) -> Path:
    """Download a file from Hugging Face Hub to local cache."""
    from huggingface_hub import hf_hub_download

    _LOG.info("Downloading %s/%s …", repo, filename)
    path = hf_hub_download(repo_id=repo, filename=filename, cache_dir=str(cache_dir))
    _LOG.info("Downloaded %s/%s to %s", repo, filename, path)
    return Path(path)


def _load_tags(csv_path: Path) -> list[str]:
    """Load tag names from selected_tags.csv (columns: tag_id, name, category, count)."""
    tags: list[str] = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader, None)  # skip header
        for row in reader:
            if len(row) > 1:
                tags.append(row[1].strip())
    _LOG.info("Loaded %d WD14 tags from %s", len(tags), csv_path)
    return tags


def _probe_io(session) -> tuple[str, str]:
    """Probe ONNX session for input/output names."""
    inp = session.get_inputs()[0].name
    out = session.get_outputs()[0].name
    _LOG.debug("ONNX input=%s output=%s", inp, out)
    return inp, out


def _init_model() -> bool:
    """Lazy-load WD ViT ONNX model on first use."""
    global _MODEL_AVAILABLE, _MODEL_ERROR, _SESSION, _LABELS, _INPUT_NAME, _OUTPUT_NAME
    if _MODEL_AVAILABLE is not None:
        return _MODEL_AVAILABLE

    with _INIT_LOCK:
        if _MODEL_AVAILABLE is not None:
            return _MODEL_AVAILABLE

        try:
            import onnxruntime as ort
        except ImportError:
            _MODEL_ERROR = "onnxruntime not installed"
            _MODEL_AVAILABLE = False
            return False

        cache_dir = Path.home() / ".cache" / "tgdl-faces" / "wd14"

        try:
            model_path = _download(_REPO, _MODEL_FILE, cache_dir)
            tags_path = _download(_REPO, _TAGS_FILE, cache_dir)
        except Exception as e:
            _MODEL_ERROR = f"Failed to download WD14 model: {e}"
            _MODEL_AVAILABLE = False
            _LOG.warning("WD14 download failed: %s", e)
            return False

        try:
            providers = _resolve_providers(os.environ.get("TGDL_FACES_PROVIDERS", "auto"))
            _SESSION = ort.InferenceSession(str(model_path), providers=providers)
            _INPUT_NAME, _OUTPUT_NAME = _probe_io(_SESSION)
            _LABELS = _load_tags(tags_path)
            _MODEL_AVAILABLE = True
            _LOG.info("WD14 ViT tagger v3 loaded (%d tags)", len(_LABELS))
            return True
        except Exception as e:
            _MODEL_ERROR = str(e)
            _MODEL_AVAILABLE = False
            _LOG.warning("Failed to load WD14 model: %s", e)
            return False


def is_ready() -> bool:
    """Check if the WD14 tagger is ready."""
    return _init_model()


def last_error() -> str | None:
    """Get last WD14 initialisation error."""
    return _MODEL_ERROR


def tag_image(img: Image.Image | np.ndarray, min_score: float = 0.35) -> list[dict]:
    """Tag an image with WD ViT tagger (Danbooru/e621 tags).

    Accepts either a PIL Image (RGB) or a numpy ndarray (BGR, HWC, uint8
    — i.e. OpenCV convention, as returned by the sidecar's ``load_image_*``
    helpers).

    Args:
        img: PIL Image or numpy ndarray.
        min_score: Minimum score threshold (0-1). Default 0.35.

    Returns:
        List of ``{tag: str, score: float}`` sorted by score descending,
        filtered to tags >= min_score.
    """
    if not _init_model():
        raise RuntimeError(f"WD14 not available: {_MODEL_ERROR}")

    try:
        # Accept both PIL Image and numpy ndarray
        if isinstance(img, np.ndarray):
            # Convert BGR (OpenCV) → RGB
            arr = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        else:
            img_rgb = img.convert("RGB")
            arr = np.array(img_rgb, dtype=np.float32) / 255.0

        h, w = arr.shape[:2]
        crop = min(h, w)
        top = (h - crop) // 2
        left = (w - crop) // 2
        arr = arr[top : top + crop, left : left + crop]

        # Resize
        from PIL import Image as PILImage
        arr = (arr * 255).clip(0, 255).astype(np.uint8)
        pil_img = PILImage.fromarray(arr)
        pil_img = pil_img.resize((_INPUT_SIZE, _INPUT_SIZE), PILImage.LANCZOS)
        arr = np.array(pil_img, dtype=np.float32) / 255.0

        # Normalise with WD14 mean/std (0.5, 0.5, 0.5)
        arr = (arr - _MEAN) / _STD
        # Model expects NHWC (batch, 448, 448, 3)
        arr = np.expand_dims(arr, 0)  # add batch dim → (1, 448, 448, 3)

        outputs = _SESSION.run([_OUTPUT_NAME], {_INPUT_NAME: arr})
        scores = outputs[0][0]

        results: list[dict] = []
        for i, score in enumerate(scores):
            if i >= len(_LABELS):
                break
            if score < min_score:
                continue
            tag_name = _LABELS[i]
            # Skip non-general categories (rating, artist, copyright, character)
            # WD tags embed category prefixes as part of the CSV.
            # In practice the ViT tagger doesn't prefix, but filter just in case.
            if ":" in tag_name:
                continue
            results.append({"tag": tag_name, "score": float(score)})

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:200]

    except Exception as e:
        _LOG.exception("WD14 tagging failed")
        raise RuntimeError(f"WD14 tagging failed: {type(e).__name__}: {e}")
