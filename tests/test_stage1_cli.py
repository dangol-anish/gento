import argparse
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from PIL import Image

from scripts.common.errors import AppError
from scripts.extractor import cli as stage1_cli
from scripts.extractor.panels import write_panel_outputs


class TestStage1Cli(unittest.TestCase):
    def test_collect_image_paths_sorts_pages_numerically(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("page5.jpg", "page6.jpg", "page10.jpg", "page2.jpg"):
                (root / name).write_bytes(b"")

            paths = stage1_cli.collect_image_paths([tmp])
            self.assertEqual([Path(p).name for p in paths], ["page2.jpg", "page5.jpg", "page6.jpg", "page10.jpg"])

    def test_write_panel_outputs_writes_panels_overlay_image(self):
        with TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            image_path = tmp_path / "page1.png"
            Image.new("RGB", (100, 80), (255, 255, 255)).save(image_path)

            out_root = tmp_path / "out"
            page_result = {
                "panels": [[10, 10, 40, 30], [50, 12, 90, 35]],
                "characters": [[12, 40, 28, 75]],
                "speech_bubbles": [[55, 40, 95, 70]],
                "texts": [[58, 44, 90, 55]],
            }

            write_panel_outputs(
                out_root=out_root,
                page_idx=0,
                image_path=str(image_path),
                page_result=page_result,
                page_ocr=None,
                chapter_slug="chapter_1",
                reading_direction="ltr",
            )

            overlay_path = out_root / "final" / "pages" / "000" / "panels_overlay.png"
            self.assertTrue(overlay_path.exists(), "expected panels_overlay.png to be written")
            self.assertGreater(overlay_path.stat().st_size, 0, "expected panels_overlay.png to be non-empty")

            detections_path = out_root / "final" / "pages" / "000" / "magi_detections_overlay.png"
            self.assertTrue(detections_path.exists(), "expected magi_detections_overlay.png to be written")
            self.assertGreater(detections_path.stat().st_size, 0, "expected magi_detections_overlay.png to be non-empty")

    def test_configure_offline_mode_sets_env_when_downloads_disallowed(self):
        with patch.dict(os.environ, {}, clear=True):
            stage1_cli._configure_offline_mode(allow_downloads=False)
            self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "1")
            self.assertEqual(os.environ.get("TRANSFORMERS_OFFLINE"), "1")

    def test_parse_args_rejects_empty_chapter_id(self):
        argv = ["prog", "--chapter-id", "   ", "--images", "/tmp/x.png", "--out", "/tmp/out"]
        with patch("sys.argv", argv):
            with self.assertRaises(AppError) as ctx:
                stage1_cli.parse_args()
        self.assertEqual(ctx.exception.code, "INVALID_REQUEST")

    def test_parse_args_rejects_unknown_model(self):
        argv = [
            "prog",
            "--chapter-id",
            "chapter_1",
            "--images",
            "/tmp/x.png",
            "--out",
            "/tmp/out",
            "--model",
            "some/other",
        ]
        with patch("sys.argv", argv):
            with self.assertRaises(AppError) as ctx:
                stage1_cli.parse_args()
        self.assertEqual(ctx.exception.code, "INVALID_REQUEST")
        self.assertIn("Only", ctx.exception.message)

    def test_run_stage_uses_model_loader_and_emits_complete(self):
        args = argparse.Namespace(
            chapter_id="chapter_1",
            images=["/tmp/images"],
            out="/tmp/out",
            device="cpu",
            model=stage1_cli.STAGE1_MODEL,
            allow_downloads=False,
            debug=False,
        )

        emitted = []

        def fake_emit(event_type: str, **payload):
            emitted.append((event_type, payload))

        with patch.object(stage1_cli, "parse_args", return_value=args), patch.object(
            stage1_cli, "collect_image_paths", return_value=["/tmp/a.png", "/tmp/b.png"]
        ), patch.object(stage1_cli, "load_image", return_value="IMG"), patch.object(
            stage1_cli, "load_magi_model", return_value=("MODEL", "PROC", "cpu")
        ) as load_magi_model, patch.object(
            stage1_cli, "predict_page", return_value=({"panels": []}, {"ocr": []})
        ), patch.object(
            stage1_cli, "write_panel_outputs", return_value=[{"panel_id": "p"}]
        ), patch.object(
            stage1_cli, "build_storyboard", return_value=Path("/tmp/out/final/storyboard.json")
        ), patch.object(stage1_cli, "emit", side_effect=fake_emit):
            stage1_cli._run_stage()

        # ensure model loader used local_files_only when downloads are disallowed
        load_magi_model.assert_called_once()
        self.assertEqual(load_magi_model.call_args.args[0], stage1_cli.STAGE1_MODEL)
        self.assertEqual(load_magi_model.call_args.args[1], "cpu")
        self.assertEqual(load_magi_model.call_args.args[2], True)

        # last progress should be 100 before complete
        progress_events = [evt for evt in emitted if evt[0] == "progress"]
        self.assertTrue(progress_events, "expected at least one progress event")
        self.assertEqual(progress_events[-1][1].get("percent"), 100)

        complete_events = [evt for evt in emitted if evt[0] == "complete"]
        self.assertEqual(len(complete_events), 1)
        self.assertEqual(complete_events[0][1]["stage"], 1)
        self.assertIn("storyboard_path", complete_events[0][1])

    def test_run_stage_raises_when_no_images_found(self):
        args = argparse.Namespace(
            chapter_id="chapter_1",
            images=["/tmp/images"],
            out="/tmp/out",
            device="cpu",
            model=stage1_cli.STAGE1_MODEL,
            allow_downloads=False,
            debug=False,
        )
        with patch.object(stage1_cli, "parse_args", return_value=args), patch.object(
            stage1_cli, "collect_image_paths", return_value=[]
        ):
            with self.assertRaises(AppError) as ctx:
                stage1_cli._run_stage()
        self.assertEqual(ctx.exception.code, "INVALID_REQUEST")

    def test_main_exits_nonzero_on_app_error(self):
        with patch.object(stage1_cli, "_run_stage", side_effect=AppError("INVALID_REQUEST", "nope")), patch(
            "scripts.common.events.emit", return_value=None
        ):
            with self.assertRaises(SystemExit) as ctx:
                stage1_cli.main()
        self.assertEqual(ctx.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
