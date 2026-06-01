# Gento Project Flow - Complete User Journey

## Architecture Overview

Gento is an **Electron desktop app** that converts manga chapters into narrated videos. It uses:
- **Electron** (Node.js) for the desktop shell and UI
- **Python** for all processing stages
- **Filesystem as message bus** (no database - all state in JSON/image files)
- **Local AI** (Ollama) for most processing
- **Claude API** for script refinement (Stage 4 only)

## User Flow - Stage by Stage

### Stage 0: Download Manga
**User Action:** Enter MangaBuddy chapter URL in the Download UI

**What Happens:**
- Python scraper fetches the manga page HTML
- Extracts chapter list and image URLs
- Downloads all page images concurrently (10 threads default)
- Saves images as `page_001.jpg`, `page_002.jpg`, etc.

**Folders Created:**
```
downloads/
└── <manga_title>/
    └── <chapter_title>/
        ├── page_001.jpg
        ├── page_002.jpg
        └── ...
```

**Data Storage:** Raw manga page images in sequential order

---

### Stage 1: Panel Extraction
**User Action:** Select downloaded chapter, click "Extract"

**What Happens:**
- Loads Magi CV model (`ragavsachdeva/magiv3` from Hugging Face)
- Processes each page image to detect:
  - Panel boundaries (bounding boxes)
  - OCR text within panels
  - Character associations
- Crops each detected panel
- Generates panel IDs from SHA256 hash of crop bytes
- Sorts panels in reading order (RTL for manga)

**Folders Created:**
```
output/
└── <manga_title>/
    └── final/
        ├── storyboard.json              # Central artifact - all panel metadata
        └── pages/
            └── 000/                     # Page index (zero-padded)
                └── panels/
                    ├── 000/             # Panel index (zero-padded)
                    │   ├── panel.png    # Cropped panel image
                    │   ├── panel.json   # Panel bbox, metadata
                    │   ├── transcript.txt  # OCR text (human-readable)
                    │   └── transcript.json # Structured OCR with bboxes
                    ├── 001/
                    │   ├── panel.png
                    │   ├── panel.json
                    │   ├── transcript.txt
                    │   └── transcript.json
                    └── ...
```

**Data Storage:**
- `storyboard.json` - Central JSON with all panels, empty scene/recap fields
- Per-panel PNG crops and OCR transcripts
- Panel IDs format: `ch{chapter}_p{page_idx}_n{panel_idx}_{10char_hash}`

---

### Stage 2: Scene Enrichment (Gemini - SKIPPED per your request)
**Note:** This stage currently uses Gemini API for scene captioning. You requested to skip this, so I'll describe the alternative flow.

**Alternative:** Users can proceed directly to Stage 3, which uses local Ollama for both scene understanding and narrative generation.

---

### Stage 3: Narrative Recap
**User Action:** Click "Recap" (uses local Ollama)

**What Happens:**
- Loads `storyboard.json` from Stage 1
- Groups panels by page
- For each page, sends all panel crops + OCR transcripts to Ollama (gemma3:4b)
- Model generates 2-4 sentence flowing narration per page
- Includes previous page recap for continuity
- Processes pages sequentially

**Folders Created:**
```
output/<manga_title>/final/
├── recap_pages.json           # Structured per-page recaps
├── recap_script.txt          # Human-readable full script
└── pages/000/panels/000/
    ├── recap.txt              # Per-panel recap (if panel mode)
    └── recap.json
```

**Data Storage:**
- `recap_pages.json` - Page-level recaps with panel references
- `recap_script.txt` - Concatenated human-readable script
- Per-panel recap files (in panel mode)

**Ollama Integration:**
- Checks if Ollama is running at `http://localhost:11434`
- Auto-starts Ollama if not running (local only)
- Uses `gemma3:4b` model by default

---

### Stage 4: Script Refinement
**User Action:** Click "Refine" (uses Claude API)

**What Happens:**
- Loads `recap_pages.json` from Stage 3
- Sends page recaps + panel evidence to Claude API
- Claude converts page-level recaps into **one sentence per panel**
- Ensures strict alignment with panel list
- Validates output has exactly one sentence per panel

**Folders Created:**
```
output/<manga_title>/final/
└── recap_pages_with_sentences.json    # Refined script with per-panel sentences
```

**Data Storage:**
- `recap_pages_with_sentences.json` - Same structure as recap_pages.json but with `sentence` field per panel
- Format:
```json
{
  "mode": "page",
  "pages": [
    {
      "page_idx": 0,
      "recap": "Page-level recap...",
      "panels": [
        {
          "sub_panel_idx": 0,
          "panel_id": "ch1_p0_n0_abc123",
          "crop_path": "final/pages/000/panels/000/panel.png",
          "sentence": "One narration sentence for this panel."
        }
      ]
    }
  ]
}
```

**API Key:** Stored in Electron app settings (`userData/settings.json`), passed via environment variable to Python

