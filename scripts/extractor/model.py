from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from PIL import Image


def _maybe_load_dotenv() -> None:
    project_root = Path(os.environ.get("GENTO_PROJECT_ROOT") or Path(__file__).resolve().parents[2])
    dotenv_path = project_root / ".env"
    if not dotenv_path.exists():
        return

    try:
        content = dotenv_path.read_text(encoding="utf-8")
    except Exception:
        return

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


def pick_device(device: str) -> str:
    import torch

    if device != "auto":
        return device
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def dtype_for_device(device: str):
    import torch

    if device in {"cuda", "mps"}:
        return torch.float16
    return torch.float32


def read_image_rgb_np(path: str) -> "Any":
    import numpy as np

    with open(path, "rb") as fh:
        image = Image.open(fh).convert("RGB")
    return np.array(image)


def load_magi_model(model_name: str, device: str, local_files_only: bool) -> tuple[Any, Any, str]:
    from transformers import AutoModelForCausalLM, AutoProcessor

    _maybe_load_dotenv()
    torch_device = pick_device(device)
    dtype = dtype_for_device(torch_device)

    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=dtype,
        trust_remote_code=True,
        local_files_only=local_files_only,
    ).to(torch_device).eval()

    _ensure_generation_mixin(model)
    _patch_prepare_inputs_for_generation(model)

    processor = AutoProcessor.from_pretrained(
        model_name,
        trust_remote_code=True,
        local_files_only=local_files_only,
    )

    return model, processor, torch_device


def _ensure_generation_mixin(model: Any) -> None:
    """
    Transformers >= 4.50 stopped inheriting GenerationMixin from PreTrainedModel.
    Some `trust_remote_code` models (including Magi's Florence2 backend) still
    expect `.generate()` to exist and will crash at runtime.
    """

    try:
        from transformers.generation.utils import GenerationMixin
    except Exception:  # noqa: BLE001
        return

    def _patch_one(obj: Any) -> None:
        if obj is None:
            return
        if isinstance(obj, GenerationMixin):
            return
        if not hasattr(obj, "prepare_inputs_for_generation"):
            return
        if hasattr(obj, "generate"):
            return
        try:
            patched_type = type(
                f"{obj.__class__.__name__}WithGeneration",
                (obj.__class__, GenerationMixin),
                {},
            )
            obj.__class__ = patched_type
            try:
                from transformers.generation.configuration_utils import GenerationConfig

                if getattr(obj, "generation_config", None) is None and hasattr(obj, "config"):
                    obj.generation_config = GenerationConfig.from_model_config(obj.config)
            except Exception:  # noqa: BLE001
                pass
        except Exception:  # noqa: BLE001
            return

    _patch_one(model)

    # Some remote-code models delegate generation to a nested language model.
    for attr in ("language_model", "text_model", "lm", "model"):
        if hasattr(model, attr):
            _patch_one(getattr(model, attr))


def _patch_prepare_inputs_for_generation(model: Any) -> None:
    """
    Newer `transformers` generation uses cache objects that can look like a
    past_key_values structure containing `None` entries. Some remote-code
    Florence2 implementations assume `past_key_values[layer][0]` is always a
    tensor, and crash when it is `None`.
    """

    def _looks_like_empty_cache(past_key_values: Any) -> bool:
        if past_key_values is None:
            return True
        try:
            first_layer = past_key_values[0]
        except Exception:  # noqa: BLE001
            return False
        if first_layer is None:
            return True
        try:
            first_key = first_layer[0]
        except Exception:  # noqa: BLE001
            return False
        return first_key is None

    def _wrap(obj: Any) -> None:
        if obj is None or not hasattr(obj, "prepare_inputs_for_generation"):
            return
        original = obj.prepare_inputs_for_generation

        def wrapped(decoder_input_ids, past_key_values=None, **kwargs):  # type: ignore[no-untyped-def]
            if past_key_values is not None and _looks_like_empty_cache(past_key_values):
                past_key_values = None
            return original(decoder_input_ids, past_key_values=past_key_values, **kwargs)

        try:
            obj.prepare_inputs_for_generation = wrapped  # type: ignore[method-assign]
        except Exception:  # noqa: BLE001
            return

    _wrap(model)
    for attr in ("language_model", "text_model", "lm", "model"):
        if hasattr(model, attr):
            _wrap(getattr(model, attr))


def predict_page(model: Any, processor: Any, image_np: "Any") -> tuple[dict[str, Any], Any]:
    detections = model.predict_detections_and_associations([image_np], processor)
    ocr_result = model.predict_ocr([image_np], processor)

    if isinstance(detections, list):
        detections = detections[0] if detections else {}
    if isinstance(ocr_result, list):
        ocr_result = ocr_result[0] if ocr_result else {}

    return detections or {}, ocr_result or {}
