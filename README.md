# Gento — Manga-to-Video Desktop App

## Full System Architecture Guide

> This document is the single source of truth for building the Gento system. It covers every component, stage, data contract, and integration point. Hand this to any AI coding assistant to implement any part of the system.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Tech Stack](#2-tech-stack)
3. [Repository Structure](#3-repository-structure)
4. [Data Contracts](#4-data-contracts)
5. [Stage-by-Stage Breakdown](#5-stage-by-stage-breakdown)
   - [Stage 0 — Download](#stage-0--download)
   - [Stage 1 — Panel Extraction](#stage-1--panel-extraction)
   - [Stage 2 — Scene Enrichment](#stage-2--scene-enrichment)
   - [Stage 3 — Narrative Recap](#stage-3--narrative-recap)
   - [Stage 4 — Script Refinement (Claude API)](#stage-4--script-refinement-claude-api)
   - [Stage 5 — Audio Generation](#stage-5--audio-generation)
   - [Stage 6 — Video Render](#stage-6--video-render)
6. [Electron Application Architecture](#6-electron-application-architecture)
7. [Python ↔ Electron Bridge](#7-python--electron-bridge)
8. [Local AI Setup (Ollama)](#8-local-ai-setup-ollama)
9. [UI Layout & Navigation](#9-ui-layout--navigation)
10. [Error Handling & Resilience](#10-error-handling--resilience)
11. [Cross-Platform Considerations](#11-cross-platform-considerations)
12. [Prerequisites & First-Run Check](#12-prerequisites--first-run-check)
13. [Environment & Configuration](#13-environment--configuration)
14. [Implementation Order](#14-implementation-order)

---

## 1. System Overview

Gento is a cross-platform desktop application (Windows, macOS, Linux) that takes a MangaBuddy.com manga URL and produces a narrated `.mp4` video recap of a chapter — entirely on the user's local machine, with one step assisted by the Claude API for script refinement.

### End-to-End Flow

```
MangaBuddy URL
      │
      ▼
[Stage 0] Download raw page images
      │  Output: /downloads/<manga>/<chapter>/page_N.jpg
      ▼
[Stage 1] Magi CV model — panel extraction, OCR, character detection
      │  Output: storyboard.json (empty scene fields) + panel.png crops
      ▼
[Stage 2] llava-phi3 via Ollama — scene captioning & tagging
      │  Output: storyboard.json (scene_caption + scene_tags filled)
      ▼
[Stage 3] Gemma3:4b via Ollama — narrative recap generation
      │  Output: recap_script.txt, recap_pages.json, panel_recaps.jsonl
      ▼
[Stage 4] Claude API — script refinement + user review screen
      │  Output: final_script.json (structured, sentence-level)
      ▼
[Stage 5] Kokoro TTS — audio generation
      │  Output: final/audio/*.wav + timing metadata in script JSON
      ▼
[Stage 6] Electron + ffmpeg — video render
         Output: out_ch001/final/video.mp4
```

### Key Design Principles

- **Filesystem as the message bus.** Stages communicate through files, not sockets or queues. `storyboard.json` is the central artefact enriched by each stage.
- **No database.** The project does not use any database. All state lives on disk in JSON/image files.
- **Fully local AI.** Stages 1–3 and Stage 5 run entirely offline via Ollama and bundled models. No data leaves the machine except for the single Claude API call in Stage 4.
- **Single Electron window.** The entire pipeline is controlled from one desktop UI. Every Python stage is spawned as a child process from Electron's main process.
- **Resumable.** Each stage checks for existing outputs and skips completed work unless `--overwrite` is passed.

---

## 2. Tech Stack

| Layer                      | Technology                                                |
| -------------------------- | --------------------------------------------------------- |
| Desktop shell              | Electron (Node.js)                                        |
| UI renderer                | Next.js + Shadcn                                          |
| Pipeline logic             | Python 3.10+                                              |
| CV / OCR model             | `ragavsachdeva/magiv3` via Hugging Face Transformers      |
| Local LLM (scenes + recap) | Gemma3:4b via Ollama                                      |
| Script refinement          | Claude API (`claude-sonnet-4-20250514`) via Anthropic SDK |
| Text-to-speech             | Kokoro TTS (local)                                        |
| Video stitching            | ffmpeg (system install or bundled binary)                 |
| HTTP scraping              | Python `httpx` (async)                                    |
| HTML parsing               | Python `BeautifulSoup4`                                   |
| Image processing           | Python `Pillow`                                           |

---

## 3. Repository Structure

```
magi/
├── electron/
│   ├── main.js                  # Electron main process — spawns Python, IPC
│   ├── preload.js               # Context bridge — exposes safe IPC to renderer
│   └── renderer/
│       ├── index.html           # Single page shell
│       ├── app.js               # UI logic, stage orchestration
│       └── styles.css
│
├── scripts/                     # Python pipeline stages
│   ├── downloader/
│   │   ├── scraper.py           # MangaBuddy scraping
│   │   ├── download.py          # Async image downloader
│   │   └── converter.py         # PDF / CBZ output (optional)
│   ├── extract_chapter.py       # Stage 1 — Magi panel extraction
│   ├── add_scenes.py            # Stage 2 — Scene captioning
│   ├── make_panel_recaps.py     # Stage 3 — Narrative recap
│   ├── refine_script.py         # Stage 4 — Claude API refinement
│   └── generate_audio.py        # Stage 5 — Kokoro TTS
│
├── video-generation/            # Stage 6 — Electron-native video renderer
│   └── renderer/                # HTML UI for preview + ffmpeg export
│
├── spec/
│   └── storyboard.schema.json   # Canonical schema for storyboard.json
│
├── config/
│   └── defaults.json            # Default settings (paths, model names, etc.)
│
├── examples/
│   └── magiv3_demo.py           # Magi model loader helper (do not modify)
│
├── requirements.txt             # Python dependencies
├── package.json                 # Electron / Node dependencies
└── README.md
```

---

## 4. Data Contracts

### 4.1 `storyboard.json` — Central Artefact

This file is created in Stage 1 and progressively enriched through Stages 2, 3, and 4. Its location is always `<output_dir>/final/storyboard.json`.

```json
{
  "meta": {
    "version": "1.0",
    "chapter_id": "chapter_1",
    "created_at": "2025-01-01T00:00:00Z",
    "source_images": ["page_001.jpg", "page_002.jpg"]
  },
  "panels": [
    {
      "panel_id": "chapter_1_p001_n00_a3f9bc1234",
      "page_idx": 0,
      "panel_idx": 0,
      "bbox": [x1, y1, x2, y2],
      "crop_path": "final/pages/000/panels/000/panel.png",
      "ocr_lines": [
        {
          "text": "Hello!",
          "bbox": [x1, y1, x2, y2],
          "speaker": "char_0",
          "is_essential": true
        }
      ],
      "scene_caption": "",        // filled by Stage 2
      "scene_tags": [],           // filled by Stage 2
      "recap": "",                // filled by Stage 3
      "script_sentences": [],     // filled by Stage 4
      "audio_path": "",           // filled by Stage 5
      "start_ms": null,           // filled by Stage 5
      "end_ms": null              // filled by Stage 5
    }
  ]
}
```

**Panel ID format:** `ch{chapter}_p{page_idx}_n{panel_idx}_{sha256_hash_10chars}`

IDs must remain stable across re-runs. Never regenerate IDs from existing crops.

### 4.2 `final_script.json` — Stage 4 Output

Produced by the Claude refinement step. This is what Stage 5 reads.

```json
{
  "chapter_id": "chapter_1",
  "refined_at": "2025-01-01T00:00:00Z",
  "pages": [
    {
      "page_idx": 0,
      "panels": [
        {
          "panel_id": "chapter_1_p001_n00_a3f9bc1234",
          "crop_path": "final/pages/000/panels/000/panel.png",
          "sentences": [
            "The hero stands at the edge of the cliff, scanning the horizon.",
            "A figure emerges from the shadows below."
          ]
        }
      ]
    }
  ],
  "raw_script": "Full concatenated script text for reference..."
}
```

### 4.3 Filesystem Layout per Chapter

```
<output_dir>/                        e.g. out_ch001/
└── final/
    ├── storyboard.json              Central artefact
    ├── recap_script.txt             Stage 3 raw output (human-readable)
    ├── recap_pages.json             Stage 3 structured output
    ├── panel_recaps.jsonl           Stage 3 per-panel output
    ├── final_script.json            Stage 4 Claude-refined script
    ├── video.mp4                    Stage 6 final output
    ├── audio/
    │   ├── panel_000.wav
    │   ├── panel_001.wav
    │   └── stitched.wav
    └── pages/
        └── 000/                     Page index (zero-padded)
            └── panels/
                └── 000/             Panel index (zero-padded)
                    ├── panel.png
                    ├── panel.json
                    ├── transcript.txt
                    ├── transcript.json
                    ├── scene.txt    (Stage 2)
                    ├── scene.json   (Stage 2)
                    ├── recap.txt    (Stage 3)
                    └── recap.json   (Stage 3)
```

---

## 5. Stage-by-Stage Breakdown

---

### Stage 0 — Download

**File:** `scripts/downloader/scraper.py` + `scripts/downloader/download.py`

**Purpose:** Scrape a MangaBuddy chapter URL and download all page images to disk.

**Input:** MangaBuddy chapter URL (string from UI)

**Output:** Directory of page images at `downloads/<manga_title>/<chapter_title>/page_N.jpg`

#### How It Works

1. Fetch the series page HTML via `httpx`. Parse with `BeautifulSoup4`.
2. Extract the `bookId` from embedded JavaScript: `var bookId = ...;`
3. Call MangaBuddy's internal API with the `bookId` to get the full chapter list.
4. For the selected chapter, fetch the chapter page HTML and extract image URLs from the `var chapImages` JS array using regex.
5. Download all images concurrently using `asyncio` + `httpx`.
   - Concurrency controlled by `asyncio.Semaphore(MAX_IMAGE_THREADS)` (default: 10).
   - Retry loop with exponential backoff on failure (`RETRY_ATTEMPTS` = 3).
6. Save images as `page_001.jpg`, `page_002.jpg`, etc. (1-indexed, zero-padded to 3 digits).

#### Config

```python
MAX_IMAGE_THREADS = 10
HTTP_TIMEOUT = 20          # seconds
DOWNLOAD_PATH = "./downloads"
RETRY_ATTEMPTS = 3
```

#### IPC Events (sent to Electron)

```
stage:progress  { stage: 0, message: "Downloading page 3/24", percent: 12 }
stage:complete  { stage: 0, output_dir: "/path/to/downloads/manga/chapter" }
stage:error     { stage: 0, message: "Error text" }
```

---

### Stage 1 — Panel Extraction

**File:** `scripts/extract_chapter.py`

**Purpose:** Run the Magi CV model over raw page images to detect panels, OCR text, and character associations. Crop individual panels and write the base `storyboard.json`.

**Input:** Directory of page images (from Stage 0 output)

**CLI:**

```bash
python scripts/extract_chapter.py \
  --chapter-id chapter_1 \
  --images /path/to/pages/ \
  --out out_ch001/ \
  --device cpu \
  --model ragavsachdeva/magiv3
```

**Output:**

- `out_ch001/final/storyboard.json` (panels list, empty scene fields)
- `out_ch001/final/pages/NNN/panels/NNN/panel.png`
- `out_ch001/final/pages/NNN/panels/NNN/transcript.txt`
- `out_ch001/final/pages/NNN/panels/NNN/transcript.json`
- `out_ch001/final/pages/NNN/panels/NNN/panel.json`

#### Model Details

- Model: `ragavsachdeva/magiv3` (Hugging Face)
- Loader: `AutoModelForCausalLM` + `AutoProcessor`
- Device options: `cpu`, `mps` (Apple Silicon), `cuda` (NVIDIA GPU)
- Offline mode: set `HF_HUB_OFFLINE=1` if `--allow-downloads` is not passed

#### Processing Steps Per Page

1. `model.predict_detections_and_associations()` — detects panels, characters, speech bubbles, and their associations.
2. `model.predict_ocr()` — extracts text content and bounding boxes.
3. For each detected panel bounding box:
   - Clamp coordinates to image dimensions.
   - Crop with Pillow.
   - Generate `panel_id` from SHA256 hash of cropped image bytes (first 10 chars).
   - Assign OCR text to panel if text center point falls within panel bbox.
   - Save `panel.png`, `transcript.txt`, `transcript.json`, `panel.json`.
4. Accumulate all panel metadata into `storyboard.json`.

#### Notes

- Panels are sorted top-to-bottom, left-to-right per page (reading order).
- `scene_caption`, `scene_tags`, `recap`, `script_sentences` fields are left empty — filled by later stages.
- The `--debug` flag writes annotated overlay images and raw JSON to `out/debug/` — useful during development.

#### IPC Events

```
stage:progress  { stage: 1, message: "Processing page 5/24", percent: 20 }
stage:complete  { stage: 1, storyboard_path: "out_ch001/final/storyboard.json" }
stage:error     { stage: 1, message: "Error text" }
```

---

### Stage 2 — Scene Enrichment

**File:** `scripts/add_scenes.py`

**Purpose:** Use a local vision-language model to look at each cropped panel image and generate a natural language caption and semantic tags describing what is happening.

**Input:** `storyboard.json` from Stage 1

**CLI:**

```bash
python scripts/add_scenes.py \
  out_ch001/final/storyboard.json \
  --scene-provider ollama \
  --ollama-model gemma3:4b \
  --ollama-host http://localhost:11434 \
  --max-image-dim 1280 \
  --chapter-context "Shounen action manga. Protagonist has spiky black hair."
```

**Output:**

- `storyboard.json` updated in-place with `scene_caption` and `scene_tags` per panel
- `scene.txt` and `scene.json` written next to each `panel.png`

#### How It Works

1. Load `storyboard.json`. Identify panels with empty `scene_caption`.
2. For each panel (one at a time for local Ollama):
   - Load `panel.png` as base64.
   - Send to Ollama with a structured prompt requesting JSON: `{ "caption": "...", "tags": ["action", "dialogue", ...] }`
   - Make a second text-only call to extract structured tags from the caption (avoids re-processing the image).
3. Write `scene.txt` and `scene.json` alongside the panel.
4. Update `storyboard.json` with filled fields.

#### Ollama Prompt (Scene Caption)

```
System: You are a manga scene analyst. Given a panel image, describe what is happening in 1-2 sentences. Focus on: character actions, emotions, and visual narrative. Return only valid JSON: {"caption": "...", "tags": ["..."]}

Context: {chapter_context}
Character hints: {character_hints}
```

#### Notes

- The `--overwrite` flag forces regeneration of existing captions.
- The `--cache` flag enables on-disk JSON caching to skip already-processed panels across runs.
- Character hints are auto-extracted from the storyboard (maps `char_0`, `char_1`, etc. to dialogue context).

#### IPC Events

```
stage:progress  { stage: 2, message: "Captioning panel 12/87", percent: 13 }
stage:complete  { stage: 2, storyboard_path: "out_ch001/final/storyboard.json" }
stage:error     { stage: 2, message: "Error text" }
```

---

### Stage 3 — Narrative Recap

**File:** `scripts/make_panel_recaps.py`

**Purpose:** Generate a flowing narrative recap of the chapter by analyzing panels in chronological reading order. Uses the local LLM as a narrator.

**Input:** `storyboard.json` from Stage 2 (with scene captions filled)

**CLI:**

```bash
python scripts/make_panel_recaps.py \
  out_ch001/final/storyboard.json \
  --mode page \
  --ollama-model gemma3:4b \
  --ollama-host http://localhost:11434 \
  --sentences-min 2 \
  --sentences-max 4 \
  --context-panels 3
```

**Output (page mode):**

- `out_ch001/final/recap_pages.json` — structured per-page recaps with panel references
- `out_ch001/final/recap_script.txt` — full human-readable script (raw draft)

**Output (panel mode):**

- `out_ch001/final/panel_recaps.jsonl` — per-panel recap
- `recap.txt` and `recap.json` written next to each `panel.png`

#### Mode: Page (Recommended)

Groups all panels from a page together. Sends all sub-panel crops + their captions/transcripts to the model in a single prompt. Generates a 2–4 sentence unified summary of the page.

This mode produces better narrative flow since the model sees the whole page at once.

#### How It Works

1. Load and strictly sort panels by `page_idx` → `panel_idx`.
2. Warm up Ollama by hitting `/api/generate` with an empty prompt (loads model into VRAM).
3. For each page:
   - Assemble all panel images + captions + OCR transcripts for that page.
   - Prepend the recap of the previous page as continuity context.
   - Call Ollama with the multimodal prompt.
   - Save result to `recap_pages.json`.

#### Narrator Prompt

```
System: You are a manga narrator writing a YouTube video script. Narrate what happens across these panels in {min}–{max} sentences. Rules: paraphrase dialogue (never quote directly), stay faithful to the visual evidence, maintain narrative continuity from the previous page recap.

Previous page recap: {previous_recap}

Page panels:
[Sub-panel 00] Caption: {caption}. Transcript: {transcript}
[Sub-panel 01] Caption: {caption}. Transcript: {transcript}
...
```

#### IPC Events

```
stage:progress  { stage: 3, message: "Narrating page 8/24", percent: 33 }
stage:complete  { stage: 3, recap_path: "out_ch001/final/recap_pages.json" }
stage:error     { stage: 3, message: "Error text" }
```

---

### Stage 4 — Script Refinement (Claude / Gemini API)

**File:** `scripts/refine_script.py`

**Purpose:** Convert the Stage 3 recap into **one narration sentence per panel**, keeping strict alignment with the extracted panel list.

**Input:** `output/final/recap_pages.json` (from Stage 3)

**Output:** `output/final/recap_pages_with_sentences.json`

#### What Stage 4 Produces

Stage 4 writes a JSON doc with the same pages/panels as Stage 3, but adds a `sentence` field per panel:

```json
{
  "mode": "page",
  "pages": [
    {
      "page_idx": 0,
      "recap": "Page-level recap from Stage 3...",
      "panels": [
        {
          "sub_panel_idx": 0,
          "panel_id": "p000_s00",
          "crop_path": "output/panels/p000/s00/crop.png",
          "sentence": "One narration sentence for this panel."
        }
      ]
    }
  ]
}
```

#### How It Works

1. Load `recap_pages.json` and sort pages by `page_idx`.
2. For each page, build a prompt that includes:
   - the page recap
   - per-panel evidence (scene captions if available + OCR transcript sidecars when present)
3. Call the selected provider:
   - **Anthropic** (`--provider anthropic`) using `ANTHROPIC_API_KEY`
   - **Gemini** (`--provider gemini`) using `GEMINI_API_KEY` or `GOOGLE_API_KEY`
4. Validate provider JSON output and coerce it to **exactly one sentence per panel** (trim/pad as needed).
5. Write `recap_pages_with_sentences.json` alongside the input recap.

#### UI Flow for Stage 4

The Electron UI provides:

1. Run Stage 4 (Claude/Gemini) to generate `recap_pages_with_sentences.json`.
2. Manual import mode to **upload a pre-made** `recap_pages_with_sentences.json` (must match the schema above).

#### IPC Events

```
stage:progress  { stage: 4, message: "Refining page 8/24...", percent: 33 }
stage:complete  { stage: 4, refined_recap_path: "output/final/recap_pages_with_sentences.json" }
stage:error     { stage: 4, message: "Error text" }
```

#### Environment Variables Required

Anthropic:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Gemini:

```
GEMINI_API_KEY=...
```

or

```
GOOGLE_API_KEY=...
```

Set in `config/defaults.json` or via the Settings screen in the UI.

---

### (Electron UI) Stage 2 — Gemini Transcriber + Narrator

**Purpose:** Automatically call Gemini on the **full page images** from `output/final/storyboard.json` using the combined “Transcriber + Narrator” prompt and write the narrator JSON output to a single file named `gemini_output`.

**Input:** `output/final/storyboard.json` (from Stage 1)

**Output:** `output/final/gemini_output`

**Notes:**

- Uses `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) from the Settings screen.
- Stage 4 will auto-detect `gemini_output` (and also checks `gemini_output.json` / `gemini_narrator.json` for backward compatibility).

---

### Stage 5 — Audio Generation

**Status:** Implemented.

**File:** `scripts/generate_audio.py`

**Purpose:** Generate **natural-sounding per-page narration** with Kokoro (one TTS call per page), stitch pages into a single narration track, and compute per-panel `start_ms/end_ms` timestamps.

**Input:** `output/final/recap_pages_with_sentences.json` (from Stage 4)

**Outputs:**

- `output/final/audio/page_000.wav`, `page_001.wav`, ... (one per page)
- `output/final/audio/narration_stitched.wav` (full chapter narration)
- `output/final/final_script.json` (timeline JSON for Stage 6)

**CLI:**

```bash
python3 -m scripts.generate_audio \
  output/final/recap_pages_with_sentences.json \
  --out-dir output/final/audio/ \
  --voice af_heart \
  --speed 1.0
```

**Timeline JSON (`final_script.json`)**

```json
{
  "audio_path": "output/final/audio/narration_stitched.wav",
  "pages": [
    {
      "page_idx": 0,
      "audio_path": "output/final/audio/page_000.wav",
      "start_ms": 0,
      "end_ms": 4200,
      "panels": [
        {
          "panel_id": "...",
          "crop_path": "...",
          "sentence": "...",
          "start_ms": 0,
          "end_ms": 2100
        }
      ]
    }
  ]
}
```

#### How It Works

1. Load `recap_pages_with_sentences.json`.
2. For each page, join panel sentences into a single page paragraph and call Kokoro once (better continuity than per-panel TTS).
3. Trim silence + normalize loudness per page, then write per-page wavs.
4. Stitch pages into `narration_stitched.wav` with short crossfades.
5. Compute panel timestamps by distributing each page duration across panels (weighted by a heuristic, or optional per-panel timing TTS).
6. Write `final_script.json` with `start_ms/end_ms` per panel.

#### Kokoro Integration Notes

- Kokoro is a local TTS library (Python). Install via `pip install kokoro`.
- Voice options depend on your Kokoro install (e.g. `af_heart`, `af_bella`, `am_michael`).

#### IPC Events

```
stage:progress  { stage: 5, message: "Generating audio for page 6/24", percent: 25 }
stage:complete  { stage: 5, stitched_audio_path: "output/final/audio/narration_stitched.wav", final_script_path: "output/final/final_script.json" }
stage:error     { stage: 5, message: "Error text" }
```

---

### Stage 6 — Video Render

**Status:** Implemented.

**File:** `scripts/render_video.py`

**Purpose:** Stitch static panel PNG images with the generated WAV audio into a final `.mp4` video using ffmpeg.

**Input:** `output/final/final_script.json` (with timing metadata from Stage 5)

**Output:** `output/final/video.mp4`

#### How It Works

1. Load `final_script.json`.
2. Generate an ffmpeg `concat` demuxer input file listing each panel image and its display duration.
3. Spawn ffmpeg with a scale/pad filter so all panels render into a consistent canvas size.

**CLI:**

```bash
python3 -m scripts.render_video \
  output/final/final_script.json \
  --out-mp4 output/final/video.mp4
```

```bash
ffmpeg \
  -f concat -safe 0 -i panel_list.txt \
  -i output/final/audio/narration_stitched.wav \
  -c:v libx264 -r 24 \
  -c:a aac -shortest \
  output/final/video.mp4
```

#### `panel_list.txt` Format

```
file '/absolute/path/to/final/pages/000/panels/000/panel.png'
duration 2.1
file '/absolute/path/to/final/pages/000/panels/001/panel.png'
duration 1.9
...
```

Duration for each panel = `(end_ms - start_ms) / 1000` seconds.

#### IPC Events

```
stage:progress  { stage: 6, message: "Encoding video...", percent: 60 }
stage:complete  { stage: 6, video_path: "output/final/video.mp4" }
stage:error     { stage: 6, message: "Error text" }
```

---

## 6. Electron Application Architecture

### Process Model

```
Main Process (main.js)
├── Manages app lifecycle
├── Spawns Python child processes for each stage
├── Handles IPC from renderer (ipcMain)
├── Reads/writes files on behalf of renderer
└── Manages ANTHROPIC_API_KEY from config

Renderer Process (renderer/app.js)
├── All UI logic
├── Sends commands to main via ipcRenderer
├── Receives stage progress/complete/error events
└── Stage 4 review screen — reads and edits script JSON

Preload (preload.js)
└── Exposes safe contextBridge API:
    window.magi.runStage(stageNum, args)
    window.magi.onProgress(callback)
    window.magi.onComplete(callback)
    window.magi.onError(callback)
    window.magi.saveScript(scriptJson)
    window.magi.getConfig()
    window.magi.setConfig(key, value)
```

### `main.js` — Core IPC Handlers

```javascript
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// Stage definitions
const STAGE_COMMANDS = {
  0: (args) => ["python", ["scripts/downloader/scraper.py", ...args]],
  1: (args) => ["python", ["scripts/extract_chapter.py", ...args]],
  2: (args) => ["python", ["scripts/add_scenes.py", ...args]],
  3: (args) => ["python", ["scripts/make_panel_recaps.py", ...args]],
  4: (args) => ["python", ["scripts/refine_script.py", ...args]],
  5: (args) => ["python", ["scripts/generate_audio.py", ...args]],
  6: (args) => ["python", ["scripts/render_video.py", ...args]],
};

ipcMain.handle("run-stage", async (event, { stage, args }) => {
  return new Promise((resolve, reject) => {
    const [cmd, cmdArgs] = STAGE_COMMANDS[stage](args);
    const proc = spawn(cmd, cmdArgs, {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: getConfig("anthropic_api_key"),
      },
    });

    proc.stdout.on("data", (data) => {
      // Each line is a JSON IPC event
      const lines = data.toString().split("\n").filter(Boolean);
      lines.forEach((line) => {
        try {
          const event_data = JSON.parse(line);
          event.sender.send("stage-event", event_data);
        } catch (_) {
          event.sender.send("stage-event", { type: "log", message: line });
        }
      });
    });

    proc.stderr.on("data", (data) => {
      event.sender.send("stage-event", {
        type: "log",
        message: data.toString(),
      });
    });

    proc.on("close", (code) => {
      if (code === 0) resolve({ success: true });
      else reject(new Error(`Stage ${stage} exited with code ${code}`));
    });
  });
});
```

### Python IPC Protocol

Each Python stage communicates with Electron by printing JSON lines to stdout:

```python
import json, sys

def emit(event_type, **kwargs):
    print(json.dumps({"type": event_type, **kwargs}), flush=True)

# Usage
emit("progress", stage=2, message="Captioning panel 5/87", percent=5)
emit("complete", stage=2, storyboard_path="out_ch001/final/storyboard.json")
emit("error", stage=2, message="Ollama connection refused")
```

stderr is forwarded to the UI log panel verbatim (useful for debugging).

---

## 7. Python ↔ Electron Bridge

### Rules

1. **Always print JSON to stdout** — one JSON object per line. Electron parses each line.
2. **Never mix stdout and non-JSON output** — use `flush=True` on all emits.
3. **Use stderr for raw logs** — tqdm progress bars, stack traces, warnings all go to stderr.
4. **Exit code 0 = success, non-zero = failure.** Electron checks the exit code.
5. **Args are passed as CLI arguments** — Electron builds the argv array and spawns the process.

### Stage Arg Formats

```javascript
// Stage 0 — Download
runStage(0, ["--url", mangaUrl, "--out", downloadPath]);

// Stage 1 — Extraction
runStage(1, [
  "--chapter-id",
  chapterId,
  "--images",
  imageDir,
  "--out",
  outDir,
  "--device",
  device,
]);

// Stage 2 — Scenes
runStage(2, [
  storyboardPath,
  "--scene-provider",
  "ollama",
  "--ollama-model",
  "gemma3:4b",
]);

// Stage 3 — Recaps
runStage(3, [storyboardPath, "--mode", "page", "--ollama-model", "gemma3:4b"]);

// Stage 4 — Refinement
runStage(4, [recapPath, "--out", finalScriptPath]);

// Stage 5 — Audio
runStage(5, [finalScriptPath, "--out-dir", audioDir]);
```

---

## 8. Local AI Setup (Ollama)

### Models Used

| Stage   | Model        | Purpose                                                                |
| ------- | ------------ | ---------------------------------------------------------------------- |
| Stage 2 | `llava-phi3` | Scene captioning — looks at panel images, writes descriptions          |
| Stage 3 | `gemma3:4b`  | Narrative recap — writes flowing narration from captions + transcripts |

### Installation

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh   # Linux/macOS
# Windows: download installer from https://ollama.com

# Pull the model
ollama pull gemma3:4b

# Verify
ollama run gemma3:4b "Hello"
```

### Ollama API Usage from Python

```python
import httpx, base64, json

def call_ollama(prompt: str, image_path: str = None, model: str = "gemma3:4b", host: str = "http://localhost:11434"):
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "format": "json"
    }
    if image_path:
        with open(image_path, "rb") as f:
            payload["images"] = [base64.b64encode(f.read()).decode()]

    response = httpx.post(f"{host}/api/generate", json=payload, timeout=120)
    response.raise_for_status()
    return json.loads(response.json()["response"])
```

### Startup Health Check

On app launch, Electron checks Ollama is running:

```javascript
async function checkOllama() {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    const data = await res.json();
    const hasGemma = data.models.some((m) => m.name.startsWith("gemma3"));
    return { running: true, hasModel: hasGemma };
  } catch {
    return { running: false, hasModel: false };
  }
}
```

---

## 9. UI Layout & Navigation

### Single Window Layout

```
┌─────────────────────────────────────────────────────┐
│  Magi                                    [─][□][✕]  │
├─────────────┬───────────────────────────────────────┤
│             │                                       │
│  SIDEBAR    │  MAIN PANEL                           │
│             │                                       │
│  ● Download │  (changes per active stage)           │
│  ○ Extract  │                                       │
│  ○ Scenes   │                                       │
│  ○ Recap    │                                       │
│  ○ Refine   │                                       │
│  ○ Audio    │                                       │
│  ○ Video    │                                       │
│             │                                       │
│  ─────────  │                                       │
│  Settings   │                                       │
│             │                                       │
└─────────────┴───────────────────────────────────────┘
```

### Stage States (Sidebar)

- `●` active / in progress (spinning indicator)
- `✓` complete (green checkmark)
- `✕` error (red)
- `○` pending (gray)

### Main Panel Views Per Stage

**Stage 0 (Download):** URL input field + chapter selector dropdown + download progress bar.

**Stages 1–3:** Log output panel (scrolling text from stderr) + progress bar from `stage:progress` events. No interaction needed — just watch it run.

**Stage 4 (Refine) — Most Complex:**

```
┌─────────────────────────┬───────────────────────────┐
│  RAW DRAFT (read-only)  │  CLAUDE'S SCRIPT (edit)   │
│                         │                           │
│  Page 1:                │  Page 1:                  │
│  The hero appears...    │  [editable textarea]      │
│                         │                           │
│  Page 2:                │  Page 2:                  │
│  ...                    │  [editable textarea]      │
│                         │                           │
└─────────────────────────┴───────────────────────────┘
[Custom system prompt ▼]     [Re-generate]  [Approve ✓]
```

**Stage 5 (Audio):** Progress bar per page, waveform preview when done.

**Stage 6 (Video):** Panel image display + audio player for preview. "Export MP4" button + ffmpeg progress bar.

### Settings Screen

- Anthropic API key (masked input, saved to OS keychain or local config)
- Ollama host URL (default: `http://localhost:11434`)
- Default output directory
- Default device for Stage 1 (`cpu` / `mps` / `cuda`)
- Default TTS voice

---

## 10. Error Handling & Resilience

### Per-Stage Retry

Each stage button in the UI is re-clickable. Stages check for existing outputs and skip completed work (resumable by default).

### Stage 2 & 3 — Panel-Level Resumption

Both `add_scenes.py` and `make_panel_recaps.py` skip panels that already have outputs. Interrupting mid-run is safe — restart and it continues from where it stopped.

### Stage 4 — API Errors

If the Claude API call fails (network, rate limit, invalid key):

- Show the error in the UI.
- Allow the user to retry.
- Allow the user to paste a manually-written script and skip the API call entirely (manual fallback).

### Stage 1 — Model Not Found

If the Magi model is not cached locally and `--allow-downloads` is not set, the stage fails with a clear error. The UI should offer a "Download model" button that re-runs with `--allow-downloads`.

### Python Process Crash

If a Python process exits with non-zero code, Electron catches it and displays:

- The last N lines of stderr as an error report.
- A "View full log" button.
- A "Retry" button for the same stage.

### Ollama Not Running

If Ollama health check fails on startup, show a persistent banner:

> "Ollama is not running. Stages 2 and 3 will not work. [Start Ollama] [Dismiss]"

The "Start Ollama" button spawns `ollama serve` as a child process.

---

## 11. Cross-Platform Considerations

### Python Path

Do not hardcode `python`. Use `python3` on macOS/Linux and detect via a config setting. Or resolve via:

```javascript
const pythonCmd = process.platform === "win32" ? "python" : "python3";
```

For packaged builds, prefer a **per-user venv** under Electron `userData` and run stages via that interpreter once it exists.

### ffmpeg Path

- macOS: `brew install ffmpeg` or bundle binary.
- Windows: download from ffmpeg.org or bundle.
- Linux: `apt install ffmpeg`.

Detect at startup:

```javascript
const { execSync } = require("child_process");
try {
  execSync("ffmpeg -version");
  // ffmpeg available
} catch {
  // show install instructions
}
```

For packaged builds, bundling `ffmpeg` via `ffmpeg-static` and prepending it to `PATH` is the simplest option.

### Installers (DMG/EXE)

This repo can build:

- macOS: DMG
- Windows: EXE (NSIS)

Commands:

- `npm run dist:mac`
- `npm run dist:win`

### File Paths

Always use `path.join()` in Node.js. Never concatenate paths with `/` or `\`. In Python, always use `pathlib.Path`.

### Ollama

Ollama has native installers for all three platforms. The Electron app should detect if Ollama is installed vs. just not running, and show appropriate guidance.

---

## 12. Prerequisites & First-Run Check

On first launch, Electron runs a prerequisite check and shows a setup screen if anything is missing:

| Requirement       | Check                                      | Install Link                      |
| ----------------- | ------------------------------------------ | --------------------------------- |
| Python (64-bit)   | `python --version`                         | python.org                        |
| pip packages      | venv import check                           | auto-install into venv            |
| Ollama            | `GET http://localhost:11434/api/tags`      | ollama.com                        |
| gemma3:4b model   | check models list from Ollama              | `ollama pull gemma3:4b`           |
| ffmpeg            | `ffmpeg -version`                          | bundled (or manual)               |
| Anthropic API key | key present in config                      | anthropic.com                     |
| Kokoro TTS        | `python -c "import kokoro"`                | `pip install kokoro`              |

Notes:

- Recommended Python: **3.11 (64-bit)**. Supported: **3.10–3.12 (64-bit)**.
- Windows: install from python.org (not the Microsoft Store stub), and ensure `python` runs the intended version in `cmd.exe` / PowerShell.

Show a checklist UI:

```
✓ Python 3.11 found
✓ pip packages installed
✕ Ollama not running → [Start Ollama]
✕ gemma3:4b not pulled → [Pull Model (~2GB)]
✓ ffmpeg found
⚠ Anthropic API key not set → [Set Key]
✓ Kokoro installed
```

---

## 13. Environment & Configuration

### `config/defaults.json`

```json
{
  "download_path": "./downloads",
  "output_path": "./output",
  "ollama_host": "http://localhost:11434",
  "ollama_model": "gemma3:4b",
  "magi_model": "ragavsachdeva/magiv3",
  "magi_device": "cpu",
  "tts_voice": "af_heart",
  "tts_speed": 1.0,
  "max_image_threads": 10,
  "http_timeout": 20,
  "retry_attempts": 3,
  "context_panels": 3,
  "recap_sentences_min": 2,
  "recap_sentences_max": 4,
  "delete_images_after_conversion": false
}
```

### Runtime Config (Electron `main.js`)

Config is stored in Electron's `app.getPath('userData')` directory as `config.json`. The Anthropic API key is stored there too (or in OS keychain for production).

---

## 14. Implementation Order

Build and test each piece in this order. Each step should be independently testable before moving on.

### Phase 1 — Shell & Bridge

1. Set up Electron project with `main.js`, `preload.js`, `renderer/index.html`.
2. Implement the Python IPC bridge: `runStage()`, JSON event parsing, log panel.
3. Build the sidebar navigation and stage state indicators.
4. Build the prerequisite check screen.

### Phase 2 — Download (Stage 0)

5. Implement `scraper.py` and `download.py`.
6. Build the Stage 0 UI: URL input, chapter selector, progress bar.
7. Test end-to-end: input a URL, see images downloaded to disk.

### Phase 3 — Extraction (Stage 1)

8. Implement `extract_chapter.py` (wrapping existing Magi code).
9. Build Stage 1 UI: log panel + progress bar.
10. Test: feed downloaded images, verify `storyboard.json` and panel crops are created.

### Phase 4 — Scene & Recap (Stages 2 & 3)

11. Implement `add_scenes.py` with Ollama/gemma3:4b.
12. Implement `make_panel_recaps.py` with Ollama/gemma3:4b.
13. Build Stage 2 & 3 UI (log + progress — no interaction needed).
14. Test full pipeline from Stage 1 → 3.

### Phase 5 — Claude Refinement (Stage 4)

15. Implement `refine_script.py`.
16. Build the Stage 4 review screen (split view, editable textarea, approve/regenerate buttons).
17. Test: feed recap, see Claude output, edit it, approve it, verify `final_script.json`.

### Phase 6 — Audio (Stage 5)

18. Implement `generate_audio.py` with Kokoro.
19. Build Stage 5 UI: progress per page.
20. Test: verify `.wav` files generated and timing written to `final_script.json`.

### Phase 7 — Video Render (Stage 6)

21. Implement the preview player (panel image + audio sync).
22. Implement ffmpeg export (panel list file generation + process spawn).
23. Build Stage 6 UI: preview + export button + progress bar.
24. Test full end-to-end: URL → `.mp4`.

### Phase 8 — Polish

25. Settings screen (API key, paths, device selection).
26. Error handling for all stages (retry buttons, log viewer).
27. First-run prerequisite check UI.
28. Cross-platform testing (Windows, macOS, Linux).

---

## Appendix: Key File Paths Quick Reference

| File                         | Created by | Read by        |
| ---------------------------- | ---------- | -------------- |
| `downloads/.../page_N.jpg`   | Stage 0    | Stage 1        |
| `final/storyboard.json`      | Stage 1    | Stages 2, 3, 4 |
| `final/pages/.../panel.png`  | Stage 1    | Stages 2, 3, 6 |
| `final/pages/.../scene.json` | Stage 2    | Stage 3        |
| `final/recap_pages.json`     | Stage 3    | Stage 4        |
| `final/final_script.json`    | Stage 4    | Stage 5        |
| `final/audio/stitched.wav`   | Stage 5    | Stage 6        |
| `final/video.mp4`            | Stage 6    | User           |

---

_This document reflects the complete Magi system as of its initial architecture. Update it as implementation decisions are made._
