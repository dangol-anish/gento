from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
from typing import Any

from PIL import Image

SUPPORTED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def collect_image_paths(inputs: list[str]) -> list[str]:
    resolved: list[str] = []
    for raw in inputs:
        path = Path(raw).expanduser()
        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS:
                    resolved.append(str(child))
            continue
        if path.is_file():
            resolved.append(str(path))
            continue
    return sorted(resolved)


def _maybe_extract_polygon(bbox: Any) -> tuple[Any, tuple[float, float, float, float] | None]:
    if bbox is None:
        return None, None
    if isinstance(bbox, dict):
        for key in ("polygon", "poly", "points", "segmentation"):
            if key in bbox:
                return _maybe_extract_polygon(bbox[key])
        for key in ("bbox", "box", "rect"):
            if key in bbox:
                return _maybe_extract_polygon(bbox[key])
        return None, None
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4 and all(isinstance(x, (int, float)) for x in bbox):
        x1, y1, x2, y2 = [float(x) for x in bbox]
        return None, (x1, y1, x2, y2)
    if isinstance(bbox, (list, tuple)) and len(bbox) >= 3 and all(
        isinstance(point, (list, tuple)) and len(point) == 2 and all(isinstance(x, (int, float)) for x in point)
        for point in bbox
    ):
        points = [(float(x), float(y)) for x, y in bbox]
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        return points, (min(xs), min(ys), max(xs), max(ys))
    return None, None


def _safe_rect_xyxy(bbox: Any) -> tuple[float, float, float, float] | None:
    _, rect = _maybe_extract_polygon(bbox)
    return rect


def _clamp_rect(rect: tuple[float, float, float, float], width: int, height: int) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = rect
    x1 = max(0.0, min(float(width), x1))
    x2 = max(0.0, min(float(width), x2))
    y1 = max(0.0, min(float(height), y1))
    y2 = max(0.0, min(float(height), y2))
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    ix1 = int(round(x1))
    iy1 = int(round(y1))
    ix2 = int(round(x2))
    iy2 = int(round(y2))
    ix1 = max(0, min(width, ix1))
    ix2 = max(0, min(width, ix2))
    iy1 = max(0, min(height, iy1))
    iy2 = max(0, min(height, iy2))
    if ix2 <= ix1:
        ix2 = min(width, ix1 + 1)
    if iy2 <= iy1:
        iy2 = min(height, iy1 + 1)
    return ix1, iy1, ix2, iy2


def _center(rect: tuple[float, float, float, float]) -> tuple[float, float]:
    x1, y1, x2, y2 = rect
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def _contains(panel_rect: tuple[float, float, float, float], text_rect: tuple[float, float, float, float]) -> bool:
    cx, cy = _center(text_rect)
    x1, y1, x2, y2 = panel_rect
    return x1 <= cx <= x2 and y1 <= cy <= y2


def _sha256_png(image: Image.Image) -> str:
    bio = io.BytesIO()
    image.save(bio, format="PNG")
    return hashlib.sha256(bio.getvalue()).hexdigest()


def _normalize_ocr_texts(page_ocr: Any) -> list[str]:
    if page_ocr is None:
        return []
    if isinstance(page_ocr, list):
        out: list[str] = []
        for item in page_ocr:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict):
                for key in ("text", "ocr", "prediction", "pred", "value"):
                    if key in item:
                        out.append(str(item[key] or ""))
                        break
                else:
                    out.append(str(item))
            else:
                out.append(str(item))
        return out
    if isinstance(page_ocr, dict):
        for key in ("ocr_texts", "ocr", "texts", "text", "predictions"):
            if key in page_ocr and isinstance(page_ocr[key], list):
                return [str(x or "") for x in page_ocr[key]]
    return [str(page_ocr)]


def _safe_text_bboxes(page_result: dict[str, Any], page_ocr: Any) -> list[tuple[str, tuple[float, float, float, float] | None]]:
    texts = page_result.get("texts") if isinstance(page_result, dict) else None
    ocr_texts = _normalize_ocr_texts(page_ocr)
    results: list[tuple[str, tuple[float, float, float, float] | None]] = []
    n = max(len(ocr_texts), len(texts) if isinstance(texts, list) else 0)
    for idx in range(n):
        text = ocr_texts[idx] if idx < len(ocr_texts) else ""
        bbox = None
        if isinstance(texts, list) and idx < len(texts):
            bbox = _safe_rect_xyxy(texts[idx])
        results.append((text.strip(), bbox))
    return results


