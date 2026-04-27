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
_ANGLE_TAG_RE = re.compile(r"</?[^>]+>")
_QUOTE_CHARS_RE = re.compile(r"[\"“”‘’]")


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
        panels = item.get("panels")
        if not isinstance(panels, list) or not panels:
            continue
        cleaned_panels: list[dict[str, str]] = []
        for p in panels:
            if not isinstance(p, dict):
                continue
            pid = p.get("panel_id")
            sentence = p.get("sentence")
            if not isinstance(pid, str) or not pid.strip() or not isinstance(sentence, str):
                continue
            s2 = sentence.strip()
            if not s2:
                continue
            cleaned_panels.append({"panel_id": pid.strip(), "sentence": s2})
        if cleaned_panels:
            out.append({"page_idx": int(page_idx), "panels": cleaned_panels})
    if not out:
        raise stage_failed("Provider output pages[] must contain {page_idx:int, panels:[{panel_id, sentence}]} objects.")
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
        "- No first-person (no inner monologue, plans, or narrator 'I').\n"
        "- No angle-bracket tags (no <narrator>, <character>, etc.).\n"
        "- Avoid purple prose and filler; be concrete and visual.\n"
        "- Keep sentences short and punchy (aim <= 18 words).\n"
        "- Avoid repetitive sentence starts; don't begin every sentence with the same word.\n"
        "- Use plain English. Do not use quotation marks.\n"
        "- Return ONLY valid JSON.\n\n"
        "Output JSON schema:\n"
        "{\n"
        '  "pages": [\n'
        "    {\n"
        '      "page_idx": 0,\n'
        '      "panels": [\n'
        '        {"panel_id": "id", "sentence": "Sentence for that panel."}\n'
        "      ]\n"
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
        # Avoid leaking angle-bracket tags (e.g. "<unsure>:") into provider outputs.
        return re.sub(r"<([^>]+)>", r"\1", txt).strip()
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
            lines.append(f"{speaker}: {text}")
        return "\n".join(lines).strip()
    return ""


def _build_page_user_prompt(
    *,
    page_idx: int,
    page_recap: str,
    panels: list[dict[str, Any]],
    out_root: Path,
    scene_caption_by_panel_id: dict[str, str],
    draft_by_panel_id: dict[str, str] | None = None,
) -> str:
    blocks: list[str] = []
    panel_ids_in_order: list[str] = []
    for panel in panels:
        panel_id = panel.get("panel_id") if isinstance(panel.get("panel_id"), str) else ""
        crop_path = panel.get("crop_path") if isinstance(panel.get("crop_path"), str) else ""
        sub_idx = panel.get("sub_panel_idx") if isinstance(panel.get("sub_panel_idx"), int) else 0
        panel_dir = (out_root / crop_path).parent if crop_path else out_root
        transcript = _read_transcript(panel_dir)
        scene_caption = scene_caption_by_panel_id.get(panel_id, "")
        transcript = "\n".join(transcript.splitlines()[:15]).strip() if transcript else ""
        draft = (draft_by_panel_id or {}).get(panel_id, "").strip() if panel_id else ""
        blocks.append(
            "\n".join(
                [
                    f"[Panel {sub_idx:03d}] panel_id={panel_id or '(unknown)'}",
                    f"Scene caption: {scene_caption.strip() or '(none)'}",
                    f"Draft sentence (may be wrong): {draft or '(none)'}",
                    f"Transcript (OCR): {transcript.strip() or '(none)'}",
                ]
            )
        )
        if panel_id.strip():
            panel_ids_in_order.append(panel_id.strip())

    evidence = "\n\n".join(blocks).strip()
    return (
        "Write EXACTLY one narration sentence per panel, in the same order as the evidence.\n"
        "Do not invent details; if evidence is unclear, write a vague but accurate sentence.\n"
        "Return ONLY the JSON object described in the system prompt.\n\n"
        f"page_idx: {page_idx}\n\n"
        f"Page recap context (do not copy verbatim):\n{page_recap.strip()}\n\n"
        f"Required panel_ids (in order): {json.dumps(panel_ids_in_order, ensure_ascii=False)}\n\n"
        "Panel evidence:\n"
        + (evidence or "(none)")
        + "\n"
    )


