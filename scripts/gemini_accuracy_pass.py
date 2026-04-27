#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
from typing import Any

import httpx

from scripts.common.errors import invalid_request, stage_failed
from scripts.common.events import emit, run_with_error_boundary


PROMPT_ACCURACY_PASS = """
Here's the combined super prompt:

---

**MANGA PANEL TRANSCRIBER + NARRATOR**

You are a two-stage manga panel processor. I will give you multiple manga page images. You will run both stages internally and output only the final narrator JSON.

---

**STAGE 1 — ACCURACY PASS (internal, not shown)**

Read each page strictly right-to-left, top-to-bottom. Before writing anything, count every distinct panel by examining borders and gutters. If unsure whether two frames are separate, treat them as two panels.

Capture for each panel:
- Exactly which characters are visible and what they are physically doing
- Facial expressions and body language, literally
- All text, speech bubbles, and narration boxes — word for word
- Nothing you cannot directly see: no assumptions, no context from other panels, no interpretation

Position labels to use only: `Top Right`, `Top Center`, `Top Left`, `Middle Right`, `Middle Center`, `Middle Left`, `Bottom Right`, `Bottom Center`, `Bottom Left`, `Full Width`

---

**STAGE 2 — NARRATOR PASS (this is your output)**

Rewrite each panel as a vivid, engaging narrator description. Rules:
- Never change, add, or remove any factual detail from Stage 1 — only change how it is written
- Never use direct quotes or quotation marks — paraphrase all dialogue in narrator voice
- Match the emotional register of each panel: urgency for panic, sarcasm for smugness, humor for comedy
- Write as a narrator describing events to an audience, not summarizing a plot
- 1 sentence maximum per panel
- Never describe visual composition, framing, or layout — no "close-up", "wide shot", "panel shows", "we see", "the shot", "portrait of"
- Describe only what is happening narratively: actions, emotions, story beats
- Never add context or details from other panels
- If a panel has very little action, keep the description short rather than padding it out

---

**Output Format:**

Return only this JSON — no explanation, no markdown, nothing outside the array:

```json
[
  {
    "page": 1,
    "panels": [
      {
        "panel": 1,
        "position": "Top Right",
        "description": "Narrator-styled rewrite of the panel. No quotes. 1 sentence max."
      }
    ]
  }
]
```

**Strict Rules:**
- Do not alter panel numbers, page numbers, or position labels
- Do not merge panels or reorder them
- Never skip a panel, even if small or transitional
- Treat each image as a completely independent page
- If given multiple images with ordering specified, produce a single complete JSON starting from the indicated page number
- Output only the final JSON array — Stage 1 is internal reasoning only

IMPORTANT: Make a complete json from starting the numbering from page [X]
""".strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stage 2: Send manga page images to the Gemini API and write narrator JSON (gemini_output)."
    )
    parser.add_argument("--storyboard", required=True, help="Path to final/storyboard.json (from Stage 1).")
    parser.add_argument(
        "--out",
        default=None,
        help="Output path (default: alongside storyboard.json as gemini_output).",
    )
    parser.add_argument("--model", default="gemini-2.5-pro")
    parser.add_argument("--timeout", type=int, default=120, help="HTTP read timeout seconds.")
    parser.add_argument("--start-page", type=int, default=1, help="1-based start page number for Gemini output.")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=4,
        help="Deprecated (ignored): Stage 2 sends all chapter pages in a single request.",
    )

    args = parser.parse_args()
    storyboard_path = Path(args.storyboard).expanduser()
    if not storyboard_path.exists():
        raise invalid_request("storyboard.json not found.", {"path": str(storyboard_path)})
    if args.start_page < 1:
        raise invalid_request("--start-page must be >= 1.", {"received": args.start_page})
    return args


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise invalid_request("Expected valid JSON.", {"path": str(path), "error": str(exc)}) from exc


def _guess_mime_type(path: Path) -> str:
    ext = path.suffix.lower().lstrip(".")
    if ext in ("jpg", "jpeg"):
        return "image/jpeg"
    if ext in ("png",):
        return "image/png"
    if ext in ("webp",):
        return "image/webp"
    return "application/octet-stream"


def _encode_image_part(path: Path) -> dict[str, Any]:
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"inline_data": {"mime_type": _guess_mime_type(path), "data": data}}


