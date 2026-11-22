#!/usr/bin/env python3
"""Wayland screen capture for capture-linux.

Negotiates an xdg-desktop-portal ScreenCast session (the compositor shows its
own picker the first time), then hands the resulting PipeWire node to GStreamer
and writes raw yuv4mpeg frames to stdout until killed.

Needs: python-dbus, python-gobject, gstreamer with the PipeWire plugin
(Arch: gst-plugin-pipewire, Debian/Ubuntu: gstreamer1.0-pipewire).
"""
import os
import sys
import signal
import subprocess

import dbus
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

FPS = sys.argv[1] if len(sys.argv) > 1 else "10"
PORTAL = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
SCREENCAST = "org.freedesktop.portal.ScreenCast"
TOKEN_FILE = os.path.join(
    os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")), "meeting-md", "screencast-token"
)

DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
portal = dbus.Interface(bus.get_object(PORTAL, PATH), SCREENCAST)
loop = GLib.MainLoop()
sender = bus.get_unique_name()[1:].replace(".", "_")
counter = 0


def fail(message):
    sys.stderr.write(message + "\n")
    sys.exit(1)


def request(method, *args, options=None):
    """Calls a portal method and blocks until its Response signal arrives."""
    global counter
    counter += 1
    token = f"meetingmd{os.getpid()}_{counter}"
    result = {}

    def on_response(code, values):
        result["code"], result["values"] = code, values
        loop.quit()

    bus.add_signal_receiver(
        on_response, "Response", "org.freedesktop.portal.Request", PORTAL,
        f"/org/freedesktop/portal/desktop/request/{sender}/{token}",
    )
    opts = dict(options or {})
    opts["handle_token"] = token
    method(*args, dbus.Dictionary(opts, signature="sv"))
    loop.run()
    if result.get("code") != 0:
        fail(f"screen capture was not granted (portal response {result.get('code')})")
    return result["values"]


def saved_token():
    try:
        with open(TOKEN_FILE) as handle:
            return handle.read().strip()
    except OSError:
        return ""


session = request(portal.CreateSession, options={"session_handle_token": f"meetingmd{os.getpid()}"})["session_handle"]

select = {
    "types": dbus.UInt32(1),          # monitors
    "multiple": False,
    "cursor_mode": dbus.UInt32(2),    # cursor embedded in the frames
    "persist_mode": dbus.UInt32(2),   # remember the choice until revoked
}
if saved_token():
    select["restore_token"] = saved_token()
request(portal.SelectSources, session, options=select)

started = request(portal.Start, session, "")
if "restore_token" in started:
    os.makedirs(os.path.dirname(TOKEN_FILE), mode=0o700, exist_ok=True)
    with open(TOKEN_FILE, "w") as handle:
        handle.write(str(started["restore_token"]))
if not started.get("streams"):
    fail("the portal returned no screen stream")

node = int(started["streams"][0][0])
fd = portal.OpenPipeWireRemote(session, dbus.Dictionary({}, signature="sv")).take()

gst = subprocess.Popen(
    [
        "gst-launch-1.0", "-q",
        "pipewiresrc", f"fd={fd}", f"path={node}", "do-timestamp=true", "!",
        "videorate", "!", f"video/x-raw,framerate={FPS}/1", "!",
        "videoconvert", "!", "video/x-raw,format=I420", "!",
        "y4menc", "!", "fdsink", "fd=1",
    ],
    pass_fds=[fd],
)
for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, lambda *_: gst.terminate())
sys.exit(gst.wait())