def write_panel_outputs(
    out_root: Path,
    page_idx: int,
    image_path: str,
    page_result: dict[str, Any],
    page_ocr: Any,
    chapter_slug: str,
) -> list[dict[str, Any]]:
    pil_image = Image.open(image_path).convert("RGB")
    width, height = pil_image.size
    panels = page_result.get("panels") if isinstance(page_result, dict) else []
    if not isinstance(panels, list):
        panels = []

    panel_rects: list[tuple[float, float, float, float]] = []
    for panel in panels:
        rect = _safe_rect_xyxy(panel)
        if rect is not None:
            panel_rects.append(rect)

    panel_rects = sorted(panel_rects, key=lambda rect: (rect[1], rect[0]))
    text_items = _safe_text_bboxes(page_result, page_ocr)

    page_panels: list[dict[str, Any]] = []
    for local_idx, rect in enumerate(panel_rects):
        ix1, iy1, ix2, iy2 = _clamp_rect(rect, width, height)
        crop = pil_image.crop((ix1, iy1, ix2, iy2))
        crop_hash = _sha256_png(crop)
        panel_id = f"{chapter_slug}_p{page_idx:03d}_n{local_idx:03d}_{crop_hash[:10]}"

        panel_dir = out_root / "final" / "pages" / f"{page_idx:03d}" / "panels" / f"{local_idx:03d}"
        panel_dir.mkdir(parents=True, exist_ok=True)

        crop_path = panel_dir / "panel.png"
        crop.save(crop_path)

        transcript_items: list[dict[str, Any]] = []
        ocr_lines: list[dict[str, Any]] = []
        for text_idx, (text, bbox) in enumerate(text_items):
            if not text or bbox is None:
                continue
            if not _contains(rect, bbox):
                continue
            transcript_items.append({
                "text_idx": text_idx,
                "speaker": "unsure",
                "text": text,
                "bbox": [float(x) for x in bbox],
                "essential": True,
            })
            ocr_lines.append({"text": text, "bbox": [float(x) for x in bbox], "speaker": "unsure"})

        transcript_text = "\n".join([f"<{item['speaker']}>: {item['text']}" for item in transcript_items])
        (panel_dir / "transcript.txt").write_text(transcript_text + ("\n" if transcript_text else ""), encoding="utf-8")
        (panel_dir / "transcript.json").write_text(
            json.dumps(transcript_items, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (panel_dir / "panel.json").write_text(
            json.dumps(
                {
                    "panel_id": panel_id,
                    "page_idx": page_idx,
                    "panel_idx": local_idx,
                    "bbox": [float(x) for x in rect],
                    "crop_path": str(Path("final") / "pages" / f"{page_idx:03d}" / "panels" / f"{local_idx:03d}" / "panel.png"),
                    "crop_sha256_png": crop_hash,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        page_panels.append(
            {
                "panel_id": panel_id,
                "page_idx": page_idx,
                "bbox": [float(x) for x in rect],
                "crop_path": str(Path("final") / "pages" / f"{page_idx:03d}" / "panels" / f"{local_idx:03d}" / "panel.png"),
                "ocr_lines": ocr_lines,
                "scene_caption": "",
                "scene_tags": [],
            }
        )

    return page_panels


def build_storyboard(
    out_root: Path,
    chapter_id: str,
    source_images: list[str],
    panels: list[dict[str, Any]],
) -> Path:
    final_root = out_root / "final"
    final_root.mkdir(parents=True, exist_ok=True)
    storyboard = {
        "version": "v1",
        "chapter_id": chapter_id,
        "source_images": source_images,
        "panels": panels,
        "beats": [],
        "script": [],
    }
    storyboard_path = final_root / "storyboard.json"
    storyboard_path.write_text(json.dumps(storyboard, ensure_ascii=False, indent=2), encoding="utf-8")
    return storyboard_path
