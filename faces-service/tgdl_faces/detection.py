"""Object detection module using YOLOv8-nano ONNX model."""

import logging
import os
import tempfile
import threading
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from .insight import _resolve_models_dir, _resolve_providers

_LOG = logging.getLogger(__name__)

_MODEL_AVAILABLE = None
_MODEL_ERROR = None
_SESSION = None
_LABELS = None
_INIT_LOCK = threading.Lock()

# COCO dataset class names (80 classes)
COCO_LABELS = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe",
    "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis",
    "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "microwave", "oven", "toaster", "sink", "refrigerator",
    "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"
]


def _model_path() -> Path:
    """Where the YOLOv8n ONNX file lives (inside the shared models dir)."""
    return _resolve_models_dir() / "yolov8n.onnx"


def _download_model(model_path: Path, url: str) -> None:
    """Download to a unique temp file, then atomically move into place.

    A fixed ``.tmp`` name let concurrent first requests clobber each other
    (ENOENT on rename, or a half-written file loaded as INVALID_PROTOBUF).
    """
    import urllib.request

    model_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=model_path.parent, prefix=model_path.name + ".", suffix=".tmp"
    )
    os.close(fd)
    try:
        urllib.request.urlretrieve(url, tmp_name)
        os.replace(tmp_name, model_path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def _init_model():
    """Lazy-load YOLO model on first use."""
    global _MODEL_AVAILABLE, _MODEL_ERROR, _SESSION, _LABELS
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

        try:
            # Try to load YOLOv8n model from Ultralytics
            # Model path: <models dir>/yolov8n.onnx or download on-demand
            model_path = _model_path()

            if not model_path.exists():
                _LOG.info(f"YOLOv8n model not found at {model_path} — downloading…")
                url = "https://github.com/ultralytics/assets/releases/latest/download/yolov8n.onnx"
                try:
                    _download_model(model_path, url)
                    _LOG.info(f"YOLOv8n model downloaded to {model_path}")
                except Exception as dl_err:
                    _LOG.warning(f"Failed to download YOLOv8n model: {dl_err}")
                    _MODEL_ERROR = f"Model not found at {model_path} and auto-download failed: {dl_err}"
                    _MODEL_AVAILABLE = False
                    return False

            _SESSION = ort.InferenceSession(
                str(model_path),
                providers=_resolve_providers(os.environ.get("TGDL_FACES_PROVIDERS", "auto")),
            )
            _LABELS = COCO_LABELS
            _MODEL_AVAILABLE = True
            _LOG.info("YOLOv8n ONNX model loaded successfully")
            return True
        except Exception as e:
            _MODEL_ERROR = str(e)
            _LOG.warning(f"Failed to load YOLO model: {e}")
            _MODEL_AVAILABLE = False
            return False


def is_ready() -> bool:
    """Check if object detection is ready."""
    return _init_model()


def last_error() -> str | None:
    """Get last detection error."""
    return _MODEL_ERROR


def detect_objects(img: Image.Image, confidence: float = 0.5) -> list[dict]:
    """Detect objects in image using YOLOv8n ONNX.

    Args:
        img: PIL Image object
        confidence: Confidence threshold (0-1)

    Returns:
        List of {object, confidence, x, y, w, h} dicts
    """
    if not _init_model():
        raise RuntimeError(f"YOLO not available: {_MODEL_ERROR}")

    try:
        # Prepare image for YOLO (640x640, normalize)
        cv_img = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
        h, w = cv_img.shape[:2]

        # Resize to 640x640 with padding
        target_size = 640
        scale = target_size / max(h, w)
        new_h, new_w = int(h * scale), int(w * scale)

        resized = cv2.resize(cv_img, (new_w, new_h))
        padded = np.full((target_size, target_size, 3), 114, dtype=np.uint8)
        y_offset = (target_size - new_h) // 2
        x_offset = (target_size - new_w) // 2
        padded[y_offset : y_offset + new_h, x_offset : x_offset + new_w] = resized

        # Normalize to [0, 1]
        input_img = padded.astype(np.float32) / 255.0
        input_img = np.transpose(input_img, (2, 0, 1))  # HWC -> CHW
        input_img = np.expand_dims(input_img, 0)  # Add batch dimension

        # Run inference
        outputs = _SESSION.run(None, {"images": input_img})
        predictions = outputs[0][0]  # (84, 8400) -> (num_classes + 4, num_boxes)

        # Parse predictions
        objects = []
        for i in range(predictions.shape[1]):
            # Extract bounding box
            x_center, y_center, box_w, box_h = predictions[:4, i]

            # Get class scores (channels 4-83 for 80 COCO classes)
            class_scores = predictions[4:, i]
            class_id = np.argmax(class_scores)
            class_score = class_scores[class_id]

            if class_score < confidence:
                continue

            # Convert coords back to original image space
            x = (x_center - x_offset) / scale
            y = (y_center - y_offset) / scale
            obj_w = box_w / scale
            obj_h = box_h / scale

            # Clamp to image bounds
            x = max(0, min(x, w))
            y = max(0, min(y, h))
            obj_w = min(obj_w, w - x)
            obj_h = min(obj_h, h - y)

            if obj_w > 0 and obj_h > 0:
                objects.append({
                    "object": _LABELS[class_id] if class_id < len(_LABELS) else f"class_{class_id}",
                    "confidence": float(class_score),
                    "x": float(x),
                    "y": float(y),
                    "w": float(obj_w),
                    "h": float(obj_h),
                })

        # Sort by confidence descending
        objects.sort(key=lambda x: x["confidence"], reverse=True)
        return objects
    except Exception as e:
        _LOG.exception("Object detection failed")
        raise RuntimeError(f"Detection failed: {type(e).__name__}: {e}")
