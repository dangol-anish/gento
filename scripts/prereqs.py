import argparse
import os
import platform
import shutil
import subprocess
import sys
import venv
from dataclasses import dataclass
from pathlib import Path
from threading import Event, Thread
from time import monotonic, sleep
from typing import Any, Optional, Tuple

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

def _user_data_dir() -> Path:
    configured = os.environ.get("GENTO_USER_DATA_DIR")
    if configured and configured.strip():
        return Path(configured).expanduser()
    return _project_root() / ".gento-userdata"


def _venv_dir() -> Path:
    return _user_data_dir() / "python" / "venv"


def _venv_python() -> Path:
    root = _venv_dir()
    if os.name == "nt":
        return root / "Scripts" / "python.exe"
    return root / "bin" / "python3"

def _python_runtime_ok() -> Tuple[bool, Optional[str]]:
    if sys.version_info < (3, 10):
        return False, "Python 3.10+ is required."
    if sys.version_info >= (3, 13):
        return False, "Python 3.13+ is not supported yet (torch/transformers wheels). Use Python 3.11 or 3.12."
    if platform.architecture()[0] != "64bit":
        return False, "64-bit Python is required."
    return True, None


def _summarize_import_error(text: str, module_name: str) -> str:
    normalized = (text or "").strip()
    if not normalized:
        return f"Failed to import '{module_name}'."

    # Common Windows PyTorch failure: missing VC++ runtime / dependent DLLs.
    if module_name == "torch":
        if (
            "WinError 126" in normalized
            or "WinError 127" in normalized
            or "DLL load failed" in normalized
            or "_load_dll_libraries" in normalized
        ):
            last_line = next((line for line in reversed(normalized.splitlines()) if line.strip()), "").strip()
            hint = (
                "Torch failed to load native DLLs. Install Microsoft Visual C++ Redistributable 2015–2022 (x64) "
                "and reboot, then retry. "
            )
            return (hint + last_line).strip()

    lines = [line.rstrip() for line in normalized.splitlines() if line.strip()]
    if not lines:
        return f"Failed to import '{module_name}'."

    # Prefer the final exception line, not the whole traceback.
    last_line = lines[-1]
    if last_line.lower().startswith("traceback"):
        return f"Failed to import '{module_name}'."
    return last_line


def _run_with_heartbeat(
    cmd: list[str],
    *,
    env: dict[str, str],
    timeout_s: int,
    heartbeat_every_s: int = 10,
    heartbeat_message: str = "Still working...",
    capture_output: bool = False,
) -> subprocess.CompletedProcess[str]:
    """
    Run a subprocess while emitting periodic heartbeat lines to stderr.
    This prevents the UI from looking 'stuck' when pip is busy but quiet.
    """
    start = monotonic()
    stop = Event()

    def _heartbeat() -> None:
        while not stop.is_set():
            sleep(heartbeat_every_s)
            if stop.is_set():
                break
            elapsed = int(monotonic() - start)
            sys.stderr.write(f"[gento] {heartbeat_message} ({elapsed}s)\n")
            sys.stderr.flush()

    thread = Thread(target=_heartbeat, daemon=True)
    thread.start()
    try:
        proc = subprocess.run(
            cmd,
            env=env,
            check=False,
            text=True,
            timeout=timeout_s,
            capture_output=capture_output,
        )
        return proc
    finally:
        stop.set()
        thread.join(timeout=1)

def _import_ok(module_name: str) -> Tuple[bool, Optional[str]]:
    python = _venv_python()
    try:
        proc = subprocess.run(
            [str(python), "-c", f"import {module_name}"],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONNOUSERSITE": "1"},
            check=False,
        )
    except Exception as exc:  # noqa: BLE001
        return False, f"Failed to run venv Python ({python}): {exc}"

    if proc.returncode == 0:
        return True, None
    stderr = (proc.stderr or "").strip()
    stdout = (proc.stdout or "").strip()
    combined = stderr or stdout
    return False, _summarize_import_error(combined, module_name)


