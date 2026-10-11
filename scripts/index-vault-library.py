"""Index metadata only for approved local libraries; never read recording contents."""

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path


RECORDINGS = {
    ".aac", ".aiff", ".amr", ".avi", ".flac", ".m4a", ".m4v", ".mkv", ".mov",
    ".mp3", ".mp4", ".ogg", ".opus", ".wav", ".webm", ".wma", ".wmv",
}


def inventory(vault, sources):
    visited = set()
    files = []
    errors = []
    allowed = [source.resolve(strict=True) for source in sources]
    for source in sources:
        pending = [source]
        while pending:
            directory = pending.pop()
            try:
                real = directory.resolve(strict=True)
                if real == vault or real.is_relative_to(vault):
                    continue
                if not any(real == root or real.is_relative_to(root) for root in allowed):
                    errors.append({"path": str(directory), "error": "External directory link not followed"})
                    continue
                if real in visited:
                    continue
                visited.add(real)
                with os.scandir(directory) as entries:
                    for entry in entries:
                        path = Path(entry.path)
                        try:
                            if entry.is_dir():
                                pending.append(path)
                            elif entry.is_file():
                                stat = entry.stat()
                                files.append({
                                    "path": str(path),
                                    "bytes": stat.st_size,
                                    "modified_ns": stat.st_mtime_ns,
                                    "recording": path.suffix.lower() in RECORDINGS,
                                    "attributes": getattr(stat, "st_file_attributes", 0),
                                })
                        except OSError as error:
                            errors.append({"path": str(path), "error": str(error)})
            except OSError as error:
                errors.append({"path": str(directory), "error": str(error)})
    return files, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, required=True)
    parser.add_argument("--source", type=Path, action="append", required=True)
    args = parser.parse_args()
    vault = args.vault.resolve(strict=True)
    if any(source.resolve() == vault for source in args.source):
        raise RuntimeError("The vault cannot be its own source library")
    folder = vault / "Computer"
    if not folder.is_dir():
        raise RuntimeError("Connect the approved live library folders first")
    files, errors = inventory(vault, args.source)
    result = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "sources": [str(path) for path in args.source],
        "files": files, "errors": errors,
    }
    path = folder / "Library inventory.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)
    print(f"Indexed {len(files)} files, {sum(file['recording'] for file in files)} recording/media files.")
    print(f"Reported {len(errors)} inaccessible or out-of-scope paths in {path}.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
