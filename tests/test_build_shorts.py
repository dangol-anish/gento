import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.build_shorts import _chapter_name_for, _expand_adjacent_panel_paths, _sanitize_folder_name, _find_panel_files


class TestBuildShorts(unittest.TestCase):
    def test_sanitize_folder_name_replaces_invalid_chars(self):
        self.assertEqual(
            _sanitize_folder_name('Magus/Library: Chapter?"<>|'),
            'Magus_Library_ Chapter_',
        )

    def test_expand_adjacent_panel_paths_for_numeric_panel_folder(self):
        paths = _expand_adjacent_panel_paths('final_1/pages/010/panels/003/panel.png')
        self.assertIn('final_1/pages/010/panels/002/panel.png', paths)
        self.assertIn('final_1/pages/010/panels/004/panel.png', paths)

    def test_expand_adjacent_panel_paths_for_numeric_filename(self):
        paths = _expand_adjacent_panel_paths('chapter_1/panel3.jpg')
        self.assertIn('chapter_1/panel2.jpg', paths)
        self.assertIn('chapter_1/panel4.jpg', paths)

    def test_chapter_name_for_finds_source_chapter(self):
        path = Path('/tmp/output/Magus of the Library/Chapter 2/final_1/pages/010/panels/003/panel.png')
        manga_root = Path('/tmp/output/Magus of the Library')
        self.assertEqual(
            _chapter_name_for(path, manga_root, ['Chapter 1', 'Chapter 2']),
            'Chapter 2',
        )

    def test_find_panel_files_matches_suffix_under_search_root(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            nested = root / 'Magus of the Library' / 'Chapter 1' / 'final_1' / 'pages' / '010' / 'panels' / '003'
            nested.mkdir(parents=True)
            file_path = nested / 'panel.png'
            file_path.write_text('dummy')

            matches = _find_panel_files('final_1/pages/010/panels/003/panel.png', root)
            self.assertEqual({file_path}, matches)

            matches = _find_panel_files('Chapter 1/final_1/pages/010/panels/003/panel.png', root)
            self.assertEqual({file_path}, matches)
