from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from scripts.common.errors import invalid_request, stage_failed
from scripts.common.events import emit, run_with_error_boundary
from scripts.downloader.download import download_chapter
from scripts.downloader.scrape import get_manga_details


DEFAULT_MAX_IMAGE_THREADS = 10
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_HTTP_TIMEOUT = 20.0


def _load_defaults() -> dict:
    defaults_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        "config",
        "defaults.json",
    )
    try:
        with open(defaults_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _resolve_chapters(chapters: list[dict], chapters_json: str | None) -> list[dict]:
    if not chapters_json:
        return chapters

    try:
        parsed = json.loads(chapters_json)
    except json.JSONDecodeError as exc:
        raise invalid_request("chapters_json must be valid JSON.", {"error": str(exc)}) from exc

    if not isinstance(parsed, list):
        raise invalid_request("chapters_json must be a JSON array.")

    selected = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        url = item.get("url")
        if isinstance(name, str) and isinstance(url, str):
            selected.append({"name": name, "url": url})
    return selected


async def _run_download(args: argparse.Namespace) -> str:
    if not args.url.strip():
        raise invalid_request("url must be a non-empty string.")
    if not args.out.strip():
        raise invalid_request("out directory must be a non-empty string.")

    defaults = _load_defaults()
    max_image_threads = int(defaults.get("max_image_threads", DEFAULT_MAX_IMAGE_THREADS))
    retry_attempts = int(defaults.get("retry_attempts", DEFAULT_RETRY_ATTEMPTS))
    http_timeout = float(defaults.get("http_timeout", DEFAULT_HTTP_TIMEOUT))

    emit("progress", stage=0, message="Scraping manga details...", percent=5)
    try:
        metadata, chapters = await get_manga_details(args.url, timeout=http_timeout)
    except Exception as exc:
        raise stage_failed(
            "Failed to scrape manga details from provided URL.",
            {"reason": str(exc)},
        ) from exc

    if not metadata:
        raise stage_failed(
            "Failed to scrape manga details from provided URL.",
            {"reason": "No metadata returned from source page."},
        )

    chapters = chapters or []
    if args.details_only:
        emit("complete", stage=0, manga_metadata=metadata, chapters=chapters)
        return args.out

    selected_chapters = _resolve_chapters(chapters, args.chapters_json)
    if not selected_chapters:
        raise invalid_request("No chapters selected for download.")

    manga_title = metadata.get("Title", "Unknown Title")
    emit("progress", stage=0, message=f"Downloading {len(selected_chapters)} chapters...", percent=10)

    completed = 0
    chapter_dirs = []
    for chapter in selected_chapters:
        chapter_dir = await download_chapter(
            chapter["url"],
            manga_title,
            chapter["name"],
            args.out,
            timeout=http_timeout,
            max_image_threads=max_image_threads,
            retry_attempts=retry_attempts,
        )
        chapter_dirs.append((chapter, chapter_dir))
        completed += 1
        percent = 10 + int((completed / len(selected_chapters)) * 80)
        emit(
            "progress",
            stage=0,
            message=f"Downloaded {completed}/{len(selected_chapters)} chapters",
            percent=percent,
        )

    if args.format in {"pdf", "cbz"}:
        from scripts.downloader.converter import convert_images_to_cbz, convert_images_to_pdf

        emit("progress", stage=0, message="Converting downloaded chapters...", percent=92)
        for chapter, chapter_dir in chapter_dirs:
            image_paths = [
                os.path.join(chapter_dir, f)
                for f in os.listdir(chapter_dir)
                if f.endswith((".png", ".jpg", ".jpeg"))
            ]
            image_paths.sort(key=lambda x: int(os.path.basename(x).split("_")[1].split(".")[0]))
            output_path = os.path.join(chapter_dir, f"{chapter['name'].replace(' ', '_')}.{args.format}")
            success = (
                convert_images_to_pdf(image_paths, output_path)
                if args.format == "pdf"
                else convert_images_to_cbz(image_paths, output_path, metadata)
            )
            if args.delete_images and success:
                for image in image_paths:
                    os.remove(image)

    emit(
        "complete",
        stage=0,
        output_dir=args.out,
        manga_title=manga_title,
        downloaded_chapters=len(selected_chapters),
        chapter_dirs=[dir_path for _chapter, dir_path in chapter_dirs],
    )
    return args.out


def run(args: argparse.Namespace) -> None:
    asyncio.run(_run_download(args))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--details-only", action="store_true")
    parser.add_argument("--chapters-json", default=None)
    parser.add_argument("--format", choices=["none", "pdf", "cbz"], default="none")
    parser.add_argument("--delete-images", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    cli_args = parse_args()
    exit_code = run_with_error_boundary(0, lambda: run(cli_args))
    sys.exit(exit_code)
