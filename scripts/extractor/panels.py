from __future__ import annotations

import hashlib
import io
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image

SUPPORTED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}

_NATURAL_SPLIT_RE = re.compile(r"(\d+)")


def _natural_sort_key(value: str) -> list[tuple[int, object]]:
    """
    Sort strings in "natural" order so embedded numbers compare numerically.

    Example: page5.jpg < page10.jpg (numeric), not page10.jpg < page5.jpg (lexicographic).
    """
    parts = _NATURAL_SPLIT_RE.split(value)
    key: list[tuple[int, object]] = []
    for part in parts:
        if not part:
            continue
        if part.isdigit():
            key.append((0, int(part)))
        else:
            key.append((1, part.casefold()))
    return key


def collect_image_paths(inputs: list[str]) -> list[str]:
    resolved: list[Path] = []
    for raw in inputs:
        path = Path(raw).expanduser()
        if path.is_dir():
            candidates = [
                child
                for child in path.rglob("*")
                if child.is_file() and child.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS
            ]
            candidates.sort(key=lambda p: _natural_sort_key(p.as_posix()))
            resolved.extend(candidates)
            continue
        if path.is_file():
            if path.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS:
                resolved.append(path)
            continue
    resolved.sort(key=lambda p: _natural_sort_key(p.as_posix()))
    return [str(p) for p in resolved]


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


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    xs = sorted(float(x) for x in values)
    mid = len(xs) // 2
    if len(xs) % 2 == 1:
        return xs[mid]
    return (xs[mid - 1] + xs[mid]) / 2.0


def _order_panel_rects(
    panel_rects: list[tuple[float, float, float, float]],
    *,
    reading_direction: str,
) -> list[tuple[float, float, float, float]]:
    """
    Produce a stable reading order for a single page.

    Manga commonly reads right-to-left (rtl). Using a naive (y, x) sort makes
    panel indexing wrong, which cascades into bad narration.
    """
    if not panel_rects:
        return []

    direction = (reading_direction or "ltr").strip().lower()
    rtl = direction == "rtl"

    # Cluster into rows based on vertical centers.
    centers_y = [(_center(r)[1]) for r in panel_rects]
    heights = [(r[3] - r[1]) for r in panel_rects]
    median_h = max(1.0, _median(heights))
    row_threshold = max(8.0, median_h * 0.6)

    # Start from top-most panels.
    rects = sorted(panel_rects, key=lambda r: (_center(r)[1], _center(r)[0]))
    rows: list[dict[str, Any]] = []
    for rect in rects:
        cy = _center(rect)[1]
        assigned = False
        for row in rows:
            if abs(cy - float(row["cy"])) <= row_threshold:
                row["rects"].append(rect)
                # Update row center.
                ys = [(_center(r)[1]) for r in row["rects"]]
                row["cy"] = sum(ys) / float(len(ys))
                assigned = True
                break
        if not assigned:
            rows.append({"cy": cy, "rects": [rect]})

    # Sort rows top->bottom, then within each row by x center based on direction.
    rows.sort(key=lambda r: float(r["cy"]))
    ordered: list[tuple[float, float, float, float]] = []
    for row in rows:
        rects_in_row = list(row["rects"])
        rects_in_row.sort(key=lambda r: _center(r)[0], reverse=rtl)
        ordered.extend(rects_in_row)
    return ordered


