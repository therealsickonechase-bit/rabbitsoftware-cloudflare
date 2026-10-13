"""Import owned GitHub default-branch snapshots into a Git-ignored vault folder."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import quote


def github(endpoint):
    result = subprocess.run(
        ["gh", "api", endpoint], capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise RuntimeError(f"{endpoint}: {result.stderr.strip()}")
    return json.loads(result.stdout)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(root, record):
    folder = root / record["name"]
    if not folder.is_dir():
        raise RuntimeError(f"Missing import folder: {folder}")
    expected = record["files"]
    actual = {p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file()}
    if actual != set(expected):
        raise RuntimeError(f"File inventory changed: {record['name']}")
    for name, checksum in expected.items():
        if digest(folder / name) != checksum:
            raise RuntimeError(f"Checksum mismatch: {record['name']}/{name}")


def save_manifest(root, manifest):
    temporary = root / ".manifest.tmp"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(root / "manifest.json")


def save_index(root, manifest):
    lines = [
        "# GitHub imports",
        "",
        f"Owner: `{manifest['owner']}`. Imported: {manifest['created_at']}.",
        "",
        "Local-only default-branch snapshots, excluded from vault Git sync.",
        "No Git history, other branches, release assets, or submodule contents.",
        "Git LFS files may be pointers; symlinks are exported as text targets.",
        "Windows filename changes are recorded under `renamed_paths` in `manifest.json`.",
        "These are snapshots, not live working copies. Re-running verifies and resumes;",
        "it does not overwrite existing imports with newer GitHub versions.",
        "Git ignore rules do not prevent MCP access. Do not send private contents",
        "to model tools without deciding explicitly what may be shared.",
        "",
        "| Repository | Visibility | Archived | Branch | Files | Status |",
        "| --- | --- | --- | --- | ---: | --- |",
    ]
    for repo in manifest["repositories"]:
        name = repo["name"]
        lines.append(
            f"| [{name}](https://github.com/{name})"
            f" | {'Private' if repo['private'] else 'Public'}"
            f" | {'Yes' if repo['archived'] else 'No'}"
            f" | {repo['default_branch']} | {len(repo['files'])}"
            f" | {repo['status']} |"
        )
    lines += ["", "## Local folders", ""]
    for repo in manifest["repositories"]:
        name = repo["name"]
        readme = next(
            (p for p in repo["files"] if p.lower() == "readme.md"), None
        )
        if readme:
            lines.append(f"- [[GitHub Imports/{name}/{readme}|{name}]]")
        else:
            lines.append(f"- `{name}` ({repo['status']})")
    (root / "00 GitHub imports.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def extract_snapshot(archive, destination, sanitize_windows_names=False):
    hashes = {}
    symlinks = 0
    lfs_pointers = 0
    renamed_paths = {}
    mapped_prefixes = {}
    occupied = {}
    with zipfile.ZipFile(archive) as bundle:
        if any(
            info.filename.startswith(("/", "\\"))
            or "\\" in info.filename
            or any(part in (".", "..") for part in info.filename.split("/"))
            for info in bundle.infolist()
        ):
            raise RuntimeError("Archive contains an unsafe path")
        roots = {PurePosixPath(info.filename).parts[0] for info in bundle.infolist()}
        if len(roots) != 1:
            raise RuntimeError("GitHub archive must have exactly one root directory")
        for info in bundle.infolist():
            parts = PurePosixPath(info.filename).parts[1:]
            if not parts:
                continue
            local_parts = ()
            for position, part in enumerate(parts):
                prefix = parts[:position + 1]
                if prefix in mapped_prefixes:
                    local_parts = mapped_prefixes[prefix]
                    continue
                local = re.sub(r'[<>:"|?*\x00-\x1f]', "_", part)
                local = re.sub(r"[. ]+$", lambda match: "_" * len(match[0]), local)
                if re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", local, re.I):
                    local = "_" + local
                key = tuple(p.casefold() for p in (*local_parts, local))
                if local != part and not sanitize_windows_names:
                    raise RuntimeError(
                        f"Unsafe or Windows-incompatible archive path: {info.filename}"
                    )
                if key in occupied and occupied[key] != prefix:
                    if not sanitize_windows_names:
                        raise RuntimeError(f"Windows filename collision: {info.filename}")
                    suffix = hashlib.sha256("/".join(prefix).encode()).hexdigest()[:12]
                    local += "-" + suffix
                    key = tuple(p.casefold() for p in (*local_parts, local))
                    if key in occupied:
                        raise RuntimeError(f"Renamed filename collision: {info.filename}")
                occupied[key] = prefix
                local_parts = (*local_parts, local)
                mapped_prefixes[prefix] = local_parts
            original_name = PurePosixPath(*parts).as_posix()
            local_name = PurePosixPath(*local_parts).as_posix()
            target = destination.joinpath(*local_parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if target.exists():
                raise RuntimeError(f"Duplicate archive path: {info.filename}")
            target.parent.mkdir(parents=True, exist_ok=True)
            checksum = hashlib.sha256()
            first = b""
            with bundle.open(info) as source, target.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    if not first:
                        first = chunk[:128]
                    output.write(chunk)
                    checksum.update(chunk)
            hashes[local_name] = checksum.hexdigest()
            if original_name != local_name:
                renamed_paths[original_name] = local_name
            symlinks += ((info.external_attr >> 16) & 0o170000) == 0o120000
            lfs_pointers += first.startswith(b"version https://git-lfs.github.com/spec/v1\n")
    return hashes, symlinks, lfs_pointers, renamed_paths


def import_repository(root, repo, sanitize_windows_names=False):
    name = repo["full_name"]
    destination = root / name
    if destination.exists():
        raise RuntimeError(f"Refusing to overwrite an unverified import: {destination}")
    branch = repo["default_branch"]
    endpoint = f"repos/{name}/commits?sha={quote(branch, safe='')}&per_page=1"
    result = subprocess.run(
        ["gh", "api", endpoint], capture_output=True, text=True, check=False
    )
    empty = False
    if result.returncode:
        error = json.loads(result.stdout) if result.stdout.strip() else {}
        empty = (
            "(HTTP 409)" in result.stderr
            and error.get("message", "").lower() == "git repository is empty."
        )
        if not empty:
            raise RuntimeError(f"{name}: {result.stderr.strip()}")
    commits = [] if empty else json.loads(result.stdout)
    record = {
        "name": name,
        "private": repo["private"],
        "archived": repo["archived"],
        "default_branch": branch,
        "commit": commits[0]["sha"] if commits else None,
        "status": "empty" if not commits else "imported",
        "files": {},
        "symlinks_as_text": 0,
        "lfs_pointers": 0,
        "renamed_paths": {},
    }
    if not commits:
        destination.mkdir(parents=True)
        return record
    with tempfile.TemporaryDirectory(prefix=".download-", dir=root) as temporary:
        staging = Path(temporary)
        archive = staging / "snapshot.zip"
        with archive.open("wb") as output:
            subprocess.run(
                ["gh", "api", f"repos/{name}/zipball/{record['commit']}"],
                stdout=output,
                check=True,
            )
        extracted = staging / "files"
        extracted.mkdir()
        files, symlinks, lfs_pointers, renamed_paths = extract_snapshot(
            archive, extracted, sanitize_windows_names
        )
        record.update(
            files=files, symlinks_as_text=symlinks, lfs_pointers=lfs_pointers,
            renamed_paths=renamed_paths,
        )
        verify(staging, {**record, "name": "files"})
        destination.parent.mkdir(parents=True, exist_ok=True)
        extracted.rename(destination)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument(
        "--sanitize-windows-names", action="store_true",
        help="Replace incompatible filename characters and record mappings in the manifest",
    )
    args = parser.parse_args()
    vault = args.vault.resolve(strict=True)
    root = vault / "GitHub Imports"
    guard = subprocess.run(
        ["git", "-C", str(vault), "check-ignore", "--no-index", str(root / "probe.txt")],
        capture_output=True,
        text=True,
        check=False,
    )
    if guard.returncode or guard.stdout.strip() == "":
        raise RuntimeError("GitHub Imports must be excluded by the vault's Git ignore rules")
    tracked = subprocess.run(
        ["git", "-C", str(vault), "ls-files", "--", "GitHub Imports"],
        capture_output=True,
        text=True,
        check=True,
    )
    if tracked.stdout.strip():
        raise RuntimeError("GitHub Imports contains tracked files; refusing private import")
    root.mkdir(exist_ok=True)
    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        if args.verify_only:
            raise RuntimeError("No import manifest exists")
        if any(root.iterdir()):
            raise RuntimeError("Import folder is not empty and has no manifest")
        manifest = {
            "owner": github("user")["login"],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "repositories": [],
        }
    for record in manifest["repositories"]:
        verify(root, record)
    if args.verify_only:
        total = sum(len(repo["files"]) for repo in manifest["repositories"])
        print(f"Verified {len(manifest['repositories'])} repositories and {total} file hashes.")
        return
    owner = github("user")["login"]
    if owner != manifest["owner"]:
        raise RuntimeError("Authenticated owner differs from the existing import")
    pages = subprocess.run(
        ["gh", "api", "--paginate", "--slurp",
         "user/repos?affiliation=owner&per_page=100&sort=full_name"],
        capture_output=True, text=True, check=True,
    )
    repos = [repo for page in json.loads(pages.stdout) for repo in page
             if repo["owner"]["login"].lower() == owner.lower()]
    completed = {repo["name"] for repo in manifest["repositories"]}
    failures = []
    save_manifest(root, manifest)
    for repo in repos:
        name = repo["full_name"]
        if name in completed:
            print(f"Verified existing: {name}", flush=True)
            continue
        print(f"Importing {name}...", flush=True)
        try:
            record = import_repository(root, repo, args.sanitize_windows_names)
        except (RuntimeError, subprocess.CalledProcessError, OSError, zipfile.BadZipFile) as error:
            failures.append(name)
            print(f"FAILED {name}: {error}", file=sys.stderr, flush=True)
            continue
        manifest["repositories"].append(record)
        save_manifest(root, manifest)
        save_index(root, manifest)
        print(
            f"  {record['status']}: {len(record['files'])} files,"
            f" {record['lfs_pointers']} LFS pointers,"
            f" {record['symlinks_as_text']} symlink targets,"
            f" {len(record['renamed_paths'])} renamed paths",
            flush=True,
        )
    save_index(root, manifest)
    if failures:
        raise RuntimeError("Imports failed (rerun to resume): " + ", ".join(failures))
    print(f"Complete: {len(manifest['repositories'])} repositories in {root}", flush=True)


if __name__ == "__main__":
    main()
