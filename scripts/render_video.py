#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import random
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from scripts.common.errors import invalid_request, stage_failed
from scripts.common.events import emit, run_with_error_boundary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage 6: render MP4 video from final_script.json + stitched narration.")
    parser.add_argument("final_script_json", help="Path to output/final/final_script.json (from Stage 5).")
    parser.add_argument("--out-mp4", default=None, help="Output mp4 path (default: alongside input as video.mp4).")
    parser.add_argument("--fps", type=int, default=24, help="Video FPS (default: 24).")
    parser.add_argument("--width", type=int, default=1920, help="(Ignored) Output width. Stage 6 always renders 1920x1080.")
    parser.add_argument("--height", type=int, default=1080, help="(Ignored) Output height. Stage 6 always renders 1920x1080.")
    parser.add_argument("--crf", type=int, default=18, help="H.264 quality CRF (default: 18).")
    parser.add_argument("--preset", default="veryfast", help="x264 preset (default: veryfast).")
    parser.add_argument(
        "--encoder",
        default=None,
        choices=["libx264", "h264_videotoolbox"],
        help="Video encoder (default: h264_videotoolbox on macOS, libx264 elsewhere).",
    )
    parser.add_argument("--video-bitrate", default="8M", help="Video bitrate for h264_videotoolbox (default: 8M).")
    parser.add_argument("--no-audio", action="store_true", help="Render video without audio track.")
    parser.add_argument("--no-transitions", action="store_true", help="Disable fly-in transitions (static panels).")
    parser.add_argument("--transition-seed", type=int, default=None, help="Random seed for per-panel transitions.")
    # Transition duration: 48 frames = 2 seconds at 24fps. Smooth and readable.
    parser.add_argument("--transition-frames", type=int, default=48, help="Number of frames for fly-in transition (default: 48, i.e. 2s at 24fps).")
    parser.add_argument(
        "--ffmpeg-loglevel",
        default="error",
        choices=["quiet", "panic", "fatal", "error", "warning", "info", "verbose", "debug", "trace"],
        help="ffmpeg loglevel to stream via stderr (default: error).",
    )
    parser.add_argument("--overwrite", action="store_true", help="Overwrite output if exists.")
    return parser.parse_args()


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise invalid_request("Expected valid JSON.", {"path": str(path), "error": str(exc)}) from exc


def _resolve_media_path(final_script_path: Path, raw: str) -> Path:
    p = Path(raw)
    if p.is_absolute():
        return p
    if p.exists():
        return p
    output_root = final_script_path.parent.parent
    cand = output_root / p
    if cand.exists():
        return cand
    cand2 = final_script_path.parent / p
    if cand2.exists():
        return cand2
    return cand


def _quote_concat_path(path: Path) -> str:
    s = str(path)
    return "'" + s.replace("'", "'\\''") + "'"


def _collect_panels(
    *,
    final_script_path: Path,
    doc: dict[str, Any],
    fps: int,
) -> dict[str, Any]:
    pages = doc.get("pages")
    if not isinstance(pages, list) or not pages:
        raise invalid_request("final_script.json must include pages[].", {"path": str(final_script_path)})

    panels: list[dict[str, Any]] = []
    for page in pages:
        if not isinstance(page, dict):
            continue
        page_panels = page.get("panels")
        if not isinstance(page_panels, list):
            continue
        for panel in page_panels:
            if isinstance(panel, dict):
                panels.append(panel)

    if not panels:
        raise invalid_request("final_script.json must include at least one panel.", {"path": str(final_script_path)})

    panels = sorted(
        panels,
        key=lambda p: (
            int(p.get("start_ms") or 0),
            int(p.get("end_ms") or 0),
            str(p.get("panel_id") or ""),
        ),
    )

    min_dur_s = 1.0 / float(max(1, fps))
    items: list[tuple[Path, float]] = []
    for panel in panels:
        crop = panel.get("crop_path")
        if not isinstance(crop, str) or not crop.strip():
            raise invalid_request("Each panel must include crop_path.", {"panel": panel})
        start_ms = int(panel.get("start_ms") or 0)
        end_ms = int(panel.get("end_ms") or 0)
        dur_s = max(0.0, (end_ms - start_ms) / 1000.0)
        if not math.isfinite(dur_s) or dur_s <= 0:
            dur_s = min_dur_s
        dur_s = max(min_dur_s, dur_s)
        crop_path = _resolve_media_path(final_script_path, crop.strip())
        if not crop_path.exists():
            raise invalid_request("Panel image not found.", {"crop_path": crop, "resolved": str(crop_path)})
        items.append((crop_path.resolve(), dur_s))

    return {"panel_count": len(items), "items": items}


