import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "repo_audit", Path(__file__).with_name("audit-vault-repos.py")
)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class CoordinatorTests(unittest.TestCase):
    def test_no_speculative_description_for_empty_repo(self):
        text, source = audit.description_for({"description": None}, "", [".gitignore"])
        self.assertIn("owner confirmation", text)
        self.assertEqual(source, "File inventory only")

    def test_existing_description_and_readme_heading_are_attributed(self):
        self.assertEqual(
            audit.description_for({"description": "Original summary"}, "# Other", []),
            ("Original summary", "Existing GitHub repository description"),
        )
        text, source = audit.description_for({"description": None}, "# Project title\n", ["README.md"])
        self.assertEqual(text, "Project title")
        self.assertIn("review before publishing", source)

    def test_inventory_gaps_do_not_claim_build_failures(self):
        gaps = audit.documentation_gaps(["src/main.py"], "Tool")
        self.assertEqual({gap[0] for gap in gaps}, {"docs", "ci"})
        self.assertIn("not a failing build", gaps[-1][2])
        self.assertEqual(audit.documentation_gaps([], None, archived=True), [])

    def test_readme_and_workflow_patterns(self):
        files = ["README.rst", ".github/workflows/test.yaml", "src/main.py"]
        self.assertEqual(audit.documentation_gaps(files, "A tool"), [])

    def test_description_uses_prose_not_badges_or_code(self):
        readme = "# Project\n\n![badge](badge.png)\n\n```sh\nrun command\n```\n\nSource and deploy configuration.\n"
        text, source = audit.description_for({"description": None}, readme, ["README.md"])
        self.assertEqual(text, "Source and deploy configuration.")
        self.assertIn("README prose", source)

    def test_relationships_require_exact_github_url_not_name_guess(self):
        names = ["owner/repo", "owner/repo-extra", "owner/other"]
        self.assertEqual(
            audit.relationship_targets("https://github.com/owner/repo-extra/docs", names, "owner/other"),
            ["owner/repo-extra"],
        )
        self.assertEqual(audit.relationship_targets("owner/repo might be related", names, "owner/other"), [])

    def test_generated_notes_do_not_overwrite_user_authored_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "note.md"
            audit.generated_file(path, "# First")
            audit.generated_file(path, "# Second")
            self.assertIn("# Second", path.read_text())
            path.write_text("# My own note", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "user-authored"):
                audit.generated_file(path, "# Replacement")

    def test_markdown_table_metadata_escapes_pipe_and_newlines(self):
        self.assertEqual(audit.markdown("title|other\nline"), "title\\|other line")

    def test_in_progress_status_does_not_make_verified_history_appear_missing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            mirror = root / "History" / "owner" / "repo"
            mirror.mkdir(parents=True)
            (mirror / "HEAD").write_text("ref: refs/heads/main\n")
            verification = {
                "verified_at": "2026-10-11",
                "histories": [{"name": "owner/repo", "commits": 12}],
                "partial_repositories": ["owner/repo"],
            }
            with patch.object(audit.sync, "invalid_tree_paths", return_value=["bad\tname"]):
                state = audit.local_status(
                    root, {"full_name": "owner/repo", "default_branch": "main"}, None, verification
                )
            self.assertEqual(state["commits"], 12)
            self.assertIn("current-cycle status unavailable", state["status"])
            self.assertEqual(state["windows_incompatible_paths"], ["bad\tname"])
            self.assertEqual(len(state["errors"]), 1)
            self.assertNotEqual(state["status"], "ok")


if __name__ == "__main__":
    unittest.main()
