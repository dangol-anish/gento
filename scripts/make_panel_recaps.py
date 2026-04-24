#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from scripts.common.errors import invalid_request, stage_failed
from scripts.common.events import emit, run_with_error_boundary


DEFAULT_MODEL = "gemma3:4b"

_CROP_PATH_RE = re.compile(r"(?:^|/)final/pages/(\d+)/panels/(\d+)/")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Stage 3: generate narrative recaps using Ollama.\n"
            "Default mode is page-first: one recap per page using Stage 2 scene outputs."
        )
    )
    parser.add_argument("storyboard", help="Path to final/storyboard.json (from Stage 2).")
    parser.add_argument("--mode", choices=["page", "panel"], default="page")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing recap outputs if present.")
    parser.add_argument(
        "--context-pages",
        type=int,
        default=3,
        help="How many previous page recaps to include as continuity context (page mode).",
    )
    parser.add_argument("--sentences-min", type=int, default=2)
    parser.add_argument("--sentences-max", type=int, default=4)

    parser.add_argument("--ollama-host", default="http://127.0.0.1:11434")
    parser.add_argument("--ollama-model", default=DEFAULT_MODEL)
    parser.add_argument("--ollama-timeout", type=int, default=900, help="Ollama read timeout seconds.")
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument(
        "--keep-alive",
        default="60m",
        help="Ollama keep_alive duration (e.g. 60m, -1 for forever).",
    )

    args = parser.parse_args()
    storyboard_path = Path(args.storyboard).expanduser()
    if not storyboard_path.exists():
        raise invalid_request("storyboard file not found.", {"path": str(storyboard_path)})
    return args


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read_storyboard(path: Path) -> dict[str, Any]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise invalid_request("storyboard must be valid JSON.", {"error": str(exc)}) from exc
    if not isinstance(doc, dict):
        raise invalid_request("storyboard must be a JSON object.")
    panels = doc.get("panels")
    if not isinstance(panels, list) or not panels:
        raise invalid_request("storyboard.panels must be a non-empty array.")
    return doc


def _panel_sort_key(panel: dict[str, Any], fallback_idx: int) -> tuple[int, int, int]:
    crop_path = panel.get("crop_path")
    if isinstance(crop_path, str):
        match = _CROP_PATH_RE.search(crop_path.replace("\\", "/"))
        if match:
            try:
                return int(match.group(1)), int(match.group(2)), fallback_idx
            except Exception:
                pass
    page_idx = panel.get("page_idx")
    if isinstance(page_idx, int):
        return int(page_idx), fallback_idx, fallback_idx
    return fallback_idx, fallback_idx, fallback_idx


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


def _read_page_caption_from_sidecars(*, out_root: Path, panels_for_page: list[dict[str, Any]]) -> str:
    for panel in panels_for_page:
        crop_rel = panel.get("crop_path")
        if not isinstance(crop_rel, str) or not crop_rel.strip():
            continue
        crop_path = out_root / crop_rel
        scene_json_path = crop_path.parent / "scene.json"
        if not scene_json_path.exists():
            continue
        try:
            scene_doc = json.loads(scene_json_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(scene_doc, dict) and isinstance(scene_doc.get("page_caption"), str):
            cap = scene_doc["page_caption"].strip()
            if cap:
                return cap
    return ""


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
            if 200 <= resp.status_code < 500:
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
        return proc.pid is not None
    except Exception:
        return False


def _ensure_ollama_ready(client: httpx.Client, host: str) -> bool:
    if _wait_for_ollama(client, host, 1.2):
        return True
    if not _is_local_ollama_host(host):
        return False
    print(f"[Stage3] Ollama not reachable at {host}; attempting to start `ollama serve`...", flush=True)
    if not _try_start_ollama_server():
        print("[Stage3] Failed to spawn `ollama serve` (is Ollama installed and on PATH?).", flush=True)
        return False
    ok = _wait_for_ollama(client, host, 8.0)
    if ok:
        print(f"[Stage3] Ollama is up at {host}.", flush=True)
    else:
        print(f"[Stage3] Ollama did not become ready at {host}.", flush=True)
    return ok


def _ollama_generate_text(
    client: httpx.Client,
    *,
    host: str,
    model: str,
    prompt: str,
    max_tokens: int,
    temperature: float,
    keep_alive: str,
) -> str:
    url = host.rstrip("/") + "/api/generate"
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "keep_alive": keep_alive,
        "options": {
            "temperature": float(temperature),
            "num_predict": int(max_tokens),
        },
    }
    resp = client.post(url, json=payload)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and isinstance(data.get("response"), str):
        return data["response"]
    return json.dumps(data)