def _gemini_generate_multimodal_json(
    client: httpx.Client,
    *,
    api_key: str,
    model: str,
    prompt: str,
    pages: list[tuple[int, Path]],
) -> Any:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    params = {"key": api_key}

    parts: list[dict[str, Any]] = [{"text": prompt}]
    for page_number_1_based, image_path in pages:
        parts.append({"text": f"\n\nPage {page_number_1_based} image:"})
        parts.append(_encode_image_part(image_path))

    payload: dict[str, Any] = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0.0,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
        },
    }

    resp = client.post(url, params=params, json=payload)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and isinstance(data.get("candidates"), list) and data["candidates"]:
        cand = data["candidates"][0]
        if isinstance(cand, dict):
            content = cand.get("content")
            if isinstance(content, dict) and isinstance(content.get("parts"), list) and content["parts"]:
                part0 = content["parts"][0]
                if isinstance(part0, dict) and isinstance(part0.get("text"), str):
                    return json.loads(part0["text"])
    return data


def _validate_panel_output(doc: Any) -> list[dict[str, Any]]:
    if not isinstance(doc, list):
        raise stage_failed("Gemini output must be a JSON array.")
    for i, page in enumerate(doc):
        if not isinstance(page, dict):
            raise stage_failed(f"Gemini output page[{i}] must be an object.")
        if not isinstance(page.get("page"), int):
            raise stage_failed(f"Gemini output page[{i}].page must be an integer.")
        if not isinstance(page.get("panels"), list):
            raise stage_failed(f"Gemini output page[{i}].panels must be a list.")
        for j, panel in enumerate(page["panels"]):
            if not isinstance(panel, dict):
                raise stage_failed(f"Gemini output page[{i}].panels[{j}] must be an object.")
            if not isinstance(panel.get("panel"), int):
                raise stage_failed(f"Gemini output page[{i}].panels[{j}].panel must be an integer.")
            if not isinstance(panel.get("position"), str) or not panel["position"].strip():
                raise stage_failed(f"Gemini output page[{i}].panels[{j}].position must be a non-empty string.")
            # Accept either narrator schema (description) or legacy accuracy schema (characters/action/text).
            if "description" in panel:
                if not isinstance(panel.get("description"), str):
                    raise stage_failed(
                        f"Gemini output page[{i}].panels[{j}].description must be a string."
                    )
            else:
                if not any((k in panel) for k in ("characters", "action", "text")):
                    raise stage_failed(
                        f"Gemini output page[{i}].panels[{j}] missing expected fields.",
                        {"expected_one_of": ["description", "characters/action/text"]},
                    )
                if panel.get("text") is not None and not isinstance(panel.get("text"), str):
                    raise stage_failed(f"Gemini output page[{i}].panels[{j}].text must be a string or null.")
    return doc


def _run_stage() -> None:
    args = parse_args()
    storyboard_path = Path(args.storyboard).expanduser()
    storyboard = _read_json(storyboard_path)
    if not isinstance(storyboard, dict):
        raise invalid_request("storyboard.json must be a JSON object.", {"path": str(storyboard_path)})

    source_images = storyboard.get("source_images")
    if not isinstance(source_images, list) or not source_images:
        raise invalid_request("storyboard.json missing source_images[].", {"path": str(storyboard_path)})

    pages: list[Path] = []
    for idx, item in enumerate(source_images):
        if not isinstance(item, str) or not item.strip():
            continue
        p = Path(item).expanduser()
        if not p.exists():
            raise invalid_request("Storyboard source image does not exist.", {"index": idx, "path": str(p)})
        pages.append(p)

    if not pages:
        raise invalid_request("No valid source_images were found in storyboard.json.", {"path": str(storyboard_path)})

    out_path = Path(args.out).expanduser() if args.out else storyboard_path.parent / "gemini_output"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    api_key = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
    if not api_key:
        raise invalid_request("Missing GEMINI_API_KEY / GOOGLE_API_KEY.", {"env": ["GEMINI_API_KEY", "GOOGLE_API_KEY"]})

    emit("progress", stage=2, message=f"Sending {len(pages)} pages to Gemini ({args.model})...", percent=5)

    timeout = httpx.Timeout(connect=20.0, read=float(args.timeout), write=20.0, pool=20.0)
    with httpx.Client(timeout=timeout) as client:
        total = len(pages)
        prompt = PROMPT_ACCURACY_PASS.replace("[X]", str(int(args.start_page)))
        emit(
            "progress",
            stage=2,
            message=f"Gemini Transcriber + Narrator: sending {total} pages in one request",
            percent=15,
        )
        batch = [(int(args.start_page) + i, pages[i]) for i in range(total)]
        raw = _gemini_generate_multimodal_json(
            client,
            api_key=api_key,
            model=str(args.model),
            prompt=prompt,
            pages=batch,
        )
        merged: list[dict[str, Any]] = _validate_panel_output(raw)

    merged.sort(key=lambda p: int(p.get("page") or 0))
    out_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    emit("progress", stage=2, message="Wrote gemini_output.", percent=100)
    emit("complete", stage=2, gemini_output_path=str(out_path))


def main() -> None:
    raise SystemExit(run_with_error_boundary(2, _run_stage))


if __name__ == "__main__":
    main()