---

### Stage 5: Audio Generation
**User Action:** Click "Audio" (uses Kokoro TTS)

**What Happens:**
- Loads `recap_pages_with_sentences.json` from Stage 4
- Joins panel sentences per page into single paragraph
- Calls Kokoro TTS once per page (better continuity than per-panel)
- Trims silence, normalizes loudness
- Stitches page audio with crossfades
- Computes panel timestamps by distributing page duration across panels

**Folders Created:**
```
output/<manga_title>/final/
├── audio/
│   ├── page_000.wav           # Per-page narration
│   ├── page_001.wav
│   ├── ...
│   └── narration_stitched.wav # Full chapter narration
└── final_script.json          # Timeline with audio paths + timestamps
```

**Data Storage:**
- Per-page WAV files in `audio/` folder
- `final_script.json` - Complete timeline:
```json
{
  "audio_path": "final/audio/narration_stitched.wav",
  "pages": [
    {
      "page_idx": 0,
      "audio_path": "final/audio/page_000.wav",
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

**Kokoro Integration:**
- Local TTS library (Python)
- Voice: `am_echo` (configurable in [defaults.json](cci:7://file:///Users/anishdangol/Documents/work/gento/config/defaults.json:0:0-0:0))
- Speed: 1.2x (configurable)

---

### Stage 6: Video Render
**User Action:** Click "Video" (uses ffmpeg)

**What Happens:**
- Loads `final_script.json` from Stage 5
- Generates ffmpeg concat demuxer file listing panels with durations
- Applies fly-in transitions (48 frames = 2 seconds at 24fps)
- Blurs panel into background for smooth transitions
- Combines panel images with stitched audio
- Encodes to H.264 MP4

**Folders Created:**
```
output/<manga_title>/final/
└── video.mp4                  # Final output video
```

**Data Storage:**
- Single `video.mp4` file (1920x1080, 24fps, H.264)

**ffmpeg Integration:**
- Uses bundled `ffmpeg-static` or system ffmpeg
- Encoder: `h264_videotoolbox` on macOS, `libx264` elsewhere
- CRF: 18 (high quality)
- Preset: `veryfast`

---

## Key Architecture Patterns

### Filesystem as Message Bus
- Each stage reads from previous stage's output
- Each stage writes to specific file paths
- No database - all state in JSON/image files
- Resumable - stages check for existing outputs

### Electron ↔ Python Bridge
- **Main Process** ([electron/main/main.js](cci:7://file:///Users/anishdangol/Documents/work/gento/electron/main/main.js:0:0-0:0)):
  - Spawns Python child processes for each stage
  - Handles IPC from renderer
  - Manages API keys in settings
  - Auto-starts Ollama if needed

- **Renderer Process** ([renderer/](cci:9://file:///Users/anishdangol/Documents/work/gento/renderer:0:0-0:0)):
  - Next.js + Shadcn UI
  - Sends commands via [window.gento.runStage(stage, args)](cci:1://file:///Users/anishdangol/Documents/work/gento/electron/preload.js:40:2-44:3)
  - Receives progress events via [window.gento.onStageEvent(callback)](cci:1://file:///Users/anishdangol/Documents/work/gento/electron/preload.js:93:2-97:3)

- **Python Stages**:
  - Print JSON to stdout for IPC events
  - Use stderr for logs
  - Exit code 0 = success, non-zero = failure

### Configuration
- [config/defaults.json](cci:7://file:///Users/anishdangol/Documents/work/gento/config/defaults.json:0:0-0:0) - Default paths, model names, settings
- `userData/settings.json` - User API keys (Anthropic, Gemini)
- Environment variables for API keys passed to Python

### Workspace Structure
```
<<project_root>/
├── downloads/              # Stage 0 output
│   └── <manga>/<chapter>/
│       └── page_*.jpg
├── output/                 # Stages 1-6 output
│   └── <manga>/
│       └── final/
│           ├── storyboard.json
│           ├── recap_pages.json
│           ├── recap_pages_with_sentences.json
│           ├── final_script.json
│           ├── audio/
│           │   ├── page_*.wav
│           │   └── narration_stitched.wav
│           ├── pages/
│           │   └── 000/panels/000/
│           │       ├── panel.png
│           │       ├── panel.json
│           │       ├── transcript.txt
│           │       └── transcript.json
│           └── video.mp4
└── .gento-userdata/        # Electron app data
    └── settings.json
```

## User Journey Summary

1. **Download** - Enter URL → get raw page images
2. **Extract** - Run CV model → get panel crops + OCR
3. **Recap** - Run local Ollama → get flowing narration
4. **Refine** - Run Claude API → get per-panel sentences
5. **Audio** - Run Kokoro TTS → get timed narration
6. **Video** - Run ffmpeg → get final MP4

Each stage is resumable - if interrupted, rerunning skips completed work (unless `--overwrite` is passed).