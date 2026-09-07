#!/usr/bin/env python3
"""Own one short-path Docker/containerd pair for a benchmark cell.

The process is intentionally small and JSON based so the campaign runner can
start it locally or through ``ssh orb``. It never examines or removes the
default Docker store.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

SHORT_ROOT = Path("/tmp")


def allowed_engine_parent(root: Path) -> bool:
    configured = os.environ.get("SBR_ENGINE_PARENTS")
    if not configured:
        raise RuntimeError("SBR_ENGINE_PARENTS is required; invoke the engine through the package coordinator")
    return any(root.parent == Path(item).resolve() for item in configured.split(":") if item)


def run(args: list[str], *, env: dict[str, str] | None = None, check: bool = True,
        timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, env=env, text=True, capture_output=True, check=check, timeout=timeout)


def sudo(args: list[str], *, check: bool = True, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return run(["sudo", "-n", *args], check=check, timeout=timeout)


def short_socket(name: str) -> Path:
    path = SHORT_ROOT / name
    if len(str(path).encode()) >= 104:
        raise RuntimeError(f"Unix socket path is too long: {path}")
    return path


def start(root: Path) -> dict[str, object]:
    root = root.resolve()
    if not allowed_engine_parent(root):
        raise RuntimeError(f"engine root is outside configured campaign parents: {root}")
    minimum_free = int(os.environ.get("SBR_MIN_FREE_BYTES", str(8 * 1024**3)))
    volume = root.parent
    while not volume.exists() and volume != volume.parent:
        volume = volume.parent
    usage = os.statvfs(volume)
    free_bytes = usage.f_bavail * usage.f_frsize
    if free_bytes < minimum_free:
        raise RuntimeError(f"insufficient free space for isolated engine: {free_bytes} < {minimum_free} bytes")
    root.mkdir(parents=True, exist_ok=False)
    token = f"sbr-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    docker_socket = short_socket(f"{token}.docker.sock")
    containerd_socket = short_socket(f"{token}.ctd.sock")
    exec_root = short_socket(f"{token}.exec")
    bridge = ("sbr" + token.replace("-", ""))[:15]
    if len(bridge) > 15:
        raise RuntimeError("bridge name exceeds Linux interface limit")
    store = root / "docker-data"
    ctd_root = root / "containerd-root"
    ctd_state = root / "containerd-state"
    ctd_pidfile = root / "containerd.pid"
    for path in (store, ctd_root, ctd_state, exec_root):
        path.mkdir(parents=True, exist_ok=True)
    ctd_log = (root / "containerd.log").open("w")
    ctd = subprocess.Popen(
        ["sudo", "-n", "sh", "-c", "echo $$ > \"$1\"; exec containerd --root \"$2\" --state \"$3\" --address \"$4\"", "engine", str(ctd_pidfile), str(ctd_root), str(ctd_state), str(containerd_socket)],
        stdout=ctd_log, stderr=subprocess.STDOUT, text=True,
    )
    try:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if ctd.poll() is not None:
                raise RuntimeError(f"containerd exited {ctd.returncode}; see {root / 'containerd.log'}")
            if containerd_socket.exists():
                break
            time.sleep(0.25)
        else:
            raise TimeoutError(f"containerd did not become ready; see {root / 'containerd.log'}")
        sudo(["ip", "link", "add", "name", bridge, "type", "bridge"])
        sudo(["ip", "link", "set", bridge, "up"])
        dockerd_log = (root / "dockerd.log").open("w")
        pidfile = root / "dockerd.pid"
        daemon = subprocess.Popen(
            ["sudo", "-n", "dockerd", "--data-root", str(store), "--exec-root", str(exec_root),
             "--host", f"unix://{docker_socket}", "--pidfile", str(pidfile),
             "--containerd", str(containerd_socket), "--group", "docker", "--bridge", bridge],
            stdout=dockerd_log, stderr=subprocess.STDOUT, text=True,
        )
        env = {**os.environ, "DOCKER_HOST": f"unix://{docker_socket}"}
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if daemon.poll() is not None:
                raise RuntimeError(f"dockerd exited {daemon.returncode}; see {root / 'dockerd.log'}")
            probe = run(["docker", "info", "--format", "{{.DockerRootDir}}"], env=env, check=False, timeout=5)
            if probe.returncode == 0:
                images = run(["docker", "images", "-q"], env=env).stdout.strip()
                if images:
                    raise RuntimeError(f"new private Docker store is not empty: {images!r}")
                descriptor = {
                    "schemaVersion": 1, "root": str(root), "dockerSocket": str(docker_socket),
                    "containerdSocket": str(containerd_socket), "execRoot": str(exec_root),
                    "bridge": bridge, "dockerdPid": daemon.pid, "containerdPid": ctd.pid,
                    "pidfile": str(pidfile), "containerdPidfile": str(ctd_pidfile), "dockerRoot": probe.stdout.strip(),
                    "emptyImageCount": 0, "freeBytesBeforeStart": free_bytes,
                }
                (root / "engine.json").write_text(json.dumps(descriptor, indent=2) + "\n")
                return descriptor
            time.sleep(0.25)
        raise TimeoutError(f"dockerd did not become ready; see {root / 'dockerd.log'}")
    except Exception:
        stop_descriptor({"root": str(root), "dockerdPid": None, "containerdPid": ctd.pid,
                         "bridge": bridge, "pidfile": str(root / "dockerd.pid"),
                         "containerdPidfile": str(ctd_pidfile), "execRoot": str(exec_root), "containerdSocket": str(containerd_socket)})
        raise
    finally:
        ctd_log.close()


def stop_descriptor(descriptor: dict[str, object]) -> None:
    root = Path(str(descriptor["root"])).resolve()
    if root == Path("/") or root == Path("/tmp") or not allowed_engine_parent(root):
        raise RuntimeError(f"refusing cleanup of unrecognised engine root: {root}")
    pidfile = Path(str(descriptor.get("pidfile", root / "dockerd.pid")))
    ctd_pidfile = Path(str(descriptor.get("containerdPidfile", root / "containerd.pid")))
    pids: list[int] = []
    for file in (pidfile, ctd_pidfile):
        if file.is_file():
            try:
                pid = int(file.read_text().strip())
            except ValueError:
                pid = 0
            if pid > 1:
                pids.append(pid)
    for pid in sorted(set(pids)):
        command_line = sudo(["sh", "-c", "tr '\\0' ' ' < /proc/$1/cmdline", "engine", str(pid)], check=False).stdout
        if str(root) not in command_line:
            raise RuntimeError(f"refusing to signal PID {pid}: command does not identify engine root")
        sudo(["kill", str(pid)], check=False)
    daemon_pid = descriptor.get("dockerdPid")
    if isinstance(daemon_pid, int) and daemon_pid > 1:
        try:
            os.kill(daemon_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    bridge = str(descriptor.get("bridge", ""))
    if bridge:
        sudo(["ip", "link", "del", bridge], check=False)
    ctd_pid = descriptor.get("containerdPid")
    if isinstance(ctd_pid, int) and ctd_pid > 1:
        try:
            os.kill(ctd_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    def alive(pid: int) -> bool:
        result = sudo(["sh", "-c", "test -r /proc/$1/cmdline && test \"$(tr '\\0' ' ' < /proc/$1/cmdline)\" != \"\"", "engine", str(pid)], check=False)
        return result.returncode == 0
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and any(alive(pid) for pid in pids):
        time.sleep(0.25)
    remaining = [pid for pid in pids if alive(pid)]
    if remaining:
        for pid in remaining:
            sudo(["kill", "-KILL", str(pid)], check=False)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and any(alive(pid) for pid in remaining):
            time.sleep(0.25)
    remaining = [pid for pid in pids if alive(pid)]
    if remaining:
        raise RuntimeError(f"refusing store cleanup while engine PIDs remain: {remaining}")
    for path in (Path(str(descriptor.get("dockerSocket", ""))), Path(str(descriptor.get("containerdSocket", "")))):
        if path and str(path) != ".":
            sudo(["rm", "-f", "--", str(path)], check=False)
    # Keep engine.json and daemon logs as audit evidence. Remove only the
    # exact private stores/state and short executor path after pid exit.
    for path in (root / "docker-data", root / "containerd-root", root / "containerd-state", Path(str(descriptor.get("execRoot", root / "exec")))):
        sudo(["rm", "-rf", "--", str(path)], check=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    start_parser = sub.add_parser("start")
    start_parser.add_argument("--root", type=Path, required=True)
    stop_parser = sub.add_parser("stop")
    stop_parser.add_argument("--descriptor", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "start":
        print(json.dumps(start(args.root)), flush=True)
    else:
        stop_descriptor(json.loads(args.descriptor.read_text()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
