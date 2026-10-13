"""Hugging Face account notes for the Obsidian vault: one note per model, dataset and Space, plus an index.

Reads only (cards, metadata and file lists; never weights or data files) using the local sign-in token
(HF_TOKEN or ~/.cache/huggingface/token). Writes under "<vault>/Hugging Face/", which must be ignored by vault
Git because private repo cards can appear there. Notes are rewritten only when their content changes; notes for
repos that no longer exist are reported, never deleted.

    python scripts/sync-huggingface-vault.py            # ~/Documents/RabbitOS Vault, or RABBIT_OBSIDIAN_VAULT
    python scripts/sync-huggingface-vault.py --vault "D:\\Other Vault"
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://huggingface.co"
KINDS = {"models": ("Models", ""), "datasets": ("Datasets", "datasets/"), "spaces": ("Spaces", "spaces/")}
README_LIMIT = 262144
FILE_LIST_LIMIT = 200


def token():
    value = os.environ.get("HF_TOKEN")
    if not value:
        path = Path.home() / ".cache" / "huggingface" / "token"
        value = path.read_text(encoding="utf-8-sig").strip() if path.is_file() else ""
    if not re.fullmatch(r"[\x21-\x7e]{8,4096}", value):
        raise RuntimeError("Sign in first (hf auth login) or set HF_TOKEN; no usable Hugging Face token found.")
    return value


def fetch(path, secret, raw=False):
    request = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {secret}"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read(README_LIMIT + 1 if raw else None)
    except urllib.error.HTTPError as error:
        if raw and error.code == 404:
            return None
        raise RuntimeError(f"Hugging Face API {path.split('?')[0]} failed: HTTP {error.code}") from None
    if raw:
        text = body[:README_LIMIT].decode("utf-8", "replace")
        return text + ("\n\n_README truncated at 256 KiB._\n" if len(body) > README_LIMIT else "")
    return json.loads(body)


def ignored_library(vault):
    root = vault / "Hugging Face"
    if not (vault / ".obsidian").is_dir():
        raise RuntimeError(f"{vault} is not an Obsidian vault")
    if (vault / ".git").exists():
        probe = subprocess.run(["git", "-C", str(vault), "check-ignore", "-q", "--no-index", "Hugging Face/probe.md"])
        if probe.returncode:
            raise RuntimeError('"Hugging Face/" must be ignored by vault Git: add /Hugging Face/ to its .gitignore')
    return root


def safe_name(value):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f#^\[\]]', "_", value).rstrip(". ") or "_"
    if re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", value, re.I):
        value = "_" + value
    return value[:150]


def split_card(readme):
    """(card metadata YAML or "", body) from a README with optional front matter."""
    match = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n?", readme or "", re.S)
    return (match.group(1), readme[match.end():]) if match else ("", readme or "")


def yaml_value(value):
    return json.dumps(value, ensure_ascii=False)


def size_text(size):
    if not isinstance(size, int):
        return ""
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024


def repo_note(kind, info, readme):
    folder, prefix = KINDS[kind]
    url = f"{API}/{prefix}{info['id']}"
    front = {"type": f"huggingface-{kind[:-1]}", "id": info["id"], "url": url, "private": bool(info.get("private")),
             "last_modified": info.get("lastModified"), "likes": info.get("likes", 0)}
    for key, name in (("downloads", "downloads"), ("pipeline_tag", "pipeline"), ("library_name", "library"),
                      ("sdk", "sdk"), ("gated", "gated")):
        if info.get(key) not in (None, False, ""):
            front[name] = info[key]
    tags = [t for t in info.get("tags", []) if isinstance(t, str)][:30]
    if tags:
        front["tags"] = ["huggingface"] + [re.sub(r"[^A-Za-z0-9_/-]", "-", t) for t in tags]
    lines = ["---"] + [f"{k}: {yaml_value(v)}" for k, v in front.items()] + ["---", f"# {info['id']}", "",
             f"[Open on Hugging Face]({url}) · {kind[:-1]} · {'private' if front['private'] else 'public'}", ""]
    files = info.get("siblings") or []
    if files:
        lines += [f"## Files ({len(files)})", ""]
        for item in files[:FILE_LIST_LIMIT]:
            size = size_text(item.get("size"))
            lines.append(f"- `{item['rfilename']}`" + (f" ({size})" if size else ""))
        if len(files) > FILE_LIST_LIMIT:
            lines.append(f"- … {len(files) - FILE_LIST_LIMIT} more")
        lines.append("")
    card, body = split_card(readme)
    if card:
        lines += ["## Card metadata", "", "```yaml", card.strip(), "```", ""]
    lines += ["## README", "", body.strip() if body.strip() else "_No README._", ""]
    return f"{folder}/{safe_name(info['id'].split('/', 1)[-1])}.md", "\n".join(lines)


def index_note(user, entries):
    lines = ["---", 'type: "huggingface-account"', f"account: {yaml_value(user)}", "---",
             f"# Hugging Face: {user}", "", f"[Profile]({API}/{user}) · synced by `scripts/sync-huggingface-vault.py`", ""]
    for kind, (folder, _) in KINDS.items():
        rows = [e for e in entries if e[0] == kind]
        lines += [f"## {folder} ({len(rows)})", ""]
        for _, path, info in rows:
            lines.append(f"- [[{path[:-3]}|{info['id'].split('/', 1)[-1]}]]" + (" (private)" if info.get("private") else ""))
        lines.append("")
    return "\n".join(lines)


def write_if_changed(path, text):
    data = text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
    if path.is_file() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)
    return True


def sync(vault):
    secret = token()
    root = ignored_library(vault)
    me = fetch("/api/whoami-v2", secret)
    owners = [me["name"]] + [org["name"] for org in me.get("orgs", [])]
    entries, changed = [], 0
    for kind, (_, prefix) in KINDS.items():
        for owner in owners:
            for item in fetch(f"/api/{kind}?author={urllib.parse.quote(owner)}&limit=1000", secret):
                repo = urllib.parse.quote(item["id"], safe="/")
                info = fetch(f"/api/{kind}/{repo}?blobs=true", secret)
                readme = fetch(f"/{prefix}{repo}/resolve/main/README.md", secret, raw=True)
                path, text = repo_note(kind, info, readme)
                entries.append((kind, path, info))
                changed += write_if_changed(root / path, text)
    changed += write_if_changed(root / "Hugging Face.md", index_note(me["name"], entries))
    expected = {root / path for _, path, _ in entries}
    stale = sorted(str(p.relative_to(root)) for folder, _ in KINDS.values()
                   for p in (root / folder).glob("*.md") if p not in expected)
    print(f"{me['name']}: {len(entries)} repos, {changed} notes updated in {root}")
    for path in stale:
        print(f"  no longer on Hugging Face (kept): {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    default = os.environ.get("RABBIT_OBSIDIAN_VAULT") or Path.home() / "Documents" / "RabbitOS Vault"
    parser.add_argument("--vault", type=Path, default=Path(default),
                        help="Obsidian vault (default: RABBIT_OBSIDIAN_VAULT or ~/Documents/RabbitOS Vault)")
    try:
        sync(parser.parse_args().vault.resolve())
    except RuntimeError as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
