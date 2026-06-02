#!/usr/bin/env python3
from __future__ import annotations

import argparse
import audioop
import json
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path, PurePosixPath
from typing import Any, Set

from scripts.common.errors import invalid_request, stage_failed
from scripts.common.events import emit, run_with_error_boundary

_STAGE = 8

PANEL_NUMBER_RE = re.compile(r"(?P<prefix>.*?)(?P<number>\d+)(?P<suffix>\.[^.]+)$")
INVALID_PATH_CHARS = re.compile(r"[\\/:*?\"<>|]+")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stage 8: build shorts audio and collect referenced panel assets."
    )
    parser.add_argument("shorts_json", nargs="+", help="One or more input shorts JSON files.")
    parser.add_argument(
        "--output-root",
        default="./output",
        help="Output root directory (default: ./output).",
    )
    parser.add_argument("--voice", default="am_echo", help="Kokoro voice id.")
    parser.add_argument("--speed", type=float, default=1.0, help="Kokoro TTS speed.")
    parser.add_argument("--sample-rate", type=int, default=24000, help="Output audio sample rate.")
    return parser.parse_args()


def _sanitize_folder_name(name: str) -> str:
    sanitized = INVALID_PATH_CHARS.sub("_", name.strip())
    return sanitized or "manga"


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise invalid_request("Shorts JSON file not found.", {"path": str(path)}) from exc
    except json.JSONDecodeError as exc:
        raise invalid_request("Malformed JSON.", {"path": str(path), "error": str(exc)}) from exc


def _to_pcm16(audio: Any) -> bytes:
    if audio is None:
        return b""
    if isinstance(audio, (bytes, bytearray)):
        return bytes(audio)
    if hasattr(audio, "tolist"):
        audio = audio.tolist()
    if isinstance(audio, bytes):
        return audio
    if isinstance(audio, bytearray):
        return bytes(audio)
    if isinstance(audio, str):
        raise stage_failed("Unsupported audio buffer type from TTS.", {"type": "str"})

    try:
        seq = list(audio)
    except Exception as exc:
        raise stage_failed("Unsupported audio buffer type from TTS.", {"type": str(type(audio)), "error": str(exc)}) from exc

    out = bytearray()
    for value in seq:
        if isinstance(value, bool):
            sample = 0
        elif isinstance(value, int):
            sample = max(-32768, min(32767, int(value)))
        else:
            try:
                sample = int(round(max(-1.0, min(1.0, float(value))) * 32767.0))
            except Exception:
                sample = 0
        out.extend(int(sample).to_bytes(2, "little", signed=True))
    return bytes(out)


def _write_wav(path: Path, pcm16: bytes, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16)


def _pip_install(requirement: str) -> None:
    pip_args = [sys.executable, "-m", "pip", "install", requirement]
    try:
        subprocess.run(pip_args, check=True, capture_output=True, text=True, timeout=600)
    except Exception as exc:
        raise stage_failed("Failed to install Kokoro dependency.", {"requirement": requirement, "error": str(exc)}) from exc


