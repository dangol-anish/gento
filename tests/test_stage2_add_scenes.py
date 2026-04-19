import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import scripts.add_scenes as stage2
from scripts.common.errors import AppError


class TestStage2AddScenes(unittest.TestCase):
    def test_parse_args_rejects_missing_storyboard(self):
        argv = ["prog", "/tmp/does-not-exist.json"]
        with patch("sys.argv", argv):
            with self.assertRaises(AppError) as ctx:
                stage2.parse_args()
        self.assertEqual(ctx.exception.code, "INVALID_REQUEST")

    def test_run_stage_updates_storyboard_and_writes_sidecars(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            out_root = Path(tmpdir) / "out_ch001"
            panel_dir = out_root / "final" / "pages" / "000" / "panels" / "000"
            panel_dir.mkdir(parents=True, exist_ok=True)

            # minimal panel image
            img = Image.new("RGB", (8, 8), (255, 0, 0))
            img_path = panel_dir / "panel.png"
            img.save(img_path)

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
                        "scene_caption": "",
                        "scene_tags": [],
                    }
                ],
                "beats": [],
                "script": [],
            }
            storyboard_path.write_text(json.dumps(storyboard), encoding="utf-8")

            emitted = []

            def fake_emit(event_type: str, **payload):
                emitted.append((event_type, payload))

            argv = ["prog", str(storyboard_path), "--ollama-host", "http://127.0.0.1:11434", "--ollama-model", "x"]
            responses = iter(
                [
                    '{"caption":"A hero confronts a threat.","tags":["action","dialogue"]}',
                    '{"caption":"The hero speaks."}',
                ]
            )
            with patch("sys.argv", argv), patch.object(stage2, "emit", side_effect=fake_emit), patch.object(
                stage2,
                "_ensure_ollama_ready",
                return_value=True,
            ), patch.object(
                stage2,
                "_ollama_generate",
                side_effect=lambda *args, **kwargs: next(responses),
            ):
                stage2._run_stage()

            updated = json.loads(storyboard_path.read_text(encoding="utf-8"))
            self.assertEqual(updated["panels"][0]["scene_caption"], "The hero speaks.")
            self.assertEqual(updated["panels"][0]["scene_tags"], ["action", "dialogue"])

            self.assertTrue((panel_dir / "scene.txt").exists())
            self.assertTrue((panel_dir / "scene.json").exists())

            complete_events = [evt for evt in emitted if evt[0] == "complete"]
            self.assertEqual(len(complete_events), 1)
            self.assertEqual(complete_events[0][1]["stage"], 2)


if __name__ == "__main__":
    unittest.main()
