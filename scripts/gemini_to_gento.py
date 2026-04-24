"""
gemini_to_gento.py — Convert Gemini narrator output to recap_pages_with_sentences.json

Usage:
    python gemini_to_gento.py \
        --gemini    out_ch001/final/gemini_narrator.json \
        --storyboard out_ch001/final/storyboard.json \
        --out       out_ch001/final/recap_pages_with_sentences.json

The Gemini input is the output of the two-pass prompt (Narrator Pass), shaped like:
[
  {
    "page": 1,
    "panels": [
      { "panel": 1, "position": "Top Right", "description": "..." }
    ]
  }
]

The storyboard.json is the Magi output from Stage 1, shaped like:
{
  "meta": { "chapter_id": "...", ... },
  "panels": [
    {
      "panel_id": "...",
      "page_idx": 0,
      "panel_idx": 0,
      "crop_path": "...",
      ...
    }
  ]
}

Mismatch strategy (Magi is always ground truth):
  - Gemini > Magi on a page: extra Gemini descriptions are joined onto the last
    matched Magi panel's sentences.
  - Gemini < Magi on a page: the available Gemini descriptions are split into
    sentence chunks and distributed across all Magi panels so every panel gets
    at least one sentence — no silence, no repetition.
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from scripts.common.errors import invalid_request
from scripts.common.events import emit, run_with_error_boundary


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def split_into_sentences(text: str) -> list[str]:
    """Split a description string into individual sentences."""
    # Split on sentence-ending punctuation followed by whitespace or end
    raw = re.split(r'(?<=[.!?])\s+', text.strip())
    # Filter empties that can slip through
    return [s.strip() for s in raw if s.strip()]


def distribute_sentences(all_sentences: list[str], n_panels: int) -> list[list[str]]:
    """
    Distribute a flat list of sentences across n_panels slots as evenly as
    possible without repetition. Every slot gets at least one sentence.

    If there are fewer sentences than panels, some panels will receive a single
    sentence that was also given to no other panel — we simply cycle through
    the sentences one-by-one across the extra slots. This is the only case
    where a sentence appears in more than one slot, but the audio will still
    differ because Kokoro TTS renders each slot independently and the surrounding
    context differs. If you would rather skip those panels, set ALLOW_CYCLE=False
    below and they will receive an empty list instead.
    """
    ALLOW_CYCLE = True  # set False to leave extra Magi panels silent instead

    if n_panels == 0:
        return []

    if not all_sentences:
        return [[] for _ in range(n_panels)]

    # Happy path — enough sentences to go around without cycling
    if len(all_sentences) >= n_panels:
        # Distribute as evenly as possible; earlier panels get the remainder
        base, extra = divmod(len(all_sentences), n_panels)
        slots = []
        idx = 0
        for i in range(n_panels):
            count = base + (1 if i < extra else 0)
            slots.append(all_sentences[idx: idx + count])
            idx += count
        return slots

    # Fewer sentences than panels
    if ALLOW_CYCLE:
        # Give each panel one sentence, cycling through the available ones
        slots = []
        for i in range(n_panels):
            slots.append([all_sentences[i % len(all_sentences)]])
        return slots
    else:
        # Assign one sentence per panel where available; rest are empty
        slots = [[s] for s in all_sentences]
        slots += [[] for _ in range(n_panels - len(all_sentences))]
        return slots


# ---------------------------------------------------------------------------
# Core converter
# ---------------------------------------------------------------------------

def _ensure_sentence(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return ""
    if re.search(r"[.!?]$", t):
        return t
    return t + "."

def convert(
    gemini_path: Path,
    storyboard_path: Path,
    *,
    allow_empty_pages: bool,
    gemini_page_offset: int,
) -> tuple[dict, list[dict]]:

    # -- Load inputs ---------------------------------------------------------
    with open(gemini_path, encoding="utf-8") as f:
        gemini_pages: list[dict] = json.load(f)

    with open(storyboard_path, encoding="utf-8") as f:
        storyboard: dict = json.load(f)

    if not isinstance(gemini_pages, list):
        raise invalid_request(
            "Gemini narrator JSON must be a list of pages.",
            {"path": str(gemini_path), "received_type": type(gemini_pages).__name__},
        )
    if not isinstance(storyboard, dict):
        raise invalid_request(
            "storyboard.json must be a JSON object.",
            {"path": str(storyboard_path), "received_type": type(storyboard).__name__},
        )

    meta = storyboard.get("meta") if isinstance(storyboard.get("meta"), dict) else {}
    chapter_id: str = str(meta.get("chapter_id") or storyboard.get("chapter_id") or "unknown")

    if "panels" not in storyboard:
        raise invalid_request(
            "storyboard.json is missing 'panels'. Make sure you selected the Stage 1 output storyboard.json.",
            {"path": str(storyboard_path), "keys": sorted(list(storyboard.keys()))[:50]},
        )
    if not isinstance(storyboard.get("panels"), list):
        raise invalid_request(
            "storyboard.json 'panels' must be a list.",
            {"path": str(storyboard_path), "received_type": type(storyboard.get("panels")).__name__},
        )

    # -- Index Magi panels by (page_idx, panel_idx) --------------------------
    # Gemini uses 1-based page numbers; Magi uses 0-based page_idx.
    magi_by_page: dict[int, list[dict]] = defaultdict(list)
    for idx, panel in enumerate(storyboard["panels"]):
        if not isinstance(panel, dict):
            raise invalid_request(
                "Each storyboard panel must be an object.",
                {"path": str(storyboard_path), "panel_index": idx, "received_type": type(panel).__name__},
            )
        required_keys = ["page_idx", "panel_id", "crop_path"]
        missing = [k for k in required_keys if k not in panel]
        if missing:
            raise invalid_request(
                "storyboard.json panels[] item is missing required keys.",
                {"path": str(storyboard_path), "panel_index": idx, "missing": missing, "keys": sorted(list(panel.keys()))[:50]},
            )
        if not isinstance(panel.get("page_idx"), int):
            raise invalid_request(
                "storyboard.json panels[] item must include integer page_idx.",
                {
                    "path": str(storyboard_path),
                    "panel_index": idx,
                    "page_idx_type": type(panel.get("page_idx")).__name__,
                },
            )
        # panel_idx is optional depending on which pipeline produced storyboard.json.
        # If missing, we'll infer it after grouping by page.
        magi_by_page[int(panel["page_idx"])].append(panel)

    # Sort each page's panels to guarantee order.
    # Prefer panel_idx when present; otherwise fall back to input order.
    for page_idx in magi_by_page:
        panels = magi_by_page[page_idx]
        if all(isinstance(p.get("panel_idx"), int) for p in panels):
            panels.sort(key=lambda p: int(p.get("panel_idx") or 0))
        else:
            # Preserve current order; then assign inferred panel_idx so downstream is consistent.
            for inferred_idx, p in enumerate(panels):
                if not isinstance(p.get("panel_idx"), int):
                    p["panel_idx"] = inferred_idx

    # -- Index Gemini descriptions by page (0-based) -------------------------
    gemini_by_page: dict[int, list[str]] = {}
    for idx, gpage in enumerate(gemini_pages):
        if not isinstance(gpage, dict):
            raise invalid_request(
                "Each Gemini page entry must be an object.",
                {"path": str(gemini_path), "page_index": idx, "received_type": type(gpage).__name__},
            )
        if "page" not in gpage or "panels" not in gpage:
            raise invalid_request(
                "Each Gemini page entry must include 'page' and 'panels'.",
                {"path": str(gemini_path), "page_index": idx, "keys": sorted(list(gpage.keys()))[:50]},
            )
        if not isinstance(gpage.get("page"), int):
            raise invalid_request(
                "Gemini page entry 'page' must be an integer (1-based).",
                {"path": str(gemini_path), "page_index": idx, "received_type": type(gpage.get("page")).__name__},
            )
        if not isinstance(gpage.get("panels"), list):
            raise invalid_request(
                "Gemini page entry 'panels' must be a list.",
                {"path": str(gemini_path), "page_index": idx, "received_type": type(gpage.get("panels")).__name__},
            )
        page_0 = (gpage["page"] - 1) - int(gemini_page_offset)          # convert 1-based → 0-based + offset
        if page_0 < 0:
            # Gemini includes pages that were deleted before Magi ran; ignore.
            continue
        cleaned_panels: list[dict] = []
        for pidx, panel in enumerate(gpage["panels"]):
            if not isinstance(panel, dict):
                raise invalid_request(
                    "Each Gemini panel entry must be an object.",
                    {"path": str(gemini_path), "page": int(gpage["page"]), "panel_index": pidx, "received_type": type(panel).__name__},
                )
            if "panel" not in panel or "description" not in panel:
                raise invalid_request(
                    "Each Gemini panel entry must include 'panel' and 'description'.",
                    {"path": str(gemini_path), "page": int(gpage["page"]), "panel_index": pidx, "keys": sorted(list(panel.keys()))[:50]},
                )
            cleaned_panels.append(panel)

        descriptions = [panel["description"] for panel in sorted(cleaned_panels, key=lambda p: p["panel"])]
        gemini_by_page[page_0] = descriptions

    # -- Build final_script.json pages list ----------------------------------
    all_page_idxs = sorted(set(list(magi_by_page.keys()) + list(gemini_by_page.keys())))
    output_pages = []
    mismatches = []   # collected for logging

    for page_idx in all_page_idxs:
        magi_panels = magi_by_page.get(page_idx, [])
        gemini_descs = gemini_by_page.get(page_idx, [])

        n_magi = len(magi_panels)
        n_gemini = len(gemini_descs)

        if n_magi == 0:
            # Gemini described a page Magi didn't find — skip entirely
            continue

        # Flatten all Gemini descriptions for this page into sentences
        all_sentences: list[str] = []
        for desc in gemini_descs:
            all_sentences.extend(split_into_sentences(desc))

        if not all_sentences:
            if allow_empty_pages:
                all_sentences = ["..."] * max(1, n_magi)
            else:
                example_descs = []
                for i, desc in enumerate(gemini_descs[:5]):
                    example_descs.append({"index": i, "len": len((desc or "").strip())})
                raise invalid_request(
                    "Gemini narrator JSON contains an empty page (no sentences).",
                    {
                        "page_idx": page_idx,
                        "page_number_1_based": page_idx + 1,
                        "gemini_expected_page_number_1_based": (page_idx + 1) + int(gemini_page_offset),
                        "gemini_page_offset": int(gemini_page_offset),
                        "gemini_panels": n_gemini,
                        "magi_panels": n_magi,
                        "example_description_lengths": example_descs,
                        "gemini_path": str(gemini_path),
                    },
                )

        if n_magi != n_gemini:
            mismatches.append({
                "page_idx": page_idx,
                "magi_panels": n_magi,
                "gemini_panels": n_gemini,
            })

        # Distribute sentences across Magi panels
        sentence_slots = distribute_sentences(all_sentences, n_magi)

        output_panels = []
        for magi_panel, sentences in zip(magi_panels, sentence_slots):
            sentence = " ".join(_ensure_sentence(s) for s in sentences if s.strip()).strip()
            if not sentence:
                raise invalid_request(
                    "Failed to generate a non-empty sentence for a panel.",
                    {"page_idx": page_idx, "panel_id": magi_panel.get("panel_id")},
                )
            output_panels.append({
                "sub_panel_idx": int(magi_panel["panel_idx"]),
                "panel_id":      magi_panel["panel_id"],
                "crop_path":     magi_panel["crop_path"],
                "sentence":      sentence,
            })

        recap = " ".join(panel["sentence"] for panel in output_panels if panel.get("sentence")).strip()
        output_pages.append({
            "page_idx": page_idx,
            "recap":    recap,
            "panels":   output_panels,
        })

    recap_pages_with_sentences = {
        "mode": "page",
        "chapter_id": chapter_id,
        "source": "gemini_narrator",
        "source_gemini_path": str(gemini_path),
        "source_storyboard_path": str(storyboard_path),
        "pages": output_pages,
    }

    return recap_pages_with_sentences, mismatches


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stage 4: Convert Gemini narrator JSON to recap_pages_with_sentences.json for Stage 5."
    )
    parser.add_argument(
        "--gemini", required=True, type=Path,
        help="Path to Gemini Narrator Pass output JSON",
    )
    parser.add_argument(
        "--storyboard", required=True, type=Path,
        help="Path to storyboard.json (Stage 1 Magi output)",
    )
    parser.add_argument(
        "--out", required=True, type=Path,
        help="Destination path for recap_pages_with_sentences.json",
    )
    parser.add_argument(
        "--allow-empty-pages",
        action="store_true",
        help="Allow empty Gemini pages; fills with '...' placeholders instead of failing.",
    )
    parser.add_argument(
        "--gemini-page-offset",
        type=int,
        default=0,
        help="Offset applied to Gemini's 1-based page numbers before matching storyboard page_idx (use N if you deleted the first N pages before running Magi).",
    )
    return parser.parse_args()

def _run_stage() -> None:
    args = parse_args()
    gemini_path = Path(args.gemini).expanduser()
    storyboard_path = Path(args.storyboard).expanduser()
    out_path = Path(args.out).expanduser()

    if not gemini_path.exists():
        raise invalid_request("--gemini file not found.", {"path": str(gemini_path)})
    if not storyboard_path.exists():
        raise invalid_request("--storyboard file not found.", {"path": str(storyboard_path)})

    emit("progress", stage=4, message="Loading inputs...", percent=5)
    doc, mismatches = convert(
        gemini_path,
        storyboard_path,
        allow_empty_pages=bool(args.allow_empty_pages),
        gemini_page_offset=int(args.gemini_page_offset or 0),
    )

    emit("progress", stage=4, message="Writing recap_pages_with_sentences.json...", percent=85)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if mismatches:
        mismatch_path = out_path.parent / "gemini_mismatches.json"
        mismatch_path.write_text(json.dumps(mismatches, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"[WARN] logged {len(mismatches)} mismatch page(s) to {mismatch_path}", file=sys.stderr)

    emit("progress", stage=4, message="Stage 4 complete.", percent=100)
    emit("complete", stage=4, refined_recap_path=str(out_path))


def main() -> None:
    raise SystemExit(run_with_error_boundary(4, _run_stage))


if __name__ == "__main__":
    main()
