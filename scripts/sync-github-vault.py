"""Full-history GitHub library with public-only automatic publishing."""

import argparse
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


LOG = logging.getLogger("vault-sync")
ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never",
       "GIT_LFS_SKIP_SMUDGE": "1"}
TRAILER = "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"


def command(*args, cwd=None, binary=False):
    result = subprocess.run(
        args, cwd=cwd, env=ENV, capture_output=True, text=not binary,
        encoding=None if binary else "utf-8", errors=None if binary else "replace",
        timeout=3600, check=False,
    )
    if result.returncode:
        error = result.stderr.decode("utf-8", "replace") if binary else result.stderr
        raise RuntimeError(f"{args[0]} {args[1]} failed: {error.strip()}")
    return result.stdout


def git(folder, *args, binary=False):
    location = ["-C", str(folder)]
    if (folder / "HEAD").is_file() and not (folder / ".git").exists():
        location += ["--git-dir=" + str(folder)]
    return command(
        "git", "-c", "core.hooksPath=NUL", *location, *args, binary=binary
    )


def api(endpoint, pages=False):
    args = ["gh", "api"]
    if pages:
        args += ["--paginate", "--slurp"]
    data = json.loads(command(*args, endpoint))
    return [item for page in data for item in page] if pages else data


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def ignored_library(vault):
    root = vault / "GitHub Live"
    output = command(
        "git", "-C", str(vault), "check-ignore", "--no-index", str(root / "probe")
    )
    if not output.strip():
        raise RuntimeError("GitHub Live must be ignored by vault Git")
    if command("git", "-C", str(vault), "ls-files", "--", "GitHub Live").strip():
        raise RuntimeError("GitHub Live contains tracked vault files")
    root.mkdir(exist_ok=True)
    return root


def safe_component(value):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).rstrip(". ") or "_"
    if re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", value, re.I):
        value = "_" + value
    return value[:160]


def ensure_clone(root, repo, mirror=False):
    folder = root / ("History" if mirror else "Repositories") / repo["full_name"]
    url = repo["clone_url"]
    if not folder.exists():
        folder.parent.mkdir(parents=True, exist_ok=True)
        args = ["git", "-c", "core.hooksPath=NUL", "clone"]
        args += ["--mirror"] if mirror else ["--no-checkout"]
        try:
            command(*args, "--", url, str(folder))
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            raise RuntimeError(
                f"Clone failed at {folder}. Inspect any partial folder before retrying: {error}"
            ) from error
        if not mirror:
            git(folder, "config", "branch." + repo["default_branch"] + ".remote", "origin")
            git(folder, "config", "branch." + repo["default_branch"] + ".merge",
                "refs/heads/" + repo["default_branch"])
    if git(folder, "remote", "get-url", "origin").strip() != url:
        raise RuntimeError(f"Unexpected Git origin at {folder}; refusing sync")
    git(folder, "config", "gc.auto", "0")
    git(folder, "config", "core.symlinks", "false")
    shallow = git(folder, "rev-parse", "--is-shallow-repository").strip()
    if shallow != "false":
        raise RuntimeError(f"Shallow repository is not a complete history: {folder}")
    if mirror:
        git(folder, "fetch", "origin")
    else:
        git(folder, "fetch", "--tags", "origin")
    return folder


def invalid_tree_paths(mirror, branch):
    branch = "refs/heads/" + branch
    result = subprocess.run(
        ["git", "--git-dir=" + str(mirror), "rev-parse", "--verify", branch],
        capture_output=True, env=ENV, check=False,
    )
    if result.returncode:
        return None
    paths = git(mirror, "ls-tree", "-r", "--name-only", "-z", branch, binary=True)
    invalid = []
    for encoded in paths.split(b"\0"):
        if not encoded:
            continue
        path = encoded.decode("utf-8", "strict")
        if any(
            re.search(r'[<>:"\\|?*\x00-\x1f]', part)
            or part.endswith((".", " "))
            or re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", part, re.I)
            for part in path.split("/")
        ):
            invalid.append(path)
    return invalid


