from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from scripts.common.errors import invalid_request
from scripts.common.events import emit, run_with_error_boundary
from scripts.extractor.model import load_magi_model, predict_page
from scripts.extractor.panels import build_storyboard, collect_image_paths, write_panel_outputs

STAGE1_MODEL = "ragavsachdeva/magiv3"


def parse_args() -> Any:
    parser = argparse.ArgumentParser(
        description=(
            "Stage 1: run Magi panel extraction and OCR over raw page images, "
            "crop detected panels, and write final/storyboard.json."
        )
    )
    parser.add_argument("--chapter-id", required=True)
    parser.add_argument(
        "--images",
        nargs="+",
        required=True,
        help="Page image paths or folders containing page images.",
    )
    parser.add_argument("--out", required=True, help="Chapter output root folder (will contain final/...).")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "mps", "cuda"])
    parser.add_argument("--model", default=STAGE1_MODEL)
    parser.add_argument("--reading-direction", default="rtl", choices=["ltr", "rtl"])
    parser.add_argument(
        "--allow-downloads",
        action="store_true",
        help="Allow Hugging Face downloads if files are missing locally.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Write debug artifacts in the output folder.",
    )

    args = parser.parse_args()

    if not args.chapter_id.strip():
        raise invalid_request("--chapter-id must not be empty.")

    if args.model != STAGE1_MODEL:
        raise invalid_request(
            f"Unsupported model '{args.model}'. Only '{STAGE1_MODEL}' is available right now."
        )

    return args


def _configure_offline_mode(allow_downloads: bool) -> None:
    if allow_downloads:
        return
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")


def _resolve_chapter_inputs(raw_inputs: list[str]) -> list[list[str]]:
    """
    Stage 1 traditionally processes a single chapter: `--images <chapter_folder_or_files...>`.

    To support multi-chapter runs, we treat each *directory* in `--images` as an independent
    chapter input. In that mode, mixing directories and files is disallowed to avoid ambiguity.
    """
    if not raw_inputs:
        return []

    resolved = [Path(value).expanduser() for value in raw_inputs]
    dirs = [p for p in resolved if p.is_dir()]
    files = [p for p in resolved if p.is_file()]

    # Single-chapter mode: 0-1 directories, optionally with files.
    if len(dirs) <= 1:
        return [raw_inputs]

    # Multi-chapter mode: 2+ directories and no files.
    if files:
        raise invalid_request(
            "When passing multiple chapter folders to --images, do not mix folders and files. "
            "Pass only chapter folders."
        )

    # One chapter per directory (stable order).
    return [[str(p)] for p in sorted(dirs, key=lambda d: d.as_posix())]


def _run_stage() -> None:
    args = parse_args()
    _configure_offline_mode(args.allow_downloads)

    chapter_inputs = _resolve_chapter_inputs(list(args.images))
    if not chapter_inputs:
        raise invalid_request("No image files found in provided paths.")

    emit("progress", stage=1, message="Loading Magi model...", percent=5)
    model, processor, device = load_magi_model(args.model, args.device, not args.allow_downloads)
    emit("progress", stage=1, message="Magi model loaded.", percent=10)

    out_root = Path(args.out).expanduser()
    multi = len(chapter_inputs) > 1
    storyboard_paths: list[str] = []

    for chapter_idx, chapter_input in enumerate(chapter_inputs):
        final_dir_name = "final" if not multi else f"final_{chapter_idx + 1}"
        debug_dir_name = "debug" if not multi else f"debug_{chapter_idx + 1}"

        image_paths = collect_image_paths(chapter_input)
        if not image_paths:
            raise invalid_request("No image files found in provided paths.")

        source_images: list[str] = []
        storyboard_panels: list[dict[str, Any]] = []
        chapter_suffix = "" if not multi else f"__{chapter_idx + 1}"
        chapter_id = f"{args.chapter_id}{chapter_suffix}"
        chapter_slug = chapter_id.strip().replace("/", "__")

        for index, image_path in enumerate(image_paths):
            percent = int(((index + 1) / len(image_paths)) * 70) + 10
            if multi:
                chapter_weight = 85.0 / float(len(chapter_inputs))
                chapter_base = 10.0 + float(chapter_idx) * chapter_weight
                percent = int(chapter_base + (float(index + 1) / float(len(image_paths))) * chapter_weight)

            emit(
                "progress",
                stage=1,
                message=f"Processing {final_dir_name} page {index + 1}/{len(image_paths)}: {Path(image_path).name}",
                percent=percent,
            )

            image_np = load_image(image_path)
            page_result, page_ocr = predict_page(model, processor, image_np)
            source_images.append(str(Path(image_path).resolve()))

            page_panels = write_panel_outputs(
                out_root=out_root,
                page_idx=index,
                image_path=image_path,
                page_result=page_result,
                page_ocr=page_ocr,
                chapter_slug=chapter_slug,
                reading_direction=str(getattr(args, "reading_direction", "rtl")),
                final_dir_name=final_dir_name,
                write_overlays=bool(args.debug),
            )
            storyboard_panels.extend(page_panels)

            if args.debug:
                _write_debug_asset(
                    out_root,
                    index,
                    image_path,
                    page_result,
                    page_ocr,
                    debug_dir_name=debug_dir_name,
                )

        storyboard_path = build_storyboard(
            out_root=out_root,
            chapter_id=chapter_id,
            source_images=source_images,
            panels=storyboard_panels,
            reading_direction=str(getattr(args, "reading_direction", "rtl")),
            final_dir_name=final_dir_name,
        )
        storyboard_paths.append(str(storyboard_path))

    emit("progress", stage=1, message="Finalizing storyboard...", percent=95)
    emit("progress", stage=1, message="Stage 1 complete.", percent=100)
    if multi:
        emit("complete", stage=1, storyboard_paths=storyboard_paths)
    else:
        emit("complete", stage=1, storyboard_path=storyboard_paths[0])


def load_image(image_path: str) -> Any:
    from scripts.extractor.model import read_image_rgb_np

    return read_image_rgb_np(image_path)


def _write_debug_asset(
    out_root: Path,
    page_idx: int,
    image_path: str,
    page_result: dict[str, Any],
    page_ocr: Any,
    *,
    debug_dir_name: str = "debug",
) -> None:
    debug_root = out_root / str(debug_dir_name)
    debug_root.mkdir(parents=True, exist_ok=True)
    debug_data = {
        "image_path": image_path,
        "page_result": page_result,
        "page_ocr": page_ocr,
    }
    (debug_root / f"page_{page_idx:03d}.json").write_text(
        json.dumps(debug_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def main() -> None:
    raise SystemExit(run_with_error_boundary(1, _run_stage))