def _kokoro_tts(text: str, *, voice: str, speed: float) -> tuple[bytes, int]:
    try:
        import kokoro  # type: ignore
    except Exception as exc:
        emit("progress", stage=_STAGE, message="Installing Kokoro TTS dependency...", percent=10)
        try:
            _pip_install("kokoro")
            import kokoro  # type: ignore
        except Exception as exc2:
            raise stage_failed(
                "Kokoro TTS is not installed and auto-install failed.",
                {"import_error": str(exc), "install_error": str(exc2)},
            ) from exc2

    sample_rate: int | None = None
    audio_buf: Any = None

    if hasattr(kokoro, "KPipeline"):
        pipeline = kokoro.KPipeline(lang_code="a")  # type: ignore[attr-defined]
        try:
            result = pipeline(text, voice=voice, speed=speed)  # type: ignore[misc]
        except TypeError:
            result = pipeline(text)  # type: ignore[misc]
        except Exception:
            result = pipeline(text)  # type: ignore[misc]

        if isinstance(result, tuple) and len(result) >= 2:
            audio_buf, sample_rate = result[0], int(result[1])
        else:
            chunks: list[bytes] = []
            chunk_sr: int | None = None
            for item in result:  # type: ignore[assignment]
                a: Any | None = None
                s: int | None = None
                if isinstance(item, tuple) and len(item) >= 2:
                    a = item[0]
                    try:
                        s = int(item[1])
                    except Exception:
                        s = None
                elif isinstance(item, dict):
                    a = item.get("audio") if "audio" in item else item.get("samples")
                    for key in ("sample_rate", "sr", "rate"):
                        if key in item:
                            try:
                                s = int(item.get(key))  # type: ignore[arg-type]
                            except Exception:
                                s = None
                            break
                else:
                    if hasattr(item, "audio"):
                        a = getattr(item, "audio")
                    elif hasattr(item, "samples"):
                        a = getattr(item, "samples")
                    if hasattr(item, "sample_rate"):
                        try:
                            s = int(getattr(item, "sample_rate"))
                        except Exception:
                            s = None
                    elif hasattr(item, "sr"):
                        try:
                            s = int(getattr(item, "sr"))
                        except Exception:
                            s = None

                if a is None:
                    continue
                if s is not None and chunk_sr is None:
                    chunk_sr = s
                chunks.append(_to_pcm16(a))
            if chunk_sr is None:
                chunk_sr = 24000
            sample_rate = chunk_sr
            audio_buf = b"".join(chunks)
    elif hasattr(kokoro, "tts"):
        result = kokoro.tts(text, voice=voice, speed=speed)  # type: ignore[attr-defined]
        if isinstance(result, tuple) and len(result) >= 2:
            audio_buf, sample_rate = result[0], int(result[1])
        else:
            audio_buf = result
            sample_rate = 24000
    else:
        raise stage_failed("Unsupported Kokoro package API.", {"attrs": dir(kokoro)[:40]})

    if sample_rate is None:
        sample_rate = 24000
    return _to_pcm16(audio_buf), int(sample_rate)


def _resample_if_needed(pcm16: bytes, src_sr: int, dst_sr: int) -> bytes:
    if not pcm16 or src_sr == dst_sr:
        return pcm16
    return audioop.ratecv(pcm16, 2, 1, int(src_sr), int(dst_sr), None)[0]


def _strip_path(path: str) -> str:
    return path.strip().replace("\\", "/").lstrip("./")


def _expand_adjacent_panel_paths(panel_path: str) -> Set[str]:
    normalized = _strip_path(panel_path)
    result = {normalized}
    candidate = PurePosixPath(normalized)

    if candidate.parent.name.isdigit():
        index = int(candidate.parent.name)
        width = len(candidate.parent.name)
        parent = candidate.parent.parent
        for delta in (-1, 1):
            if index + delta >= 0:
                sibling = parent / f"{index + delta:0{width}d}" / candidate.name
                result.add(sibling.as_posix())

    match = PANEL_NUMBER_RE.match(candidate.name)
    if match:
        prefix, number, suffix = match.group("prefix"), match.group("number"), match.group("suffix")
        index = int(number)
        width = len(number)
        for delta in (-1, 1):
            if index + delta >= 0:
                sibling = candidate.parent / f"{prefix}{index + delta:0{width}d}{suffix}"
                result.add(sibling.as_posix())

    return result


def _find_panel_files(panel_path: str, search_root: Path) -> Set[Path]:
    normalized = _strip_path(panel_path)
    candidates: Set[Path] = set()
    direct = search_root / normalized
    if direct.exists() and direct.is_file():
        candidates.add(direct)
        return candidates

    suffix = normalized
    for path in search_root.rglob("*"):  # type: ignore[arg-type]
        if path.is_file() and "shorts" not in path.parts and path.as_posix().endswith(suffix):
            candidates.add(path)
    return candidates


def _chapter_name_for(path: Path | str, manga_root: Path, source_chapters: list[str]) -> str:
    path_obj = Path(path) if isinstance(path, str) else path
    relative = path_obj
    if path_obj.is_relative_to(manga_root):
        relative = path_obj.relative_to(manga_root)
    else:
        try:
            relative = path_obj.relative_to(manga_root.parent)
        except ValueError:
            relative = path_obj
    parts = list(relative.parts)
    if parts and parts[0] == manga_root.name:
        parts = parts[1:]
    for candidate in parts:
        if candidate in source_chapters:
            return candidate
    if parts:
        return parts[0]
    return "unknown"