def _sentence_violations(sentence: str) -> list[str]:
    s = (sentence or "").strip()
    if not s:
        return ["empty"]
    violations: list[str] = []
    if _ANGLE_TAG_RE.search(s):
        violations.append("contains_angle_brackets")
    if _QUOTE_CHARS_RE.search(s):
        violations.append("contains_quotes")
    if re.search(r"\b(I|I'd|I'll|Im|I'm|me|my|mine|we|our|ours)\b", s, flags=re.IGNORECASE):
        violations.append("first_person")
    # Common LLM slop / purple prose crutches.
    slop_phrases = [
        "contemplative frown",
        "etched on his face",
        "clouding his features",
        "dominating his features",
        "a mix of",
        "a wave of",
        "a growing sense of",
        "punctuated by",
        "utterly perplexed",
        "a visible expression of",
        "fresh wave of",
        "the protagonist",
        "seemingly oblivious",
    ]
    lower = s.lower()
    if any(p in lower for p in slop_phrases):
        violations.append("purple_prose")
    words = re.findall(r"\w+", s)
    if len(words) > 26:
        violations.append("too_long")
    return violations


def _fix_sentence_locally(sentence: str) -> str:
    """
    Deterministic cleanup; don't try to be 'smart', just remove obvious garbage.
    Provider should do the heavy lifting.
    """
    s = (sentence or "").strip()
    if not s:
        return ""
    s = _ANGLE_TAG_RE.sub("", s)
    s = _QUOTE_CHARS_RE.sub("", s)
    s = re.sub(r"[ \t]+", " ", s).strip()
    # Trim a few recurring purple-prose fragments.
    s = re.sub(r"\bthe protagonist\b", "they", s, flags=re.IGNORECASE)
    s = re.sub(r"\b(a )?(contemplative frown|bewildered expression|questioning gaze)\b.*?\b(as|while)\b", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s{2,}", " ", s).strip()
    if s and not re.search(r"[.!?]$", s):
        s += "."
    return s


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
    sentences_by_page_idx: dict[int, dict[str, str]],
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

        panels_out: list[dict[str, Any]] = []
        by_panel_id = sentences_by_page_idx.get(int(page_idx), {})
        for panel in panels_clean:
            pid = str(panel.get("panel_id") or "").strip()
            sentence = by_panel_id.get(pid, "") if pid else ""
            panels_out.append({**panel, "sentence": str(sentence or "").strip()})

        pages_out.append({"page_idx": int(page_idx), "recap": recap.strip(), "panels": panels_out})

    if not pages_out:
        raise stage_failed("Failed to build output pages (recap_pages.json missing expected page structure).")

    return {"mode": "page", "pages": pages_out}


def _normalize_provider_page_output(
    *,
    raw: dict[str, Any],
    page_idx: int,
    required_panel_ids: list[str],
) -> dict[str, Any]:
    """
    Accept either the new schema (panels:[{panel_id,sentence}]) or older schema (sentences:[...]).
    Returns a dict shaped like: {page_idx:int, panels:[{panel_id, sentence}]}
    """
    if not isinstance(raw, dict):
        raise stage_failed("Provider output must be a JSON object.")

    # New schema.
    if isinstance(raw.get("panels"), list):
        doc = {"pages": [raw]}
        pages = _validate_pages_sentences(doc)
        only = next((p for p in pages if isinstance(p, dict) and p.get("page_idx") == int(page_idx)), None)
        if only is None:
            raise stage_failed("Provider response missing page_idx.", {"page_idx": page_idx})
        return only

    # Old schema: page-level sentences list; map by required panel ids.
    sentences = raw.get("sentences")
    if isinstance(sentences, list) and required_panel_ids:
        cleaned: list[str] = []
        for s in sentences:
            if isinstance(s, str) and s.strip():
                cleaned.append(_fix_sentence_locally(s.strip()))
        # Pad/trim.
        if len(cleaned) < len(required_panel_ids):
            cleaned.extend([""] * (len(required_panel_ids) - len(cleaned)))
        cleaned = cleaned[: len(required_panel_ids)]
        panels_out = [{"panel_id": pid, "sentence": cleaned[i]} for i, pid in enumerate(required_panel_ids)]
        return {"page_idx": int(page_idx), "panels": panels_out}

    raise stage_failed("Provider output missing expected fields.", {"expected": ["panels", "sentences"]})


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
    model = str(args.model or ("claude-sonnet-4-20250514" if provider == "anthropic" else "gemini-2.5-pro"))

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

    sentences_by_page_idx: dict[int, dict[str, str]] = {}

    timeout = httpx.Timeout(float(max(5, int(args.timeout))))
    with httpx.Client(timeout=timeout) as client:
        for idx, page in enumerate(pages_sorted, start=1):
            page_idx = int(page.get("page_idx") or 0)
            page_recap = page.get("recap") if isinstance(page.get("recap"), str) else ""
            panels = page.get("panels") if isinstance(page.get("panels"), list) else []
            panel_drafts = page.get("panel_drafts") if isinstance(page.get("panel_drafts"), list) else []
            draft_by_panel_id: dict[str, str] = {}
            for item in panel_drafts:
                if not isinstance(item, dict):
                    continue
                pid = item.get("panel_id")
                s = item.get("draft_sentence")
                if isinstance(pid, str) and pid.strip() and isinstance(s, str) and s.strip():
                    draft_by_panel_id[pid.strip()] = s.strip()
            panel_refs: list[dict[str, Any]] = [p for p in panels if isinstance(p, dict)]
            if not panel_refs:
                continue
            required_panel_ids = [
                str(p.get("panel_id") or "").strip()
                for p in panel_refs
                if isinstance(p.get("panel_id"), str) and str(p.get("panel_id") or "").strip()
            ]

            percent = 10 + int((idx / max(1, len(pages_sorted))) * 70)
            emit("progress", stage=4, message=f"Refining page {idx}/{len(pages_sorted)} (page_idx={page_idx})...", percent=percent)

            base_user_prompt = _build_page_user_prompt(
                page_idx=page_idx,
                page_recap=page_recap,
                panels=panel_refs,
                out_root=out_root,
                scene_caption_by_panel_id=scene_caption_by_panel_id,
                draft_by_panel_id=draft_by_panel_id or None,
            )

            # One retry loop if the provider produces slop.
            last_text = ""
            for attempt in range(2):
                critique = ""
                if attempt == 1 and last_text:
                    critique = (
                        "\n\nYour previous output violated rules (first-person/tags/quotes/purple-prose/too-long). "
                        "Rewrite to comply. Keep the same page_idx and the same panel_id set.\n"
                        "Previous output:\n"
                        + last_text.strip()
                        + "\n"
                    )
                user_prompt = base_user_prompt + critique

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
                            temperature=float(args.temperature) if attempt == 0 else 0.0,
                        )
                    except Exception as exc:  # noqa: BLE001
                        raise stage_failed(
                            "Failed to call Anthropic API.", {"reason": str(exc), "model": model, "page_idx": page_idx}
                        ) from exc
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
                            temperature=float(args.temperature) if attempt == 0 else 0.0,
                        )
                    except Exception as exc:  # noqa: BLE001
                        raise stage_failed(
                            "Failed to call Gemini API.", {"reason": str(exc), "model": model, "page_idx": page_idx}
                        ) from exc

                elapsed = round(time.time() - started, 2)
                last_text = text or ""
                parsed = _extract_first_json_object(text)
                if parsed is None:
                    if attempt == 0:
                        continue
                    raise stage_failed(
                        "Provider did not return valid JSON.",
                        {"hint": "Ensure the model outputs JSON only.", "page_idx": page_idx, "took_s": elapsed},
                    )

                normalized = _normalize_provider_page_output(
                    raw=parsed,
                    page_idx=page_idx,
                    required_panel_ids=required_panel_ids,
                )
                panel_items = normalized.get("panels") if isinstance(normalized.get("panels"), list) else []
                by_panel_id: dict[str, str] = {}
                violations: list[dict[str, Any]] = []
                starts: list[str] = []
                for item in panel_items:
                    if not isinstance(item, dict):
                        continue
                    pid = item.get("panel_id")
                    sentence = item.get("sentence")
                    if not isinstance(pid, str) or not pid.strip() or not isinstance(sentence, str):
                        continue
                    fixed = _fix_sentence_locally(sentence)
                    by_panel_id[pid.strip()] = fixed.strip()
                    v = _sentence_violations(fixed)
                    if v:
                        violations.append({"panel_id": pid.strip(), "violations": v, "sentence": fixed})
                    first_word = (re.findall(r"[A-Za-z]+", fixed)[:1] or [""])[0].lower()
                    if first_word:
                        starts.append(first_word)

                if starts:
                    # If most sentences start with the same token (e.g. "he"), nudge a rewrite.
                    counts: dict[str, int] = {}
                    for w in starts:
                        counts[w] = counts.get(w, 0) + 1
                    most = max(counts.values()) if counts else 0
                    if most >= max(3, int(len(starts) * 0.6)):
                        violations.append({"panel_id": "(page)", "violations": ["repetitive_starts"], "sentence": ""})

                # If it's clean enough, accept; otherwise retry once with critique.
                if not violations or attempt == 1:
                    if violations and attempt == 1:
                        emit(
                            "log",
                            stage=4,
                            message=f"Stage 4: accepted with remaining violations on page_idx={page_idx}: {len(violations)}",
                        )
                    sentences_by_page_idx[page_idx] = by_panel_id
                    break

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
