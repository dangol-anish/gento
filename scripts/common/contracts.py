from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _load_stage_event_contract() -> dict[str, Any]:
    project_root = Path(os.environ.get("GENTO_PROJECT_ROOT") or Path(__file__).resolve().parents[2])
    contract_path = project_root / "shared" / "stage-event-contract.json"
    fallback = {
        "event_types": {
            "progress": {"required_fields": ["stage", "message"]},
            "complete": {"required_fields": ["stage"]},
            "error": {"required_fields": ["stage", "error"]},
        }
    }
    try:
        return json.loads(contract_path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return fallback


STAGE_EVENT_CONTRACT = _load_stage_event_contract()


def validate_stage_event(event_type: str, payload: dict[str, Any]) -> None:
    event_types = STAGE_EVENT_CONTRACT.get("event_types", {})
    event_def = event_types.get(event_type)
    if event_def is None:
        raise ValueError(f"Unsupported event type: {event_type}")

    required_fields = event_def.get("required_fields", [])
    missing = [field for field in required_fields if field not in payload]
    if missing:
        raise ValueError(
            f"Event '{event_type}' missing required fields: {', '.join(missing)}"
        )
