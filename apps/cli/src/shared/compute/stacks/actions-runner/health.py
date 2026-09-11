#!/usr/bin/env python3
"""Answers the launcher's HTTP probe while the runner does its work.

A runner only ever calls out to GitHub, so it would otherwise have nothing
listening on $PORT. Serving the supervisor's state file makes the compute
report whether it is waiting for a job, running one, or wedged.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_FILE = os.environ.get("RUNNER_STATE_FILE", "/home/runner/state.json")
PORT = int(os.environ.get("PORT", "8080"))


def read_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {"phase": "unknown"}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - http.server's interface
        state = read_state()
        body = json.dumps({"compute": "actions-runner", **state}).encode("utf-8")
        # A wedged supervisor should look unhealthy to whatever is probing.
        code = 503 if state.get("phase") in ("error", "stopped") else 200
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s [health] %s\n" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
