#!/usr/bin/env python3
from __future__ import annotations

import argparse
import audioop
import json
import re
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from scripts.common.errors import invalid_request, stage_failed
from scripts.common.events import emit, run_with_error_boundary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stage 5: generate natural per-page narration audio from recap_pages_with_sentences.json."
    )
    parser.add_argument("refined_recap_pages", help="Path to final/recap_pages_with_sentences.json (from Stage 4).")
    parser.add_argument(
        "--out-dir",
        default=None,
        help="Output audio folder (default: alongside input as ./audio).",
    )
    parser.add_argument(
        "--out-json",
        default=None,
        help="Output final_script.json path (default: alongside input as final_script.json).",
    )
    parser.add_argument("--voice", default=None, help="Kokoro voice id (default: read from config/defaults.json).")
    parser.add_argument("--speed", type=float, default=None, help="TTS speed (default: read from config/defaults.json).")
    parser.add_argument("--sample-rate", type=int, default=None, help="Override output sample rate (Hz).")
    parser.add_argument("--snap-window-ms", type=int, default=150, help="Boundary snapping search window (ms).")
    parser.add_argument("--no-snap", action="store_true", help="Disable pause snapping for panel boundaries.")
    parser.add_argument("--fast", action="store_true", help="Use word-count heuristic for page duration estimates instead of real TTS (faster but less accurate timestamps).")
    parser.add_argument("--silence-threshold-db", type=float, default=-42.0, help="Trim threshold in dBFS.")
    args = parser.parse_args()

    in_path = Path(args.refined_recap_pages).expanduser()
    if not in_path.exists():
        raise invalid_request("Input recap_pages_with_sentences.json not found.", {"path": str(in_path)})
    return args


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise invalid_request("Expected valid JSON.", {"path": str(path), "error": str(exc)}) from exc


