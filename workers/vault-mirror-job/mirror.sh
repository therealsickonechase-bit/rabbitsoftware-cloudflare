#!/usr/bin/env bash
# Mirrors the Obsidian vault from GitHub into the private Google Cloud vault bucket, so the cloud copy stays current even when the owner's PC is off.
# One run: shallow-clone the repo (read-only token from the environment, never printed), drop the folders that must never reach the cloud, refuse to continue if the clone
# looks empty, then rsync into gs://<bucket>/github-mirror/ (files removed from GitHub are removed from the mirror; the bucket is versioned, so old versions are kept).
set -euo pipefail
set +x
REPO="${VAULT_REPO:-therealsickonechase-bit/obsidian-rabbitos-vault}"
BUCKET="${VAULT_BUCKET:-rabbitsoftware-io-vault-private}"
PREFIX="${VAULT_PREFIX:-github-mirror}"
MIN_FILES="${MIN_FILES:-50}"
URL="${VAULT_GIT_URL:-https://github.com/${REPO}.git}"
log() { printf '{"severity":"%s","event":"%s","detail":"%s"}\n' "$1" "$2" "${3:-}"; }

if ! [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9._-]{2,62}$ ]] || ! [[ "$PREFIX" =~ ^[A-Za-z0-9._-]+$ ]]; then log ERROR vault_mirror_failed "bad bucket or prefix"; exit 1; fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
  git -c "http.extraheader=$AUTH" clone --depth 1 --quiet "$URL" "$WORK/repo" 2>/dev/null || { log ERROR vault_mirror_failed "clone failed (token missing, expired or without read access to the repository)"; exit 1; }
else
  git clone --depth 1 --quiet "$URL" "$WORK/repo" 2>/dev/null || { log ERROR vault_mirror_failed "clone failed (no token set and the repository is not public)"; exit 1; }
fi
HEAD_SHA="$(git -C "$WORK/repo" rev-parse --short HEAD)"

# never mirrored: git internals, the headset recordings, and the self-copying PC folder view (same exclusions as the PC upload)
rm -rf "$WORK/repo/.git" "$WORK/repo/Local/EEG" "$WORK/repo/Local/RabbitOS folder"

COUNT="$(find "$WORK/repo" -type f | wc -l)"
if [ "$COUNT" -lt "$MIN_FILES" ]; then log ERROR vault_mirror_failed "only $COUNT files after cloning; refusing to touch the mirror"; exit 1; fi

gcloud storage rsync --recursive --delete-unmatched-destination-objects --quiet "$WORK/repo" "gs://${BUCKET}/${PREFIX}" >/dev/null
log INFO vault_mirror_done "commit ${HEAD_SHA}, ${COUNT} files -> gs://${BUCKET}/${PREFIX}"
