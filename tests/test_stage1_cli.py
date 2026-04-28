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
                write_overlays=True,
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
            reading_direction="rtl",
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

    def test_run_stage_multi_chapter_emits_storyboard_paths(self):
        with TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            ch1 = tmp_path / "ch1"
            ch2 = tmp_path / "ch2"
            ch1.mkdir(parents=True, exist_ok=True)
            ch2.mkdir(parents=True, exist_ok=True)

            args = argparse.Namespace(
                chapter_id="chapter",
                images=[str(ch1), str(ch2)],
                out=str(tmp_path / "out"),
                device="cpu",
                model=stage1_cli.STAGE1_MODEL,
                allow_downloads=False,
                debug=False,
                reading_direction="rtl",
            )

            emitted = []

            def fake_emit(event_type: str, **payload):
                emitted.append((event_type, payload))

            def fake_collect_image_paths(inputs):
                if inputs == [str(ch1)]:
                    return [str(ch1 / "a.png")]
                if inputs == [str(ch2)]:
                    return [str(ch2 / "b.png")]
                return []

            with patch.object(stage1_cli, "parse_args", return_value=args), patch.object(
                stage1_cli, "collect_image_paths", side_effect=fake_collect_image_paths
            ), patch.object(stage1_cli, "load_image", return_value="IMG"), patch.object(
                stage1_cli, "load_magi_model", return_value=("MODEL", "PROC", "cpu")
            ), patch.object(
                stage1_cli, "predict_page", return_value=({"panels": []}, {"ocr": []})
            ), patch.object(
                stage1_cli, "write_panel_outputs", return_value=[{"panel_id": "p"}]
            ) as write_panel_outputs, patch.object(
                stage1_cli,
                "build_storyboard",
                side_effect=[
                    Path(tmp_path / "out" / "final_1" / "storyboard.json"),
                    Path(tmp_path / "out" / "final_2" / "storyboard.json"),
                ],
            ), patch.object(stage1_cli, "emit", side_effect=fake_emit):
                stage1_cli._run_stage()

            # ensure final_dir_name switches per chapter
            final_dir_names = [call.kwargs.get("final_dir_name") for call in write_panel_outputs.call_args_list]
            self.assertEqual(final_dir_names, ["final_1", "final_2"])

            complete_events = [evt for evt in emitted if evt[0] == "complete"]
            self.assertEqual(len(complete_events), 1)
            self.assertIn("storyboard_paths", complete_events[0][1])
            self.assertEqual(
                complete_events[0][1]["storyboard_paths"],
                [
                    str(tmp_path / "out" / "final_1" / "storyboard.json"),
                    str(tmp_path / "out" / "final_2" / "storyboard.json"),
                ],
            )

    def test_main_exits_nonzero_on_app_error(self):
        with patch.object(stage1_cli, "_run_stage", side_effect=AppError("INVALID_REQUEST", "nope")), patch(
            "scripts.common.events.emit", return_value=None
        ):
            with self.assertRaises(SystemExit) as ctx:
                stage1_cli.main()
        self.assertEqual(ctx.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