def _read_defaults() -> dict[str, Any]:
    defaults_path = Path(__file__).resolve().parents[1] / "config" / "defaults.json"
    try:
        return json.loads(defaults_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _ensure_sentence_punctuation(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    if re.search(r"[.!?]$", t):
        return t
    return t + "."


def _page_text_from_panels(panels: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for panel in panels:
        s = panel.get("sentence") if isinstance(panel, dict) else ""
        if not isinstance(s, str):
            continue
        s = _ensure_sentence_punctuation(s)
        if s:
            parts.append(s)
    return " ".join(parts).strip()


def _dbfs_to_linear(threshold_db: float) -> float:
    return float(10 ** (threshold_db / 20.0))


def _int16_max() -> int:
    return 32767


def _bytes_to_int16_list(pcm16: bytes) -> list[int]:
    out: list[int] = []
    for i in range(0, len(pcm16), 2):
        v = int.from_bytes(pcm16[i : i + 2], "little", signed=True)
        out.append(v)
    return out


def _int16_list_to_bytes(samples: Sequence[int]) -> bytes:
    return b"".join(int(s).to_bytes(2, "little", signed=True) for s in samples)


def _trim_silence(pcm16: bytes, sample_rate: int, threshold_db: float) -> bytes:
    if not pcm16:
        return pcm16
    frame_samples = max(1, int(sample_rate * 0.01))
    frame_bytes = frame_samples * 2
    linear = _dbfs_to_linear(threshold_db)
    threshold_amp = int(_int16_max() * linear)

    def frame_is_silent(frame: bytes) -> bool:
        if not frame:
            return True
        return audioop.max(frame, 2) < threshold_amp

    start = 0
    while start + frame_bytes <= len(pcm16) and frame_is_silent(pcm16[start : start + frame_bytes]):
        start += frame_bytes

    end = len(pcm16)
    while end - frame_bytes >= start + frame_bytes and frame_is_silent(pcm16[end - frame_bytes : end]):
        end -= frame_bytes

    if start >= end:
        return pcm16[: min(len(pcm16), frame_bytes)]
    return pcm16[start:end]


def _rms_normalize(pcm16: bytes, target_dbfs: float = -18.0) -> bytes:
    if not pcm16:
        return pcm16
    rms = audioop.rms(pcm16, 2)
    if rms <= 0:
        return pcm16
    target_linear = _dbfs_to_linear(target_dbfs)
    target_rms = int(_int16_max() * target_linear)
    if target_rms <= 0:
        return pcm16
    factor = target_rms / float(rms)
    factor = max(0.1, min(10.0, factor))
    return audioop.mul(pcm16, 2, factor)


def _limit_peak(pcm16: bytes, peak_dbfs: float = -1.0) -> bytes:
    if not pcm16:
        return pcm16
    peak = audioop.max(pcm16, 2)
    if peak <= 0:
        return pcm16
    limit = int(_int16_max() * _dbfs_to_linear(peak_dbfs))
    if peak <= limit:
        return pcm16
    factor = limit / float(peak)
    return audioop.mul(pcm16, 2, factor)


def _snap_boundary_to_pause(pcm16: bytes, sample_rate: int, center_sample: int, window_ms: int) -> int:
    if not pcm16:
        return center_sample
    total_samples = len(pcm16) // 2
    if total_samples <= 0:
        return center_sample
    window_samples = max(1, int(sample_rate * (window_ms / 1000.0)))
    start = max(0, center_sample - window_samples)
    end = min(total_samples, center_sample + window_samples)
    if end <= start + 1:
        return center_sample

    frame_samples = max(1, int(sample_rate * 0.01))
    best_idx = center_sample
    best_rms = None
    for frame_start in range(start, end, frame_samples):
        frame_end = min(end, frame_start + frame_samples)
        fragment = pcm16[frame_start * 2 : frame_end * 2]
        r = audioop.rms(fragment, 2)
        if best_rms is None or r < best_rms:
            best_rms = r
            best_idx = frame_start + (frame_end - frame_start) // 2
    return int(best_idx)


def _compute_panel_boundaries_samples(
    *,
    page_pcm16: bytes,
    sample_rate: int,
    panel_weights_s: Sequence[float],
    snap: bool,
    snap_window_ms: int,
) -> list[int]:
    """
    Returns N+1 monotonically increasing boundary sample indices for N panels.
    """
    n = len(panel_weights_s)
    page_samples = len(page_pcm16) // 2
    if n <= 0:
        return [0, page_samples]
    if page_samples <= 0:
        return [0 for _ in range(n + 1)]

    weights = [max(0.0, float(w)) for w in panel_weights_s]
    total_w = sum(w for w in weights if w > 0)
    if total_w <= 0:
        weights = [1.0 for _ in range(n)]
        total_w = float(n)

    boundaries = [0]
    cursor = 0
    for idx in range(n):
        w = weights[idx]
        frac = w / total_w
        dur = int(round(frac * page_samples))
        if idx == n - 1:
            dur = max(0, page_samples - cursor)
        dur = max(1, dur) if page_samples > 0 else 0
        cursor = min(page_samples, cursor + dur)
        boundaries.append(cursor)
    boundaries[-1] = page_samples

    if snap and n > 1:
        for i in range(1, n):
            center = int(boundaries[i])
            snapped = _snap_boundary_to_pause(page_pcm16, sample_rate, center, snap_window_ms)
            boundaries[i] = int(snapped)

        for i in range(1, n):
            boundaries[i] = max(boundaries[i], boundaries[i - 1] + 1)
        for i in range(n - 1, 0, -1):
            boundaries[i] = min(boundaries[i], boundaries[i + 1] - 1)

        boundaries[0] = 0
        boundaries[-1] = page_samples
        for i in range(1, n):
            boundaries[i] = max(0, min(page_samples, boundaries[i]))

        for i in range(1, n):
            boundaries[i] = max(boundaries[i], boundaries[i - 1] + 1)
        for i in range(n - 1, 0, -1):
            boundaries[i] = min(boundaries[i], boundaries[i + 1] - 1)

    return boundaries


def _write_wav(path: Path, pcm16: bytes, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16)


def _duration_s(pcm16: bytes, sample_rate: int) -> float:
    if sample_rate <= 0:
        return 0.0
    return (len(pcm16) / 2.0) / float(sample_rate)


@dataclass(frozen=True)
class TtsResult:
    pcm16: bytes
    sample_rate: int


def _to_pcm16(audio: Any) -> bytes:
    if audio is None:
        return b""
    if isinstance(audio, (bytes, bytearray)):
        return bytes(audio)
    if hasattr(audio, "tolist"):
        audio = audio.tolist()
    if isinstance(audio, Sequence):
        seq = audio
    else:
        try:
            seq = list(audio)  # type: ignore[arg-type]
        except Exception:
            raise stage_failed("Unsupported audio buffer type from TTS.", {"type": str(type(audio))})

    out = bytearray()
    for v in seq:
        if isinstance(v, bool):
            s = 0
        elif isinstance(v, int):
            s = max(-32768, min(32767, int(v)))
        else:
            try:
                f = float(v)
            except Exception:
                f = 0.0
            f = max(-1.0, min(1.0, f))
            s = int(round(f * 32767.0))
        out.extend(int(s).to_bytes(2, "little", signed=True))
    return bytes(out)


_KOKORO_ENGINE: Any | None = None


def _pip_install(requirement: str) -> None:
    emit("progress", stage=5, message=f"Installing Python dependency: {requirement}...", percent=11)
    in_venv = getattr(sys, "base_prefix", sys.prefix) != sys.prefix
    pip_args = [sys.executable, "-m", "pip", "install"]
    if not in_venv:
        pip_args.append("--user")
    pip_args.append(requirement)

    try:
        proc = subprocess.run(
            pip_args,
            capture_output=True,
            text=True,
            check=False,
            timeout=600,
        )
    except Exception as exc:  # noqa: BLE001
        raise stage_failed(
            "Failed to run pip to install dependencies.",
            {"requirement": requirement, "python": sys.executable, "pip_args": pip_args, "error": str(exc)},
        ) from exc

    if proc.returncode != 0:
        raise stage_failed(
            "pip install failed.",
            {
                "requirement": requirement,
                "python": sys.executable,
                "returncode": proc.returncode,
                "stdout": (proc.stdout or "").strip()[-2000:],
                "stderr": (proc.stderr or "").strip()[-2000:],
            },
        )


def _kokoro_tts(text: str, *, voice: str, speed: float) -> TtsResult:
    global _KOKORO_ENGINE
    try:
        import kokoro  # type: ignore
    except Exception as exc:  # noqa: BLE001
        try:
            _pip_install("kokoro")
            import kokoro  # type: ignore  # noqa: F401, PLC0415
        except Exception as exc2:  # noqa: BLE001
            raise stage_failed(
                "Kokoro TTS is not installed and auto-install failed.",
                {
                    "hint": "pip install kokoro",
                    "python": sys.executable,
                    "import_error": str(exc),
                    "install_error": str(exc2),
                },
            ) from exc2

    sr: int | None = None
    audio_buf: Any = None

    if hasattr(kokoro, "KPipeline"):
        if _KOKORO_ENGINE is None:
            _KOKORO_ENGINE = kokoro.KPipeline(lang_code="a")  # type: ignore[attr-defined]
        pipe = _KOKORO_ENGINE
        try:
            result = pipe(text, voice=voice, speed=speed)  # type: ignore[misc]
        except TypeError:
            result = pipe(text)  # type: ignore[misc]
        if isinstance(result, tuple) and len(result) >= 2:
            audio_buf, sr = result[0], int(result[1])
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
            sr = chunk_sr
            audio_buf = b"".join(chunks)
    elif hasattr(kokoro, "tts"):
        result = kokoro.tts(text, voice=voice, speed=speed)  # type: ignore[attr-defined]
        if isinstance(result, tuple) and len(result) >= 2:
            audio_buf, sr = result[0], int(result[1])
        else:
            audio_buf = result
            sr = None
    else:
        raise stage_failed("Unsupported kokoro package API.", {"module_attrs": dir(kokoro)[:40]})

    if sr is None:
        sr = 24000
    pcm16 = _to_pcm16(audio_buf)
    return TtsResult(pcm16=pcm16, sample_rate=int(sr))


def _resample_if_needed(pcm16: bytes, src_sr: int, dst_sr: int) -> bytes:
    if not pcm16 or src_sr == dst_sr:
        return pcm16
    converted, _ = audioop.ratecv(pcm16, 2, 1, int(src_sr), int(dst_sr), None)
    return converted


def _estimate_page_duration_s(
    panels: list[dict[str, Any]],
    *,
    voice: str,
    speed: float,
    sample_rate: int,
    silence_db: float,
    do_timing_tts: bool,
) -> float:
    """
    Estimate how long the narration for a page will be.

    When --timing-tts is set we generate real TTS for the page text and
    measure it precisely.  Otherwise we fall back to a fast word-count
    heuristic (about 0.28 s/word at normal speed, scaled by 1/speed).
    """
    page_text = _page_text_from_panels(panels)
    if not page_text:
        return 0.0

    if do_timing_tts:
        tts = _kokoro_tts(page_text, voice=voice, speed=speed)
        pcm = _resample_if_needed(tts.pcm16, tts.sample_rate, sample_rate)
        pcm = _trim_silence(pcm, sample_rate, silence_db)
        return max(0.05, _duration_s(pcm, sample_rate))
    else:
        word_count = len(page_text.split())
        # ~0.28 s/word at speed=1.0; faster speed → fewer seconds.
        return max(0.15, word_count * 0.28 / max(0.1, speed))


def _estimate_panel_weights(
    panels: list[dict[str, Any]],
    *,
    voice: str,
    speed: float,
    sample_rate: int,
    silence_db: float,
    do_timing_tts: bool,
) -> list[float]:
    """
    Estimate the relative duration weight for each panel within a page.
    Uses the same TTS / heuristic choice as _estimate_page_duration_s.
    """
    weights: list[float] = []
    for panel in panels:
        s = panel.get("sentence")
        if not isinstance(s, str) or not s.strip():
            weights.append(0.2)
            continue
        s_norm = _ensure_sentence_punctuation(s)
        if do_timing_tts:
            tts = _kokoro_tts(s_norm, voice=voice, speed=speed)
            pcm = _resample_if_needed(tts.pcm16, tts.sample_rate, sample_rate)
            pcm = _trim_silence(pcm, sample_rate, silence_db)
            w = max(0.05, _duration_s(pcm, sample_rate))
        else:
            w = max(0.15, float(len(s_norm.split())) * 0.28 / max(0.1, speed))
        weights.append(float(w))
    return weights


def _run_stage() -> None:
    args = parse_args()
    in_path = Path(args.refined_recap_pages).expanduser()
    in_dir = in_path.parent
    out_dir = Path(args.out_dir).expanduser() if isinstance(args.out_dir, str) and args.out_dir else (in_dir / "audio")
    out_json = (
        Path(args.out_json).expanduser()
        if isinstance(args.out_json, str) and args.out_json
        else (in_dir / "final_script.json")
    )

    defaults = _read_defaults()
    voice = str(args.voice or defaults.get("tts_voice") or "am_echo")
    speed = float(args.speed if args.speed is not None else float(defaults.get("tts_speed") or 1.0))
    target_sr: int | None = int(args.sample_rate) if isinstance(args.sample_rate, int) and args.sample_rate else None

    silence_db = float(args.silence_threshold_db)
    snap_window_ms = int(max(0, args.snap_window_ms))
    do_snap = not bool(args.no_snap)
    do_timing_tts = not bool(args.fast)

    emit("progress", stage=5, message="Loading recap_pages_with_sentences.json...", percent=5)
    doc = _read_json(in_path)
    if not isinstance(doc, dict) or doc.get("mode") != "page":
        raise invalid_request("Expected mode='page' input.", {"path": str(in_path)})
    pages = doc.get("pages")
    if not isinstance(pages, list) or not pages:
        raise invalid_request("Expected non-empty pages[].", {"path": str(in_path)})

    pages_sorted: list[dict[str, Any]] = [
        p for p in pages if isinstance(p, dict) and isinstance(p.get("page_idx"), int)
    ]
    pages_sorted.sort(key=lambda p: int(p.get("page_idx") or 0))
    if not pages_sorted:
        raise invalid_request("No pages[] entries with page_idx.", {"path": str(in_path)})

    # -------------------------------------------------------------------------
    # Pass 1: collect per-page panels and estimate durations.
    #
    # This pass never touches the final audio.  Its only job is to figure out
    # how long each page's narration will be so we can carve up the single
    # full-chapter audio into proportional timestamps afterwards.
    #
    # We also collect per-panel weights here so the panel-boundary logic in
    # pass 3 has something to work with.
    # -------------------------------------------------------------------------
    emit("progress", stage=5, message="Estimating per-page durations...", percent=10)

    per_page_panels: dict[int, list[dict[str, Any]]] = {}
    per_page_duration_s: dict[int, float] = {}
    per_page_panel_weights: dict[int, list[float]] = {}

    # We need a sample rate before we can do timing-TTS properly.
    # If the user didn't specify one, probe it with a quick single-word call.
    if target_sr is None:
        probe = _kokoro_tts("Hello.", voice=voice, speed=speed)
        target_sr = probe.sample_rate
        emit("progress", stage=5, message=f"Detected TTS sample rate: {target_sr} Hz", percent=12)

    active_pages = [
        p for p in pages_sorted
        if isinstance(p.get("panels"), list) and any(isinstance(x, dict) for x in p["panels"])
    ]

    for i, page in enumerate(active_pages, start=1):
        page_idx = int(page.get("page_idx") or 0)
        panels = [p for p in page["panels"] if isinstance(p, dict)]
        per_page_panels[page_idx] = panels

        page_text = _page_text_from_panels(panels)
        if not page_text:
            per_page_duration_s[page_idx] = 0.0
            per_page_panel_weights[page_idx] = [0.2 for _ in panels]
            continue

        percent = 12 + int((i / max(1, len(active_pages))) * 28)
        emit(
            "progress",
            stage=5,
            message=f"Estimating duration page {i}/{len(active_pages)} (page_idx={page_idx})...",
            percent=percent,
        )

        dur = _estimate_page_duration_s(
            panels,
            voice=voice,
            speed=speed,
            sample_rate=target_sr,
            silence_db=silence_db,
            do_timing_tts=do_timing_tts,
        )
        per_page_duration_s[page_idx] = dur

        weights = _estimate_panel_weights(
            panels,
            voice=voice,
            speed=speed,
            sample_rate=target_sr,
            silence_db=silence_db,
            # Panel weights always use heuristic to avoid 2× TTS calls per panel.
            # Only the page-level duration benefits from --timing-tts precision.
            do_timing_tts=False,
        )
        per_page_panel_weights[page_idx] = weights

    if not per_page_duration_s:
        raise stage_failed("No usable pages found.", {"hint": "Check that Stage 4 sentences are non-empty."})

    total_estimated_s = sum(per_page_duration_s.values())
    if total_estimated_s <= 0:
        raise stage_failed("All estimated page durations are zero.", {"hint": "Check panel sentences."})

    # -------------------------------------------------------------------------
    # Pass 2: generate the full chapter as a single TTS call.
    #
    # We join every page's text in order, separated by a double space so the
    # TTS model treats them as distinct sentences rather than running them
    # together.  The result is one continuous, naturally-prosodied narration
    # with no resets, no stitching seams, and no per-page energy spikes.
    # -------------------------------------------------------------------------
    emit("progress", stage=5, message="Building full chapter text...", percent=42)

    chapter_parts: list[str] = []
    for page in pages_sorted:
        page_idx = int(page.get("page_idx") or 0)
        panels = per_page_panels.get(page_idx)
        if not panels:
            continue
        page_text = _page_text_from_panels(panels)
        if page_text:
            chapter_parts.append(page_text)

    if not chapter_parts:
        raise stage_failed("No page text to narrate.", {"hint": "Check panel sentences."})

    # Two spaces between pages gives Kokoro a natural inter-sentence pause
    # without introducing an explicit break token.
    full_chapter_text = "  ".join(chapter_parts)

    emit("progress", stage=5, message="Generating full chapter TTS (one continuous call)...", percent=45)
    full_tts = _kokoro_tts(full_chapter_text, voice=voice, speed=speed)

    full_pcm = _resample_if_needed(full_tts.pcm16, full_tts.sample_rate, target_sr)
    full_pcm = _trim_silence(full_pcm, target_sr, silence_db)
    full_pcm = _rms_normalize(full_pcm, target_dbfs=-18.0)
    full_pcm = _limit_peak(full_pcm, peak_dbfs=-1.0)

    full_duration_s = _duration_s(full_pcm, target_sr)
    if full_duration_s <= 0:
        raise stage_failed("Full chapter TTS produced empty audio.", {})

    emit(
        "progress",
        stage=5,
        message=f"Full chapter audio: {full_duration_s:.1f}s (estimated {total_estimated_s:.1f}s)",
        percent=75,
    )

    # -------------------------------------------------------------------------
    # Pass 3: carve timestamps proportionally and compute panel boundaries.
    #
    # Each page's share of the full audio is:
    #   page_frac = page_duration_estimate / total_duration_estimate
    #   page_real_duration = page_frac * full_duration_s
    #
    # Within each page slice we subdivide by panel weights exactly as before,
    # using the existing _compute_panel_boundaries_samples logic against the
    # relevant slice of the full PCM buffer.
    # -------------------------------------------------------------------------
    emit("progress", stage=5, message="Carving timestamps and computing panel boundaries...", percent=80)

    pages_out: list[dict[str, Any]] = []
    cursor_samples = 0

    for i, page in enumerate(pages_sorted, start=1):
        page_idx = int(page.get("page_idx") or 0)
        panels = per_page_panels.get(page_idx)
        if not panels:
            continue

        est_dur = per_page_duration_s.get(page_idx, 0.0)
        if est_dur <= 0:
            continue

        page_frac = est_dur / total_estimated_s
        page_samples = int(round(page_frac * (len(full_pcm) // 2)))

        # Last page gets whatever samples remain to avoid rounding drift.
        remaining_pages_with_audio = sum(
            1 for p in pages_sorted[i:]
            if per_page_duration_s.get(int(p.get("page_idx") or 0), 0.0) > 0
        )
        if remaining_pages_with_audio == 0:
            page_samples = max(0, (len(full_pcm) // 2) - cursor_samples)

        page_samples = max(0, min(page_samples, (len(full_pcm) // 2) - cursor_samples))

        page_start_sample = cursor_samples
        page_end_sample = cursor_samples + page_samples

        # Slice of the full audio for this page (used for pause snapping).
        page_slice_pcm = full_pcm[page_start_sample * 2 : page_end_sample * 2]

        weights = per_page_panel_weights.get(page_idx, [1.0 for _ in panels])
        if len(weights) != len(panels):
            weights = [1.0 for _ in panels]

        boundaries = _compute_panel_boundaries_samples(
            page_pcm16=page_slice_pcm,
            sample_rate=target_sr,
            panel_weights_s=weights,
            snap=do_snap,
            snap_window_ms=snap_window_ms,
        )

        panel_entries: list[dict[str, Any]] = []
        for idx, panel in enumerate(panels):
            local_start = int(boundaries[idx]) if idx < len(boundaries) else 0
            local_end = int(boundaries[idx + 1]) if idx + 1 < len(boundaries) else page_samples

            abs_start_ms = int(round(((page_start_sample + local_start) / target_sr) * 1000.0))
            abs_end_ms = int(round(((page_start_sample + local_end) / target_sr) * 1000.0))

            panel_entries.append(
                {
                    "sub_panel_idx": int(panel.get("sub_panel_idx") or 0),
                    "panel_id": panel.get("panel_id"),
                    "crop_path": panel.get("crop_path"),
                    "sentence": panel.get("sentence"),
                    "start_ms": abs_start_ms,
                    "end_ms": abs_end_ms,
                }
            )

        pages_out.append(
            {
                "page_idx": page_idx,
                "recap": page.get("recap", ""),
                "start_ms": int(round((page_start_sample / target_sr) * 1000.0)),
                "end_ms": int(round((page_end_sample / target_sr) * 1000.0)),
                "panels": panel_entries,
            }
        )

        cursor_samples += page_samples

        if i % 5 == 0:
            percent = 80 + int((i / max(1, len(pages_sorted))) * 15)
            emit("progress", stage=5, message="Computing panel timestamps...", percent=percent)

    # -------------------------------------------------------------------------
    # Write outputs.
    # -------------------------------------------------------------------------
    narration_path = out_dir / "narration.wav"
    emit("progress", stage=5, message="Writing narration audio...", percent=95)
    _write_wav(narration_path, full_pcm, target_sr)

    final_doc = {
        "mode": "page",
        "source_refined_recap_path": str(in_path),
        "audio_path": str(narration_path),
        "sample_rate": target_sr,
        "total_duration_ms": int(round(full_duration_s * 1000.0)),
        "pages": pages_out,
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(final_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    emit("progress", stage=5, message="Stage 5 complete.", percent=100)
    emit(
        "complete",
        stage=5,
        narration_audio_path=str(narration_path),
        final_script_path=str(out_json),
        audio_dir=str(out_dir),
        voice=voice,
        speed=speed,
        full_duration_s=round(full_duration_s, 3),
        total_estimated_s=round(total_estimated_s, 3),
    )


def main() -> None:
    raise SystemExit(run_with_error_boundary(5, _run_stage))


if __name__ == "__main__":
    main()