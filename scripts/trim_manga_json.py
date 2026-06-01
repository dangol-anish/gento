#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Trim manga chapter JSON files to pages[].panels[].{sentence,crop_path}."
    )
    parser.add_argument(
        "input_jsons",
        nargs="+",
        help="One or more input chapter JSON file paths to trim.",
    )
    return parser.parse_args()


def _trim_panel(panel: Any) -> Dict[str, Any]:
    return {
        "sentence": panel.get("sentence") if isinstance(panel, dict) else None,
        "crop_path": panel.get("crop_path") if isinstance(panel, dict) else None,
    }


def _trim_pages(doc: Any) -> Dict[str, List[Dict[str, Any]]]:
    if not isinstance(doc, dict):
        raise ValueError("Expected top-level JSON object.")

    pages = doc.get("pages")
    if pages is None:
        raise ValueError("Missing top-level 'pages' array.")
    if not isinstance(pages, list):
        raise ValueError("Expected top-level 'pages' to be a list.")

    trimmed_pages: List[Dict[str, Any]] = []
    for page in pages:
        if not isinstance(page, dict):
            raise ValueError("Each page entry must be an object.")
        panels = page.get("panels")
        if panels is None:
            raise ValueError("Each page must contain a 'panels' array.")
        if not isinstance(panels, list):
            raise ValueError("Expected page 'panels' to be a list.")

        trimmed_panels = [_trim_panel(panel) for panel in panels]
        trimmed_pages.append({"panels": trimmed_panels})

    return {"pages": trimmed_pages}


def _output_path(input_path: Path) -> Path:
    suffix = input_path.suffix
    if suffix.lower() != ".json":
        return input_path.with_name(f"{input_path.name}_trimmed")
    return input_path.with_name(f"{input_path.stem}_trimmed{suffix}")


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def process_file(input_path: Path) -> Path | None:
    if not input_path.exists():
        print(f"Error: file not found: {input_path}", file=sys.stderr)
        return None

    original_size = _file_size(input_path)
    try:
        with input_path.open("r", encoding="utf-8") as handle:
            doc = json.load(handle)
    except json.JSONDecodeError as exc:
        print(f"Error: malformed JSON in {input_path}: {exc}", file=sys.stderr)
        return None
    except OSError as exc:
        print(f"Error: cannot read {input_path}: {exc}", file=sys.stderr)
        return None

    try:
        trimmed = _trim_pages(doc)
    except ValueError as exc:
        print(f"Error: invalid structure in {input_path}: {exc}", file=sys.stderr)
        return None

    output_path = _output_path(input_path)
    try:
        with output_path.open("w", encoding="utf-8") as handle:
            json.dump(trimmed, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    except OSError as exc:
        print(f"Error: cannot write {output_path}: {exc}", file=sys.stderr)
        return None

    trimmed_size = _file_size(output_path)
    reduction = 0.0
    if original_size > 0:
        reduction = 100.0 * (original_size - trimmed_size) / original_size

    print(
        f"Trimmed {input_path.name}: {original_size} bytes -> {trimmed_size} bytes "
        f"({reduction:.1f}% reduction)"
    )
    return output_path


def main() -> int:
    args = parse_args()
    success = True
    output_paths: list[str] = []

    for path_str in args.input_jsons:
        input_path = Path(path_str).expanduser()
        output_path = process_file(input_path)
        if output_path is None:
            success = False
            continue
        output_paths.append(str(output_path))

    if output_paths:
        print(json.dumps({"type": "complete", "stage": 7, "output_paths": output_paths}))

    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