def _check_binary(cmd: str) -> Tuple[bool, Optional[str]]:
    resolved = shutil.which(cmd)
    if resolved:
        return True, resolved
    return False, None


def _check_magi_model_cached() -> Tuple[bool, Optional[str]]:
    python = _venv_python()
    try:
        proc = subprocess.run(
            [
                str(python),
                "-c",
                (
                    "from huggingface_hub import snapshot_download;"
                    f"snapshot_download(repo_id={MAGI_MODEL_REPO!r}, local_files_only=True)"
                ),
            ],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
            check=False,
        )
    except Exception as exc:  # noqa: BLE001
        return False, f"Failed to run venv Python ({python}): {exc}"
    if proc.returncode == 0:
        return True, None
    stderr = (proc.stderr or "").strip()
    stdout = (proc.stdout or "").strip()
    return False, stderr or stdout or "Magi model is not cached locally."


def _download_magi_model() -> None:
    emit("progress", stage=STAGE, message="Downloading Magi model (Hugging Face cache)...", percent=65)
    python = _venv_python()
    proc = subprocess.run(
        [
            str(python),
            "-c",
            (
                "from huggingface_hub import snapshot_download;"
                f"snapshot_download(repo_id={MAGI_MODEL_REPO!r}, local_files_only=False, resume_download=True)"
            ),
        ],
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        check=False,
        text=True,
    )
    if proc.returncode != 0:
        raise stage_failed("Failed to download Magi model.", {"exit_code": proc.returncode})


def _pip_install_requirements() -> None:
    if sys.version_info < (3, 10):
        raise stage_failed(
            "Python 3.10+ is required to install prerequisites.",
            {"found": platform.python_version(), "executable": sys.executable},
        )

    if sys.version_info >= (3, 13):
        raise stage_failed(
            "Python is too new for some ML wheels (torch/transformers). Install Python 3.11 or 3.12 and retry.",
            {"found": platform.python_version(), "executable": sys.executable},
        )

    if platform.architecture()[0] != "64bit":
        raise stage_failed(
            "64-bit Python is required (32-bit cannot install torch wheels).",
            {"found": platform.architecture()[0], "executable": sys.executable},
        )

    requirements = _requirements_path()
    if not requirements.exists():
        raise stage_failed("requirements.txt not found.", {"path": str(requirements)})

    venv_dir = _venv_dir()
    venv_python = _venv_python()
    if not venv_python.exists():
        emit("progress", stage=STAGE, message="Creating Python environment (venv)...", percent=12)
        venv_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            venv.EnvBuilder(with_pip=True).create(str(venv_dir))
        except Exception as exc:  # noqa: BLE001
            raise stage_failed(
                "Failed to create Python venv.",
                {"path": str(venv_dir), "reason": str(exc)},
            ) from exc

    emit("progress", stage=STAGE, message="Upgrading pip tooling...", percent=18)

    env = {
        **os.environ,
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PIP_NO_INPUT": "1",
        "PYTHONUNBUFFERED": "1",
        "PIP_PROGRESS_BAR": "off",
    }
    # On Windows, upgrading setuptools can sometimes hang due to file locks/AV.
    # pip+wheel are enough for installing binary wheels from requirements.txt.
    upgrade_proc = _run_with_heartbeat(
        [str(venv_python), "-m", "pip", "install", "--upgrade", "pip", "wheel"],
        env=env,
        timeout_s=15 * 60,
        heartbeat_message="Upgrading pip/wheel...",
    )
    if upgrade_proc.returncode != 0:
        raise stage_failed(
            "Failed to upgrade pip/setuptools/wheel.",
            {"exit_code": upgrade_proc.returncode, "hint": f"{venv_python} -m pip install -U pip setuptools wheel"},
        )

    req_lines = [line.strip() for line in requirements.read_text(encoding="utf-8").splitlines()]
    reqs = [line for line in req_lines if line and not line.startswith("#")]
    if not reqs:
        return

    def _error_tail(proc: subprocess.CompletedProcess[str]) -> str:
        text = (proc.stderr or proc.stdout or "").strip()
        if not text:
            return f"pip exited with code {proc.returncode}"
        return "\n".join(text.splitlines()[-12:]).strip()

    failures: list[dict[str, Any]] = []
    start_percent = 20
    end_percent = 60
    step = max(1, int((end_percent - start_percent) / max(1, len(reqs))))

    # Install torch first (its wheels are large and on a separate index for some platforms).
    ordered = sorted(reqs, key=lambda r: (0 if r.strip().lower() == "torch" else 1, r))

    for index, req in enumerate(ordered):
        percent = min(end_percent, start_percent + index * step)
        emit("progress", stage=STAGE, message=f"Installing Python package: {req}...", percent=percent)

        base_cmd = [
            str(venv_python),
            "-m",
            "pip",
            "install",
            "--prefer-binary",
            "--only-binary",
            ":all:",
            "--retries",
            "3",
            "--timeout",
            "60",
            req,
        ]

        # torch frequently requires the official PyTorch wheel index on Windows.
        cmd = base_cmd
        if req.strip().lower() == "torch":
            cmd = [
                str(venv_python),
                "-m",
                "pip",
                "install",
                "--prefer-binary",
                "--only-binary",
                ":all:",
                "--retries",
                "3",
                "--timeout",
                "60",
                "--index-url",
                "https://download.pytorch.org/whl/cpu",
                "--extra-index-url",
                "https://pypi.org/simple",
                req,
            ]

        proc = _run_with_heartbeat(
            cmd,
            env=env,
            timeout_s=15 * 60,
            heartbeat_message=f"Installing {req}...",
            capture_output=True,
        )

        if proc.returncode != 0:
            tail = _error_tail(proc)
            failures.append({"requirement": req, "exit_code": proc.returncode})
            emit("progress", stage=STAGE, message=f"Failed to install {req}: {tail}", percent=percent)
        else:
            emit("progress", stage=STAGE, message=f"Installed {req}.", percent=percent)

    if failures:
        # Don't hard-fail the stage — return a report so the UI can show what's still missing.
        sys.stderr.write("[gento] Some Python packages failed to install. Re-check prerequisites for details.\n")
        sys.stderr.flush()