# ---------------------------------------------------------------------------
# Transition system
#
# Each transition is a short "fly-in": the panel slides from off-screen to its
# resting position (center of canvas), OR zooms in from a small scale.
# All effects last exactly `transition_frames` frames (default 48 = 2s at 24fps).
#
# Easing: smoothstep  s(t) = 3t² - 2t³
#   - Starts slow, accelerates through the middle, decelerates to rest.
#   - No overshoot, no bounce — completely smooth arrival.
#
# Position expression (for slide transitions):
#   t = n / (N-1)              [0..1 over N frames]
#   smooth = 3t² - 2t³         [smoothstep ease-in-out]
#   pos = start_offset * (1 - smooth)   [start_offset → 0]
#
# Available transition kinds:
#   from_left   : panel enters from left edge
#   from_right  : panel enters from right edge
#   from_top    : panel enters from top edge
#   from_bottom : panel enters from bottom edge
#   zoom_in     : panel scales up from ~20% to 100%
#   zoom_out    : panel scales down from 150% to 100%
# ---------------------------------------------------------------------------

_TRANSITION_KINDS = ["from_left", "from_right", "from_top", "from_bottom"]


def _choose_transition(rng: random.Random) -> str:
    return rng.choice(_TRANSITION_KINDS)


def _build_intro_segment_filtergraph(
    *,
    kind: str,
    width: int,
    height: int,
    fps: int,
    transition_frames: int,
    pix_fmt: str,
) -> str:
    """
    Return an ffmpeg -vf filter string that takes a single still image (input [0:v])
    and produces `transition_frames` frames of animation where the panel flies
    in from the chosen direction.

    Easing uses smoothstep: s(t) = 3t^2 - 2t^3  (ease-in-out, no bounce).

    The input image is assumed to already be scaled to width x height.
    """
    N = max(2, transition_frames)
    Nm1 = N - 1

    W = width
    H = height

    # Smoothstep ease-in-out: s(t) = 3t^2 - 2t^3, where t = n/Nm1
    # Position offset = start_offset * (1 - s(t))  →  travels from start_offset to 0
    # In ffmpeg expression syntax (t = n/Nm1):
    #   t_expr   = "n/{Nm1}"
    #   smooth   = "3*(n/{Nm1})^2 - 2*(n/{Nm1})^3"   — but ffmpeg uses pow()
    #   residual = "1 - smooth"  =  "(1-(n/{Nm1}))^2 * (1+2*(n/{Nm1}))"
    #            (factored form of 1-smoothstep, avoids needing subtraction of a cube)
    # Factored residual (easier for ffmpeg parser):
    #   residual(t) = (1-t)^2 * (1+2t)
    # This equals 1 at t=0 and 0 at t=1 — exactly what we need.

    def residual(t_var: str) -> str:
        """ffmpeg expression for (1-t)^2*(1+2t) using t_var as the t expression."""
        return f"(1-{t_var})*(1-{t_var})*(1+2*{t_var})"

    t_expr = f"n/{Nm1}"
    res = residual(t_expr)

    if kind in ("from_left", "from_right", "from_top", "from_bottom"):
        if kind == "from_left":
            x_expr = f"({-W}*{res})"
            y_expr = "0"
        elif kind == "from_right":
            x_expr = f"({W}*{res})"
            y_expr = "0"
        elif kind == "from_top":
            x_expr = "0"
            y_expr = f"({-H}*{res})"
        else:  # from_bottom
            x_expr = "0"
            y_expr = f"({H}*{res})"

        vf = (
            f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
            f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black,"
            f"setsar=1[panel_scaled];"
            f"color=black:size={W}x{H}:rate={fps}[bg];"
            f"[bg][panel_scaled]overlay=x='{x_expr}':y='{y_expr}':shortest=1,"
            f"trim=end_frame={N},setpts=PTS-STARTPTS,"
            f"format={pix_fmt}"
        )
        return vf




