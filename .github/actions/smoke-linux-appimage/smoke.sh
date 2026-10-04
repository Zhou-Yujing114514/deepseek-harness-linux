#!/usr/bin/env bash
# Boot a packaged Linux AppImage on a virtual display and refuse to let it pass if it does not come up.
#
# The pipeline used to validate packaging configuration and then ship whatever came out. That is
# how a build carrying a mandatory-update policy reached users: the config was valid, the package
# was well formed, and the app threw the moment it started. Nothing between electron-builder and
# the update server ever opened the thing.
#
# A startup failure shows up in one of three places, and any one of them is fatal here:
#   1. the main process exits while starting up,
#   2. main.ts logs the throw it could not recover from,
#   3. a window appears carrying the fatal dialog's title.
#
# Usage: smoke.sh <directory holding exactly one .AppImage>
set -uo pipefail

directory="$1"
if [[ -z "${directory:-}" ]]; then
  echo "usage: smoke.sh <directory holding a packaged AppImage>" >&2
  exit 2
fi

# i18n key `startupFailed`, rendered by the dialog main.ts opens when startup throws.
FATAL_TITLE="DeepSeek Harness is unavailable"
FATAL_LOG_PATTERN='desktop policy|The application could not start|Unhandled|fatal'

shopt -s nullglob
images=("$directory"/*.AppImage)
if [[ ${#images[@]} -ne 1 ]]; then
  echo "FAIL: expected exactly one AppImage in $directory, found ${#images[@]}" >&2
  exit 1
fi
image="${images[0]}"
echo "== target =="
echo "    $image ($(stat -c %s "$image") bytes)"

work=$(mktemp -d)
display=:99
log="$work/startup.log"
app_pid=""
xvfb_pid=""
cleanup() {
  [[ -n "$app_pid" ]] && kill -9 "$app_pid" 2>/dev/null
  [[ -n "$xvfb_pid" ]] && kill -9 "$xvfb_pid" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

echo "== unpacking =="
# Mounting an AppImage needs FUSE, which a CI container does not offer; the runtime can unpack
# itself either way, so take the path that needs no kernel module.
( cd "$work" && "$image" --appimage-extract > /dev/null 2>&1 )
appdir="$work/squashfs-root"
if [[ ! -x "$appdir/AppRun" ]]; then
  echo "FAIL: no executable AppRun under $appdir" >&2
  exit 1
fi

echo "== starting virtual display =="
Xvfb "$display" -screen 0 1280x1024x24 -nolisten tcp > /dev/null 2>&1 &
xvfb_pid=$!
export DISPLAY="$display"
export XDG_RUNTIME_DIR="$work/xdg"
mkdir -p "$XDG_RUNTIME_DIR"
sleep 3

echo "== launching the application =="
( cd "$appdir" && exec ./AppRun --no-sandbox --disable-gpu --disable-dev-shm-usage ) > "$log" 2>&1 &
app_pid=$!

titles=""
# Cold Electron startup on a runner takes tens of seconds; ninety is generous but cheap,
# because the loop exits the moment a window shows up.
for _ in $(seq 1 45); do
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "FAIL: the application exited during startup" >&2
    sed -n '1,60p' "$log" >&2
    exit 1
  fi
  if grep -qaE "$FATAL_LOG_PATTERN" "$log" 2>/dev/null; then
    echo "FAIL: the application logged a fatal startup error" >&2
    grep -aE "$FATAL_LOG_PATTERN" "$log" | head -5 >&2
    exit 1
  fi
  found=$(xdotool search --onlyvisible --name '.' getwindowname 2>/dev/null | sort -u || true)
  if [[ -n "$found" ]]; then
    # Keep watching briefly: the fatal dialog and the real window can appear in either order,
    # and a window list sampled too early would let a broken build through.
    sleep 10
    titles=$(xdotool search --onlyvisible --name '.' getwindowname 2>/dev/null | sort -u || true)
    break
  fi
  sleep 2
done

echo "== window titles =="
printf '%s\n' "$titles" | sed 's/^/    /'

# A screenshot costs little and is the only artefact that shows what a red build actually drew.
if command -v import > /dev/null 2>&1 && [[ -n "$titles" ]]; then
  mkdir -p "${RUNNER_TEMP:-/tmp}/dsh-smoke"
  import -window root "${RUNNER_TEMP:-/tmp}/dsh-smoke/startup.png" 2>/dev/null || true
fi

if printf '%s' "$titles" | grep -qF "$FATAL_TITLE"; then
  echo "FAIL: the app opened the fatal startup dialog" >&2
  sed -n '1,60p' "$log" >&2
  exit 1
fi
if [[ -z "$titles" ]]; then
  echo "FAIL: no named window appeared within the timeout" >&2
  sed -n '1,60p' "$log" >&2
  exit 1
fi

echo "PASS: the application started and opened a window"
exit 0
