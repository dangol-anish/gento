import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.render_video import _resolve_media_path


class TestStage6ResolveMediaPath(unittest.TestCase):
    def test_resolves_mismatched_run_dir_prefix(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            out_root = root / "output"
            run_dir = out_root / "final"
            final_script = run_dir / "final_script.json"
            final_script.parent.mkdir(parents=True, exist_ok=True)
            final_script.write_text("{}", encoding="utf-8")

            # Actual panel path lives under output/final/...
            actual = run_dir / "pages" / "000" / "panels" / "000" / "panel.png"
            actual.parent.mkdir(parents=True, exist_ok=True)
            actual.write_bytes(b"x")

            # But JSON references a different run-dir prefix (e.g. user renamed folder).
            resolved = _resolve_media_path(final_script, "final_1/pages/000/panels/000/panel.png")
            self.assertEqual(resolved.resolve(), actual.resolve())