def _run_check() -> PrereqCheck:
    prereqs: list[dict[str, Any]] = []

    python_ok, python_reason = _python_runtime_ok()
    prereqs.append(
        {
            "id": "python",
            "label": "Python (64-bit, 3.10–3.12 recommended 3.11)",
            "status": "ok" if python_ok else "missing",
            "kind": "manual",
            "details": {
                "version": platform.python_version(),
                "executable": sys.executable,
                "architecture": platform.architecture()[0],
                "reason": python_reason,
            },
        }
    )

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

    venv_python = _venv_python()
    if venv_python.exists():
        missing_any = False
        for package, module in python_modules:
            ok, error = _import_ok(module)
            if not ok:
                missing_any = True
            prereqs.append(
                {
                    "id": f"python:{package}",
                    "label": f"Python package (Gento venv): {package}",
                    "status": "ok" if ok else "missing",
                    "kind": "download",
                    "details": {"import_error": error} if error else None,
                }
            )
    else:
        missing_any = True
        for package, _module in python_modules:
            prereqs.append(
                {
                    "id": f"python:{package}",
                    "label": f"Python package (Gento venv): {package}",
                    "status": "missing",
                    "kind": "download",
                    "details": {"reason": "Python venv has not been created yet."},
                }
            )

    if venv_python.exists():
        magi_ok, magi_err = _check_magi_model_cached()
    else:
        magi_ok, magi_err = False, "Python venv has not been created yet."
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
        magi_error = None
        if isinstance(magi_missing.get("details"), dict):
            magi_error = magi_missing["details"].get("error")
        if isinstance(magi_error, str) and (
            "No module named" in magi_error or "huggingface_hub" in magi_error or "Failed to run venv Python" in magi_error
        ):
            # Dependencies aren't installed correctly yet; don't attempt the model download.
            sys.stderr.write("[gento] Skipping Magi model download until Python dependencies are installed.\n")
            sys.stderr.flush()
        else:
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
