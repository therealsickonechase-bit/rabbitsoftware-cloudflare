"""Offline checks for sync-huggingface-vault.py. Run: python -B scripts/test-sync-huggingface-vault.py"""

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("hfsync", Path(__file__).with_name("sync-huggingface-vault.py"))
hfsync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hfsync)

INFO = {"id": "someone/Tiny-Model", "private": True, "likes": 2, "downloads": 7, "lastModified": "2026-10-01T00:00:00.000Z",
        "pipeline_tag": "text-generation", "tags": ["gguf", "llama 3"],
        "siblings": [{"rfilename": "model.gguf", "size": 2 * 1024 ** 3}, {"rfilename": "README.md"}]}


class NoteTests(unittest.TestCase):
    def test_model_note_has_front_matter_files_card_and_readme(self):
        path, text = hfsync.repo_note("models", INFO, "---\nlicense: mit\n---\n# Tiny\nHello")
        self.assertEqual(path, "Models/Tiny-Model.md")
        self.assertTrue(text.startswith('---\ntype: "huggingface-model"\nid: "someone/Tiny-Model"'))
        self.assertIn('private: true', text)
        self.assertIn("- `model.gguf` (2.0 GB)", text)
        self.assertIn("```yaml\nlicense: mit\n```", text)
        self.assertIn("## README\n\n# Tiny\nHello", text)
        self.assertIn('"llama-3"', text)

    def test_spaces_and_datasets_use_their_url_prefix_and_folder(self):
        path, text = hfsync.repo_note("spaces", {"id": "a/b", "sdk": "gradio"}, None)
        self.assertEqual(path, "Spaces/b.md")
        self.assertIn("https://huggingface.co/spaces/a/b", text)
        self.assertIn("_No README._", text)
        self.assertEqual(hfsync.repo_note("datasets", {"id": "a/x.jsonl"}, "")[0], "Datasets/x.jsonl.md")

    def test_names_are_safe_on_windows(self):
        self.assertEqual(hfsync.safe_name("CON"), "_CON")
        self.assertEqual(hfsync.safe_name("a:b?[c]."), "a_b__c_")

    def test_index_links_every_repo(self):
        text = hfsync.index_note("someone", [("models", "Models/Tiny-Model.md", INFO)])
        self.assertIn("[[Models/Tiny-Model|Tiny-Model]] (private)", text)
        self.assertIn("## Spaces (0)", text)


class VaultTests(unittest.TestCase):
    def test_library_must_be_git_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            vault = Path(folder)
            with self.assertRaises(RuntimeError):
                hfsync.ignored_library(vault)
            (vault / ".obsidian").mkdir()
            subprocess.run(["git", "init", "-q", str(vault)], check=True)
            with self.assertRaisesRegex(RuntimeError, "must be ignored"):
                hfsync.ignored_library(vault)
            (vault / ".gitignore").write_text("/Hugging Face/\n")
            self.assertEqual(hfsync.ignored_library(vault), vault / "Hugging Face")

    def test_unchanged_notes_are_not_rewritten(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "a" / "b.md"
            self.assertTrue(hfsync.write_if_changed(path, "x"))
            self.assertFalse(hfsync.write_if_changed(path, "x"))
            self.assertTrue(hfsync.write_if_changed(path, "y"))
            self.assertTrue(hfsync.write_if_changed(path, "line\r\nend"))
            self.assertFalse(hfsync.write_if_changed(path, "line\r\nend"))
            self.assertEqual(path.read_bytes(), b"line\nend")


if __name__ == "__main__":
    unittest.main()
