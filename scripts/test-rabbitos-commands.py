"""Verify command previews without installs, remote writes, or application startup."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "rabbitos-commands.ps1"


@unittest.skipUnless(shutil.which("pwsh"), "PowerShell 7 is required")
class CommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="RabbitOS commands ' ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for marker in (
            "scripts\\sync-github-vault.py", "src\\lib\\tasks.ts",
            "rabbit-os\\core\\event_bus.py", "package-lock.json",
        ):
            path = self.root / marker
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}")

    def run_script(self, area, action, *extra):
        return subprocess.run(
            ["pwsh", "-NoProfile", "-File", str(SCRIPT), "-Area", area,
             "-Action", action, "-Repository", str(self.root), *extra],
            text=True, capture_output=True, check=False,
        )

    def test_all_local_validation_previews(self):
        expected = {
            "cloudflare": "test-rabbitos-commands.py",
            "console": "'--no-install' 'tsc' '--noEmit'",
            "core": "'discover' '-s' 'tests'",
        }
        for area, command in expected.items():
            with self.subTest(area=area):
                result = self.run_script(area, "Validate", "-Preview")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(command, result.stdout)
                self.assertIn("''", result.stdout)

    def test_remote_actions_are_preview_only_without_a_preview_flag(self):
        for area in ("cloudflare", "console", "core"):
            for action in ("PublishCommands", "DeployCommands"):
                with self.subTest(area=area, action=action):
                    result = self.run_script(area, action)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("PREVIEW ONLY", result.stdout)
                    if action == "PublishCommands" or area != "core":
                        self.assertIn('if ($LASTEXITCODE -ne 0)', result.stdout)
        self.assertFalse((self.root / ".git").exists())
        self.assertFalse((self.root / "node_modules").exists())

    def test_local_workers_use_dev_config_and_disable_remote_bindings(self):
        for target in ("sync", "node-worker", "gateway"):
            result = self.run_script("cloudflare", "Dev", "-Target", target, "-Preview")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"workers\\{target}\\wrangler.dev.toml", result.stdout)
            self.assertIn("'--local'", result.stdout)
            self.assertNotIn("'--remote'", result.stdout)

    def test_missing_checkout_and_unverified_core_start_fail(self):
        missing = self.root / "rabbit-os" / "core" / "event_bus.py"
        missing.unlink()
        result = self.run_script("core", "Validate", "-Preview")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing", result.stderr)
        missing.write_text("")
        result = self.run_script("core", "Dev", "-Preview")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not been verified", result.stderr)

    def test_setup_preview_does_not_install_dependencies(self):
        for area in ("cloudflare", "console", "core"):
            result = self.run_script(area, "Setup", "-Preview")
            self.assertEqual(result.returncode, 0, result.stderr)
            if area == "core":
                self.assertNotIn("'ci'", result.stdout)
            else:
                self.assertIn("'npm.cmd' 'ci'", result.stdout)
        self.assertFalse((self.root / "node_modules").exists())

    def test_vault_and_worker_deploy_commands_only_print(self):
        result = self.run_script("cloudflare", "VaultCommands", "-Vault", str(self.root))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--verify-only", result.stdout)
        self.assertNotIn("Register-ScheduledTask", result.stdout)
        self.assertFalse((self.root / "Computer").exists())
        for target in ("sync", "node-worker", "gateway"):
            result = self.run_script("cloudflare", "DeployCommands", "-Target", target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("--dry-run", result.stdout)
            self.assertIn(f"workers\\{target}\\wrangler.toml", result.stdout)
            self.assertIn("PREVIEW ONLY", result.stdout)

    def test_failed_native_command_stops_the_sequence(self):
        (self.root / "tests").mkdir()
        (self.root / "tests" / "test_failure.py").write_text(
            "import unittest\n"
            "class Failure(unittest.TestCase):\n"
            "    def test_fail(self): self.fail('intentional fixture failure')\n"
        )
        result = self.run_script("core", "Validate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Remaining commands were not run", result.stderr)
        self.assertNotIn("'diff' '--check'", result.stdout)

    def test_run_tasks_are_explicit_and_remote_tasks_only_show_commands(self):
        tasks = json.loads((ROOT / ".vscode" / "tasks.json").read_text())["tasks"]
        self.assertEqual(len({task["label"] for task in tasks}), len(tasks))
        for task in tasks:
            self.assertTrue(task["inAgents"])
            self.assertNotIn("runOptions", task)
            self.assertEqual(task["type"], "process")
            self.assertEqual(task["command"], "pwsh")
            self.assertIn("rabbitos-commands.ps1", task["args"][2])
            if "publication" in task["label"] or "deployment" in task["label"]:
                action = task["args"][task["args"].index("-Action") + 1]
                self.assertIn(action, ("PublishCommands", "DeployCommands"))


if __name__ == "__main__":
    unittest.main()
