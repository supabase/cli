#!/usr/bin/env python3
"""Repeat the original Kong-backed E2E test and preserve each attempt."""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
HARNESS = Path(__file__).resolve().parent
OUTPUT_DIR = Path(os.environ["OUTPUT_DIR"]).resolve() if "OUTPUT_DIR" in os.environ else (
    Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "edge-runtime-crash"
).resolve()
MAX_ATTEMPTS = 30
MAX_SECONDS = 600
TEST_PATH = "src/shared/functions/serve-main-offline.e2e.test.ts"
TEST_NAME = "preserves function env and CORS headers"


def main() -> int:
    real_docker = shutil.which("docker")
    if real_docker is None:
        print("docker is not available on PATH", file=sys.stderr)
        return 2

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    attempts_dir = OUTPUT_DIR / "attempts"
    attempts_dir.mkdir(exist_ok=True)
    env = os.environ.copy()
    env["REAL_DOCKER"] = str(Path(real_docker).resolve())
    env["OUTPUT_DIR"] = str(OUTPUT_DIR)
    env.setdefault("CRASH_TRACE", "0")
    env["PATH"] = f"{HARNESS}{os.pathsep}{env.get('PATH', '')}"
    command = [
        "pnpm",
        "--filter",
        "supabase",
        "test:e2e:run",
        TEST_PATH,
        "-t",
        TEST_NAME,
        "--passWithNoTests=false",
    ]
    deadline = time.monotonic() + MAX_SECONDS
    results = []
    for number in range(1, MAX_ATTEMPTS + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print("Stopped at the 10-minute wall-clock limit.")
            break
        log_path = attempts_dir / f"attempt-{number:02d}.log"
        status_path = attempts_dir / f"attempt-{number:02d}.json"
        started = time.time()
        timed_out = False
        try:
            result = subprocess.run(
                command,
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=remaining,
            )
            status = result.returncode
            output = result.stdout
        except subprocess.TimeoutExpired as error:
            timed_out = True
            status = 124
            output = error.stdout or ""
            if isinstance(output, bytes):
                output = output.decode(errors="replace")
            output += "\nHarness stopped the test at the 10-minute wall-clock limit.\n"
        log_path.write_text(output)
        record = {
            "attempt": number,
            "command": command,
            "exitCode": status,
            "timedOut": timed_out,
            "startedAtUnix": started,
            "elapsedSeconds": round(time.time() - started, 2),
            "log": str(log_path),
        }
        status_path.write_text(json.dumps(record, indent=2) + "\n")
        results.append(record)
        print(f"===== attempt {number}: exit {status}; log {log_path} =====", flush=True)
        print(output, flush=True)
        if (OUTPUT_DIR / "first-exit-135.json").exists():
            print("Captured a runtime exit code 135; stopping after the first crash.")
            break
        if timed_out:
            break

    summary = {
        "classification": (
            "exit-code-135-captured"
            if (OUTPUT_DIR / "first-exit-135.json").exists()
            else "no-exit-135-captured"
        ),
        "attempts": results,
        "attemptCount": len(results),
    }
    summary_path = OUTPUT_DIR / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Summary: {summary_path}")
    print(f"Classification: {summary['classification']}")
    if any(result["exitCode"] != 0 for result in results):
        print("One or more test attempts failed; see their per-attempt logs.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
