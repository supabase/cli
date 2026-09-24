#!/usr/bin/env python3
"""Prove the Docker shim and runner produce a readable SIGBUS core."""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


HARNESS = Path(__file__).resolve().parent
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "/tmp/edge-runtime-crash")).resolve()
IMAGE = os.environ.get("EDGE_RUNTIME_IMAGE", "public.ecr.aws/supabase/edge-runtime:v1.76.2")


def execute(args, env, timeout=60):
    return subprocess.run(
        args,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )


def main() -> int:
    real_docker = shutil.which("docker")
    if real_docker is None:
        print("docker is not available on PATH", file=sys.stderr)
        return 2

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "cores").mkdir(exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix=".core-preflight-", dir=OUTPUT_DIR))
    container = f"supabase-serve-kong-e2e-preflight-{os.getpid()}-runtime"
    env = os.environ.copy()
    env["REAL_DOCKER"] = str(Path(real_docker).resolve())
    env["OUTPUT_DIR"] = str(work_dir)
    env.setdefault("CRASH_TRACE", "0")
    env["PATH"] = f"{HARNESS}{os.pathsep}{env.get('PATH', '')}"
    created = False

    try:
        run = execute(
            [
                "docker",
                "run",
                "-d",
                "--name",
                container,
                "--entrypoint",
                "/bin/sh",
                IMAGE,
                "-c",
                'sh -c \'kill -BUS $$\' & child=$!; wait "$child"',
            ],
            env,
        )
        if run.returncode != 0:
            raise RuntimeError(f"Docker preflight run failed ({run.returncode}):\n{run.stdout}")
        created = True

        waited = execute(["docker", "wait", container], env)
        if waited.returncode != 0:
            raise RuntimeError(f"Docker wait failed ({waited.returncode}):\n{waited.stdout}")
        try:
            exit_code = int(waited.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError) as error:
            raise RuntimeError(f"Unexpected docker wait output: {waited.stdout!r}") from error
        if exit_code != 135:
            raise RuntimeError(f"SIGBUS child exited with {exit_code}, expected 135")

        removed = execute(["docker", "rm", "-f", container], env)
        created = False
        if removed.returncode != 0:
            raise RuntimeError(f"Docker rm failed ({removed.returncode}):\n{removed.stdout}")

        cores_dir = work_dir / "cores"
        cores = sorted(path for path in cores_dir.glob("core.*") if path.is_file() and path.stat().st_size > 0)
        if not cores:
            raise RuntimeError("SIGBUS child exited 135, but the shim-mounted cores directory is empty")

        core = cores[0]
        gdb = shutil.which("gdb")
        if gdb is None:
            raise RuntimeError("gdb is required to validate the preflight core")
        gdb_command = ["sudo", gdb, "-nx", "-batch", "-c", str(core), "-ex", "p $_siginfo"]
        checked = execute(gdb_command, env, timeout=30)
        gdb_report = checked.stdout
        (OUTPUT_DIR / "preflight-gdb.txt").write_text(gdb_report)
        if checked.returncode != 0 or not re.search(r"si_signo\s*=\s*7\b", gdb_report):
            raise RuntimeError(f"GDB did not confirm SIGBUS in the preflight core:\n{gdb_report}")

        destination_dir = OUTPUT_DIR / "cores" / f"preflight-{os.getpid()}"
        destination_dir.mkdir(parents=True, exist_ok=False)
        moved = []
        for source in cores:
            destination = destination_dir / source.name
            shutil.move(str(source), destination)
            moved.append({"path": str(destination), "size": destination.stat().st_size})

        report = {
            "image": IMAGE,
            "container": container,
            "exitCode": exit_code,
            "signal": "SIGBUS",
            "cores": moved,
            "gdbReport": str(OUTPUT_DIR / "preflight-gdb.txt"),
        }
        (OUTPUT_DIR / "preflight.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        return 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"Core capture preflight failed: {error}", file=sys.stderr)
        return 1
    finally:
        if created:
            execute(["docker", "rm", "-f", container], env)
        shutil.rmtree(work_dir)


if __name__ == "__main__":
    raise SystemExit(main())
