import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import scripts.make_panel_recaps as stage3
from scripts.common.errors import AppError


class TestStage3MakePanelRecaps(unittest.TestCase):
    def test_parse_args_rejects_missing_storyboard(self):
        argv = ["prog", "/tmp/does-not-exist.json"]
        with patch("sys.argv", argv):
            with self.assertRaises(AppError):
                stage3.parse_args()

    def test_page_mode_writes_recap_pages_and_script(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            out_root = Path(tmpdir) / "out_ch001"
            panel_dir = out_root / "final" / "pages" / "000" / "panels" / "000"
            panel_dir.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (8, 8), (0, 0, 0)).save(panel_dir / "panel.png")
            (panel_dir / "transcript.txt").write_text("<unsure>: hi\n", encoding="utf-8")
            (panel_dir / "scene.json").write_text(json.dumps({"page_caption": "A tense moment."}), encoding="utf-8")

            storyboard_path = out_root / "final" / "storyboard.json"
            storyboard = {
                "version": "v1",
                "chapter_id": "chapter_1",
                "source_images": [],
                "panels": [
                    {
                        "panel_id": "p0",
                        "page_idx": 0,
                        "bbox": [0, 0, 1, 1],
                        "crop_path": "final/pages/000/panels/000/panel.png",
                        "ocr_lines": [{"text": "Hello", "bbox": [0, 0, 1, 1], "speaker": "unsure"}],
                        "scene_caption": "Someone speaks.",
                        "scene_tags": ["dialogue"],
                    }
                ],
                "beats": [],
                "script": [],
            }
            storyboard_path.write_text(json.dumps(storyboard), encoding="utf-8")

            argv = ["prog", str(storyboard_path), "--mode", "page", "--ollama-model", "x", "--ollama-host", "http://127.0.0.1:11434"]
            emitted = []

            def fake_emit(event_type: str, **payload):
                emitted.append((event_type, payload))

            with patch("sys.argv", argv), patch.object(stage3, "emit", side_effect=fake_emit), patch.object(
                stage3, "_ensure_ollama_ready", return_value=True
            ), patch.object(stage3, "_ollama_generate_text", return_value="A recap sentence."):
                stage3._run_stage()

            recap_pages = out_root / "final" / "recap_pages.json"
            recap_script = out_root / "final" / "recap_script.txt"
            self.assertTrue(recap_pages.exists())
            self.assertTrue(recap_script.exists())
            doc_out = json.loads(recap_pages.read_text(encoding="utf-8"))
            self.assertEqual(doc_out["mode"], "page")
            self.assertEqual(doc_out["pages"][0]["page_idx"], 0)
            self.assertIn("A recap sentence.", doc_out["pages"][0]["recap"])
            self.assertIn("A recap sentence.", recap_script.read_text(encoding="utf-8"))

            complete_events = [evt for evt in emitted if evt[0] == "complete"]
            self.assertEqual(len(complete_events), 1)
            self.assertEqual(complete_events[0][1]["stage"], 3)


if __name__ == "__main__":
    unittest.main()
