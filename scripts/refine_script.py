#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from scripts.common.errors import invalid_request, stage_failed
from scripts.common.events import emit, run_with_error_boundary


_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stage 4: refine recap into recap_pages_with_sentences.json using Claude or Gemini."
    )
    parser.add_argument("recap_pages", help="Path to final/recap_pages.json (from Stage 3).")
    parser.add_argument("--provider", choices=["anthropic", "gemini"], default="anthropic")
    parser.add_argument("--model", default=None, help="Provider model name (defaults depend on provider).")
    parser.add_argument(
        "--out",
        default=None,
        help="Output path (default: alongside recap_pages.json as recap_pages_with_sentences.json).",
    )
    parser.add_argument("--system-prompt", default=None, help="Override system prompt.")
    parser.add_argument("--timeout", type=int, default=120, help="HTTP read timeout seconds.")
    parser.add_argument("--max-tokens", type=int, default=4000)
    parser.add_argument("--temperature", type=float, default=0.2)

    args = parser.parse_args()
    recap_path = Path(args.recap_pages).expanduser()
    if not recap_path.exists():
        raise invalid_request("recap_pages.json not found.", {"path": str(recap_path)})
    return args


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise invalid_request("Expected valid JSON.", {"path": str(path), "error": str(exc)}) from exc


def _strip_json_fences(text: str) -> str:
    text = (text or "").strip()
    if not text:
        return text
    # Remove leading/trailing fenced blocks if the model wrapped its JSON.
    text = _JSON_FENCE_RE.sub("", text).strip()
    return text