def _order_panel_items(
    panel_items: list[tuple[tuple[float, float, float, float], Any]],
    *,
    reading_direction: str,
) -> list[tuple[tuple[float, float, float, float], Any]]:
    """
    Same as `_order_panel_rects`, but preserves per-panel metadata (e.g. polygons).
    """
    if not panel_items:
        return []

    direction = (reading_direction or "ltr").strip().lower()
    rtl = direction == "rtl"

    rects = [rect for rect, _ in panel_items]
    heights = [(r[3] - r[1]) for r in rects]
    median_h = max(1.0, _median(heights))
    row_threshold = max(8.0, median_h * 0.6)

    # Start from top-most panels.
    indexed = list(enumerate(panel_items))
    indexed.sort(key=lambda it: (_center(it[1][0])[1], _center(it[1][0])[0], it[0]))
    rows: list[dict[str, Any]] = []
    for original_idx, (rect, meta) in indexed:
        cy = _center(rect)[1]
        assigned = False
        for row in rows:
            if abs(cy - float(row["cy"])) <= row_threshold:
                row["items"].append((original_idx, (rect, meta)))
                ys = [(_center(item[1][0])[1]) for item in row["items"]]
                row["cy"] = sum(ys) / float(len(ys))
                assigned = True
                break
        if not assigned:
            rows.append({"cy": cy, "items": [(original_idx, (rect, meta))]})

    rows.sort(key=lambda r: float(r["cy"]))
    ordered: list[tuple[tuple[float, float, float, float], Any]] = []
    for row in rows:
        items_in_row = list(row["items"])
        items_in_row.sort(
            key=lambda it: (_center(it[1][0])[0], it[0]),
            reverse=rtl,
        )
        ordered.extend([item for _, item in items_in_row])
    return ordered


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
    reading_direction: str = "ltr",
    *,
    final_dir_name: str = "final",
    write_overlays: bool = False,
) -> list[dict[str, Any]]:
    pil_image = Image.open(image_path).convert("RGB")
    width, height = pil_image.size
    panels = page_result.get("panels") if isinstance(page_result, dict) else []
    if not isinstance(panels, list):
        panels = []

    panel_items: list[tuple[tuple[float, float, float, float], Any]] = []
    for panel in panels:
        points, rect = _maybe_extract_polygon(panel)
        if rect is not None:
            panel_items.append((rect, points))

    panel_items = _order_panel_items(panel_items, reading_direction=reading_direction)
    text_items = _safe_text_bboxes(page_result, page_ocr)

    page_root = out_root / str(final_dir_name) / "pages" / f"{page_idx:03d}"
    page_root.mkdir(parents=True, exist_ok=True)
    if write_overlays:
        _write_panel_overlay(page_root=page_root, base_image=pil_image, panel_items=panel_items)
        _write_detections_overlay(
            page_root=page_root, base_image=pil_image, page_result=page_result, page_ocr=page_ocr
        )

    page_panels: list[dict[str, Any]] = []
    for local_idx, (rect, _points) in enumerate(panel_items):
        ix1, iy1, ix2, iy2 = _clamp_rect(rect, width, height)
        crop = pil_image.crop((ix1, iy1, ix2, iy2))
        crop_hash = _sha256_png(crop)
        panel_id = f"{chapter_slug}_p{page_idx:03d}_n{local_idx:03d}_{crop_hash[:10]}"

        panel_dir = page_root / "panels" / f"{local_idx:03d}"
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
                    "crop_path": str(Path(str(final_dir_name)) / "pages" / f"{page_idx:03d}" / "panels" / f"{local_idx:03d}" / "panel.png"),
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
                "crop_path": str(Path(str(final_dir_name)) / "pages" / f"{page_idx:03d}" / "panels" / f"{local_idx:03d}" / "panel.png"),
                "ocr_lines": ocr_lines,
                "scene_caption": "",
                "scene_tags": [],
            }
        )

    return page_panels


def _write_panel_overlay(
    *,
    page_root: Path,
    base_image: Image.Image,
    panel_items: list[tuple[tuple[float, float, float, float], Any]],
) -> None:
    """
    Write a convenience visualization: the original page with detected panel outlines.
    """
    from PIL import ImageDraw, ImageFont

    if not panel_items:
        return

    overlay = base_image.convert("RGBA")
    draw = ImageDraw.Draw(overlay, "RGBA")
    font = ImageFont.load_default()

    for idx, (rect, points) in enumerate(panel_items):
        x1, y1, x2, y2 = rect
        outline = (255, 0, 64, 220)
        label_bg = (0, 0, 0, 160)
        label_fg = (255, 255, 255, 235)
        width = 4

        if isinstance(points, list) and points and all(
            isinstance(p, (list, tuple)) and len(p) == 2 for p in points
        ):
            poly = [(float(px), float(py)) for px, py in points]
            # Pillow's polygon() width support has varied; draw as a polyline for robustness.
            draw.line(poly + [poly[0]], fill=outline, width=width, joint="curve")
        else:
            draw.rectangle([float(x1), float(y1), float(x2), float(y2)], outline=outline, width=width)

        label = str(idx)
        tx = int(max(0.0, min(float(overlay.size[0] - 1), float(x1))))
        ty = int(max(0.0, min(float(overlay.size[1] - 1), float(y1))))
        # Small background for readability.
        try:
            left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
            tw, th = int(right - left), int(bottom - top)
        except Exception:
            tw, th = 10, 10
        pad_x, pad_y = 4, 2
        draw.rectangle([tx, ty, tx + tw + pad_x * 2, ty + th + pad_y * 2], fill=label_bg)
        draw.text((tx + pad_x, ty + pad_y), label, fill=label_fg, font=font)

    overlay.save(page_root / "panels_overlay.png")


