#!/bin/sh
set -eu

: "${PI_HOST_VERSION:?PI_HOST_VERSION is required}"
: "${PI_HOST_ARCH:?PI_HOST_ARCH is required}"
: "${PI_HOST_CHECKSUM:?PI_HOST_CHECKSUM is required}"
: "${PI_HOST_BASE_URL:=https://github.com/vastsa/PI-Desktop/releases/download}"

ROOT="${PI_HOST_ROOT:-$HOME/.pi-desktop/host}"
VERSION_DIR="$ROOT/versions/$PI_HOST_VERSION"
RUNTIME_DIR="$ROOT/runtime"
LOG_DIR="$ROOT/logs"
BUNDLE_NAME="pi-host-$PI_HOST_VERSION-linux-$PI_HOST_ARCH.tar.gz"
BUNDLE_URL="$PI_HOST_BASE_URL/v$PI_HOST_VERSION/$BUNDLE_NAME"
DOWNLOAD="$ROOT/tmp/$BUNDLE_NAME"

mkdir -p "$ROOT/versions" "$ROOT/tmp" "$RUNTIME_DIR" "$LOG_DIR"

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "REMOTE_DOWNLOAD_FAILED: curl or wget is required" >&2
    exit 1
  fi
}

running_pid() {
  [ -f "$RUNTIME_DIR/host.pid" ] || return 1
  pid="$(cat "$RUNTIME_DIR/host.pid")"
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

if pid="$(running_pid)"; then
  current_version="unknown"
  if [ -f "$RUNTIME_DIR/host.json" ]; then
    current_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RUNTIME_DIR/host.json")"
  fi
  if [ "$current_version" = "$PI_HOST_VERSION" ]; then
    echo "PI_HOST_ALREADY_RUNNING version=$PI_HOST_VERSION pid=$pid"
    cat "$RUNTIME_DIR/host.json"
    exit 0
  fi
  kill "$pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
fi

download "$BUNDLE_URL" "$DOWNLOAD"
printf '%s  %s\n' "$PI_HOST_CHECKSUM" "$DOWNLOAD" | sha256sum -c -
rm -rf "$VERSION_DIR"
mkdir -p "$VERSION_DIR"
tar -xzf "$DOWNLOAD" -C "$VERSION_DIR"
ln -sfn "$VERSION_DIR" "$ROOT/current"

BOOT_LOG="$LOG_DIR/boot-$PI_HOST_VERSION.log"
: > "$BOOT_LOG"
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c "exec '$VERSION_DIR/node' '$VERSION_DIR/pi-host.js' --data-dir '$RUNTIME_DIR'" \
    >>"$BOOT_LOG" 2>&1 &
else
  nohup "$VERSION_DIR/node" "$VERSION_DIR/pi-host.js" --data-dir "$RUNTIME_DIR" \
    >>"$BOOT_LOG" 2>&1 &
fi

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if grep -q 'pi-host.ready' "$BOOT_LOG" 2>/dev/null; then
    cat "$BOOT_LOG"
    cat "$RUNTIME_DIR/host.json"
    exit 0
  fi
  if grep -q 'pi-host.failed' "$BOOT_LOG" 2>/dev/null; then
    cat "$BOOT_LOG" >&2
    exit 1
  fi
  sleep 1
done

echo "REMOTE_HOST_START_FAILED: pi-host did not become ready" >&2
cat "$BOOT_LOG" >&2
exit 1
