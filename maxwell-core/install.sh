#!/usr/bin/env bash
# Installs Maxwell Core on Linux (Debian, Ubuntu, Raspberry Pi OS, and most others with systemd). Run as root:  sudo ./install.sh
#
#   sudo ./install.sh                 install and start the private node (RPC on 127.0.0.1 only)
#   sudo ./install.sh --dry-run       show what would be done and change nothing
#   sudo ./install.sh --no-start      install but do not start
#   sudo ./install.sh --no-systemd    copy files and create the user/data folder only (containers, other init systems)
#   sudo ./install.sh --uninstall     stop and remove the program and the service (the data folder /var/lib/maxwell is kept unless you add --purge)
#
# What it does: checks for Node.js 22 or newer, creates a system user "maxwell" with no login, copies the program to /opt/maxwell-core, creates the data folder /var/lib/maxwell
# (owned by that user), installs a systemd service with hardening, and adds a "maxwell-cli" command. Nothing is downloaded, and nothing listens beyond 127.0.0.1.
set -euo pipefail

PREFIX="${MAXWELL_PREFIX:-/opt/maxwell-core}"
DATADIR="${MAXWELL_DATADIR:-/var/lib/maxwell}"
USER_NAME="maxwell"
DRY=0; START=1; SYSTEMD=1; UNINSTALL=0; PURGE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-start) START=0 ;;
    --no-systemd) SYSTEMD=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "would run: $*"; else "$@"; fi; }
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$DRY" = 0 ] && [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo ./install.sh); or add --dry-run to just look" >&2; exit 1; fi

if [ "$UNINSTALL" = 1 ]; then
  if [ "$SYSTEMD" = 1 ] && command -v systemctl >/dev/null 2>&1; then
    run systemctl disable --now maxwell-core.service 2>/dev/null || true
    run systemctl disable --now maxwell-core-witness.timer 2>/dev/null || true
    run rm -f /etc/systemd/system/maxwell-core.service /etc/systemd/system/maxwell-core-witness.service /etc/systemd/system/maxwell-core-witness.timer
    run systemctl daemon-reload || true
  fi
  run rm -f /usr/local/bin/maxwell-cli
  run rm -rf "$PREFIX"
  if [ "$PURGE" = 1 ]; then run rm -rf "$DATADIR"; say "removed the data folder $DATADIR"; else say "kept the data folder $DATADIR (add --purge to delete it)"; fi
  say "Maxwell Core removed."; exit 0
fi

# 1. Node.js 22 or newer
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Maxwell Core needs Node.js 22 or newer (no other packages)." >&2
  echo "Install it from https://nodejs.org/en/download (pick the Linux ARM64 build on a Raspberry Pi 4/5 with a 64-bit OS), then run this again." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then echo "Node.js $NODE_MAJOR found at $NODE_BIN; Maxwell Core needs 22 or newer." >&2; exit 1; fi
say "Node.js $("$NODE_BIN" -v) at $NODE_BIN"

# 2. the program itself must be complete
for f in maxwell-core.mjs witness.mjs package.json; do [ -f "$SRC/$f" ] || { echo "missing $SRC/$f: run this from the maxwell-core folder" >&2; exit 1; }; done
"$NODE_BIN" --check "$SRC/maxwell-core.mjs"

# 3. user, folders, files
if ! id "$USER_NAME" >/dev/null 2>&1; then
  run useradd --system --home-dir "$DATADIR" --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
fi
run install -d -m 0755 "$PREFIX"
run install -m 0644 "$SRC/maxwell-core.mjs" "$SRC/witness.mjs" "$SRC/package.json" "$PREFIX/"
run install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$DATADIR"

# 4. the command-line helper: runs as the maxwell user so it can read the node's cookie file
CLI_TMP="$(mktemp)"
cat > "$CLI_TMP" <<EOF
#!/bin/sh
# maxwell-cli <method> [params...]   talks to the Maxwell Core on this machine (RPC on 127.0.0.1)
if [ "\$(id -un)" = "$USER_NAME" ]; then exec "$NODE_BIN" "$PREFIX/maxwell-core.mjs" cli --datadir "$DATADIR" "\$@"; fi
exec sudo -u "$USER_NAME" "$NODE_BIN" "$PREFIX/maxwell-core.mjs" cli --datadir "$DATADIR" "\$@"
EOF
run install -m 0755 "$CLI_TMP" /usr/local/bin/maxwell-cli
rm -f "$CLI_TMP"

# 5. systemd
if [ "$SYSTEMD" = 1 ]; then
  command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found; use --no-systemd" >&2; exit 1; }
  for unit in maxwell-core.service maxwell-core-witness.service maxwell-core-witness.timer; do
    sed -e "s#@NODE@#$NODE_BIN#g" -e "s#@PREFIX@#$PREFIX#g" -e "s#@DATADIR@#$DATADIR#g" "$SRC/$unit" > "/tmp/$unit.$$"
    run install -m 0644 "/tmp/$unit.$$" "/etc/systemd/system/$unit"
    rm -f "/tmp/$unit.$$"
  done
  run systemctl daemon-reload
  run systemctl enable maxwell-core.service
  if [ "$START" = 1 ]; then run systemctl restart maxwell-core.service; fi
fi

say ""
if [ "$DRY" = 1 ]; then say "Dry run finished: nothing was changed."; exit 0; fi
say "Maxwell Core is installed."
if [ "$SYSTEMD" = 1 ] && [ "$START" = 1 ]; then
  say "  status:   systemctl status maxwell-core"
  say "  try it:   maxwell-cli getblockchaininfo        (the first sync takes a few seconds)"
else
  say "  sync once: sudo -u $USER_NAME $NODE_BIN $PREFIX/maxwell-core.mjs sync --datadir $DATADIR"
fi
say "  be a witness (optional): see README.md, section 'Becoming a witness'."
