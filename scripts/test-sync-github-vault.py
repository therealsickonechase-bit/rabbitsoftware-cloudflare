import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "live_sync", Path(__file__).with_name("sync-github-vault.py")
)
live_sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live_sync)
index_spec = importlib.util.spec_from_file_location(
    "library_index", Path(__file__).with_name("index-vault-library.py")
)
library_index = importlib.util.module_from_spec(index_spec)
index_spec.loader.exec_module(library_index)


class LiveSyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.repo = {
            "full_name": "owner/repo", "default_branch": "main",
            "private": False, "archived": False,
        }

    def test_credential_paths_and_content_block_automatic_publication(self):
        for name in [".env", ".env.local", "nested/key.pem", "private-cloud-data/file"]:
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                live_sync.validate_publish_files(self.folder, [name])
        path = self.folder / "file.txt"
        path.write_text("-----BEGIN PRIVATE KEY-----\n")
        with self.assertRaisesRegex(RuntimeError, "credential content"):
            live_sync.validate_publish_files(self.folder, ["file.txt"])

    def test_normal_edits_are_eligible(self):
        (self.folder / "README.md").write_text("# Updated project\n")
        live_sync.validate_publish_files(self.folder, ["README.md"])

    def test_staged_changes_require_manual_review(self):
        with patch.object(live_sync, "git", return_value=b"M  README.md\0"):
            with self.assertRaisesRegex(RuntimeError, "Staged"):
                live_sync.changed_files(self.folder)

    def test_unstaged_and_new_names_are_preserved(self):
        with patch.object(live_sync, "git", return_value=b" M file with spaces.md\0?? new.md\0"):
            self.assertEqual(
                live_sync.changed_files(self.folder), ["file with spaces.md", "new.md"]
            )

    def mock_git(self, *args, **kwargs):
        if args[1:3] == ("symbolic-ref", "--short"):
            return "main\n"
        if args[1] == "status":
            return b""
        if args[1] == "rev-list":
            return "0 0\n" if "--left-right" in args else "0\n"
        return ""

    def test_private_and_archived_repos_never_auto_push(self):
        for property_name in ["private", "archived"]:
            repo = {**self.repo, property_name: True}
            with self.subTest(property_name=property_name):
                with patch.object(live_sync, "git", side_effect=self.mock_git) as git:
                    with patch.object(live_sync.subprocess, "run",
                                      return_value=subprocess.CompletedProcess([], 0)):
                        with self.assertRaisesRegex(RuntimeError, "forbidden"):
                            live_sync.update_worktree(self.folder, repo, publish=True)
                self.assertFalse(any(call.args[1] in ("commit", "push") for call in git.call_args_list))

    def test_setup_never_commits_or_pushes(self):
        with patch.object(live_sync, "git", side_effect=self.mock_git) as git:
            with patch.object(live_sync.subprocess, "run",
                              return_value=subprocess.CompletedProcess([], 0)):
                live_sync.update_worktree(self.folder, self.repo, publish=False)
        self.assertFalse(any(call.args[1] in ("commit", "push") for call in git.call_args_list))

    def test_divergence_stops_without_rebase_or_stash(self):
        def divergent(*args, **kwargs):
            if args[1] == "rev-list":
                return "1 1\n"
            return self.mock_git(*args, **kwargs)
        with patch.object(live_sync, "git", side_effect=divergent) as git:
            with patch.object(live_sync.subprocess, "run",
                              return_value=subprocess.CompletedProcess([], 0)):
                with self.assertRaisesRegex(RuntimeError, "Remote advanced"):
                    live_sync.update_worktree(self.folder, self.repo, publish=True)
        self.assertFalse(any(
            call.args[1] in ("commit", "push", "rebase", "stash", "merge")
            for call in git.call_args_list
        ))

    def test_public_edits_commit_then_push_without_force(self):
        def modified(*args, **kwargs):
            if args[1] == "status":
                return b" M README.md\0"
            if args[1] == "rev-list" and "--count" in args and "--left-right" not in args:
                return "1\n"
            return self.mock_git(*args, **kwargs)
        (self.folder / "README.md").write_text("# Public update\n")
        with patch.object(live_sync, "git", side_effect=modified) as git:
            with patch.object(live_sync.subprocess, "run",
                              return_value=subprocess.CompletedProcess([], 0)):
                live_sync.update_worktree(self.folder, self.repo, publish=True)
        verbs = [call.args[1] for call in git.call_args_list]
        self.assertLess(verbs.index("commit"), verbs.index("push"))
        self.assertTrue(any(live_sync.TRAILER in call.args for call in git.call_args_list))
        self.assertFalse(any("--force" in call.args for call in git.call_args_list))

    def test_release_name_sanitization(self):
        self.assertEqual(live_sync.safe_component("CON.txt"), "_CON.txt")
        self.assertEqual(live_sync.safe_component("a/b\tc"), "a_b_c")

    def test_bare_histories_use_explicit_git_directory(self):
        (self.folder / "HEAD").write_text("ref: refs/heads/main\n")
        with patch.object(live_sync, "command", return_value="") as command:
            live_sync.git(self.folder, "fetch", "origin")
        self.assertIn("--git-dir=" + str(self.folder), command.call_args.args)

    def test_actual_git_two_way_sync_with_local_remote(self):
        remote = self.folder / "remote.git"
        working = self.folder / "working"
        other = self.folder / "other"
        live_sync.command("git", "init", "--bare", "--initial-branch=main", str(remote))
        live_sync.command("git", "clone", str(remote), str(working))
        live_sync.git(working, "config", "user.name", "Vault Sync Test")
        live_sync.git(working, "config", "user.email", "test@example.invalid")
        (working / "README.md").write_text("# Outgoing edit\n")
        live_sync.update_worktree(working, self.repo, publish=True)
        self.assertEqual(
            live_sync.git(working, "rev-parse", "HEAD").strip(),
            live_sync.git(remote, "rev-parse", "refs/heads/main").strip(),
        )
        self.assertIn(live_sync.TRAILER, live_sync.git(working, "log", "-1", "--format=%B"))
        live_sync.command("git", "clone", str(remote), str(other))
        live_sync.git(other, "config", "user.name", "Vault Sync Test")
        live_sync.git(other, "config", "user.email", "test@example.invalid")
        (other / "README.md").write_text("# Incoming edit\n")
        live_sync.git(other, "add", "--all")
        live_sync.git(other, "commit", "-m", "Incoming change")
        live_sync.git(other, "push", "origin", "main")
        live_sync.git(working, "fetch", "origin")
        live_sync.update_worktree(working, self.repo, publish=True)
        self.assertEqual((working / "README.md").read_text(), "# Incoming edit\n")

    def test_metadata_inventory_excludes_vault_and_marks_recordings(self):
        source = self.folder / "Documents"
        source.mkdir()
        vault = source / "RabbitOS Vault"
        vault.mkdir()
        (source / "recording.wav").write_bytes(b"not-read-as-audio")
        (source / "notes.txt").write_text("not read as model context")
        (vault / "excluded.md").write_text("no recursive import")
        files, errors = library_index.inventory(vault, [source])
        self.assertEqual(errors, [])
        self.assertEqual(len(files), 2)
        self.assertEqual(sum(file["recording"] for file in files), 1)
        self.assertFalse(any(Path(file["path"]).is_relative_to(vault) for file in files))
        self.assertTrue(all("contents" not in file for file in files))

    def test_full_sync_preserves_previous_repository_status_during_incremental_updates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "policy.json").write_text(json.dumps({
                "owner": "owner", "auto_push_private": False, "auto_push_public": True,
            }), encoding="utf-8")
            (root / "status.json").write_text(json.dumps({
                "updated_at": "previous-cycle", "repositories": [
                    {"name": "owner/previous", "private": True, "archived": False,
                     "auto_push": False, "status": "ok", "errors": [], "commits": 3},
                ],
            }), encoding="utf-8")
            repo = {
                "full_name": "owner/current", "owner": {"login": "owner"},
                "private": True, "archived": False, "default_branch": "main",
            }
            def fake_api(endpoint, pages=False):
                return {"login": "owner"} if endpoint == "user" else [repo]
            with patch.object(live_sync, "api", side_effect=fake_api):
                with patch.object(live_sync, "ensure_clone", side_effect=RuntimeError("network unavailable")):
                    self.assertEqual(live_sync.sync(root, setup=True), 1)
            state = json.loads((root / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(
                {entry["name"] for entry in state["repositories"]},
                {"owner/previous", "owner/current"},
            )
            self.assertTrue((root / "last-completed-status.json").is_file())

    def test_metadata_inventory_checks_file_link_boundaries(self):
        source = self.folder / "Documents"
        source.mkdir()
        vault = source / "RabbitOS Vault"
        vault.mkdir()
        outside = self.folder / "Unapproved"
        outside.mkdir()
        external = outside / "external.wav"
        external.write_bytes(b"external")
        excluded = vault / "excluded.txt"
        excluded.write_text("vault")
        approved = source / "approved.wav"
        approved.write_bytes(b"approved")
        targets = {
            source / "external-link.wav": external,
            source / "vault-link.txt": excluded,
            source / "approved-link.wav": approved,
        }
        for link in targets:
            link.write_text("stand-in for a Windows file link")
        original_resolve = Path.resolve

        def resolve(path, *args, **kwargs):
            return targets.get(path) or original_resolve(path, *args, **kwargs)

        with patch.object(Path, "resolve", resolve):
            files, errors = library_index.inventory(vault, [source])
        names = {Path(file["path"]).name for file in files}
        self.assertEqual(names, {"approved.wav", "approved-link.wav"})
        self.assertEqual(errors, [{
            "path": str(source / "external-link.wav"),
            "error": "External file link not followed",
        }])

    def test_metadata_inventory_scans_canonical_alias_target_once(self):
        source = self.folder / "Music"
        source.mkdir()
        recording = source / "recording.wav"
        recording.write_bytes(b"not-read")
        alias = self.folder / "Documents Music"
        original_resolve = Path.resolve

        def resolve(path, *args, **kwargs):
            return source if path == alias else original_resolve(path, *args, **kwargs)

        with patch.object(Path, "resolve", resolve):
            with patch.object(library_index.os, "scandir", wraps=library_index.os.scandir) as scan:
                with patch.object(Path, "open", side_effect=AssertionError("Do not read file contents")):
                    files, errors = library_index.inventory(self.folder / "Vault", [alias, source])
        self.assertEqual(errors, [])
        self.assertEqual([file["path"] for file in files], [str(recording)])
        scan.assert_called_once_with(source)


if __name__ == "__main__":
    unittest.main()
