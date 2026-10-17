import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("github_bundles", Path(__file__).with_name("github-bundles.py"))
gb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gb)


def run(folder, *args):
    subprocess.run(["git", "-C", str(folder), *args], check=True, capture_output=True)


def make_repo(folder, files):
    folder.mkdir(parents=True)
    run(folder, "init", "-q", "-b", "main")
    run(folder, "config", "user.email", "t@example.com")
    run(folder, "config", "user.name", "t")
    for name, text in files.items():
        (folder / name).write_text(text)
    run(folder, "add", "-A")
    run(folder, "commit", "-q", "-m", "first")


class Bundles(unittest.TestCase):
    def test_bundle_verify_restore_and_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            root = tmp / "vault" / "GitHub Live" / "Repositories" / "org"
            make_repo(root / "alpha", {"a.txt": "hello"})
            make_repo(root / "beta", {"b.txt": "world"})
            (root / "empty").mkdir()
            run(root / "empty", "init", "-q")
            out = tmp / "out"
            argv = ["--vault", str(tmp / "vault"), "--out", str(out)]
            import sys
            old = sys.argv
            try:
                sys.argv = ["x", *argv]
                self.assertEqual(gb.main(), 0)
                manifest = json.loads((out / "manifest.json").read_text())
                by = {e["repo"]: e for e in manifest["repositories"]}
                self.assertEqual(by["org/alpha"]["status"], "bundled")
                self.assertEqual(by["org/empty"]["status"], "empty")
                self.assertEqual(by["org/alpha"]["commits"], 1)
                self.assertEqual(gb.verify(out, manifest), [])
                # the bundle restores to the same files and commit
                clone = tmp / "restored"
                subprocess.run(["git", "clone", "-q", str(out / "org" / "alpha.bundle"), str(clone)], check=True, capture_output=True)
                self.assertEqual((clone / "a.txt").read_text(), "hello")
                self.assertEqual(gb.git(clone, "rev-parse", "HEAD").strip(), by["org/alpha"]["head"])
                # second run: nothing moved, nothing re-bundled
                self.assertEqual(gb.main(), 0)
                again = {e["repo"]: e for e in json.loads((out / "manifest.json").read_text())["repositories"]}
                self.assertEqual(again["org/alpha"]["status"], "unchanged")
                # a new commit changes only that repo
                (root / "beta" / "b.txt").write_text("changed")
                run(root / "beta", "commit", "-qam", "second")
                self.assertEqual(gb.main(), 0)
                third = {e["repo"]: e for e in json.loads((out / "manifest.json").read_text())["repositories"]}
                self.assertEqual((third["org/alpha"]["status"], third["org/beta"]["status"], third["org/beta"]["commits"]), ("unchanged", "bundled", 2))
                # tampering is caught
                (out / "org" / "alpha.bundle").write_bytes(b"corrupt")
                self.assertTrue(gb.verify(out, json.loads((out / "manifest.json").read_text())))
                sys.argv = ["x", *argv, "--verify-only"]
                self.assertEqual(gb.main(), 1)
            finally:
                sys.argv = old


if __name__ == "__main__":
    unittest.main()
