import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import scripts.refine_script as stage4


class TestStage4RefineScript(unittest.TestCase):
    def test_writes_recap_pages_with_sentences_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / "out_ch001"
            final_root = root / "final"
            final_root.mkdir(parents=True, exist_ok=True)

            storyboard_path = final_root / "storyboard.json"
            storyboard_path.write_text(json.dumps({"chapter_id": "chapter_1", "panels": [1]}), encoding="utf-8")

            recap_pages_path = final_root / "recap_pages.json"
            recap_pages = {
                "mode": "page",
                "storyboard": str(storyboard_path),
                "provider": "ollama",
                "model": "x",
                "generated_at": "2026-04-19T00:00:00Z",
                "raw_script": "raw recap",
                "pages": [
                    {
                        "page_idx": 0,
                        "recap": "A recap.",
                        "panels": [
                            {"sub_panel_idx": 0, "panel_id": "p0", "crop_path": "final/pages/000/panels/000/panel.png"},
                            {"sub_panel_idx": 1, "panel_id": "p1", "crop_path": "final/pages/000/panels/001/panel.png"},
                        ],
                    }
                ],
            }
            recap_pages_path.write_text(json.dumps(recap_pages), encoding="utf-8")

            out_path = final_root / "recap_pages_with_sentences.json"

            argv = [
                "prog",
                str(recap_pages_path),
                "--provider",
                "anthropic",
                "--model",
                "test-model",
                "--out",
                str(out_path),
            ]

            emitted = []

            def fake_emit(event_type: str, **payload):
                emitted.append((event_type, payload))

            provider_json = json.dumps(
                {
                    "page_idx": 0,
                    "panels": [
                        {"panel_id": "p0", "sentence": "One."},
                        {"panel_id": "p1", "sentence": "Two."},
                    ],
                }
            )

            with patch("sys.argv", argv), patch.object(stage4, "emit", side_effect=fake_emit), patch.object(
                stage4, "_anthropic_messages_create", return_value=provider_json
            ), patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test"}):
                stage4._run_stage()

            self.assertTrue(out_path.exists())
            doc = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(doc["mode"], "page")
            self.assertEqual(doc["pages"][0]["page_idx"], 0)
            self.assertEqual(doc["pages"][0]["recap"], "A recap.")
            self.assertEqual(len(doc["pages"][0]["panels"]), 2)
            self.assertEqual(doc["pages"][0]["panels"][0]["panel_id"], "p0")
            self.assertEqual(doc["pages"][0]["panels"][1]["panel_id"], "p1")
            self.assertEqual(doc["pages"][0]["panels"][0]["sentence"], "One.")
            self.assertEqual(doc["pages"][0]["panels"][1]["sentence"], "Two.")

            complete_events = [evt for evt in emitted if evt[0] == "complete"]
            self.assertEqual(len(complete_events), 1)
            self.assertEqual(complete_events[0][1]["stage"], 4)
            self.assertIn("refined_recap_path", complete_events[0][1])


if __name__ == "__main__":
    unittest.main()
