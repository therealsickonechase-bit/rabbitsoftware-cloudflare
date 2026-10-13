"""Prepare separate RabbitSoftware prototypes without starting services."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys


COMPONENTS = {
    "backend": (
        "RABBIT-SOFTWARE", "688857c30ab3d81e9491de689f41ff2719ca2d0c",
        "rabbit-os", "requirements.txt",
    ),
    "monitor": (
        "dna-chain", "2897f87f8d63bee9eeba3a63f25382a3a45dab69", ".", None,
    ),
    "research": (
        "cancer-mutation-blockchain", "1518685a92acfb3a8935c5b516db8e712dea2c58",
        ".", "requirements.txt",
    ),
}


def run(*args, cwd=None, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True, timeout=600)


def prepare(component, root):
    repo, revision, folder, requirements = COMPONENTS[component]
    destination = root / component
    if destination.exists():
        raise FileExistsError(f"Refusing to overwrite {destination}; select a new directory.")
    destination.mkdir(parents=True)
    run("git", "init", str(destination))
    run("git", "remote", "add", "origin",
        f"https://github.com/rabbitsoftware-io/{repo}.git", cwd=destination)
    if component == "backend":
        run("git", "sparse-checkout", "init", "--no-cone", cwd=destination)
        run("git", "sparse-checkout", "set", "--no-cone", "/rabbit-os/", cwd=destination)
    run("git", "fetch", "--depth=1", "origin", revision, cwd=destination)
    if component == "backend":
        # Git must index legacy Windows-invalid paths, but sparse checkout never writes them.
        run("git", "-c", "core.protectNTFS=false", "checkout", "--detach", revision, cwd=destination)
    else:
        run("git", "checkout", "--detach", revision, cwd=destination)
    run(sys.executable, "-m", "venv", str(destination / ".venv"))
    python = destination / ".venv" / ("Scripts" if os.name == "nt" else "bin") / (
        "python.exe" if os.name == "nt" else "python"
    )
    source = destination / folder
    if requirements:
        run(str(python), "-m", "pip", "install", "-r", str(source / requirements))
    run(str(python), "-m", "pip", "check")
    if component == "backend":
        env = dict(os.environ, LLM_PROVIDER="mock", DB_PATH=":memory:")
        run(str(python), "-B", "-c",
            "from fastapi.testclient import TestClient; from core.main import app\n"
            "with TestClient(app) as client:\n"
            "    response = client.get('/health')\n"
            "    assert response.status_code == 200, response.text\n"
            "    assert response.json()['status'] == 'ok', response.text\n",
            cwd=source, env=env)
        print(f'Backend ready. From "{source}", run:\n'
              f'"{python}" -m uvicorn core.main:app --host 127.0.0.1 --port 8000')
    elif component == "monitor":
        run(str(python), "-B", "chain_monitor_agent.py", "--help", cwd=source)
        print(f'Monitor prepared at "{source}". Only --help was tested; '
              "no network scan or scheduled service was started.")
    else:
        run(str(python), "-B", "-c", "import flask, requests, cryptography", cwd=source)
        if not (source / "orchestrator.py").is_file():
            raise FileNotFoundError(f"Missing research entry point in {source}")
        print(f'Research dependencies prepared at "{source}". '
              "No research services, public uploads or tunnels were started.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", choices=(*COMPONENTS, "all"), default="backend")
    parser.add_argument("--directory", type=Path, default=Path("rabbitsoftware-local"))
    parser.add_argument("--check", action="store_true", help="Check prerequisites without installing.")
    args = parser.parse_args()
    if not (3, 11) <= sys.version_info[:2] <= (3, 12):
        parser.error("Python 3.11 or 3.12 is required by these pinned dependencies; "
                     "use Python 3.11 for the backend CI baseline.")
    if not shutil.which("git"):
        parser.error("Git is required. Install Git, then reopen your terminal.")
    if args.check:
        print(f"Prerequisites available: Python {sys.version.split()[0]} and Git.")
        return
    root = args.directory.resolve()
    for component in COMPONENTS if args.component == "all" else (args.component,):
        prepare(component, root)


if __name__ == "__main__":
    main()
