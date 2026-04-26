from __future__ import annotations

import argparse
import importlib
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scripts.common.errors import invalid_request, stage_failed
from scripts.common.events import emit, run_with_error_boundary

STAGE = 99
MAGI_MODEL_REPO = "ragavsachdeva/magiv3"


@dataclass(frozen=True)
class PrereqCheck:
    prereqs: list[dict[str, Any]]
    requirements_met: bool


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _requirements_path() -> Path:
    return _project_root() / "requirements.txt"


def _import_ok(module_name: str) -> tuple[bool, str | None]:
    try:
        importlib.import_module(module_name)
        return True, None
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def _check_binary(cmd: str) -> tuple[bool, str | None]:
    resolved = shutil.which(cmd)
    if resolved:
        return True, resolved
    return False, None


def _check_magi_model_cached() -> tuple[bool, str | None]:
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(repo_id=MAGI_MODEL_REPO, local_files_only=True)
        return True, None
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def _download_magi_model() -> None:
    from huggingface_hub import snapshot_download

    emit("progress", stage=STAGE, message="Downloading Magi model (Hugging Face cache)...", percent=65)
    snapshot_download(repo_id=MAGI_MODEL_REPO, local_files_only=False, resume_download=True)


def _pip_install_requirements() -> None:
    requirements = _requirements_path()
    if not requirements.exists():
        raise stage_failed("requirements.txt not found.", {"path": str(requirements)})

    emit("progress", stage=STAGE, message="Installing Python dependencies (pip)...", percent=20)

    env = {
        **os.environ,
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PYTHONUNBUFFERED": "1",
    }
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "-r",
            str(requirements),
        ],
        env=env,
        check=False,
        text=True,
    )
    if proc.returncode != 0:
        raise stage_failed(
            "pip install failed.",
            {
                "exit_code": proc.returncode,
                "hint": f"{sys.executable} -m pip install -r {requirements}",
            },
        )


def _run_check() -> PrereqCheck:
    prereqs: list[dict[str, Any]] = []

    ffmpeg_ok, ffmpeg_path = _check_binary("ffmpeg")
    prereqs.append(
        {
            "id": "ffmpeg",
            "label": "ffmpeg (video rendering)",
            "status": "ok" if ffmpeg_ok else "missing",
            "kind": "manual",
            "details": {"path": ffmpeg_path} if ffmpeg_path else None,
        }
    )

    ollama_ok, ollama_path = _check_binary("ollama")
    prereqs.append(
        {
            "id": "ollama",
            "label": "Ollama (local scenes/recaps)",
            "status": "ok" if ollama_ok else "missing",
            "kind": "manual",
            "details": {"path": ollama_path} if ollama_path else None,
        }
    )

    python_modules: list[tuple[str, str]] = [
        ("httpx", "httpx"),
        ("beautifulsoup4", "bs4"),
        ("pillow", "PIL"),
        ("transformers", "transformers"),
        ("torch", "torch"),
        ("einops", "einops"),
        ("pytorch_metric_learning", "pytorch_metric_learning"),
        ("timm", "timm"),
        ("matplotlib", "matplotlib"),
        ("shapely", "shapely"),
        ("kokoro", "kokoro"),
    ]

    missing_any = False
    for package, module in python_modules:
        ok, error = _import_ok(module)
        if not ok:
            missing_any = True
        prereqs.append(
            {
                "id": f"python:{package}",
                "label": f"Python package: {package}",
                "status": "ok" if ok else "missing",
                "kind": "download",
                "details": {"import_error": error} if error else None,
            }
        )

    magi_ok, magi_err = _check_magi_model_cached()
    prereqs.append(
        {
            "id": "magi-model",
            "label": f"Magi model cache: {MAGI_MODEL_REPO}",
            "status": "ok" if magi_ok else "missing",
            "kind": "download",
            "details": {"error": magi_err} if magi_err else None,
        }
    )

    requirements_met = all(p.get("status") == "ok" for p in prereqs)
    if missing_any and requirements_met:
        # Should not happen, but keep the report consistent.
        requirements_met = False

    return PrereqCheck(prereqs=prereqs, requirements_met=requirements_met)


def _run_install() -> PrereqCheck:
    initial = _run_check()

    missing_downloadables = [
        p for p in initial.prereqs if p.get("status") != "ok" and p.get("kind") == "download"
    ]
    if not missing_downloadables:
        emit("progress", stage=STAGE, message="Nothing to download. Re-checking prerequisites...", percent=90)
        return _run_check()

    if any(p.get("id", "").startswith("python:") for p in missing_downloadables):
        _pip_install_requirements()

    # Re-check after pip to avoid downloading Magi with a broken transformers install.
    mid = _run_check()
    magi_missing = next(
        (p for p in mid.prereqs if p.get("id") == "magi-model" and p.get("status") != "ok"),
        None,
    )
    if magi_missing is not None:
        _download_magi_model()

    emit("progress", stage=STAGE, message="Finalizing prerequisite install...", percent=95)
    return _run_check()


def parse_args() -> Any:
    parser = argparse.ArgumentParser(description="Stage 99: check and optionally download Gento prerequisites.")
    parser.add_argument("--mode", choices=["check", "install"], default="check")
    args = parser.parse_args()
    if args.mode not in {"check", "install"}:
        raise invalid_request("--mode must be 'check' or 'install'.")
    return args


def _run_stage() -> None:
    args = parse_args()

    emit("progress", stage=STAGE, message="Checking prerequisites...", percent=2)

    if args.mode == "check":
        report = _run_check()
        emit(
            "complete",
            stage=STAGE,
            requirements_met=report.requirements_met,
            prereqs=report.prereqs,
            message="Prerequisite check complete.",
        )
        return

    if args.mode == "install":
        report = _run_install()
        emit(
            "complete",
            stage=STAGE,
            requirements_met=report.requirements_met,
            prereqs=report.prereqs,
            message="Prerequisite install complete.",
        )
        return

    raise stage_failed("Unsupported mode.", {"mode": args.mode})


def main() -> None:
    raise SystemExit(run_with_error_boundary(STAGE, _run_stage))


if __name__ == "__main__":
    main()

