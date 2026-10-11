"""Offline regression checks for the public setup tool."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("site_setup", ROOT / "site" / "installers" / "setup.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def test_all_local_html_resources_and_links_exist(self):
        site = ROOT / "site"
        problems = []

        class Links(HTMLParser):
            def __init__(self, path):
                super().__init__()
                self.path = path

            def handle_starttag(self, tag, attrs):
                for key, value in attrs:
                    if key not in ("src", "href") or not value:
                        continue
                    url = urlsplit(value)
                    if url.scheme or url.netloc or not url.path:
                        continue
                    target = (site / unquote(url.path).lstrip("/") if url.path.startswith("/")
                              else self.path.parent / unquote(url.path))
                    if not target.exists():
                        problems.append(f"{self.path.name}: {value}")

        for page in site.glob("*.html"):
            Links(page).feed(page.read_text(encoding="utf-8"))
        self.assertEqual(problems, [])

    def test_unsupported_python_fails_before_any_install(self):
        for version in ((3, 10), (3, 13), (3, 14)):
            with self.subTest(version=version), patch.object(setup.sys, "version_info", version), \
                    patch.object(setup.sys, "argv", ["setup.py", "--check"]), \
                    patch.object(setup, "prepare") as prepare:
                with self.assertRaises(SystemExit) as error:
                    setup.main()
                self.assertEqual(error.exception.code, 2)
                prepare.assert_not_called()

    def test_existing_checkout_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "backend").mkdir()
            with patch.object(setup, "run") as run:
                with self.assertRaises(FileExistsError):
                    setup.prepare("backend", root)
                run.assert_not_called()

    def test_backend_sparse_checkout_and_isolated_health_check(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(setup, "run") as run:
            setup.prepare("backend", Path(directory))
            calls = run.call_args_list
            commands = [call.args for call in calls]
            self.assertIn(("git", "sparse-checkout", "set", "--no-cone", "/rabbit-os/"), commands)
            checkout = next(command for command in commands if "checkout" in command)
            self.assertEqual(checkout[:5], ("git", "-c", "core.protectNTFS=false", "checkout", "--detach"))
            self.assertLess(next(i for i, cmd in enumerate(commands) if "sparse-checkout" in cmd),
                            commands.index(checkout))
            health = next(call for call in calls if "TestClient" in " ".join(call.args))
            self.assertEqual(health.kwargs["env"]["DB_PATH"], ":memory:")
            self.assertEqual(health.kwargs["env"]["LLM_PROVIDER"], "mock")
            self.assertIn("client.get('/health')", health.args[-1])
            pip = next(command for command in commands if "install" in command)
            self.assertIn("requirements.txt", pip[-1])
            self.assertIn(".venv", pip[0])
            self.assertNotIn("sudo", " ".join(pip))

    def test_monitor_does_not_register_or_start_a_service(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(setup, "run") as run:
            setup.prepare("monitor", Path(directory))
            commands = [call.args for call in run.call_args_list]
            self.assertEqual(commands[-1][-2:], ("chain_monitor_agent.py", "--help"))
            text = " ".join(" ".join(command) for command in commands)
            self.assertNotIn("ScheduledTask", text)
            self.assertNotIn("systemctl", text)
            self.assertNotIn("--watch", text)
            self.assertNotIn("core.protectNTFS", text)

    def test_research_checks_dependencies_without_starting_orchestrator(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(setup, "run") as run:
            root = Path(directory)
            with patch.object(Path, "is_file", return_value=True):
                setup.prepare("research", root)
            commands = [call.args for call in run.call_args_list]
            self.assertEqual(commands[-1][-1], "import flask, requests, cryptography")
            self.assertFalse(any("orchestrator.py" in command for command in commands))

    def test_failed_command_stops_installation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            setup, "run", side_effect=subprocess.CalledProcessError(1, "git")
        ) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                setup.prepare("backend", Path(directory))
            self.assertEqual(run.call_count, 1)

    def test_homepage_uses_reviewable_setup_not_retired_shell_pipes(self):
        home = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("| iex", home)
        self.assertNotIn("| bash", home)
        self.assertNotIn("Helloworld/master/install.", home)
        self.assertIn("installers/setup.py", home)
        self.assertIn("--check", home)
        self.assertIn("--component all", home)
        self.assertIn("setup.html", home)
        self.assertTrue((ROOT / "site" / "setup.html").is_file())


if __name__ == "__main__":
    unittest.main()
