import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from scripts.extractor import panels as stage1_panels


class TestStage1Panels(unittest.TestCase):
    def test_collect_image_paths_from_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.jpg").write_bytes(b"fake")
            (root / "b.png").write_bytes(b"fake")
            (root / "c.txt").write_text("nope", encoding="utf-8")
            nested = root / "nested"
            nested.mkdir()
            (nested / "d.jpeg").write_bytes(b"fake")

            result = stage1_panels.collect_image_paths([str(root)])
            self.assertEqual(
                result,
                sorted([str(root / "a.jpg"), str(root / "b.png"), str(nested / "d.jpeg")]),
            )

    def test_safe_rect_xyxy_supports_points_and_dicts(self):
        rect = stage1_panels._safe_rect_xyxy({"polygon": [(1, 2), (5, 2), (5, 10), (1, 10)]})
        self.assertEqual(rect, (1.0, 2.0, 5.0, 10.0))

        rect = stage1_panels._safe_rect_xyxy([1, 2, 3, 4])
        self.assertEqual(rect, (1.0, 2.0, 3.0, 4.0))

        self.assertIsNone(stage1_panels._safe_rect_xyxy("invalid"))

    def test_clamp_rect_always_produces_non_empty_crop(self):
        # inverted + out-of-bounds
        clamped = stage1_panels._clamp_rect((200, 200, -5, -5), width=100, height=100)
        x1, y1, x2, y2 = clamped
        self.assertGreaterEqual(x1, 0)
        self.assertGreaterEqual(y1, 0)
        self.assertLessEqual(x2, 100)
        self.assertLessEqual(y2, 100)
        self.assertGreater(x2, x1)
        self.assertGreater(y2, y1)

    def test_write_panel_outputs_writes_files_and_assigns_ocr(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_root = Path(tmp) / "out"
            img_path = Path(tmp) / "page.png"

            Image.new("RGB", (100, 100), (255, 255, 255)).save(img_path)

            page_result = {
                "panels": [[10, 10, 90, 90]],
                "texts": [[20, 20, 30, 30], [95, 95, 99, 99]],
            }
            page_ocr = {"ocr_texts": ["inside", "outside"]}

            panels = stage1_panels.write_panel_outputs(
                out_root=out_root,
                page_idx=0,
                image_path=str(img_path),
                page_result=page_result,
                page_ocr=page_ocr,
                chapter_slug="chapter_1",
            )

            self.assertEqual(len(panels), 1)
            panel = panels[0]
            self.assertTrue(panel["panel_id"].startswith("chapter_1_p000_n000_"))
            self.assertEqual(panel["page_idx"], 0)
            self.assertEqual(panel["bbox"], [10.0, 10.0, 90.0, 90.0])
            self.assertEqual(len(panel["ocr_lines"]), 1)
            self.assertEqual(panel["ocr_lines"][0]["text"], "inside")

            panel_dir = out_root / "final" / "pages" / "000" / "panels" / "000"
            self.assertTrue((panel_dir / "panel.png").exists())
            self.assertTrue((panel_dir / "panel.json").exists())
            self.assertTrue((panel_dir / "transcript.json").exists())
            self.assertTrue((panel_dir / "transcript.txt").exists())

            transcript_txt = (panel_dir / "transcript.txt").read_text(encoding="utf-8")
            self.assertIn("inside", transcript_txt)
            self.assertNotIn("outside", transcript_txt)

            panel_json = json.loads((panel_dir / "panel.json").read_text(encoding="utf-8"))
            self.assertEqual(panel_json["page_idx"], 0)
            self.assertEqual(panel_json["panel_idx"], 0)
            self.assertEqual(panel_json["bbox"], [10.0, 10.0, 90.0, 90.0])
            self.assertTrue(panel_json["crop_path"].endswith("final/pages/000/panels/000/panel.png"))
            self.assertEqual(len(panel_json["crop_sha256_png"]), 64)

    def test_build_storyboard_writes_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_root = Path(tmp) / "out"
            storyboard_path = stage1_panels.build_storyboard(
                out_root=out_root,
                chapter_id="chapter_1",
                source_images=["/a.png", "/b.png"],
                panels=[{"panel_id": "x"}],
            )
            self.assertTrue(storyboard_path.exists())
            data = json.loads(storyboard_path.read_text(encoding="utf-8"))
            self.assertEqual(data["version"], "v1")
            self.assertEqual(data["chapter_id"], "chapter_1")
            self.assertEqual(data["source_images"], ["/a.png", "/b.png"])
            self.assertEqual(data["panels"], [{"panel_id": "x"}])


if __name__ == "__main__":
    unittest.main()

