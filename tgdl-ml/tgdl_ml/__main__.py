from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.environ.get("TGDL_ML_HOST") or "0.0.0.0"
    port = int(os.environ.get("TGDL_ML_PORT") or "3800")
    log_level = (os.environ.get("TGDL_ML_LOG_LEVEL") or "info").lower()
    uvicorn.run("tgdl_ml.app:app", host=host, port=port, log_level=log_level)


if __name__ == "__main__":
    main()
