#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
import subprocess
from urllib.parse import urlparse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from PIL import Image

from scripts.common.errors import invalid_request, stage_failed
from scripts.common.events import emit, run_with_error_boundary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stage 2: enrich storyboard panels with scene_caption + scene_tags via Ollama."
    )
    parser.add_argument("storyboard", help="Path to final/storyboard.json (from Stage 1).")
    parser.add_argument(
        "--out",
        default=None,
        help="Write enriched storyboard to a different path instead of overwriting in-place.",
    )
    parser.add_argument("--overwrite", action="store_true", help="Replace existing scene_caption/scene_tags.")

    parser.add_argument("--scene-provider", choices=["ollama", "none"], default="ollama")
    parser.add_argument("--ollama-host", default="http://127.0.0.1:11434")
    parser.add_argument("--ollama-model", default="gemma3:4b")
    parser.add_argument(
        "--ollama-timeout",
        type=int,
        default=600,
        help="Request timeout seconds (first run can be slow while the model loads).",
    )
    parser.add_argument("--ollama-caption-tokens", type=int, default=256)
    parser.add_argument("--ollama-tags-tokens", type=int, default=64)
    parser.add_argument(
        "--chapter-context",
        default="",
        help="Optional free-text context about this manga/chapter passed to the model.",
    )

    args = parser.parse_args()

    storyboard_path = Path(args.storyboard).expanduser()
    if not storyboard_path.exists():
        raise invalid_request("storyboard file not found.", {"path": str(storyboard_path)})

    return args


def _read_storyboard(path: Path) -> dict[str, Any]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise invalid_request("storyboard must be valid JSON.", {"error": str(exc)}) from exc

    if not isinstance(doc, dict):
        raise invalid_request("storyboard must be a JSON object.")

    panels = doc.get("panels")
    if not isinstance(panels, list):
        raise invalid_request("storyboard.panels must be an array.")

    return doc


def _needs_scene(panel: dict[str, Any], overwrite: bool) -> bool:
    if overwrite:
        return True
    cap = panel.get("scene_caption")
    return not (isinstance(cap, str) and cap.strip())


def _extract_first_json_object(text: str) -> dict[str, Any] | None:
    cleaned = text.strip()
    cleaned = cleaned.replace("```json", "```").strip()
    if cleaned.startswith("```") and cleaned.endswith("```"):
        cleaned = cleaned.strip("`").strip()

    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass

    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _extract_first_json_array(text: str) -> list[Any] | None:
    cleaned = text.strip()
    cleaned = cleaned.replace("```json", "```").strip()
    if cleaned.startswith("```") and cleaned.endswith("```"):
        cleaned = cleaned.strip("`").strip()

    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, list) else None
    except Exception:
        pass

    match = re.search(r"\[.*\]", cleaned, flags=re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, list) else None
    except Exception:
        return None


def _encode_png_base64(image_path: Path) -> str:
    image = Image.open(image_path).convert("RGB")
    # Use original PNG bytes if possible to avoid re-encoding; otherwise fall back.
    data = image_path.read_bytes()
    if image_path.suffix.lower() not in {".png"}:
        from io import BytesIO

        bio = BytesIO()
        image.save(bio, format="PNG")
        data = bio.getvalue()
    return base64.b64encode(data).decode("utf-8")


def _ollama_generate(
    client: httpx.Client,
    *,
    host: str,
    model: str,
    prompt: str,
    image_b64: str | None,
    max_tokens: int,
    temperature: float,
) -> str:
    url = host.rstrip("/") + "/api/generate"
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": float(temperature),
            "num_predict": int(max_tokens),
        },
    }
    if image_b64:
        payload["images"] = [image_b64]

    resp = client.post(url, json=payload)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and isinstance(data.get("response"), str):
        return data["response"]
    return json.dumps(data)