def clone_worktree(root, repo, mirror):
    branch = repo["default_branch"]
    invalid = invalid_tree_paths(mirror, branch)
    if invalid:
        LOG.warning(
            "%s: %s Windows-incompatible paths; complete history retained, "
            "mapped snapshot remains in GitHub Imports, automatic checkout/push disabled",
            repo["full_name"], len(invalid),
        )
        return None, invalid
    folder = ensure_clone(root, repo)
    if invalid is None:
        return folder, []
    marker = folder / ".git" / "vault-initial-checkout"
    if not marker.exists():
        if any(item.name != ".git" for item in folder.iterdir()):
            raise RuntimeError(f"Unmarked worktree contains files; refusing checkout: {folder}")
        git(folder, "checkout", branch)
        marker.write_text("Complete checkout\n", encoding="ascii")
    return folder, []


def changed_files(folder):
    output = git(folder, "status", "--porcelain=v1", "-z", "--untracked-files=all", binary=True)
    entries = output.split(b"\0")
    files = []
    position = 0
    while position < len(entries):
        entry = entries[position]
        position += 1
        if not entry:
            continue
        state = entry[:2].decode("ascii")
        if state not in ("??", "!!") and state[0] != " ":
            raise RuntimeError("Staged changes or conflicts require manual review")
        name = entry[3:].decode("utf-8")
        if state != "!!":
            files.append(name)
        if "R" in state or "C" in state:
            position += 1
    return files


def validate_publish_files(folder, names):
    for name in names:
        path = folder / name
        if any(
            part.lower() in (".git", ".obsidian", "private-cloud-data", "backup")
            or part.lower().startswith(".env")
            or part.lower() == ".dev.vars"
            or part.lower().endswith((".pem", ".key", ".pfx", ".p12"))
            for part in Path(name).parts
        ):
            raise RuntimeError(f"Credential/private path requires manual review: {name}")
        if not path.exists():
            continue
        if not path.resolve().is_relative_to(folder.resolve()):
            raise RuntimeError(f"File points outside repository: {name}")
        current = path
        while current != folder:
            if getattr(current.lstat(), "st_file_attributes", 0) & 0x400:
                raise RuntimeError(f"Filesystem link requires manual review: {name}")
            current = current.parent
        if path.stat().st_size > 95 * 1024 * 1024:
            attributes = git(folder, "check-attr", "filter", "--", name).strip()
            if not attributes.endswith(": lfs"):
                raise RuntimeError(f"Large non-LFS file requires manual review: {name}")
        with path.open("rb") as stream:
            overlap = b""
            while chunk := stream.read(1024 * 1024):
                data = overlap + chunk
                if re.search(
                    rb"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"
                    rb"|(?:gh[pousr]_[A-Za-z0-9]{30,})"
                    rb"|github_pat_[A-Za-z0-9_]{40,}"
                    rb"|AKIA[0-9A-Z]{16}", data
                ):
                    raise RuntimeError(f"Possible credential content requires manual review: {name}")
                overlap = data[-256:]