def _extract_first_json_object(text: str) -> dict[str, Any] | None:
    text = (text or "").strip()
    if not text:
        return None
    # First try direct parse.
    try:
        parsed = json.loads(_strip_json_fences(text))
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass

    # Fallback: find first {...} block.
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for i, ch in enumerate(text[start:], start=start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                snippet = text[start : i + 1]
                try:
                    parsed = json.loads(_strip_json_fences(snippet))
                    return parsed if isinstance(parsed, dict) else None
                except Exception:
                    return None
    return None


def _load_chapter_id_from_storyboard(storyboard_path: str | None) -> str | None:
    if not storyboard_path or not isinstance(storyboard_path, str):
        return None
    try:
        path = Path(storyboard_path).expanduser()
        if not path.exists():
            return None
        doc = _read_json(path)
        if isinstance(doc, dict) and isinstance(doc.get("chapter_id"), str) and doc["chapter_id"].strip():
            return doc["chapter_id"].strip()
    except Exception:
        return None
    return None


def _validate_pages_sentences(doc: Any) -> list[dict[str, Any]]:
    if not isinstance(doc, dict):
        raise stage_failed("Provider output must be a JSON object.")
    pages = doc.get("pages")
    if not isinstance(pages, list) or not pages:
        raise stage_failed("Provider output must include non-empty pages[].")
    out: list[dict[str, Any]] = []
    for item in pages:
        if not isinstance(item, dict):
            continue
        page_idx = item.get("page_idx")
        if not isinstance(page_idx, int):
            continue
        sentences = item.get("sentences")
        if not isinstance(sentences, list):
            continue
        cleaned: list[str] = []
        for s in sentences:
            if not isinstance(s, str):
                continue
            s2 = s.strip()
            if s2:
                cleaned.append(s2)
        out.append({"page_idx": int(page_idx), "sentences": cleaned})
    if not out:
        raise stage_failed("Provider output pages[] must contain {page_idx:int, sentences:string[]} objects.")
    return out


def _coerce_one_sentence_per_panel(sentences: list[str], panel_count: int) -> list[str]:
    """
    Stage 4 output requires exactly one sentence per panel.
    If the provider returns too few or too many, we trim/pad.
    """
    sentences = [str(s).strip() for s in (sentences or []) if str(s).strip()]
    if panel_count <= 0:
        return []
    if len(sentences) >= panel_count:
        return sentences[:panel_count]
    # Pad missing with empty strings (caller may decide to error; we keep it explicit).
    return sentences + ([""] * (panel_count - len(sentences)))


def _build_default_system_prompt() -> str:
    return (
        "You are a professional manga video script editor.\n"
        "You will receive a raw AI-generated recap of a manga chapter (page by page) plus per-panel evidence.\n"
        "Your job is to write one clean narration sentence per panel.\n\n"
        "Rules:\n"
        "- Keep the narrative faithful to the evidence; do not invent plot details.\n"
        "- Paraphrase dialogue; do not quote directly.\n"
        "- Use plain English. Do not use quotation marks.\n"
        "- Return ONLY valid JSON.\n\n"
        "Output JSON schema:\n"
        "{\n"
        '  "pages": [\n'
        "    {\n"
        '      "page_idx": 0,\n'
        '      "sentences": ["Sentence for panel 0.", "Sentence for panel 1."]\n'
        "    }\n"
        "  ]\n"
        "}\n"
    )


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _read_transcript(panel_dir: Path) -> str:
    txt = _read_text(panel_dir / "transcript.txt").strip()
    if txt:
        return txt
    try:
        items = json.loads(_read_text(panel_dir / "transcript.json"))
    except Exception:
        items = None
    if isinstance(items, list):
        lines: list[str] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            speaker = item.get("speaker") if isinstance(item.get("speaker"), str) else "unsure"
            text = item.get("text") if isinstance(item.get("text"), str) else ""
            text = text.strip()
            if not text:
                continue
            lines.append(f"<{speaker}>: {text}")
        return "\n".join(lines).strip()
    return ""


def _build_page_user_prompt(
    *,
    page_idx: int,
    page_recap: str,
    panels: list[dict[str, Any]],
    out_root: Path,
    scene_caption_by_panel_id: dict[str, str],
) -> str:
    blocks: list[str] = []
    for panel in panels:
        panel_id = panel.get("panel_id") if isinstance(panel.get("panel_id"), str) else ""
        crop_path = panel.get("crop_path") if isinstance(panel.get("crop_path"), str) else ""
        sub_idx = panel.get("sub_panel_idx") if isinstance(panel.get("sub_panel_idx"), int) else 0
        panel_dir = (out_root / crop_path).parent if crop_path else out_root
        transcript = _read_transcript(panel_dir)
        scene_caption = scene_caption_by_panel_id.get(panel_id, "")
        transcript = "\n".join(transcript.splitlines()[:15]).strip() if transcript else ""
        blocks.append(
            "\n".join(
                [
                    f"[Panel {sub_idx:03d}] panel_id={panel_id or '(unknown)'}",
                    f"Scene caption: {scene_caption.strip() or '(none)'}",
                    f"Transcript (OCR): {transcript.strip() or '(none)'}",
                ]
            )
        )

    evidence = "\n\n".join(blocks).strip()
    return (
        "Write one narration sentence per panel, in the same order as the evidence.\n"
        "Return ONLY the JSON object described in the system prompt.\n\n"
        f"page_idx: {page_idx}\n\n"
        f"Page recap context (do not copy verbatim):\n{page_recap.strip()}\n\n"
        "Panel evidence:\n"
        + (evidence or "(none)")
        + "\n"
    )


def _anthropic_messages_create(
    client: httpx.Client,
    *,
    api_key: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
) -> str:
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": model,
        "max_tokens": int(max_tokens),
        "temperature": float(temperature),
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    resp = client.post(url, headers=headers, json=payload)
    resp.raise_for_status()
    data = resp.json()
    # Expected shape: { content: [ { type: "text", text: "..." } ] }
    if isinstance(data, dict) and isinstance(data.get("content"), list) and data["content"]:
        first = data["content"][0]
        if isinstance(first, dict) and isinstance(first.get("text"), str):
            return first["text"]
    return json.dumps(data)


def _gemini_generate_content(
    client: httpx.Client,
    *,
    api_key: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int,
    temperature: float,
) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    params = {"key": api_key}
    payload: dict[str, Any] = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": f"{system}\n\n{user}"}],
            }
        ],
        "generationConfig": {
            "temperature": float(temperature),
            "maxOutputTokens": int(max_tokens),
        },
    }
    # Ask for JSON if supported; ignore if API rejects field.
    payload["generationConfig"]["responseMimeType"] = "application/json"

    resp = client.post(url, params=params, json=payload)
    resp.raise_for_status()
    data = resp.json()
    # Expected shape: { candidates: [ { content: { parts: [ { text: "..." } ] } } ] }
    if isinstance(data, dict) and isinstance(data.get("candidates"), list) and data["candidates"]:
        cand = data["candidates"][0]
        if isinstance(cand, dict):
            content = cand.get("content")
            if isinstance(content, dict) and isinstance(content.get("parts"), list) and content["parts"]:
                part0 = content["parts"][0]
                if isinstance(part0, dict) and isinstance(part0.get("text"), str):
                    return part0["text"]
    return json.dumps(data)


