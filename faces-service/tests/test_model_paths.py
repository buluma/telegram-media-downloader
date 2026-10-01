"""Model cache locations and first-use download behaviour.

The YOLO and WD14 loaders used to hardcode ``~/.cache`` while insightface and
CLIP honoured ``TGDL_FACES_MODELS_DIR``. A routine ``~/.cache`` wipe then
deleted only those two, and concurrent first requests raced on the shared
``.tmp`` download file (ENOENT on rename, INVALID_PROTOBUF on a half-written
model).
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

import pytest

from tgdl_faces import detection, wd14


def test_yolo_model_path_honors_models_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("TGDL_FACES_MODELS_DIR", str(tmp_path))
    assert detection._model_path() == tmp_path.resolve() / "yolov8n.onnx"


def test_wd14_cache_dir_honors_models_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("TGDL_FACES_MODELS_DIR", str(tmp_path))
    assert wd14._cache_dir() == tmp_path.resolve() / "wd14"


def test_concurrent_yolo_first_use_downloads_once(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("TGDL_FACES_MODELS_DIR", str(tmp_path))
    monkeypatch.setattr(detection, "_MODEL_AVAILABLE", None)
    monkeypatch.setattr(detection, "_MODEL_ERROR", None)
    monkeypatch.setattr(detection, "_SESSION", None)

    calls: list[str] = []

    def slow_download(url: str, dest: object) -> None:
        calls.append(str(dest))
        time.sleep(0.3)
        Path(str(dest)).write_bytes(b"fake-onnx")

    monkeypatch.setattr("urllib.request.urlretrieve", slow_download)
    monkeypatch.setattr("onnxruntime.InferenceSession", lambda *a, **k: object())

    results: list[bool] = []

    def worker() -> None:
        results.append(detection._init_model())

    with caplog.at_level(logging.WARNING, logger=detection._LOG.name):
        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    assert len(calls) == 1
    assert results == [True] * 4
    assert (tmp_path / "yolov8n.onnx").read_bytes() == b"fake-onnx"
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert list(tmp_path.glob("*.tmp")) == []