def _extract_shapes(value: Any) -> list[tuple[tuple[float, float, float, float], Any]]:
    """
    Best-effort conversion of a Magi detection list into drawable shapes.

    Returns a list of (rect, points) where points is either a polygon list or None.
    """
    if value is None:
        return []
    if isinstance(value, dict):
        # Some structures might wrap an array under a common key.
        for key in ("items", "detections", "results", "predictions", "boxes"):
            if key in value:
                return _extract_shapes(value.get(key))
        return []
    if not isinstance(value, list):
        return []

    shapes: list[tuple[tuple[float, float, float, float], Any]] = []
    for item in value:
        points, rect = _maybe_extract_polygon(item)
        if rect is not None:
            shapes.append((rect, points))
    return shapes


def _write_detections_overlay(
    *,
    page_root: Path,
    base_image: Image.Image,
    page_result: dict[str, Any],
    page_ocr: Any,
) -> None:
    """
    Write a single image showing *all* Magi detections we know how to visualize:
    panels, characters, speech bubbles, and text boxes (if present).
    """
    from PIL import ImageDraw, ImageFont

    if not isinstance(page_result, dict) or not page_result:
        return

    categories: list[tuple[str, str, tuple[int, int, int, int], Any]] = [
        ("panels", "p", (255, 0, 64, 220), page_result.get("panels")),
        ("characters", "c", (0, 128, 255, 220), page_result.get("characters") or page_result.get("chars")),
        (
            "speech_bubbles",
            "b",
            (0, 200, 120, 220),
            page_result.get("speech_bubbles")
            or page_result.get("bubbles")
            or page_result.get("balloons")
            or page_result.get("speech"),
        ),
        ("texts", "t", (255, 200, 0, 220), page_result.get("texts")),
    ]

    overlays: list[tuple[str, list[tuple[tuple[float, float, float, float], Any]], str, tuple[int, int, int, int]]] = []
    for name, prefix, color, value in categories:
        shapes = _extract_shapes(value)
        if shapes:
            overlays.append((name, shapes, prefix, color))

    if not overlays:
        return

    overlay = base_image.convert("RGBA")
    draw = ImageDraw.Draw(overlay, "RGBA")
    font = ImageFont.load_default()

    def _draw_label(x: float, y: float, text: str) -> None:
        tx = int(max(0.0, min(float(overlay.size[0] - 1), float(x))))
        ty = int(max(0.0, min(float(overlay.size[1] - 1), float(y))))
        label_bg = (0, 0, 0, 160)
        label_fg = (255, 255, 255, 235)
        try:
            left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
            tw, th = int(right - left), int(bottom - top)
        except Exception:
            tw, th = 10, 10
        pad_x, pad_y = 4, 2
        draw.rectangle([tx, ty, tx + tw + pad_x * 2, ty + th + pad_y * 2], fill=label_bg)
        draw.text((tx + pad_x, ty + pad_y), text, fill=label_fg, font=font)

    width = 3
    for _cat_name, shapes, prefix, color in overlays:
        for idx, (rect, points) in enumerate(shapes):
            x1, y1, x2, y2 = rect
            if isinstance(points, list) and points and all(isinstance(p, (list, tuple)) and len(p) == 2 for p in points):
                poly = [(float(px), float(py)) for px, py in points]
                draw.line(poly + [poly[0]], fill=color, width=width, joint="curve")
                lx, ly = poly[0]
            else:
                draw.rectangle([float(x1), float(y1), float(x2), float(y2)], outline=color, width=width)
                lx, ly = float(x1), float(y1)
            _draw_label(lx, ly, f"{prefix}{idx}")

    overlay.save(page_root / "magi_detections_overlay.png")


def build_storyboard(
    out_root: Path,
    chapter_id: str,
    source_images: list[str],
    panels: list[dict[str, Any]],
    reading_direction: str = "ltr",
    *,
    final_dir_name: str = "final",
) -> Path:
    final_root = out_root / str(final_dir_name)
    final_root.mkdir(parents=True, exist_ok=True)
    storyboard = {
        "version": "v1",
        "chapter_id": chapter_id,
        "reading_direction": (reading_direction or "ltr").strip().lower(),
        "source_images": source_images,
        "panels": panels,
        "beats": [],
        "script": [],
    }
    storyboard_path = final_root / "storyboard.json"
    storyboard_path.write_text(json.dumps(storyboard, ensure_ascii=False, indent=2), encoding="utf-8")
    return storyboard_path