def _build_recap_pages_with_sentences(
    *,
    recap_pages: dict[str, Any],
    sentences_by_page_idx: dict[int, list[str]],
) -> dict[str, Any]:
    pages_in = recap_pages.get("pages") if isinstance(recap_pages.get("pages"), list) else []
    pages_out: list[dict[str, Any]] = []
    for item in pages_in:
        if not isinstance(item, dict):
            continue
        page_idx = item.get("page_idx")
        recap = item.get("recap")
        panels = item.get("panels")
        if not isinstance(page_idx, int) or not isinstance(recap, str) or not isinstance(panels, list):
            continue

        panels_clean: list[dict[str, Any]] = []
        for ref in panels:
            if not isinstance(ref, dict):
                continue
            sub_panel_idx = ref.get("sub_panel_idx") if isinstance(ref.get("sub_panel_idx"), int) else 0
            panel_id = ref.get("panel_id") if isinstance(ref.get("panel_id"), str) else ""
            crop_path = ref.get("crop_path") if isinstance(ref.get("crop_path"), str) else ""
            if not panel_id.strip() or not crop_path.strip():
                continue
            panels_clean.append(
                {
                    "sub_panel_idx": int(sub_panel_idx),
                    "panel_id": panel_id.strip(),
                    "crop_path": crop_path.strip(),
                }
            )

        one_each = _coerce_one_sentence_per_panel(sentences_by_page_idx.get(int(page_idx), []), len(panels_clean))
        panels_out: list[dict[str, Any]] = []
        for i, panel in enumerate(panels_clean):
            panels_out.append({**panel, "sentence": one_each[i] if i < len(one_each) else ""})

        pages_out.append({"page_idx": int(page_idx), "recap": recap.strip(), "panels": panels_out})

    if not pages_out:
        raise stage_failed("Failed to build output pages (recap_pages.json missing expected page structure).")

    return {"mode": "page", "pages": pages_out}


