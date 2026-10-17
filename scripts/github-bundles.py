"""Pack every GitHub Live mirror into one verified git bundle (full history, all branches and tags) plus a manifest.

The mirrors in <vault>/GitHub Live/Repositories/<owner>/<repo> were taken from GitHub while the organisation's admin account still worked. This script
turns each of them into <out>/<owner>/<repo>.bundle and writes <out>/manifest.json (repo, head commit, ref digest, commit count, size, SHA-256), so the
history can live in Google Cloud and be restored with `git clone <repo>.bundle` without GitHub or any account. Nothing in the mirrors is changed.
A repo is only re-bundled when its refs changed since the last run.

    python github-bundles.py --vault "C:/Users/odaat/Documents/RabbitOS Vault" --out "%LOCALAPPDATA%/RabbitOS/github-bundles"
    python github-bundles.py ... --verify-only      # check the bundles against the manifest, change nothing
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1"}


def git(folder, *args, check=True):
    result = subprocess.run(["git", "-C", str(folder), *args], capture_output=True, text=True, encoding="utf-8", errors="replace", env=ENV, timeout=3600)
    if check and result.returncode:
        raise RuntimeError(f"git {args[0]} failed in {folder.name}: {result.stderr.strip()[:300]}")
    return result.stdout


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def refs_digest(folder):
    """A short fingerprint of every ref (name and commit): changes whenever any branch or tag moves."""
    refs = git(folder, "for-each-ref", "--format=%(refname) %(objectname)")
    return hashlib.sha256(refs.encode()).hexdigest(), len([line for line in refs.splitlines() if line])


def find_repos(root):
    root = Path(root)
    for owner in sorted(p for p in root.iterdir() if p.is_dir()):
        for repo in sorted(p for p in owner.iterdir() if p.is_dir() and ((p / ".git").exists() or (p / "HEAD").is_file())):
            yield owner.name, repo


def bundle_repo(owner, folder, out, previous):
    name = folder.name
    key = f"{owner}/{name}"
    digest, ref_count = refs_digest(folder)
    target = Path(out) / owner / f"{name}.bundle"
    old = previous.get(key)
    if old and old["refs_digest"] == digest and target.is_file() and target.stat().st_size == old["bytes"]:
        return {**old, "status": "unchanged"}
    if ref_count == 0:
        return {"repo": key, "status": "empty", "refs_digest": digest, "refs": 0}
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    git(folder, "bundle", "create", str(temporary), "--all")
    git(folder, "bundle", "verify", str(temporary))
    temporary.replace(target)
    head = git(folder, "rev-parse", "HEAD", check=False).strip()
    commits = git(folder, "rev-list", "--all", "--count", check=False).strip()
    return {
        "repo": key, "status": "bundled", "bundle": f"{owner}/{name}.bundle", "head": head, "commits": int(commits or 0), "refs": ref_count,
        "refs_digest": digest, "bytes": target.stat().st_size, "sha256": sha256(target), "bundled_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def verify(out, manifest):
    problems = []
    for entry in manifest.get("repositories", []):
        if entry.get("status") not in ("bundled", "unchanged"):
            continue
        path = Path(out) / entry["bundle"]
        if not path.is_file():
            problems.append(f"{entry['repo']}: bundle file missing")
        elif path.stat().st_size != entry["bytes"] or sha256(path) != entry["sha256"]:
            problems.append(f"{entry['repo']}: bundle does not match the manifest")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    out = Path(args.out)
    manifest_path = out / "manifest.json"
    previous_manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {"repositories": []}
    if args.verify_only:
        problems = verify(out, previous_manifest)
        print("\n".join(problems) or f"verified {len(previous_manifest['repositories'])} manifest entries")
        return 1 if problems else 0
    root = Path(args.vault) / "GitHub Live" / "Repositories"
    previous = {entry["repo"]: entry for entry in previous_manifest["repositories"] if entry.get("refs_digest")}
    results, failures = [], 0
    for owner, folder in find_repos(root):
        try:
            entry = bundle_repo(owner, folder, out, previous)
        except Exception as error:  # one bad repo must not stop the others
            failures += 1
            entry = {"repo": f"{owner}/{folder.name}", "status": "failed", "error": str(error)[:300]}
        results.append(entry)
        print(f"{entry['status']:9} {entry['repo']}" + (f"  ({entry['bytes'] / 1048576:.1f} MB, {entry['commits']} commits)" if "bytes" in entry else ""))
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"version": 1, "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "GitHub Live mirrors", "repositories": results}
    manifest["root"] = hashlib.sha256("".join(sorted(e["sha256"] for e in results if e.get("sha256"))).encode()).hexdigest()
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    problems = verify(out, manifest)
    print(f"{len(results)} repositories, {failures} failed, manifest root {manifest['root'][:16]}")
    for problem in problems:
        print("PROBLEM", problem)
    return 1 if failures or problems else 0


if __name__ == "__main__":
    sys.exit(main())
