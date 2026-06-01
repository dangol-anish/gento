import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.trim_manga_json import _output_path, _trim_pages, _trim_panel, process_file


class TestTrimMangaJson(unittest.TestCase):
    def test_trim_panel_preserves_sentence_and_crop_path(self):
        input_panel = {
            "sub_panel_idx": 0,
            "panel_id": "chapter_1__1_p000_n000_e939c833cb",
            "crop_path": "final_1/pages/000/panels/000/panel.png",
            "sentence": "An adorned ebony steed races across the heavens...",
            "start_ms": 0,
            "end_ms": 5856,
        }
        trimmed = _trim_panel(input_panel)
        self.assertEqual(trimmed, {
            "sentence": "An adorned ebony steed races across the heavens...",
            "crop_path": "final_1/pages/000/panels/000/panel.png",
        })

    def test_trim_pages_transforms_nested_structure(self):
        doc = {
            "mode": "page",
            "some_meta": "value",
            "pages": [
                {
                    "page_idx": 0,
                    "recap": "...",
                    "start_ms": 0,
                    "end_ms": 1234,
                    "panels": [
                        {
                            "sub_panel_idx": 0,
                            "panel_id": "id",
                            "crop_path": "path.png",
                            "sentence": "Hello",
                            "start_ms": 0,
                            "end_ms": 100,
                        }
                    ],
                }
            ],
        }
        trimmed = _trim_pages(doc)
        self.assertEqual(trimmed, {
            "pages": [
                {
                    "panels": [
                        {
                            "sentence": "Hello",
                            "crop_path": "path.png",
                        }
                    ]
                }
            ]
        })

    def test_output_path_appends_trimmed_before_extension(self):
        self.assertEqual(
            _output_path(Path("chapter_1.json")),
            Path("chapter_1_trimmed.json"),
        )
        self.assertEqual(
            _output_path(Path("chapter_1")),
            Path("chapter_1_trimmed"),
        )

    def test_process_file_writes_trimmed_json_and_reports_sizes(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            input_path = root / "chapter_1.json"
            output_path = root / "chapter_1_trimmed.json"
            raw = {
                "mode": "page",
                "pages": [
                    {
                        "page_idx": 0,
                        "panels": [
                            {
                                "sub_panel_idx": 0,
                                "panel_id": "id",
                                "crop_path": "path.png",
                                "sentence": "Hello",
                                "start_ms": 0,
                                "end_ms": 100,
                            }
                        ],
                    }
                ],
            }
            input_path.write_text(json.dumps(raw), encoding="utf-8")
            success = process_file(input_path)
            self.assertTrue(success)
            self.assertTrue(output_path.exists())
            trimmed = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(trimmed, {
                "pages": [
                    {"panels": [{"sentence": "Hello", "crop_path": "path.png"}]}
                ]
            })
