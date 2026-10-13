#!/usr/bin/env python3
"""
run_console.py — how the SoundBase plugin starts ad600_console.py.

The console is run unmodified; this only adds the one thing a supervised child
needs that an operator-driven tool did not: it must not outlive its parent.

A session that is abandoned rather than closed leaves the AD600 holding our
membership and the scan slot, and the next controller is refused until the
device is power-cycled. The plugin asks for a clean exit itself (a `quit` line
in the command file, then SIGINT), but it cannot do that if it is killed. So
the plugin keeps our stdin open for as long as it lives, and when that pipe
closes we raise SIGTERM against ourselves — which the console already handles
by releasing the scan slot and leaving the session before it exits.

    python3 run_console.py <run_for_secs> <cmd_file> <log_file>

Stdlib only.
"""
import os
import signal
import sys
import threading


def _exit_with_parent():
    # the raw descriptor, not sys.stdin: a thread parked inside the buffered
    # reader holds its lock, and the interpreter aborts on the way out
    try:
        while os.read(0, 4096):
            pass
    except Exception:
        pass
    try:
        os.kill(os.getpid(), signal.SIGTERM)
    except Exception:
        os._exit(0)


if __name__ == "__main__":
    threading.Thread(target=_exit_with_parent, daemon=True).start()
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import ad600_console

    ad600_console.main()