def _copy_panel(src: Path | str, dest_root: Path, chapter_name: str, manga_root: Path) -> Path:
    src_obj = Path(src) if isinstance(src, str) else src
    try:
        relative = src_obj.relative_to(manga_root)
    except ValueError:
        parts = list(src_obj.parts)
        if chapter_name in parts:
            chapter_index = parts.index(chapter_name)
            relative = Path(*parts[chapter_index + 1 :])
        else:
            relative = src_obj.name
    parts = list(relative.parts) if isinstance(relative, Path) else [relative]
    if parts and parts[0] == chapter_name:
        relative = Path(*parts[1:])
    destination = dest_root / chapter_name / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_obj, destination)
    return destination


def _copy_panel_ordered(src: Path | str, dest_root: Path, index: int) -> Path:
    src_obj = Path(src) if isinstance(src, str) else src
    suffix = src_obj.suffix or ".png"
    destination = dest_root / f"panel_{index:04d}{suffix}"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_obj, destination)
    return destination


def _gather_sources(shorts: Any) -> tuple[list[str], list[str]]:
    if not isinstance(shorts, list):
        raise invalid_request("Expected shorts to be a list.", {})
    statements: list[str] = []
    panel_paths: list[str] = []
    for short in shorts:
        if not isinstance(short, dict):
            continue
        beats = short.get("beats")
        if not isinstance(beats, list):
            continue
        for beat in beats:
            if not isinstance(beat, dict):
                continue
            narration = beat.get("narration")
            panel_path = beat.get("panel_path")
            if isinstance(narration, str) and narration.strip():
                statements.append(narration.strip())
            if isinstance(panel_path, str) and panel_path.strip():
                panel_paths.append(panel_path.strip())
    return statements, panel_paths


def _run_stage() -> None:
    args = parse_args()
    output_root = Path(args.output_root).expanduser()
    output_root.mkdir(parents=True, exist_ok=True)

    for input_path_str in args.shorts_json:
        input_path = Path(input_path_str).expanduser()
        emit("progress", stage=_STAGE, message=f"Loading shorts JSON {input_path.name}...", percent=5)
        doc = _load_json(input_path)

        manga_title = doc.get("manga_title")
        if not isinstance(manga_title, str) or not manga_title.strip():
            raise invalid_request("Missing manga_title.", {"path": str(input_path)})
        manga_name = _sanitize_folder_name(manga_title)

        source_chapters = doc.get("source_chapters")
        if not isinstance(source_chapters, list):
            source_chapters = []
        else:
            source_chapters = [str(item) for item in source_chapters if isinstance(item, str)]

        shorts = doc.get("shorts")
        narrations, panel_paths = _gather_sources(shorts)
        if not narrations:
            raise invalid_request("No narration text found.", {"path": str(input_path)})

        full_text = "  ".join(narrations)
        emit("progress", stage=_STAGE, message="Generating full narration audio...", percent=20)
        pcm16, source_sr = _kokoro_tts(full_text, voice=args.voice, speed=args.speed)
        audio_path = output_root / manga_name / "shorts" / "narration.wav"
        target_sr = int(args.sample_rate or source_sr)
        pcm16 = _resample_if_needed(pcm16, source_sr, target_sr)
        _write_wav(audio_path, pcm16, target_sr)

        emit("progress", stage=_STAGE, message="Collecting referenced panels...", percent=45)
        manga_root = output_root / manga_name
        shorts_root = manga_root / "shorts"
        panels_root = shorts_root / "panels"
        copied_paths: list[str] = []
        missing_paths: list[str] = []
        panel_index = 1

        search_roots = [manga_root, output_root]
        if manga_root.exists() and manga_root != output_root:
            search_roots = [manga_root, output_root]
        else:
            search_roots = [output_root]

        for panel_path in panel_paths:
            candidates: Set[Path] = set()
            for expanded in _expand_adjacent_panel_paths(panel_path):
                for search_root in search_roots:
                    candidates.update(_find_panel_files(expanded, search_root))
            if not candidates:
                missing_paths.append(panel_path)
                continue

            candidate = sorted(candidates)[0]
            dest = _copy_panel_ordered(candidate, panels_root, panel_index)
            copied_paths.append(dest.as_posix())
            panel_index += 1

        emit(
            "complete",
            stage=_STAGE,
            message=f"Built shorts for {manga_title}.",
            manga_title=manga_title,
            output_audio=str(audio_path),
            output_dir=str(shorts_root),
            copied_panels=copied_paths,
            missing_panel_paths=missing_paths,
        )


if __name__ == "__main__":
    raise SystemExit(run_with_error_boundary(_STAGE, _run_stage))
