import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "vault_import", Path(__file__).with_name("import-github-vault.py")
)
vault_import = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vault_import)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / "snapshot.zip"
        self.destination = self.root / "repo"
        self.destination.mkdir()

    def make_archive(self, files):
        with zipfile.ZipFile(self.archive, "w") as bundle:
            for name, data in files:
                bundle.writestr(name, data)

    def test_complete_inventory_hashes_binary_and_lfs(self):
        self.make_archive([
            ("owner-repo-sha/", ""),
            ("owner-repo-sha/README.md", "# Example\n"),
            ("owner-repo-sha/nested/file.bin", b"\x00\xff\x01"),
            ("owner-repo-sha/model", "version https://git-lfs.github.com/spec/v1\n"),
        ])
        hashes, links, lfs, renamed = vault_import.extract_snapshot(
            self.archive, self.destination
        )
        self.assertEqual(set(hashes), {"README.md", "nested/file.bin", "model"})
        self.assertEqual((links, lfs), (0, 1))
        self.assertEqual(renamed, {})
        self.assertEqual(
            (self.destination / "nested" / "file.bin").read_bytes(), b"\x00\xff\x01"
        )
        record = {"name": "repo", "files": hashes}
        vault_import.verify(self.root, record)
        (self.destination / "README.md").write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "Checksum mismatch"):
            vault_import.verify(self.root, record)

    def test_symlink_is_text_not_an_active_link(self):
        with zipfile.ZipFile(self.archive, "w") as bundle:
            link = zipfile.ZipInfo("root/link")
            link.create_system = 3
            link.external_attr = 0o120777 << 16
            bundle.writestr(link, "../../outside")
        _, links, _, _ = vault_import.extract_snapshot(self.archive, self.destination)
        self.assertEqual(links, 1)
        self.assertFalse((self.destination / "link").is_symlink())
        self.assertEqual((self.destination / "link").read_text(), "../../outside")

    def test_unsafe_windows_and_traversal_paths_rejected(self):
        for name in ["root/../outside", "/root/file", "root\\..\\outside",
                     "root/CON.txt", "root/stream:secret", "root/name."]:
            with self.subTest(name=name):
                self.make_archive([(name, "content")])
                with self.assertRaises(RuntimeError):
                    vault_import.extract_snapshot(self.archive, self.destination)

    def test_multiple_roots_rejected(self):
        self.make_archive([("first/a", "a"), ("second/b", "b")])
        with self.assertRaisesRegex(RuntimeError, "exactly one root"):
            vault_import.extract_snapshot(self.archive, self.destination)

    def test_added_or_missing_files_fail_inventory_verification(self):
        self.make_archive([("root/a", "a")])
        hashes, _, _, _ = vault_import.extract_snapshot(self.archive, self.destination)
        record = {"name": "repo", "files": hashes}
        extra = self.destination / "extra"
        extra.write_text("extra")
        with self.assertRaisesRegex(RuntimeError, "inventory changed"):
            vault_import.verify(self.root, record)
        extra.unlink()
        (self.destination / "a").unlink()
        with self.assertRaisesRegex(RuntimeError, "inventory changed"):
            vault_import.verify(self.root, record)

    def test_sanitized_names_preserve_every_file_and_record_mapping(self):
        self.make_archive([
            ("root/Application\tStorage\tHub", "tabs"),
            ("root/Application_Storage_Hub", "underscores"),
            ("root/CON.txt", "reserved"),
            ("root/folder\t/a.md", "nested"),
            ("root/folder\t/b.md", "same directory"),
        ])
        hashes, _, _, renamed = vault_import.extract_snapshot(
            self.archive, self.destination, sanitize_windows_names=True
        )
        self.assertEqual(len(hashes), 5)
        self.assertEqual(len(renamed), 5)
        for original, local in renamed.items():
            self.assertTrue((self.destination / local).is_file())
            self.assertNotIn("\t", local)
        self.assertEqual(
            (self.destination / renamed["Application\tStorage\tHub"]).read_text(),
            "tabs",
        )
        self.assertEqual(
            Path(renamed["folder\t/a.md"]).parent,
            Path(renamed["folder\t/b.md"]).parent,
        )
        vault_import.verify(self.root, {"name": "repo", "files": hashes})


if __name__ == "__main__":
    unittest.main()