def _prompt_for_page(
    *,
    prev_context: str,
    page_idx: int,
    page_caption: str,
    panel_blocks: list[str],
    sentences_min: int,
    sentences_max: int,
) -> str:
    evidence = "\n\n".join([b.strip() for b in panel_blocks if b.strip()]).strip()
    if evidence:
        evidence = evidence[:12000]

    return (
        "You are a manga narrator writing a YouTube recap script.\n"
        f"Write {sentences_min} to {sentences_max} sentences describing what happens on this page.\n\n"
        "Rules:\n"
        "- Write only what the evidence clearly supports. If the evidence is confusing or contradictory, write a vague but coherent sentence that fits the surrounding context.\n"
        "- Never use quotation marks of any kind. Convert all dialogue into plain third-person description.\n"
        "- Never invent character names, locations, or events not mentioned in the evidence.\n"
        "- Never include meta-commentary, self-references, or anything that sounds like you are describing your own output.\n"
        "- Maintain continuity with the previous recap context.\n"
        "- Write in clear, punchy English. Output ONLY the recap sentences, nothing else.\n\n"
        f"Previous page recap context:\n{prev_context.strip() or '(none)'}\n\n"
        f"Page index: {page_idx}\n\n"
        f"Page narrative summary:\n{page_caption.strip() or '(none)'}\n\n"
        "Panel evidence:\n"
        + (evidence or "(none)")
        + "\n"
    )


def _panel_block(*, panel_idx: int, panel_id: str, scene_caption: str, transcript: str) -> str:
    transcript = (transcript or "").strip()
    if transcript:
        transcript = "\n".join(transcript.splitlines()[:25]).strip()
    return (
        f"[Panel {panel_idx:03d}] panel_id={panel_id or '(unknown)'}\n"
        f"Scene caption: {scene_caption.strip() or '(none)'}\n"
        f"Transcript (OCR):\n{transcript or '(none)'}\n"
    )


