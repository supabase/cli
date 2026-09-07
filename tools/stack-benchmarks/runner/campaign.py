#!/usr/bin/env python3
"""Resumable, serial fresh benchmark campaign.

Measured execution is deliberately opt-in: ``SBR_GO=1`` is required. A dry
matrix is always available and does not import or start a stack. Each sample
is its own cell, allowing an interrupted campaign to resume without rerunning
successful samples.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import shlex
import shutil
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
CAMPAIGN_ROOT: Path | None = None
MANIFEST_PATH = HERE / "manifest.json"
STOP = False
ACTIVE_PROCESS: subprocess.Popen[str] | None = None
FORWARDS: dict[str, subprocess.Popen[str]] = {}
PATHS = {
    "macos": {},
    "ubuntu-22.04": {},
}


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def event(kind: str, **fields: object) -> None:
    row = {"event": kind, "atUnixSeconds": time.time(), **fields}
    print(json.dumps(row, separators=(",", ":")), flush=True)


def stop_signal(_signum: int, _frame: object) -> None:
    global STOP
    STOP = True
    if ACTIVE_PROCESS is not None and ACTIVE_PROCESS.poll() is None:
        ACTIVE_PROCESS.send_signal(signal.SIGTERM)
    event("pause-requested", message="finish current subprocess, then stop before the next cell")


def command(args: list[str], *, env: dict[str, str] | None = None, cwd: Path | None = None,
            timeout: int | None = None, stdout: Path | None = None, stderr: Path | None = None) -> int:
    global ACTIVE_PROCESS
    out = stdout.open("w") if stdout else subprocess.PIPE
    err = stderr.open("w") if stderr else subprocess.PIPE
    try:
        process = subprocess.Popen(args, env=env, cwd=cwd, stdout=out, stderr=err, text=True)
        ACTIVE_PROCESS = process
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            raise
    finally:
        ACTIVE_PROCESS = None
        if stdout:
            out.close()
        if stderr:
            err.close()


def remote_prefix() -> list[str]:
    host = os.environ.get("SBR_LINUX_SSH")
    return ["ssh", "-o", "BatchMode=yes", host] if host else []


def path_for(platform: str, name: str) -> str:
    return PATHS[platform][name]


def cells(manifest: dict, mode: str, platform: str, case_filter: str | None = None) -> list[dict[str, object]]:
    names = list(manifest["cases"])
    if case_filter is not None:
        if case_filter not in names:
            raise ValueError(f"unknown benchmark case: {case_filter}")
        names = [case_filter]
    rows = []
    sample_count = int(manifest["modes"][mode]["samplesPerCase"])
    order = [(sample, case) for sample in range(1, sample_count + 1) for case in names] if mode == "cold" else [(sample, case) for case in names for sample in range(1, sample_count + 1)]
    for sample, case in order:
            rows.append({"platform": platform, "mode": mode, "case": case, "sample": sample,
                         "cellId": f"{platform}/{mode}/{case}/{sample}"})
    return rows


def cell_root(cell: dict[str, object]) -> Path:
    if CAMPAIGN_ROOT is None:
        raise RuntimeError("campaign output is not configured; use the package coordinator")
    return CAMPAIGN_ROOT / "results" / str(cell["platform"]) / str(cell["mode"]) / str(cell["case"]) / f"sample-{cell['sample']}"


def cell_root_remote(cell: dict[str, object]) -> Path:
    return Path(path_for(str(cell["platform"]), "root")) / "results" / str(cell["platform"]) / str(cell["mode"]) / str(cell["case"]) / f"sample-{cell['sample']}"


def status_path(cell: dict[str, object]) -> Path:
    return cell_root(cell) / "cell-status.json"


def is_completed(cell: dict[str, object]) -> bool:
    path = status_path(cell)
    if not path.is_file():
        return False
    try:
        return read_json(path).get("status") == "completed" and (cell_root(cell) / "runner-result.json").is_file()
    except (OSError, ValueError, TypeError):
        return False


def base_env(cell: dict[str, object], manifest: dict, engine_socket: str | None) -> dict[str, str]:
    platform = str(cell["platform"])
    mode = str(cell["mode"])
    case = str(cell["case"])
    root = cell_root_remote(cell) if platform == "ubuntu-22.04" else cell_root(cell)
    source = path_for(platform, "source")
    harness = path_for(platform, "harness")
    env = {**os.environ,
           "BENCHMARK_SOURCE_REVISION": str(manifest["source"]["revision"]),
           "BENCHMARK_SAMPLES": "1", "BENCHMARK_TIMEOUT_MS": str(30 * 60 * 1000),
           "BENCHMARK_MEMORY_HELPER_IMAGE": "python:3.12-slim",
           "BENCHMARK_OUTPUT": str(root / "legacy-results.json"),
           "BENCHMARK_RUN_ROOT": str(root / "legacy-projects"),
           "BENCHMARK_SOURCE_ROOT": f"{source}/packages/stack",
           "SUPABASE_TELEMETRY_DISABLED": "1"}
    if engine_socket:
        env["DOCKER_HOST"] = f"unix://{engine_socket}"
    if case == "legacy" or case == "legacy-pooler":
        env.update({"BENCHMARK_CLI": str(manifest["legacy"]["linuxPath" if platform == "ubuntu-22.04" else "hostPath"]),
                    "BENCHMARK_SKIP_WARMUP": "0" if mode == "hot" else "1", "BENCHMARK_RESTART": "1" if mode == "hot" else "0",
                    "BENCHMARK_MEMORY": "1" if mode == "hot" else "0",
                    "BENCHMARK_ENABLE_POOLER": "1" if case == "legacy-pooler" else "0"})
    else:
        runtime = "container" if case.startswith("new-container") else "native"
        scenario = "eager" if case.endswith("eager") else "default"
        shared_home = Path(path_for(platform, "root")) / "results" / platform / mode / "home"
        home = shared_home if mode == "hot" else root / "home"
        env.update({"SUPABASE_HOME": str(home), "BENCHMARK_HOME": str(home),
                    "BENCHMARK_ROOT": str(root / "new-stack"), "BENCHMARK_CACHE_MODE": mode,
                    "BENCHMARK_RUNTIME": runtime, "BENCHMARK_SCENARIO": scenario,
                    "BENCHMARK_SKIP_PREPARE": "0" if mode == "hot" else "1", "BENCHMARK_SKIP_WARMUP": "0" if mode == "hot" else "1",
                    "BENCHMARK_WAIT_PREFETCH": "1", "BENCHMARK_MEMORY": "1" if mode == "hot" else "0",
                    "BENCHMARK_RESTART": "1" if mode == "hot" else "0",
                    "BENCHMARK_RESTART_ALL": "1" if mode == "hot" else "0",
                    "BENCHMARK_RUN_LABEL": f"{case}-sample-{cell['sample']}",
                    "BENCHMARK_RUNTIME_PLATFORM": platform})
    return env


def local_engine_start(root: Path) -> dict:
    result = subprocess.run([sys.executable, str(HERE / "engine.py"), "start", "--root", str(root)], text=True,
                            capture_output=True, check=True)
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    return json.loads(lines[-1])


def engine_start(platform: str, cell: dict[str, object], shared: bool) -> tuple[dict, subprocess.Popen[str] | None, str]:
    token = uuid.uuid4().hex[:8]
    if platform == "macos" and os.environ.get("SBR_MAC_DOCKER_SSH"):
        ssh_host = os.environ["SBR_MAC_DOCKER_SSH"]
        remote_root = str(Path(path_for("ubuntu-22.04", "root")) / "engines" / f"macos-{cell['mode']}-{token}")
        remote_command = shlex.join(["env", f"SBR_ENGINE_PARENTS={Path(remote_root).parent}", "python3",
                                     path_for("ubuntu-22.04", "runner") + "/engine.py", "start", "--root", remote_root])
        result = subprocess.run(["ssh", "-o", "BatchMode=yes", ssh_host, remote_command],
                                text=True, capture_output=True, check=True)
        descriptor = json.loads([line for line in result.stdout.splitlines() if line.strip()][-1])
        remote_socket = str(descriptor["dockerSocket"])
        # The harness passes DOCKER_HOST into containers and bind-mounts that
        # exact absolute path. The forwarded host socket must therefore use
        # the VM descriptor path verbatim. macOS /private/tmp is shared at the
        # same path; the VM's ordinary /tmp remains VM-local.
        local_socket = remote_socket
        if len(local_socket.encode()) >= 104:
            raise RuntimeError(f"forwarded Unix socket path too long: {local_socket}")
        if Path(local_socket).exists():
            raise RuntimeError(f"refusing to replace pre-existing forwarded socket: {local_socket}")
        forward = subprocess.Popen(["ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
                                    "-L", f"{local_socket}:{remote_socket}", ssh_host],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if forward.poll() is not None:
                error = forward.stderr.read() if forward.stderr else ""
                raise RuntimeError(f"Unix socket forwarding failed: {error.strip()}")
            if Path(local_socket).exists():
                FORWARDS[local_socket] = forward
                descriptor["localForwardSocket"] = local_socket
                return descriptor, forward, local_socket
            time.sleep(0.1)
        forward.terminate()
        raise TimeoutError(f"forwarded Docker socket did not appear: {local_socket}")
    if platform == "ubuntu-22.04" and remote_prefix():
        remote_root = str(Path(path_for(platform, "root")) / "engines" / f"{cell['mode']}-{token}")
        remote_command = shlex.join(["env", f"SBR_ENGINE_PARENTS={Path(remote_root).parent}", "python3",
                                     path_for(platform, "runner") + "/engine.py", "start", "--root", remote_root])
        args = remote_prefix() + [remote_command]
        result = subprocess.run(args, text=True, capture_output=True, check=True)
        descriptor = json.loads([line for line in result.stdout.splitlines() if line.strip()][-1])
        return descriptor, None, str(descriptor["dockerSocket"])
    if CAMPAIGN_ROOT is None:
        raise RuntimeError("campaign output is not configured; use the package coordinator")
    descriptor = local_engine_start(CAMPAIGN_ROOT / "engines" / f"{cell['platform']}-{cell['mode']}-{token}")
    return descriptor, None, str(descriptor["dockerSocket"])


def engine_stop(platform: str, descriptor: dict) -> None:
    local_socket = descriptor.get("localForwardSocket")
    if isinstance(local_socket, str):
        forward = FORWARDS.pop(local_socket, None)
        if forward is not None and forward.poll() is None:
            forward.terminate()
            try:
                forward.wait(timeout=5)
            except subprocess.TimeoutExpired:
                forward.kill()
        Path(local_socket).unlink(missing_ok=True)
        ssh_host = os.environ["SBR_MAC_DOCKER_SSH"]
        remote_command = shlex.join(["env", f"SBR_ENGINE_PARENTS={Path(str(descriptor['root'])).parent}", "python3",
                                     path_for("ubuntu-22.04", "runner") + "/engine.py", "stop", "--descriptor",
                                     str(Path(str(descriptor["root"])) / "engine.json")])
        subprocess.run(["ssh", "-o", "BatchMode=yes", ssh_host, remote_command], check=False)
        return
    if platform == "ubuntu-22.04" and remote_prefix():
        remote_command = shlex.join(["env", f"SBR_ENGINE_PARENTS={Path(str(descriptor['root'])).parent}", "python3",
                                     path_for(platform, "runner") + "/engine.py", "stop", "--descriptor",
                                     str(Path(str(descriptor["root"])) / "engine.json")])
        subprocess.run(remote_prefix() + [remote_command], check=False)
    else:
        subprocess.run([sys.executable, str(HERE / "engine.py"), "stop", "--descriptor", str(Path(str(descriptor["root"])) / "engine.json")], check=False)


def pull_helper(platform: str, socket_path: str) -> None:
    env = {**os.environ, "DOCKER_HOST": f"unix://{socket_path}"}
    if platform == "ubuntu-22.04" and remote_prefix():
        # The helper image is pulled by the VM before any timed process starts.
        subprocess.run(remote_prefix() + [shlex.join(["env", f"DOCKER_HOST=unix://{socket_path}", "docker", "pull", "python:3.12-slim"])], check=True)
    else:
        subprocess.run(["docker", "pull", "python:3.12-slim"], env=env, check=True)


def run_cell(cell: dict[str, object], manifest: dict, engine: tuple[dict, str] | None) -> int:
    root = cell_root(cell)
    remote_root = cell_root_remote(cell)
    if root.exists() and not is_completed(cell):
        attempt = root.parent / "attempts" / f"sample-{cell['sample']}-{int(time.time())}-{uuid.uuid4().hex[:8]}"
        attempt.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(root), str(attempt))
    if str(cell["platform"]) == "ubuntu-22.04" and remote_prefix():
        remote_attempts = remote_root.parent / "attempts"
        remote_attempt_name = "sample-%s-%s-%s" % (cell["sample"], int(time.time()), uuid.uuid4().hex[:8])
        remote_command = f"if test -d {shlex.quote(str(remote_root))}; then mkdir -p {shlex.quote(str(remote_attempts))} && mv -- {shlex.quote(str(remote_root))} {shlex.quote(str(remote_attempts / remote_attempt_name))}; fi"
        subprocess.run(remote_prefix() + [remote_command], check=True)
    root.mkdir(parents=True, exist_ok=True)
    descriptor, socket_path = engine if engine else (None, None)
    env = base_env(cell, manifest, socket_path)
    platform = str(cell["platform"])
    harness = path_for(platform, "harness")
    case = str(cell["case"])
    if case.startswith("new-"):
        script = f"{harness}/new-stack.ts"
        args = ["bun", script]
    else:
        script = f"{harness}/legacy.ts"
        args = ["bun", script]
    if platform == "ubuntu-22.04" and remote_prefix():
        # Use explicit env argv so paths, sockets, and credentials are not shell-expanded.
        remote_values = [f"{key}={value}" for key, value in env.items() if key.startswith("BENCHMARK_") or key in {"SUPABASE_HOME", "SUPABASE_TELEMETRY_DISABLED", "DOCKER_HOST"}]
        remote_command = ["env", *remote_values, "bun", *args[1:]]
        command_args = remote_prefix() + [shlex.join(remote_command)]
    else:
        command_args = args
    started = time.time()
    write_json(root / "cell-status.json", {"status": "running", "cell": cell, "startedAtUnixSeconds": started})
    event("cell-start", cellId=cell["cellId"], mode=cell["mode"], case=case, sample=cell["sample"], platform=platform)
    code: int | None = None
    primary_error: Exception | None = None
    sync_error: Exception | None = None
    try:
        code = command(command_args, env=None if platform == "ubuntu-22.04" and remote_prefix() else env,
                       timeout=30 * 60, stdout=root / "stdout.log", stderr=root / "stderr.log")
    except Exception as error:
        primary_error = error
    finally:
        if platform == "ubuntu-22.04" and remote_prefix():
            try:
                sync_remote_cell(cell)
            except Exception as error:
                sync_error = error
                write_json(root / "sync-failure.json", {"status": "sync-failed", "cell": cell,
                                                         "error": f"{type(error).__name__}: {error}"})
    if isinstance(primary_error, subprocess.TimeoutExpired):
        result = {"status": "timeout", "cell": cell, "elapsedSeconds": time.time() - started}
        if sync_error is not None:
            result["syncError"] = f"{type(sync_error).__name__}: {sync_error}"
        write_json(root / "runner-result.json", result)
        write_json(root / "cell-status.json", {**result, "status": "failed", "reason": "timeout"})
        event("cell-failed", cellId=cell["cellId"], status="timeout", syncFailed=sync_error is not None)
        return 124
    if primary_error is not None:
        result = {"status": "failed", "reason": "command-error", "cell": cell,
                  "error": f"{type(primary_error).__name__}: {primary_error}",
                  "elapsedSeconds": round(time.time() - started, 3),
                  "stdoutPath": str(root / "stdout.log"), "stderrPath": str(root / "stderr.log")}
    else:
        result = {"status": "completed" if code == 0 and sync_error is None else "failed", "cell": cell,
                  "returncode": code, "elapsedSeconds": round(time.time() - started, 3),
                  "stdoutPath": str(root / "stdout.log"), "stderrPath": str(root / "stderr.log")}
        if sync_error is not None:
            result["reason"] = "remote-sync" if code == 0 else "command-and-sync"
            if code != 0:
                result["commandError"] = f"command returned exit code {code}"
    if sync_error is not None:
        result["syncError"] = f"{type(sync_error).__name__}: {sync_error}"
    write_json(root / "runner-result.json", result)
    cell_status = result
    if sync_error is not None and primary_error is None and code == 0:
        # The command itself succeeded, but remote output was not collected;
        # classify this as setup failure so aggregation excludes the cell.
        cell_status = {**result, "status": "setup-failed", "reason": "remote-sync"}
    write_json(root / "cell-status.json", cell_status)
    # Cold native cells own a disposable home. Keep result JSON/logs, but
    # remove the potentially multi-GB downloaded cache after a success.
    if result["status"] == "completed" and str(cell["mode"]) == "cold" and case.startswith("new-native"):
        cleanup_home = (remote_root / "home" if platform == "ubuntu-22.04" and remote_prefix()
                        else root / "home")
        remove_exact_path(platform, cleanup_home)
    event("cell-complete" if result["status"] == "completed" else "cell-failed", cellId=cell["cellId"], returncode=code,
          elapsedSeconds=result["elapsedSeconds"])
    return code if result["status"] == "completed" or code not in (None, 0) else 70


def sync_remote_cell(cell: dict[str, object]) -> None:
    """Copy remote harness output while retaining host runner-owned files."""
    if str(cell["platform"]) != "ubuntu-22.04" or not remote_prefix():
        return
    local = cell_root(cell)
    remote = cell_root_remote(cell)
    excludes = ["--exclude=./stdout.log", "--exclude=./stderr.log", "--exclude=./cell-status.json",
                "--exclude=./runner-result.json", "--exclude=./setup-failure.json",
                "--exclude=./home", "--exclude=./legacy-projects", "--exclude=./new-stack/projects"]
    # Exclude generated homes/project trees at the remote source too, so the
    # SSH subprocess never buffers multi-GB caches in host memory.
    remote_tar = shlex.join(["tar", *excludes, "-cf", "-", "-C", str(remote), "."])
    archive = subprocess.run(remote_prefix() + [remote_tar], capture_output=True, check=True)
    subprocess.run(["tar", "-xf", "-", "-C", str(local), "--no-same-owner", *excludes], input=archive.stdout, check=True)


def remove_exact_path(platform: str, path: Path) -> None:
    """Remove one campaign-owned path, using sudo only on the VM."""
    campaign_results = (Path(path_for(platform, "root")) / "results").resolve()
    target = path.resolve()
    if campaign_results not in target.parents:
        raise RuntimeError(f"refusing cleanup outside campaign results: {target}")
    if platform == "ubuntu-22.04" and remote_prefix():
        script = (
            "from pathlib import Path; import shutil, sys; "
            "p=Path(sys.argv[1]); "
            "shutil.rmtree(p) if p.is_dir() else p.unlink(missing_ok=True)"
        )
        command_line = shlex.join(["sudo", "-n", "python3", "-c", script, str(path)])
        subprocess.run(remote_prefix() + [command_line], check=True)
    elif path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def setup_failure(cell: dict[str, object], error: BaseException) -> None:
    root = cell_root(cell)
    root.mkdir(parents=True, exist_ok=True)
    value = {"status": "setup-failed", "cell": cell, "error": f"{type(error).__name__}: {error}"}
    write_json(root / "setup-failure.json", value)
    write_json(root / "cell-status.json", value)
    event("setup-failed", cellId=cell["cellId"], error= value["error"])


def apply_overrides(manifest: dict, args: argparse.Namespace) -> None:
    global CAMPAIGN_ROOT, PATHS
    if args.output:
        CAMPAIGN_ROOT = Path(args.output)
        PATHS["macos"]["root"] = str(CAMPAIGN_ROOT)
    if args.source:
        PATHS["macos"]["source"] = str(Path(args.source).resolve())
        manifest["source"]["hostPath"] = PATHS["macos"]["source"]
    if args.linux_source:
        PATHS["ubuntu-22.04"]["source"] = args.linux_source
        manifest["source"]["linuxPath"] = args.linux_source
    if args.linux_root:
        PATHS["ubuntu-22.04"]["root"] = args.linux_root
    if args.linux_runner:
        PATHS["ubuntu-22.04"]["runner"] = args.linux_runner
    if args.harness:
        PATHS["macos"]["harness"] = str(Path(args.harness).resolve())
        manifest["harness"]["hostPath"] = PATHS["macos"]["harness"]
    if args.linux_harness:
        PATHS["ubuntu-22.04"]["harness"] = args.linux_harness
        manifest["harness"]["linuxPath"] = args.linux_harness
        if not args.linux_runner:
            PATHS["ubuntu-22.04"]["runner"] = str(Path(args.linux_harness).parent / "runner")
    if args.legacy:
        manifest["legacy"]["hostPath"] = args.legacy
    if args.linux_legacy:
        manifest["legacy"]["linuxPath"] = args.linux_legacy
    if args.vm:
        os.environ["SBR_MAC_DOCKER_SSH"] = args.vm
        os.environ["SBR_LINUX_SSH"] = args.vm
    if args.ref:
        manifest["source"]["revision"] = args.ref


def dry_run(manifest: dict, mode: str | None, platform: str | None, case_filter: str | None) -> int:
    modes = [mode] if mode else ["cold", "hot"]
    platforms = [platform] if platform else list(manifest["platforms"])
    rows = [cell for m in modes for p in platforms for cell in cells(manifest, m, p, case_filter)]
    print(json.dumps({"schemaVersion": 1, "campaignId": manifest["campaignId"], "timed": False,
                      "sourceRevision": manifest["source"]["revision"], "cellCount": len(rows), "cells": rows}, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["cold", "hot"])
    parser.add_argument("--platform", choices=["macos", "ubuntu-22.04"])
    parser.add_argument("--case", dest="case_filter", help="run or list one benchmark case")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--ref", "--revision", dest="ref")
    parser.add_argument("--output")
    parser.add_argument("--source")
    parser.add_argument("--linux-source")
    parser.add_argument("--linux-root")
    parser.add_argument("--linux-runner")
    parser.add_argument("--harness")
    parser.add_argument("--linux-harness")
    parser.add_argument("--legacy")
    parser.add_argument("--linux-legacy")
    parser.add_argument("--vm", help="SSH host for the dedicated Docker VM, e.g. orb")
    args = parser.parse_args()
    manifest = read_json(MANIFEST_PATH)
    if args.dry_run or not args.run:
        apply_overrides(manifest, args)
        return dry_run(manifest, args.mode, args.platform, args.case_filter)
    required = {
        "--ref": args.ref,
        "--output": args.output,
        "--source": args.source,
        "--linux-source": args.linux_source,
        "--linux-root": args.linux_root,
        "--linux-runner": args.linux_runner,
        "--harness": args.harness,
        "--linux-harness": args.linux_harness,
        "--legacy": args.legacy,
        "--linux-legacy": args.linux_legacy,
        "--vm": args.vm,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        parser.error("--run requires package-coordinator paths: " + ", ".join(missing))
    apply_overrides(manifest, args)
    if os.environ.get("SBR_GO") != "1":
        print("refusing timed run: set SBR_GO=1 only after root publication/metadata verification", file=sys.stderr)
        return 2
    modes = [args.mode] if args.mode else ["cold", "hot"]
    platforms = [args.platform] if args.platform else list(manifest["platforms"])
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, stop_signal)
    for mode in modes:
        for platform in platforms:
            shared_engine: tuple[dict, str] | None = None
            try:
                for cell in [c for c in cells(manifest, mode, platform, args.case_filter) if not is_completed(c)]:
                    if STOP:
                        event("campaign-paused", nextCell=cell["cellId"])
                        return 130
                    container = str(cell["case"]).startswith("new-container") or str(cell["case"]).startswith("legacy")
                    engine = shared_engine
                    if container and engine is None:
                        try:
                            descriptor, _forward, socket_path = engine_start(platform, cell, mode == "hot")
                        except Exception as error:
                            setup_failure(cell, error)
                            event("campaign-stopped", cellId=cell["cellId"], reason="setup failure")
                            return 70
                        engine = (descriptor, socket_path)
                        if mode == "hot":
                            shared_engine = engine
                            try:
                                pull_helper(platform, socket_path)
                            except Exception as error:
                                setup_failure(cell, error)
                                engine_stop(platform, descriptor)
                                shared_engine = None
                                event("campaign-stopped", cellId=cell["cellId"], reason="setup failure")
                                return 70
                    try:
                        code = run_cell(cell, manifest, engine)
                    except Exception as error:
                        # A transport/sync failure must still stop the exact
                        # cold engine before the campaign records setup-failed.
                        if mode == "cold" and engine is not None:
                            engine_stop(platform, engine[0])
                            engine = None
                        setup_failure(cell, error)
                        event("campaign-stopped", cellId=cell["cellId"], reason="cell exception")
                        return 70
                    if mode == "cold" and engine is not None:
                        engine_stop(platform, engine[0])
                    if code != 0:
                        event("campaign-stopped", cellId=cell["cellId"], reason="cell failure")
                        return code
                if shared_engine is not None:
                    engine_stop(platform, shared_engine[0])
                    shared_engine = None
                if mode == "hot":
                    # Shared hot native home is retained until every case and
                    # sample on this platform has completed.
                    shared_home = Path(path_for(platform, "root")) / "results" / platform / mode / "home"
                    remove_exact_path(platform, shared_home)
            finally:
                if shared_engine is not None:
                    engine_stop(platform, shared_engine[0])
    event("campaign-complete", modes=modes, platforms=platforms)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
