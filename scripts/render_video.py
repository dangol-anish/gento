#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import shlex
import subprocess
from pathlib import Path
from typing import Any

from scripts.common.errors import invalid_request, stage_failed
from scripts.common.events import emit, run_with_error_boundary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage 6: render MP4 video from final_script.json + stitched narration.")
    parser.add_argument("final_script_json", help="Path to output/final/final_script.json (from Stage 5).")
    parser.add_argument("--out-mp4", default=None, help="Output mp4 path (default: alongside input as video.mp4).")
    parser.add_argument("--fps", type=int, default=24, help="Video FPS (default: 24).")
    parser.add_argument("--width", type=int, default=1080, help="Output width (default: 1080).")
    parser.add_argument("--height", type=int, default=1920, help="Output height (default: 1920).")
    parser.add_argument("--crf", type=int, default=18, help="H.264 quality CRF (default: 18).")
    parser.add_argument("--preset", default="veryfast", help="x264 preset (default: veryfast).")
    parser.add_argument("--no-audio", action="store_true", help="Render video without audio track.")
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

    # Try relative to CWD first.
    if p.exists():
        return p

    # Most gento outputs store crop_path like "final/pages/..." which is relative to the output root.
    # If final_script.json lives at output/final/final_script.json, output root is output/.
    output_root = final_script_path.parent.parent
    cand = output_root / p
    if cand.exists():
        return cand

    # Also try alongside final_script.json (common for audio_path).
    cand2 = final_script_path.parent / p
    if cand2.exists():
        return cand2

    return cand


def _quote_concat_path(path: Path) -> str:
    # concat demuxer uses its own quoting rules; single quotes are common.
    # Escape single quotes by closing/opening.
    s = str(path)
    return "'" + s.replace("'", "'\\''") + "'"


def _build_concat_list(
    *,
    final_script_path: Path,
    doc: dict[str, Any],
    out_list_path: Path,
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

    out_list_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for img_path, dur_s in items:
        lines.append(f"file {_quote_concat_path(img_path)}")
        lines.append(f"duration {dur_s:.6f}")
    # Repeat last file so its duration applies.
    lines.append(f"file {_quote_concat_path(items[-1][0])}")
    out_list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    return {"panel_count": len(items), "panel_list_path": str(out_list_path)}


def _run_stage() -> None:
    args = parse_args()
    in_path = Path(args.final_script_json).expanduser()
    if not in_path.exists():
        raise invalid_request("final_script.json not found.", {"path": str(in_path)})

    fps = int(args.fps)
    if fps <= 0 or fps > 120:
        raise invalid_request("fps must be between 1 and 120.", {"fps": fps})

    width = int(args.width)
    height = int(args.height)
    if width <= 0 or height <= 0:
        raise invalid_request("width/height must be positive integers.", {"width": width, "height": height})

    emit("progress", stage=6, message="Loading final_script.json...", percent=5)
    doc = _read_json(in_path)
    if not isinstance(doc, dict):
        raise invalid_request("final_script.json must be a JSON object.", {"path": str(in_path)})

    audio_path_raw = doc.get("audio_path")
    if not args.no_audio and (not isinstance(audio_path_raw, str) or not audio_path_raw.strip()):
        raise invalid_request("final_script.json must include audio_path (string).", {"path": str(in_path)})

    out_mp4 = Path(args.out_mp4).expanduser() if isinstance(args.out_mp4, str) and args.out_mp4.strip() else in_path.parent / "video.mp4"
    out_mp4.parent.mkdir(parents=True, exist_ok=True)

    work_dir = out_mp4.parent / "video"
    panel_list_path = work_dir / "panel_list.txt"

    emit("progress", stage=6, message="Building panel timeline...", percent=12)
    build_meta = _build_concat_list(final_script_path=in_path, doc=doc, out_list_path=panel_list_path, fps=fps)

    audio_path = None
    if not args.no_audio:
        audio_path = _resolve_media_path(in_path, str(audio_path_raw).strip())
        if not audio_path.exists():
            raise invalid_request("Narration audio not found.", {"audio_path": audio_path_raw, "resolved": str(audio_path)})

    emit("progress", stage=6, message="Rendering mp4 with ffmpeg...", percent=25)
    vf = f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p"
    cmd: list[str] = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(panel_list_path),
    ]

    if audio_path is not None:
        cmd += ["-i", str(audio_path)]

    cmd += [
        "-vf",
        vf,
        "-r",
        str(fps),
        "-c:v",
        "libx264",
        "-preset",
        str(args.preset),
        "-crf",
        str(int(args.crf)),
    ]

    if audio_path is not None:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]

    if args.overwrite:
        cmd.append("-y")
    else:
        cmd.append("-n")

    cmd.append(str(out_mp4))

    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise stage_failed(
            "ffmpeg failed to render video.",
            {
                "cmd": " ".join(shlex.quote(x) for x in cmd),
                "returncode": proc.returncode,
                "stdout": (proc.stdout or "").strip()[-2000:],
                "stderr": (proc.stderr or "").strip()[-2000:],
                **build_meta,
            },
        )

    emit("progress", stage=6, message="Stage 6 complete.", percent=100)
    emit(
        "complete",
        stage=6,
        video_path=str(out_mp4),
        panel_list_path=str(panel_list_path),
        panel_count=int(build_meta["panel_count"]),
    )


def main() -> None:
    raise SystemExit(run_with_error_boundary(6, _run_stage))


if __name__ == "__main__":
    main()
