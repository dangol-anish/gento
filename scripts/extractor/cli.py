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


def _run_stage() -> None:
    args = parse_args()
    _configure_offline_mode(args.allow_downloads)

    image_paths = collect_image_paths(args.images)
    if not image_paths:
        raise invalid_request("No image files found in provided paths.")

    emit("progress", stage=1, message="Loading Magi model...", percent=5)
    model, processor, device = load_magi_model(args.model, args.device, not args.allow_downloads)
    emit("progress", stage=1, message="Magi model loaded.", percent=10)

    out_root = Path(args.out).expanduser()
    source_images: list[str] = []
    storyboard_panels: list[dict[str, Any]] = []
    chapter_slug = args.chapter_id.strip().replace("/", "__")

    for index, image_path in enumerate(image_paths):
        emit(
            "progress",
            stage=1,
            message=f"Processing page {index + 1}/{len(image_paths)}: {Path(image_path).name}",
            percent=int(((index + 1) / len(image_paths)) * 70) + 10,
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
        )
        storyboard_panels.extend(page_panels)

        if args.debug:
            _write_debug_asset(out_root, index, image_path, page_result, page_ocr)

    storyboard_path = build_storyboard(
        out_root=out_root,
        chapter_id=args.chapter_id,
        source_images=source_images,
        panels=storyboard_panels,
    )

    emit("progress", stage=1, message="Finalizing storyboard...", percent=95)
    emit("progress", stage=1, message="Stage 1 complete.", percent=100)
    emit(
        "complete",
        stage=1,
        storyboard_path=str(storyboard_path),
    )


def load_image(image_path: str) -> Any:
    from scripts.extractor.model import read_image_rgb_np

    return read_image_rgb_np(image_path)


def _write_debug_asset(out_root: Path, page_idx: int, image_path: str, page_result: dict[str, Any], page_ocr: Any) -> None:
    debug_root = out_root / "debug"
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