def update_worktree(folder, repo, publish=False):
    branch = repo["default_branch"]
    if git(folder, "symbolic-ref", "--short", "HEAD").strip() != branch:
        raise RuntimeError("Non-default branch checked out; manual Git workflow required")
    names = changed_files(folder)
    remote = "refs/remotes/origin/" + branch
    remote_exists = subprocess.run(
        ["git", "-C", str(folder), "rev-parse", "--verify", remote],
        capture_output=True, env=ENV, check=False,
    ).returncode == 0
    if remote_exists:
        ahead_behind = git(folder, "rev-list", "--left-right", "--count", "HEAD..." + remote)
        ahead, behind = map(int, ahead_behind.split())
        if behind and (ahead or names):
            raise RuntimeError("Remote advanced while local edits/commits exist; no stash/rebase attempted")
        if behind:
            git(folder, "merge", "--ff-only", remote)
    if publish and (repo["private"] or repo["archived"]):
        raise RuntimeError("Automatic publishing is forbidden for private or archived repositories")
    if names and not publish:
        LOG.warning("%s: local edits preserved; commit/push awaits approval", repo["full_name"])
    if not publish:
        return
    if names:
        validate_publish_files(folder, names)
        git(folder, "add", "--all")
        git(
            folder, "commit", "-m", "Sync vault edits", "-m", TRAILER,
        )
        LOG.info("%s: committed public repository edits", repo["full_name"])
    local_exists = subprocess.run(
        ["git", "-C", str(folder), "rev-parse", "--verify", "HEAD"],
        capture_output=True, env=ENV, check=False,
    ).returncode == 0
    if not local_exists:
        return
    if not remote_exists or int(git(folder, "rev-list", "--count", remote + "..HEAD")):
        git(folder, "push", "origin", f"HEAD:refs/heads/{branch}")
        LOG.info("%s: pushed public repository commits", repo["full_name"])


def download_releases(root, repo, cache):
    assets = 0
    for release in api(f"repos/{repo['full_name']}/releases?per_page=100", pages=True):
        target = (
            root / "Release assets" / repo["full_name"]
            / f"{release['id']}-{safe_component(release['tag_name'])}"
        )
        for asset in release["assets"]:
            key = str(asset["id"])
            file = target / f"{asset['id']}-{safe_component(asset['name'])}"
            previous = cache.get(key)
            if previous and file.exists():
                if checksum(file) != previous["sha256"]:
                    raise RuntimeError(f"Release asset edited locally; refusing overwrite: {file}")
                assets += 1
                continue
            if file.exists():
                raise RuntimeError(f"Unverified release asset exists: {file}")
            target.mkdir(parents=True, exist_ok=True)
            temporary = file.with_suffix(file.suffix + ".partial")
            try:
                with temporary.open("wb") as output:
                    result = subprocess.run(
                        ["gh", "api", "-H", "Accept: application/octet-stream",
                         f"repos/{repo['full_name']}/releases/assets/{asset['id']}"],
                        stdout=output, stderr=subprocess.PIPE, env=ENV, timeout=3600,
                        check=False,
                    )
                if result.returncode:
                    raise RuntimeError(result.stderr.decode("utf-8", "replace").strip())
                if temporary.stat().st_size != asset["size"]:
                    raise RuntimeError(f"Release asset size mismatch: {asset['name']}")
                temporary.replace(file)
            finally:
                if temporary.exists():
                    temporary.unlink()
            cache[key] = {
                "repository": repo["full_name"], "name": asset["name"],
                "path": file.relative_to(root).as_posix(), "bytes": asset["size"],
                "sha256": checksum(file),
            }
            save_json(root / "release-assets.json", cache)
            assets += 1
    return assets


def attempt(entry, phase, operation):
    try:
        return operation()
    except (RuntimeError, subprocess.TimeoutExpired, OSError, ValueError) as error:
        entry["status"] = "partial"
        entry["errors"].append(f"{phase}: {error}")
        LOG.error("%s %s: %s", entry["name"], phase, error)
        return None


def fetch_all_lfs(folder, repo):
    try:
        git(folder, "lfs", "fetch", "--all", "origin")
    except RuntimeError as error:
        if (repo["private"] or not repo.get("fork")
                or "Git LFS is disabled for this repository." not in str(error)):
            raise
        metadata = api("repos/" + repo["full_name"])
        parent = metadata.get("parent")
        if not parent or parent["private"]:
            raise
        LOG.warning(
            "%s: fork LFS disabled; trying the public parent %s as a download-only source",
            repo["full_name"], parent["full_name"],
        )
        git(folder, "config", "remote.vault-lfs-source.url", parent["clone_url"])
        git(folder, "lfs", "fetch", "--all", "vault-lfs-source")


