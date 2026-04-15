import json
from typing import Any

from scripts.common.errors import AppError, ERROR_CODES


def emit(event_type: str, **payload: Any) -> None:
    """
    Emit one JSON event line for Electron IPC parsing.
    """
    print(json.dumps({"type": event_type, **payload}), flush=True)


def emit_error(stage: int, error: AppError) -> None:
    emit("error", stage=stage, error=error.to_dict())


def run_with_error_boundary(stage: int, fn) -> int:
    """
    Run stage code with consistent error output and exit code.
    """
    try:
        fn()
        return 0
    except AppError as app_error:
        emit_error(stage, app_error)
        return 1
    except Exception as exc:  # noqa: BLE001
        emit(
            "error",
            stage=stage,
            error={
                "code": ERROR_CODES["INTERNAL_ERROR"],
                "message": str(exc),
                "details": None,
            },
        )
        return 1