def _run_page_mode(
    *,
    args: argparse.Namespace,
    storyboard_path: Path,
    doc: dict[str, Any],
    out_root: Path,
) -> Path:
    final_root = storyboard_path.parent
    recap_pages_path = final_root / "recap_pages.json"
    recap_script_path = final_root / "recap_script.txt"

    if recap_pages_path.exists() and not args.overwrite:
        emit("progress", stage=3, message="recap_pages.json already exists; skipping (pass --overwrite).", percent=100)
        emit("complete", stage=3, recap_path=str(recap_pages_path))
        return recap_pages_path

    panels = doc.get("panels") or []
    panels_sorted: list[dict[str, Any]] = []
    for idx, panel in enumerate(panels):
        if isinstance(panel, dict):
            panel_copy = dict(panel)
            panel_copy["_order_idx"] = idx
            panels_sorted.append(panel_copy)
    panels_sorted.sort(key=lambda panel: _panel_sort_key(panel, int(panel.get("_order_idx") or 0)))

    by_page: dict[int, list[dict[str, Any]]] = {}
    for panel in panels_sorted:
        page_idx = panel.get("page_idx")
        if isinstance(page_idx, int):
            by_page.setdefault(int(page_idx), []).append(panel)

    page_indices = sorted(by_page.keys())
    if not page_indices:
        raise stage_failed("No page groups found in storyboard.panels.", {"reason": "Missing/invalid page_idx fields."})

    timeout = httpx.Timeout(float(max(5, int(args.ollama_timeout))))
    with httpx.Client(timeout=timeout) as client:
        if not _ensure_ollama_ready(client, args.ollama_host):
            raise stage_failed("Ollama is not running or reachable.", {"host": args.ollama_host})

        # Warm-up to encourage model load and keep-alive.
        try:
            _ollama_generate_text(
                client,
                host=args.ollama_host,
                model=args.ollama_model,
                prompt="",
                max_tokens=1,
                temperature=0.0,
                keep_alive=str(args.keep_alive),
            )
        except Exception:
            pass

        pages_out: list[dict[str, Any]] = []
        previous_recaps: list[str] = []
        total_pages = len(page_indices)

        for position, page_idx in enumerate(page_indices, start=1):
            percent = 5 + int((position / total_pages) * 90)
            emit(
                "progress",
                stage=3,
                message=f"Generating recap for page {position}/{total_pages} (page_idx={page_idx})...",
                percent=percent,
            )

            page_panels = by_page.get(page_idx) or []
            page_caption = _read_page_caption_from_sidecars(out_root=out_root, panels_for_page=page_panels)

            panel_blocks: list[str] = []
            used_panels: list[dict[str, Any]] = []
            for panel in page_panels:
                crop_rel = panel.get("crop_path")
                if not isinstance(crop_rel, str) or not crop_rel.strip():
                    continue
                crop_rel_norm = crop_rel.replace("\\", "/")
                match = _CROP_PATH_RE.search(crop_rel_norm)
                sub_idx = 0
                if match:
                    try:
                        sub_idx = int(match.group(2))
                    except Exception:
                        sub_idx = 0

                crop_path = out_root / crop_rel
                transcript = _read_transcript(crop_path.parent)
                scene_caption = panel.get("scene_caption") if isinstance(panel.get("scene_caption"), str) else ""
                panel_id = panel.get("panel_id") if isinstance(panel.get("panel_id"), str) else ""

                panel_blocks.append(
                    _panel_block(
                        panel_idx=sub_idx,
                        panel_id=panel_id,
                        scene_caption=scene_caption,
                        transcript=transcript,
                    )
                )
                used_panels.append({"sub_panel_idx": int(sub_idx), "panel_id": panel_id, "crop_path": crop_rel})

            used_panels.sort(key=lambda item: int(item.get("sub_panel_idx") or 0))
            panel_blocks.sort(
                key=lambda block: int(re.search(r"\[Panel (\d+)\]", block).group(1)) if re.search(r"\[Panel (\d+)\]", block) else 0
            )

            context_k = max(0, int(args.context_pages))
            prev_context = "\n\n".join([x for x in previous_recaps[-context_k:] if x.strip()]).strip() if context_k else ""

            prompt = _prompt_for_page(
                prev_context=prev_context,
                page_idx=int(page_idx),
                page_caption=page_caption,
                panel_blocks=panel_blocks,
                sentences_min=max(1, int(args.sentences_min)),
                sentences_max=max(max(1, int(args.sentences_min)), int(args.sentences_max)),
            )

            try:
                recap = _ollama_generate_text(
                    client,
                    host=args.ollama_host,
                    model=args.ollama_model,
                    prompt=prompt,
                    max_tokens=max(32, int(args.max_tokens)),
                    temperature=float(args.temperature),
                    keep_alive=str(args.keep_alive),
                )
            except Exception as exc:  # noqa: BLE001
                raise stage_failed(
                    "Failed to call Ollama for recap generation.",
                    {
                        "reason": str(exc),
                        "host": args.ollama_host,
                        "model": args.ollama_model,
                        "page_idx": int(page_idx),
                    },
                ) from exc

            recap = (recap or "").strip()
            pages_out.append({"page_idx": int(page_idx), "recap": recap, "panels": used_panels})
            if recap.strip():
                previous_recaps.append(recap.strip())

    raw_script = "\n\n".join([str(page.get("recap") or "").strip() for page in pages_out if str(page.get("recap") or "").strip()]).strip()
    recap_pages_path.write_text(
        json.dumps(
            {
                "mode": "page",
                "storyboard": str(storyboard_path),
                "provider": "ollama",
                "model": str(args.ollama_model),
                "generated_at": _now_utc_iso(),
                "raw_script": raw_script,
                "pages": pages_out,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    recap_script_path.write_text(raw_script + ("\n" if raw_script else ""), encoding="utf-8")

    emit("progress", stage=3, message="Stage 3 complete.", percent=100)
    emit("complete", stage=3, recap_path=str(recap_pages_path))
    return recap_pages_path


def _run_panel_mode(
    *,
    args: argparse.Namespace,
    storyboard_path: Path,
    doc: dict[str, Any],
    out_root: Path,
) -> Path:
    # Keep panel mode as a fallback/debug option.
    final_root = storyboard_path.parent
    recap_script_path = final_root / "recap_script.txt"
    panel_recaps_path = final_root / "panel_recaps.jsonl"

    panels = doc.get("panels") or []
    panels_sorted: list[dict[str, Any]] = []
    for idx, panel in enumerate(panels):
        if isinstance(panel, dict):
            panel_copy = dict(panel)
            panel_copy["_order_idx"] = idx
            panels_sorted.append(panel_copy)
    panels_sorted.sort(key=lambda panel: _panel_sort_key(panel, int(panel.get("_order_idx") or 0)))

    to_process: list[dict[str, Any]] = []
    for panel in panels_sorted:
        crop_rel = panel.get("crop_path")
        if not isinstance(crop_rel, str) or not crop_rel.strip():
            continue
        crop_path = out_root / crop_rel
        if not crop_path.exists():
            continue
        recap_path = crop_path.parent / "recap.txt"
        if recap_path.exists() and not args.overwrite:
            continue
        to_process.append(panel)

    timeout = httpx.Timeout(float(max(5, int(args.ollama_timeout))))
    with httpx.Client(timeout=timeout) as client:
        if not _ensure_ollama_ready(client, args.ollama_host):
            raise stage_failed("Ollama is not running or reachable.", {"host": args.ollama_host})

        total = max(1, len(to_process))
        generated: list[dict[str, Any]] = []
        for index, panel in enumerate(panels_sorted, start=1):
            crop_rel = panel.get("crop_path")
            if not isinstance(crop_rel, str) or not crop_rel.strip():
                continue
            crop_path = out_root / crop_rel
            if not crop_path.exists():
                continue

            panel_dir = crop_path.parent
            recap_txt_path = panel_dir / "recap.txt"
            if recap_txt_path.exists() and not args.overwrite:
                existing = _read_text(recap_txt_path).strip()
                if existing:
                    generated.append({"panel_id": panel.get("panel_id", ""), "crop_path": crop_rel, "recap": existing})
                continue

            percent = 5 + int((min(index, total) / total) * 90)
            emit("progress", stage=3, message=f"Generating recap for panel {index}/{total}...", percent=percent)

            panel_id = panel.get("panel_id") if isinstance(panel.get("panel_id"), str) else ""
            scene_caption = panel.get("scene_caption") if isinstance(panel.get("scene_caption"), str) else ""
            transcript = _read_transcript(panel_dir)
            prompt = (
                "You are a manga narrator. Write 1-3 sentences describing what happens in this panel.\n"
                "Rules: use ONLY the provided evidence, paraphrase dialogue, output ONLY the recap text.\n\n"
                f"panel_id: {panel_id or '(unknown)'}\n"
                f"Scene caption: {scene_caption.strip() or '(none)'}\n"
                f"Transcript (OCR):\n{transcript.strip() or '(none)'}\n"
            )

            try:
                recap = _ollama_generate_text(
                    client,
                    host=args.ollama_host,
                    model=args.ollama_model,
                    prompt=prompt,
                    max_tokens=max(32, int(args.max_tokens)),
                    temperature=float(args.temperature),
                    keep_alive=str(args.keep_alive),
                )
            except Exception as exc:  # noqa: BLE001
                recap = f"ERROR: {exc}"

            recap = (recap or "").strip()
            recap_txt_path.write_text(recap + ("\n" if recap else ""), encoding="utf-8")
            (panel_dir / "recap.json").write_text(
                json.dumps(
                    {
                        "panel_id": panel_id,
                        "crop_path": crop_rel,
                        "recap": recap,
                        "provider": "ollama",
                        "model": str(args.ollama_model),
                        "generated_at": _now_utc_iso(),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            generated.append({"panel_id": panel_id, "crop_path": crop_rel, "recap": recap})

    script = "\n\n".join([str(item.get("recap") or "").strip() for item in generated if str(item.get("recap") or "").strip()]).strip()
    recap_script_path.write_text(script + ("\n" if script else ""), encoding="utf-8")
    panel_recaps_path.write_text(
        "\n".join([json.dumps(item, ensure_ascii=False) for item in generated]).strip() + ("\n" if generated else ""),
        encoding="utf-8",
    )

    emit("progress", stage=3, message="Stage 3 complete.", percent=100)
    emit("complete", stage=3, recap_path=str(panel_recaps_path))
    return panel_recaps_path


def _run_stage() -> None:
    args = parse_args()
    storyboard_path = Path(args.storyboard).expanduser()
    doc = _read_storyboard(storyboard_path)
    final_root = storyboard_path.parent
    out_root = final_root.parent

    emit("progress", stage=3, message="Preparing recap generation...", percent=1)
    if args.mode == "panel":
        _run_panel_mode(args=args, storyboard_path=storyboard_path, doc=doc, out_root=out_root)
        return
    _run_page_mode(args=args, storyboard_path=storyboard_path, doc=doc, out_root=out_root)


def main() -> None:
    raise SystemExit(run_with_error_boundary(3, _run_stage))


if __name__ == "__main__":
    main()