def sync(root, setup, selected=None):
    owner = api("user")["login"]
    policy_path = root / "policy.json"
    if not policy_path.exists():
        if not setup:
            raise RuntimeError("Run --setup before enabling scheduled sync")
        save_json(policy_path, {
            "owner": owner, "auto_push_public": True,
            "auto_push_private": False, "interval_minutes": 5,
        })
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    if policy["owner"] != owner or policy.get("auto_push_private") is not False:
        raise RuntimeError("Owner mismatch or unsafe private-repository publishing policy")
    repos = [
        repo for repo in api("user/repos?affiliation=owner&per_page=100&sort=full_name", pages=True)
        if repo["owner"]["login"].lower() == owner.lower()
    ]
    if selected:
        unknown = set(selected) - {repo["full_name"] for repo in repos}
        if unknown:
            raise RuntimeError("Requested repositories are not owned/accessible: " + ", ".join(unknown))
        repos = [repo for repo in repos if repo["full_name"] in selected]
    cache_path = root / "release-assets.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    previous = root / "status.json"
    results = (
        json.loads(previous.read_text(encoding="utf-8"))["repositories"]
        if previous.exists() else []
    )
    for repo in repos:
        name = repo["full_name"]
        LOG.info("Syncing %s (%s)", name, "private" if repo["private"] else "public")
        entry = {
            "name": name, "private": repo["private"], "archived": repo["archived"],
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "branch": repo["default_branch"],
            "auto_push": not repo["private"] and not repo["archived"]
                         and policy.get("auto_push_public") is True,
            "status": "ok", "errors": [],
        }
        try:
            mirror = ensure_clone(root, repo, mirror=True)
            entry["history_refs"] = len(git(mirror, "for-each-ref", "--format=%(refname)").splitlines())
            entry["commits"] = int(git(mirror, "rev-list", "--all", "--count").strip())
            attempt(entry, "History LFS download", lambda: fetch_all_lfs(mirror, repo))
            folder, invalid = clone_worktree(root, repo, mirror)
            entry["windows_incompatible_paths"] = invalid
            if folder:
                if not entry["errors"]:
                    attempt(
                        entry, "Working-copy sync",
                        lambda: update_worktree(folder, repo, publish=not setup and entry["auto_push"]),
                    )
                else:
                    LOG.warning("%s: publishing deferred because history downloads are incomplete", name)
                if entry["commits"]:
                    attempt(entry, "Working-copy LFS download",
                            lambda: fetch_all_lfs(folder, repo))
                    attempt(entry, "Working-copy LFS checkout", lambda: git(folder, "lfs", "checkout"))
                    if not changed_files(folder):
                        attempt(entry, "Submodule checkout",
                                lambda: git(folder, "submodule", "update", "--init", "--recursive"))
                        attempt(
                            entry, "Submodule history and LFS download",
                            lambda: git(
                                folder, "submodule", "foreach", "--recursive",
                                "git -c core.hooksPath=NUL fetch --tags origin && "
                                "git -c core.hooksPath=NUL lfs fetch --all && "
                                "git -c core.hooksPath=NUL lfs checkout",
                            ),
                        )
                    else:
                        LOG.warning("%s: submodule update deferred because of local edits", name)
            else:
                entry["auto_push"] = False
                if not entry["errors"]:
                    entry["status"] = "history-only"
            entry["release_assets"] = download_releases(root, repo, cache)
        except (RuntimeError, subprocess.TimeoutExpired, OSError, ValueError) as error:
            entry["status"] = "error"
            entry["errors"].append(str(error))
            LOG.error("%s: %s", name, error)
        if entry["errors"]:
            entry["auto_push"] = False
        results = [result for result in results if result["name"] != name]
        results.append(entry)
        results.sort(key=lambda result: result["name"].casefold())
        save_json(root / "status.json", {
            "updated_at": datetime.now(timezone.utc).isoformat(), "repositories": results,
        })
    save_json(root / "last-completed-status.json", {
        "updated_at": datetime.now(timezone.utc).isoformat(), "repositories": results,
    })
    lines = [
        "# GitHub live library", "",
        "Full-history repositories and release assets. Local-only: excluded from vault Git.",
        "Edit files under `Repositories`, not the earlier `GitHub Imports` snapshots.",
        "Public, non-archived repositories auto-commit/push on the default branch.",
        "Private repos require approval. Conflicts, staged changes, credential candidates,",
        "linked files, and unsupported Windows paths require manual review.",
        "History mirrors are never pushed. Release assets are verified downloads, not uploads.",
        "Personal recordings in Computer/Downloads, Computer/OneDrive and Documents media",
        "links stay in their source storage; they are not published to GitHub.",
        "", "| Repository | Visibility | Auto-push | Commits | Status |",
        "| --- | --- | --- | ---: | --- |",
    ]
    for entry in results:
        lines.append(
            f"| [{entry['name']}](https://github.com/{entry['name']})"
            f" | {'Private' if entry['private'] else 'Public'}"
            f" | {'Yes' if entry['auto_push'] else 'No'}"
            f" | {entry.get('commits', 'unknown')} | {entry['status']} |"
        )
    lines += [
        "", "See `status.json` and `sync.log` for explicit errors.",
        "Windows-incompatible repos retain full Git histories and mapped imported files;",
        "they cannot use a native Windows checkout without renaming paths on GitHub.",
        "Empty and dotfile-only repos may be hidden by Obsidian.",
    ]
    (root / "00 GitHub live.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return sum(bool(entry["errors"]) for entry in results)


def verify_library(root):
    state = json.loads((root / "status.json").read_text(encoding="utf-8"))
    verified = []
    for repo in state["repositories"]:
        folder = root / "History" / repo["name"]
        if git(folder, "rev-parse", "--is-shallow-repository").strip() != "false":
            raise RuntimeError(f"History is shallow: {repo['name']}")
        git(folder, "fsck", "--connectivity-only", "--no-dangling")
        count = int(git(folder, "rev-list", "--all", "--count"))
        if count != repo["commits"]:
            raise RuntimeError(f"History commit count changed: {repo['name']}")
        verified.append({"name": repo["name"], "commits": count})
    cache_path = root / "release-assets.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    for asset in cache.values():
        path = root / asset["path"]
        if path.stat().st_size != asset["bytes"] or checksum(path) != asset["sha256"]:
            raise RuntimeError(f"Release asset integrity failure: {asset['path']}")
    result = {
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "histories": verified, "release_assets": len(cache),
        "partial_repositories": [repo["name"] for repo in state["repositories"] if repo["errors"]],
    }
    save_json(root / "verification.json", result)
    LOG.info(
        "Verified %s full-history mirrors, %s Git commits and %s release assets; "
        "%s repositories have explicitly reported content-download errors",
        len(verified), sum(repo["commits"] for repo in verified), len(cache),
        len(result["partial_repositories"]),
    )
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, required=True)
    parser.add_argument("--setup", action="store_true", help="Import without committing or pushing")
    parser.add_argument("--repository", action="append", help="Retry an owned repository without reprocessing others")
    parser.add_argument("--verify-only", action="store_true", help="Check Git object connectivity and asset hashes without syncing")
    args = parser.parse_args()
    root = ignored_library(args.vault.resolve(strict=True))
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(root / "sync.log", encoding="utf-8"),
                  logging.StreamHandler(sys.stdout)],
    )
    import msvcrt

    with (root / "sync.lock").open("a+b") as lock:
        lock.seek(0, 2)
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            LOG.warning("Another sync is already running; this trigger will not overlap it")
            return 0
        try:
            if args.verify_only:
                return verify_library(root)
            errors = sync(root, args.setup, args.repository)
            LOG.info("Sync finished with %s repository errors", errors)
            return 1 if errors else 0
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


if __name__ == "__main__":
    sys.exit(main())