def _normalize_tags(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        tag = str(value).strip().lower()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        normalized.append(tag)
    return normalized


def _build_page_prompt(*, chapter_context: str, ocr_text: str) -> str:
    rules = (
        "You are a manga page scene analyst.\n"
        "Given a full manga page image, write a rich 2-4 sentence narrative description of what happens on the page.\n"
        "Then provide 4-10 semantic tags.\n"
        "Return ONLY valid JSON with this shape:\n"
        '{"caption": "2-4 sentences", "tags": ["4-10 short lowercase tags"]}\n'
        "Rules:\n"
        "- Focus on visible actions/emotions and narrative beats.\n"
        "- Use OCR/dialogue only as a hint; do not invent unseen details.\n"
        "- Tags must be short (1-3 words), lowercase, no duplicates.\n"
    )
    ctx = chapter_context.strip()
    parts = [rules]
    if ctx:
        parts.append(f"Chapter context: {ctx}\n")
    if ocr_text.strip():
        parts.append(f"OCR/dialogue hint (entire page):\n{ocr_text.strip()}\n")
    return "\n".join(parts).strip()


def _build_panel_annotation_prompt(*, page_caption: str, panel_ocr_text: str, panel_position: str) -> str:
    return (
        "You are a manga panel annotator.\n"
        "Given a page-level narrative and the panel's OCR/dialogue hint, write ONE sentence describing this specific panel.\n"
        "Return ONLY valid JSON with this shape:\n"
        '{"caption": "one sentence"}\n'
        f"Panel position: {panel_position}\n\n"
        f"Page narrative:\n{page_caption.strip()}\n\n"
        f"Panel OCR/dialogue hint:\n{panel_ocr_text.strip() or '(none)'}\n"
    )


def _is_local_ollama_host(host: str) -> bool:
    try:
        parsed = urlparse(host)
        hostname = parsed.hostname or ""
        return hostname in {"127.0.0.1", "localhost"}
    except Exception:
        return False


def _wait_for_ollama(client: httpx.Client, host: str, timeout_s: float) -> bool:
    url = host.rstrip("/") + "/api/tags"
    start = time.time()
    while time.time() - start < timeout_s:
        try:
            resp = client.get(url, headers={"Accept": "application/json"})
            if resp.status_code >= 200 and resp.status_code < 500:
                return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


def _try_start_ollama_server() -> bool:
    try:
        proc = subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        # Detach; we only care that it spawned.
        return proc.pid is not None
    except Exception:
        return False


def _ensure_ollama_ready(client: httpx.Client, host: str) -> bool:
    if _wait_for_ollama(client, host, 1.2):
        return True

    if not _is_local_ollama_host(host):
        return False

    print(f"[Stage2] Ollama not reachable at {host}; attempting to start `ollama serve`...", flush=True)
    started = _try_start_ollama_server()
    if not started:
        print("[Stage2] Failed to spawn `ollama serve` (is Ollama installed and on PATH?).", flush=True)
        return False

    ok = _wait_for_ollama(client, host, 8.0)
    if ok:
        print(f"[Stage2] Ollama is up at {host}.", flush=True)
    else:
        print(f"[Stage2] Ollama did not become ready at {host}.", flush=True)
    return ok


def _build_caption_prompt(*, chapter_context: str, ocr_text: str) -> str:
    rules = (
        "You are a manga panel scene analyst.\n"
        "Return ONLY valid JSON with this shape:\n"
        '{"caption": "1-2 sentences describing what is happening", "tags": ["3-8 short lowercase tags"]}\n'
        "Rules:\n"
        "- Focus on visible actions/emotions and narrative beats.\n"
        "- If OCR/dialogue is present, use it only as a hint; do not invent unseen details.\n"
        "- Tags must be short (1-3 words), lowercase, no duplicates.\n"
    )
    ctx = chapter_context.strip()
    parts = [rules]
    if ctx:
        parts.append(f"Chapter context: {ctx}\n")
    if ocr_text.strip():
        parts.append(f"OCR/dialogue hint:\n{ocr_text.strip()}\n")
    return "\n".join(parts).strip()


def _build_tags_prompt(caption: str) -> str:
    return (
        "Extract 3-8 short lowercase semantic tags from the caption.\n"
        "Return ONLY a JSON array of strings.\n"
        f"Caption:\n{caption.strip()}\n"
    )


def _run_stage() -> None:
    args = parse_args()

    if args.scene_provider == "none":
        emit("complete", stage=2, message="Scene provider set to 'none'; nothing to do.")
        return

    storyboard_path = Path(args.storyboard).expanduser()
    doc = _read_storyboard(storyboard_path)
    panels = doc.get("panels") or []

    final_root = storyboard_path.parent
    out_root = final_root.parent

    source_images = doc.get("source_images") if isinstance(doc.get("source_images"), list) else []
    panels_by_page: dict[int, list[tuple[int, dict[str, Any]]]] = {}
    for idx, panel in enumerate(panels):
        if not isinstance(panel, dict):
            continue
        page_idx = panel.get("page_idx")
        if not isinstance(page_idx, int):
            continue
        panels_by_page.setdefault(page_idx, []).append((idx, panel))

    pages_to_process: list[int] = []
    for page_idx, items in panels_by_page.items():
        needs_any = False
        for _, panel in items:
            if _needs_scene(panel, args.overwrite):
                needs_any = True
                break
        if needs_any:
            pages_to_process.append(page_idx)

    pages_to_process.sort()

    if not pages_to_process:
        emit("progress", stage=2, message="No panels require scene enrichment.", percent=100)
        emit("complete", stage=2, storyboard_path=str(storyboard_path))
        return

    emit(
        "progress",
        stage=2,
        message=f"Connecting to Ollama ({args.ollama_model})...",
        percent=5,
    )

    timeout = httpx.Timeout(float(max(5, int(args.ollama_timeout))))
    with httpx.Client(timeout=timeout) as client:
        if not _ensure_ollama_ready(client, args.ollama_host):
            raise stage_failed(
                "Ollama is not running or reachable.",
                {"host": args.ollama_host},
            )

        total_pages = len(pages_to_process)
        for page_number, page_idx in enumerate(pages_to_process, start=1):
            items = panels_by_page.get(page_idx) or []
            if not items:
                continue

            page_percent = 5 + int((page_number / total_pages) * 70)
            emit(
                "progress",
                stage=2,
                message=f"Captioning page {page_number}/{total_pages} (page_idx={page_idx})...",
                percent=page_percent,
            )

            # Build page OCR text (all panels on the page).
            page_texts: list[str] = []
            for _, panel in items:
                ocr_lines = panel.get("ocr_lines")
                if not isinstance(ocr_lines, list):
                    continue
                for line in ocr_lines:
                    if isinstance(line, dict) and isinstance(line.get("text"), str) and line["text"].strip():
                        page_texts.append(line["text"].strip())
            page_ocr_text = "\n".join(page_texts)

            # Determine best page image: doc.source_images[page_idx] or first crop fallback.
            page_image_path: Path | None = None
            if isinstance(source_images, list) and page_idx < len(source_images) and isinstance(source_images[page_idx], str):
                candidate = Path(source_images[page_idx]).expanduser()
                if candidate.exists():
                    page_image_path = candidate
            if page_image_path is None:
                first_crop_rel = items[0][1].get("crop_path")
                if isinstance(first_crop_rel, str) and first_crop_rel.strip():
                    candidate = out_root / first_crop_rel
                    if candidate.exists():
                        page_image_path = candidate

            if page_image_path is None:
                raise stage_failed(
                    "Failed to locate a page image for scene enrichment.",
                    {"page_idx": page_idx, "reason": "No source_images entry and no panel crop exists."},
                )

            page_image_b64 = _encode_png_base64(page_image_path)
            page_prompt = _build_page_prompt(
                chapter_context=str(args.chapter_context or ""),
                ocr_text=page_ocr_text,
            )

            try:
                raw_page = _ollama_generate(
                    client,
                    host=args.ollama_host,
                    model=args.ollama_model,
                    prompt=page_prompt,
                    image_b64=page_image_b64,
                    max_tokens=int(args.ollama_caption_tokens),
                    temperature=0.2,
                )
            except Exception as exc:  # noqa: BLE001
                raise stage_failed(
                    "Failed to call Ollama for page captioning.",
                    {"reason": str(exc), "host": args.ollama_host, "model": args.ollama_model, "page_idx": page_idx},
                ) from exc

            parsed_page = _extract_first_json_object(raw_page)
            page_caption = ""
            page_tags: list[str] = []
            if isinstance(parsed_page, dict):
                if isinstance(parsed_page.get("caption"), str):
                    page_caption = parsed_page["caption"].strip()
                page_tags = _normalize_tags(parsed_page.get("tags"))
            if not page_caption:
                page_caption = raw_page.strip()

            if not page_tags:
                # Cheap fallback: derive tags from the page caption only once per page.
                try:
                    tags_raw = _ollama_generate(
                        client,
                        host=args.ollama_host,
                        model=args.ollama_model,
                        prompt=_build_tags_prompt(page_caption),
                        image_b64=None,
                        max_tokens=int(args.ollama_tags_tokens),
                        temperature=0.0,
                    )
                    arr = _extract_first_json_array(tags_raw)
                    if isinstance(arr, list):
                        page_tags = _normalize_tags(arr)
                except Exception:
                    page_tags = []

            # Annotate panels on this page with a cheap text-only call.
            total_panels = len(items)
            for local_index, (panel_index, panel) in enumerate(items, start=1):
                if not _needs_scene(panel, args.overwrite):
                    # Still write sidecars below with the page caption.
                    continue

                panel_texts: list[str] = []
                ocr_lines = panel.get("ocr_lines")
                if isinstance(ocr_lines, list):
                    for line in ocr_lines:
                        if isinstance(line, dict) and isinstance(line.get("text"), str) and line["text"].strip():
                            panel_texts.append(line["text"].strip())
                panel_ocr_text = "\n".join(panel_texts)
                panel_position = f"panel {local_index} of {total_panels}"

                try:
                    raw_panel = _ollama_generate(
                        client,
                        host=args.ollama_host,
                        model=args.ollama_model,
                        prompt=_build_panel_annotation_prompt(
                            page_caption=page_caption,
                            panel_ocr_text=panel_ocr_text,
                            panel_position=panel_position,
                        ),
                        image_b64=None,
                        max_tokens=int(args.ollama_tags_tokens),
                        temperature=0.2,
                    )
                except Exception as exc:  # noqa: BLE001
                    raise stage_failed(
                        "Failed to call Ollama for panel annotation.",
                        {
                            "reason": str(exc),
                            "host": args.ollama_host,
                            "model": args.ollama_model,
                            "page_idx": page_idx,
                            "panel_id": panel.get("panel_id"),
                        },
                    ) from exc

                parsed_panel = _extract_first_json_object(raw_panel)
                panel_caption = ""
                if isinstance(parsed_panel, dict) and isinstance(parsed_panel.get("caption"), str):
                    panel_caption = parsed_panel["caption"].strip()
                if not panel_caption:
                    panel_caption = raw_panel.strip()

                panel["scene_caption"] = panel_caption
                panel["scene_tags"] = page_tags

            # Write sidecars for all panels on this page (adds page caption context).
            now_utc = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            for _, panel in items:
                crop_rel = panel.get("crop_path")
                if not isinstance(crop_rel, str) or not crop_rel.strip():
                    continue
                crop_path = out_root / crop_rel
                if not crop_path.exists():
                    continue
                panel_dir = crop_path.parent
                caption = (panel.get("scene_caption") or "").strip() if isinstance(panel.get("scene_caption"), str) else ""
                tags = panel.get("scene_tags") if isinstance(panel.get("scene_tags"), list) else []
                (panel_dir / "scene.txt").write_text(caption + ("\n" if caption else ""), encoding="utf-8")
                (panel_dir / "scene.json").write_text(
                    json.dumps(
                        {
                            "scene_caption": caption,
                            "scene_tags": tags,
                            "page_caption": page_caption,
                            "page_tags": page_tags,
                            "provider": "ollama",
                            "ollama_host": args.ollama_host,
                            "ollama_model": args.ollama_model,
                            "updated_at": now_utc,
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )

    out_path = Path(args.out).expanduser() if args.out else storyboard_path
    out_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")

    emit("progress", stage=2, message="Stage 2 complete.", percent=100)
    emit("complete", stage=2, storyboard_path=str(out_path))


def main() -> None:
    raise SystemExit(run_with_error_boundary(2, _run_stage))


if __name__ == "__main__":
    main()