def _run_ffmpeg_streaming(cmd: list[str]) -> tuple[int, str]:
    """Run ffmpeg and stream stderr lines. Returns (exit_code, stderr_tail)."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stderr_tail: list[str] = []
    max_tail_lines = 200

    assert proc.stderr is not None
    for line in proc.stderr:
        line = (line or "").rstrip()
        if line:
            print(f"[ffmpeg] {line}", file=sys.stderr)
            stderr_tail.append(line)
            if len(stderr_tail) > max_tail_lines:
                stderr_tail = stderr_tail[-max_tail_lines:]

    proc.wait()
    return int(proc.returncode or 0), "\n".join(stderr_tail[-max_tail_lines:])


def _render_panel_with_transition(
    *,
    img_path: Path,
    dur_s: float,
    transition_kind: str,
    width: int,
    height: int,
    fps: int,
    transition_frames: int,
    encoder: str,
    crf: int,
    preset: str,
    video_bitrate: str,
    pix_fmt: str,
    out_path: Path,
    overwrite: bool,
    ffmpeg_loglevel: str,
) -> tuple[int, str]:
    """
    Render a single panel segment with a fly-in transition intro.

    Strategy:
      1. Render the SHORT transition intro clip (transition_frames frames) using
         the animated filtergraph. This is fast — very few frames.
      2. Render the STATIC remainder of the panel (dur_s minus transition duration).
         This uses the concat demuxer on a single image, which ffmpeg handles
         extremely efficiently (no per-frame filter cost).
      3. Concatenate intro + static with stream copy (instant).

    This approach avoids per-frame zoompan on long panels entirely.
    The only slow part is the intro (≤48 frames by default).
    """
    N = max(2, transition_frames)
    transition_dur_s = N / float(fps)
    static_dur_s = max(0.0, dur_s - transition_dur_s)

    seg_dir = out_path.parent
    seg_dir.mkdir(parents=True, exist_ok=True)

    stem = out_path.stem
    intro_path = seg_dir / f"{stem}_intro.mp4"
    static_path = seg_dir / f"{stem}_static.mp4"
    seg_list_path = seg_dir / f"{stem}_parts.txt"

    overwrite_flag = ["-y"] if overwrite else ["-n"]

    # ── 1. Intro clip ────────────────────────────────────────────────────────
    intro_vf = _build_intro_segment_filtergraph(
        kind=transition_kind,
        width=width,
        height=height,
        fps=fps,
        transition_frames=N,
        pix_fmt=pix_fmt,
    )

    intro_cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", ffmpeg_loglevel,
        "-loop", "1",
        "-framerate", str(fps),
        "-t", f"{transition_dur_s:.6f}",
        "-i", str(img_path),
        "-vf", intro_vf,
        "-r", str(fps),
        "-c:v", encoder,
        "-an",
    ]
    if encoder == "libx264":
        intro_cmd += ["-preset", preset, "-crf", str(crf)]
    else:
        intro_cmd += ["-allow_sw", "1", "-b:v", video_bitrate, "-pix_fmt", pix_fmt]
    intro_cmd += overwrite_flag + [str(intro_path)]

    rc, stderr = _run_ffmpeg_streaming(intro_cmd)
    if rc != 0:
        return rc, stderr

    # ── 2. Static clip (rest of panel duration) ───────────────────────────────
    if static_dur_s > 0:
        static_vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,"
            f"setsar=1,format={pix_fmt}"
        )
        static_cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", ffmpeg_loglevel,
            "-loop", "1",
            "-framerate", str(fps),
            "-t", f"{static_dur_s:.6f}",
            "-i", str(img_path),
            "-vf", static_vf,
            "-r", str(fps),
            "-c:v", encoder,
            "-an",
        ]
        if encoder == "libx264":
            static_cmd += ["-preset", preset, "-crf", str(crf)]
        else:
            static_cmd += ["-allow_sw", "1", "-b:v", video_bitrate, "-pix_fmt", pix_fmt]
        static_cmd += overwrite_flag + [str(static_path)]

        rc, stderr = _run_ffmpeg_streaming(static_cmd)
        if rc != 0:
            return rc, stderr

        # ── 3. Concat intro + static ─────────────────────────────────────────
        seg_list_path.write_text(
            f"file {_quote_concat_path(intro_path.resolve())}\n"
            f"file {_quote_concat_path(static_path.resolve())}\n",
            encoding="utf-8",
        )
        concat_cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", ffmpeg_loglevel,
            "-f", "concat", "-safe", "0",
            "-i", str(seg_list_path),
            "-c", "copy",
            "-an",
        ] + overwrite_flag + [str(out_path)]

        rc, stderr = _run_ffmpeg_streaming(concat_cmd)
        if rc != 0:
            return rc, stderr
    else:
        # Panel is shorter than transition — just use the intro directly.
        import shutil
        shutil.copy2(str(intro_path), str(out_path))

    return 0, ""


def _run_stage() -> None:
    args = parse_args()
    in_path = Path(args.final_script_json).expanduser()
    if not in_path.exists():
        raise invalid_request("final_script.json not found.", {"path": str(in_path)})

    fps = int(args.fps)
    if fps <= 0 or fps > 120:
        raise invalid_request("fps must be between 1 and 120.", {"fps": fps})

    width = 1920
    height = 1080
    requested_width = int(args.width)
    requested_height = int(args.height)
    if requested_width != width or requested_height != height:
        print(
            f"[WARN] Stage 6 render size is fixed at {width}x{height}; ignoring requested {requested_width}x{requested_height}.",
            file=sys.stderr,
        )

    transition_frames = max(2, int(args.transition_frames))

    emit("progress", stage=6, message="Loading final_script.json...", percent=5)
    doc = _read_json(in_path)
    if not isinstance(doc, dict):
        raise invalid_request("final_script.json must be a JSON object.", {"path": str(in_path)})

    audio_path_raw = doc.get("audio_path")
    if not args.no_audio and (not isinstance(audio_path_raw, str) or not audio_path_raw.strip()):
        raise invalid_request("final_script.json must include audio_path (string).", {"path": str(in_path)})

    out_mp4 = (
        Path(args.out_mp4).expanduser()
        if isinstance(args.out_mp4, str) and args.out_mp4.strip()
        else in_path.parent / "video.mp4"
    )
    out_mp4.parent.mkdir(parents=True, exist_ok=True)

    work_dir = out_mp4.parent / "video"
    panel_list_path = work_dir / "panel_list.txt"

    emit("progress", stage=6, message="Building panel timeline...", percent=12)
    collect_meta = _collect_panels(final_script_path=in_path, doc=doc, fps=fps)
    items: list[tuple[Path, float]] = collect_meta["items"]

    audio_path = None
    if not args.no_audio:
        audio_path = _resolve_media_path(in_path, str(audio_path_raw).strip())
        if not audio_path.exists():
            raise invalid_request("Narration audio not found.", {"audio_path": audio_path_raw, "resolved": str(audio_path)})

    # Write panel list (kept for debugging).
    panel_list_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for img_path, dur_s in items:
        lines.append(f"file {_quote_concat_path(img_path)}")
        lines.append(f"duration {dur_s:.6f}")
    lines.append(f"file {_quote_concat_path(items[-1][0])}")
    panel_list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    transitions_enabled = not bool(args.no_transitions)
    encoder = (
        str(args.encoder).strip()
        if isinstance(args.encoder, str) and args.encoder.strip()
        else "libx264"
    )
    pix_fmt = "nv12" if encoder == "h264_videotoolbox" else "yuv420p"

    emit("progress", stage=6, message="Rendering mp4 with ffmpeg...", percent=25)

    if transitions_enabled:
        rng = random.Random(args.transition_seed)
        segments_dir = work_dir / "segments"
        segments_dir.mkdir(parents=True, exist_ok=True)
        segment_paths: list[Path] = []

        for i, (img_path, dur_s) in enumerate(items, start=1):
            transition_kind = _choose_transition(rng)
            seg_path = segments_dir / f"panel_{i:04d}.mp4"
            segment_paths.append(seg_path)

            emit(
                "progress",
                stage=6,
                message=f"Rendering panel {i}/{len(items)} [{transition_kind}]...",
                percent=25 + int((i / max(1, len(items))) * 60),
            )

            rc, stderr = _render_panel_with_transition(
                img_path=img_path,
                dur_s=dur_s,
                transition_kind=transition_kind,
                width=width,
                height=height,
                fps=fps,
                transition_frames=transition_frames,
                encoder=encoder,
                crf=int(args.crf),
                preset=str(args.preset),
                video_bitrate=str(args.video_bitrate),
                pix_fmt=pix_fmt,
                out_path=seg_path,
                overwrite=bool(args.overwrite),
                ffmpeg_loglevel=str(args.ffmpeg_loglevel),
            )

            if rc != 0:
                raise stage_failed(
                    "ffmpeg failed while rendering a panel segment.",
                    {
                        "panel_index": i,
                        "img_path": str(img_path),
                        "transition_kind": transition_kind,
                        "returncode": rc,
                        "stderr": (stderr or "").strip()[-4000:],
                    },
                )

        # ── Concat all segments ───────────────────────────────────────────────
        seg_list_path = work_dir / "segment_list.txt"
        seg_lines = [f"file {_quote_concat_path(p.resolve())}" for p in segment_paths]
        seg_list_path.write_text("\n".join(seg_lines) + "\n", encoding="utf-8")

        concat_cmd: list[str] = [
            "ffmpeg", "-hide_banner", "-loglevel", str(args.ffmpeg_loglevel),
            "-stats", "-stats_period", "1",
            "-f", "concat", "-safe", "0",
            "-i", str(seg_list_path),
        ]
        if audio_path is not None:
            concat_cmd += ["-i", str(audio_path)]

        concat_cmd += ["-c:v", "copy"]
        if audio_path is not None:
            concat_cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
        else:
            concat_cmd += ["-an"]

        if args.overwrite:
            concat_cmd.append("-y")
        else:
            concat_cmd.append("-n")
        concat_cmd.append(str(out_mp4))

        emit("progress", stage=6, message="Concatenating panel segments...", percent=90)
        rc, concat_stderr = _run_ffmpeg_streaming(concat_cmd)
        if rc != 0:
            # Fallback: re-encode on concat failure.
            concat_cmd_re = [
                "ffmpeg", "-hide_banner", "-loglevel", str(args.ffmpeg_loglevel),
                "-stats", "-stats_period", "1",
                "-f", "concat", "-safe", "0",
                "-i", str(seg_list_path),
            ]
            if audio_path is not None:
                concat_cmd_re += ["-i", str(audio_path)]
            concat_cmd_re += ["-c:v", encoder]
            if encoder == "libx264":
                concat_cmd_re += ["-preset", str(args.preset), "-crf", str(int(args.crf))]
            else:
                concat_cmd_re += ["-allow_sw", "1", "-b:v", str(args.video_bitrate), "-pix_fmt", pix_fmt]
            if audio_path is not None:
                concat_cmd_re += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
            else:
                concat_cmd_re += ["-an"]
            if args.overwrite:
                concat_cmd_re.append("-y")
            else:
                concat_cmd_re.append("-n")
            concat_cmd_re.append(str(out_mp4))

            emit("progress", stage=6, message="Concat copy failed; re-encoding final mp4...", percent=92)
            rc2, stderr2 = _run_ffmpeg_streaming(concat_cmd_re)
            if rc2 != 0:
                raise stage_failed(
                    "ffmpeg failed to concatenate rendered segments.",
                    {
                        "cmd_copy": " ".join(shlex.quote(x) for x in concat_cmd),
                        "stderr_copy": (concat_stderr or "").strip()[-4000:],
                        "cmd_reencode": " ".join(shlex.quote(x) for x in concat_cmd_re),
                        "stderr_reencode": (stderr2 or "").strip()[-4000:],
                        "returncode": rc2,
                        "panel_count": int(collect_meta["panel_count"]),
                    },
                )
            raise stage_failed(
                "ffmpeg failed to concatenate rendered segments (copy failed, re-encode succeeded — check output).",
                {
                    "cmd": " ".join(shlex.quote(x) for x in concat_cmd),
                    "returncode": rc,
                    "stderr": (concat_stderr or "").strip()[-4000:],
                },
            )

    else:
        # ── No transitions: static concat (fast path) ─────────────────────────
        vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,"
            f"format={pix_fmt}"
        )
        cmd: list[str] = [
            "ffmpeg", "-hide_banner", "-loglevel", str(args.ffmpeg_loglevel),
            "-stats", "-stats_period", "1",
            "-f", "concat", "-safe", "0",
            "-i", str(panel_list_path),
        ]
        if audio_path is not None:
            cmd += ["-i", str(audio_path)]
        cmd += ["-vf", vf, "-r", str(fps), "-c:v", encoder]
        if encoder == "libx264":
            cmd += ["-preset", str(args.preset), "-crf", str(int(args.crf))]
        else:
            cmd += ["-allow_sw", "1", "-b:v", str(args.video_bitrate), "-pix_fmt", pix_fmt]
        if audio_path is not None:
            cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
        if args.overwrite:
            cmd.append("-y")
        else:
            cmd.append("-n")
        cmd.append(str(out_mp4))

        rc, stderr_tail = _run_ffmpeg_streaming(cmd)
        if rc != 0:
            raise stage_failed(
                "ffmpeg failed to render video.",
                {
                    "cmd": " ".join(shlex.quote(x) for x in cmd),
                    "returncode": rc,
                    "stderr": (stderr_tail or "").strip()[-4000:],
                    "panel_count": int(collect_meta["panel_count"]),
                    "panel_list_path": str(panel_list_path),
                },
            )

    emit("progress", stage=6, message="Stage 6 complete.", percent=100)
    emit(
        "complete",
        stage=6,
        video_path=str(out_mp4),
        panel_list_path=str(panel_list_path),
        panel_count=int(collect_meta["panel_count"]),
    )


def main() -> None:
    raise SystemExit(run_with_error_boundary(6, _run_stage))


if __name__ == "__main__":
    main()