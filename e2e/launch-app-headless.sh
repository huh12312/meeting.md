#!/bin/sh
# Launches the forked app on a virtual X display with canned audio, for UI-driven
# end-to-end checks. Needs the Vite dev server (npx vite, in app/) running.
# MIC_FILE / SYSTEM_FILE pick the audio played as "You" / "Them" (default: a
# looping test clip).
here="$(cd "$(dirname "$0")" && pwd)"
profile="${1:-/tmp/mmd-app}"
mic="-re -stream_loop -1 -i $here/jfk.wav"
system="-re -stream_loop -1 -ss 3 -i $here/jfk.wav"
[ -n "$MIC_FILE" ] && mic="-re -i $MIC_FILE"
[ -n "$SYSTEM_FILE" ] && system="-re -i $SYSTEM_FILE"
cd "$here/../app" || exit 1
exec env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 \
  MEETING_MD_MIC_INPUT="$mic" MEETING_MD_SYSTEM_AUDIO_INPUT="$system" \
  xvfb-run -a -s "-screen 0 1280x800x24" \
  node_modules/electron/dist/electron . --user-data-dir="$profile" --remote-debugging-port=9333
