from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _load_error_codes() -> dict[str, str]:
    project_root = Path(os.environ.get("GENTO_PROJECT_ROOT") or Path(__file__).resolve().parents[2])
    codes_path = project_root / "shared" / "error-codes.json"
    fallback = {
        "INVALID_REQUEST": "INVALID_REQUEST",
        "INVALID_STAGE": "INVALID_STAGE",
        "STAGE_EXECUTION_FAILED": "STAGE_EXECUTION_FAILED",
        "PROCESS_SPAWN_FAILED": "PROCESS_SPAWN_FAILED",
        "PROCESS_EXIT_NON_ZERO": "PROCESS_EXIT_NON_ZERO",
        "INTERNAL_ERROR": "INTERNAL_ERROR",
    }
    try:
        return json.loads(codes_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return fallback


ERROR_CODES = _load_error_codes()


@dataclass
class AppError(Exception):
    code: str
    message: str
    details: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "details": self.details,
        }


def invalid_request(message: str, details: dict[str, Any] | None = None) -> AppError:
    return AppError(ERROR_CODES["INVALID_REQUEST"], message, details)


def stage_failed(message: str, details: dict[str, Any] | None = None) -> AppError:
    return AppError(ERROR_CODES["STAGE_EXECUTION_FAILED"], message, details)