def _run_stage() -> None:
    args = parse_args()
    recap_path = Path(args.recap_pages).expanduser()
    out_path = (
        Path(args.out).expanduser()
        if isinstance(args.out, str) and args.out
        else (recap_path.parent / "recap_pages_with_sentences.json")
    )

    emit("progress", stage=4, message="Loading recap_pages.json...", percent=5)
    recap = _read_json(recap_path)
    if not isinstance(recap, dict):
        raise invalid_request("recap_pages.json must be a JSON object.", {"path": str(recap_path)})

    provider = str(args.provider)
    model = str(args.model or ("claude-sonnet-4-20250514" if provider == "anthropic" else "gemini-1.5-pro"))

    system_prompt = str(args.system_prompt).strip() if args.system_prompt else _build_default_system_prompt()
    storyboard_path = recap.get("storyboard") if isinstance(recap.get("storyboard"), str) else None
    storyboard_doc: dict[str, Any] | None = None
    if storyboard_path:
        try:
            storyboard_doc = _read_json(Path(storyboard_path).expanduser())
        except Exception:
            storyboard_doc = None

    scene_caption_by_panel_id: dict[str, str] = {}
    if isinstance(storyboard_doc, dict):
        panels = storyboard_doc.get("panels")
        if isinstance(panels, list):
            for panel in panels:
                if not isinstance(panel, dict):
                    continue
                pid = panel.get("panel_id")
                cap = panel.get("scene_caption")
                if isinstance(pid, str) and pid.strip() and isinstance(cap, str) and cap.strip():
                    scene_caption_by_panel_id[pid.strip()] = cap.strip()

    # Derive out_root for transcript sidecars (same layout as Stage 3).
    out_root = Path(storyboard_path).expanduser().parent.parent if storyboard_path else recap_path.parent.parent

    pages_in = recap.get("pages") if isinstance(recap.get("pages"), list) else []
    pages_sorted: list[dict[str, Any]] = []
    for item in pages_in:
        if isinstance(item, dict) and isinstance(item.get("page_idx"), int):
            pages_sorted.append(item)
    pages_sorted.sort(key=lambda x: int(x.get("page_idx") or 0))

    if not pages_sorted:
        raise invalid_request("recap_pages.json is missing pages[].", {"hint": "Run Stage 3 first."})

    sentences_by_page_idx: dict[int, list[str]] = {}

    timeout = httpx.Timeout(float(max(5, int(args.timeout))))
    with httpx.Client(timeout=timeout) as client:
        for idx, page in enumerate(pages_sorted, start=1):
            page_idx = int(page.get("page_idx") or 0)
            page_recap = page.get("recap") if isinstance(page.get("recap"), str) else ""
            panels = page.get("panels") if isinstance(page.get("panels"), list) else []
            panel_refs: list[dict[str, Any]] = [p for p in panels if isinstance(p, dict)]
            if not panel_refs:
                continue

            percent = 10 + int((idx / max(1, len(pages_sorted))) * 70)
            emit("progress", stage=4, message=f"Refining page {idx}/{len(pages_sorted)} (page_idx={page_idx})...", percent=percent)

            user_prompt = _build_page_user_prompt(
                page_idx=page_idx,
                page_recap=page_recap,
                panels=panel_refs,
                out_root=out_root,
                scene_caption_by_panel_id=scene_caption_by_panel_id,
            )

            started = time.time()
            if provider == "anthropic":
                api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
                if not api_key:
                    raise stage_failed("Missing ANTHROPIC_API_KEY.", {"env": "ANTHROPIC_API_KEY"})
                try:
                    text = _anthropic_messages_create(
                        client,
                        api_key=api_key,
                        model=model,
                        system=system_prompt,
                        user=user_prompt,
                        max_tokens=int(args.max_tokens),
                        temperature=float(args.temperature),
                    )
                except Exception as exc:  # noqa: BLE001
                    raise stage_failed("Failed to call Anthropic API.", {"reason": str(exc), "model": model, "page_idx": page_idx}) from exc
            else:
                api_key = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
                if not api_key:
                    raise stage_failed(
                        "Missing GEMINI_API_KEY / GOOGLE_API_KEY.",
                        {"env": ["GEMINI_API_KEY", "GOOGLE_API_KEY"]},
                    )
                try:
                    text = _gemini_generate_content(
                        client,
                        api_key=api_key,
                        model=model,
                        system=system_prompt,
                        user=user_prompt,
                        max_tokens=int(args.max_tokens),
                        temperature=float(args.temperature),
                    )
                except Exception as exc:  # noqa: BLE001
                    raise stage_failed("Failed to call Gemini API.", {"reason": str(exc), "model": model, "page_idx": page_idx}) from exc

            elapsed = round(time.time() - started, 2)
            parsed = _extract_first_json_object(text)
            if parsed is None:
                raise stage_failed(
                    "Provider did not return valid JSON.",
                    {"hint": "Ensure the model outputs JSON only.", "page_idx": page_idx, "took_s": elapsed},
                )
            refined_pages = _validate_pages_sentences({"pages": [parsed]} if "page_idx" in parsed else parsed)
            def _page_idx_value(item: dict[str, Any]) -> int | None:
                v = item.get("page_idx")
                return int(v) if isinstance(v, int) else None

            only = next((p for p in refined_pages if _page_idx_value(p) == page_idx), None)
            if only is None:
                raise stage_failed("Provider response missing page_idx.", {"page_idx": page_idx, "took_s": elapsed})
            sentences_by_page_idx[page_idx] = list(only.get("sentences") or [])

    final_doc = _build_recap_pages_with_sentences(recap_pages=recap, sentences_by_page_idx=sentences_by_page_idx)

    emit("progress", stage=4, message="Writing recap_pages_with_sentences.json...", percent=90)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(final_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    emit("progress", stage=4, message="Stage 4 complete.", percent=100)
    emit("complete", stage=4, refined_recap_path=str(out_path), provider=provider, model=model)


def main() -> None:
    raise SystemExit(run_with_error_boundary(4, _run_stage))


if __name__ == "__main__":
    main()
