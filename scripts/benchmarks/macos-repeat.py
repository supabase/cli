#!/usr/bin/env python3
"""Measure repeated cached eager native starts on macOS."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import signal
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stack


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def persist(path: Path, record: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def process_sample() -> dict[str, Any]:
    result = stack.run(
        ["ps", "-axo", "pid,ppid,%cpu,rss,command"], cwd=Path.cwd(),
        env=os.environ.copy(), timeout=15,
    )
    return {"sampled_at": timestamp(), **result}


class ResourceSampler:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.process_stop = threading.Event()
        self.process_thread: threading.Thread | None = None
        self.collectors: list[dict[str, Any]] = []

    def start(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        commands = [
            ("top", ["top", "-R", "-F", "-l", "0", "-s", "1", "-n", "0"]),
            ("vm_stat", ["vm_stat", "1"]),
            ("iostat", ["iostat", "-w", "1"]),
        ]
        for name, command in commands:
            output = self.directory / f"{name}.log"
            stream = output.open("wb")
            try:
                process = subprocess.Popen(
                    command, stdout=stream, stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as error:
                stream.write(f"collector spawn failed at {timestamp()}: {error}\n".encode())
                stream.close()
                self.collectors.append({"name": name, "argv": command, "available": False, "error": str(error), "path": str(output)})
            else:
                self.collectors.append({"name": name, "argv": command, "available": True, "started_at": timestamp(), "path": str(output), "process": process, "stream": stream})
        self.process_thread = threading.Thread(target=self._sample_processes, daemon=True)
        self.process_thread.start()

    def _sample_processes(self) -> None:
        path = self.directory / "processes.jsonl"
        with path.open("a", encoding="utf-8") as stream:
            while not self.process_stop.is_set():
                stream.write(json.dumps(process_sample()) + "\n")
                stream.flush()
                self.process_stop.wait(2)

    def stop(self) -> list[dict[str, Any]]:
        self.process_stop.set()
        if self.process_thread is not None:
            self.process_thread.join(timeout=20)
        results = []
        for collector in self.collectors:
            process = collector.pop("process", None)
            stream = collector.pop("stream", None)
            if process is not None:
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                        process.wait(timeout=5)
                    except (OSError, subprocess.TimeoutExpired):
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except OSError:
                            pass
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            pass
                collector.update({"finished_at": timestamp(), "exit_code": process.poll()})
            if stream is not None:
                stream.close()
            results.append(collector)
        return results


def sysctl_swap(env: dict[str, str], cwd: Path) -> dict[str, Any]:
    return {"sampled_at": timestamp(), **stack.run(["sysctl", "vm.swapusage"], cwd=cwd, env=env, timeout=15)}


def start_command(cli: Path, project: Path) -> list[str]:
    return [str(cli), "start", "--workdir", str(project), "--runtime", "native", "--eager", "--output-format", "json"]


def run_start(cli: Path, project: Path, env: dict[str, str], sampler_dir: Path | None) -> dict[str, Any]:
    cache_root = Path(env["SUPABASE_HOME"]) / "cache" / "stack"
    phase: dict[str, Any] = {"project": str(project), "started_at": timestamp(), "cache_before": stack.cache_inventory(cache_root)}
    phase["swap_before"] = sysctl_swap(env, project)
    sampler = ResourceSampler(sampler_dir) if sampler_dir is not None else None
    sampling_started = time.perf_counter()
    try:
        if sampler is not None:
            sampler.start()
        phase["start_command_started_at"] = timestamp()
        phase["start"] = stack.run(start_command(cli, project), cwd=project, env=env)
        phase["start_command_finished_at"] = timestamp()
    finally:
        if sampler is not None:
            phase["samplers"] = sampler.stop()
    phase["start_wall_ms"] = phase["start"].get("elapsed_ms")
    phase["sampling_window_ms"] = round((time.perf_counter() - sampling_started) * 1000, 2)
    phase["swap_after"] = sysctl_swap(env, project)
    phase["cache_after"] = stack.cache_inventory(cache_root)
    phase["status"] = stack.status_command(cli, "new", project, env)
    status_payload = stack.json_value(phase["status"].get("stdout", ""))
    phase["readiness"] = stack.service_readiness(status_payload, "eager")
    phase["ready"] = bool(phase["start"].get("ok") and phase["status"].get("ok") and phase["readiness"].get("expected_ready") and phase["readiness"].get("selected_service_count") == 11)
    phase["finished_at"] = timestamp()
    return phase


def init_owned(cli: Path, project: Path, project_id: str, env: dict[str, str]) -> dict[str, Any]:
    result = stack.init_project(cli, project, env)
    stack.configure_project(project, project_id, stack=True, pooler=False)
    result["config_exists"] = (project / "supabase" / "config.toml").is_file()
    return result


def destroy(cli: Path, project: Path, env: dict[str, str]) -> dict[str, Any]:
    if not project.exists():
        return {"ok": True, "skipped": True}
    return stack.destroy_new(cli, project, env)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path, help="Compiled CLI executable")
    parser.add_argument("--output", required=True, type=Path, help="JSON result path")
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--sample", required=True, help="Runner or campaign identifier")
    parser.add_argument("--trace-file", type=Path, help="Optional source lifecycle JSONL trace destination")
    args = parser.parse_args()
    cli = args.cli.resolve()
    if not cli.is_file() or not os.access(cli, os.X_OK):
        parser.error(f"CLI must be an executable file: {cli}")
    if args.repetitions < 1:
        parser.error("--repetitions must be >= 1")
    if platform.system() != "Darwin":
        parser.error("this benchmark requires macOS")

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_parent = Path(os.environ.get("RUNNER_TEMP", "/tmp")).resolve()
    root = temp_parent / f"macos-repeat-{os.getpid()}-{time.time_ns()}"
    root.mkdir()
    resources = output.parent / f"{output.stem}-resources-{os.getpid()}-{time.time_ns()}"
    resources.mkdir(exist_ok=True)
    home = root / "supabase-home"
    base_env = os.environ.copy()
    base_env.update({
        "SUPABASE_HOME": str(home), "SUPABASE_NO_UPDATE_NOTIFIER": "1",
        "SUPABASE_TELEMETRY_DISABLED": "1", "SUPABASE_NO_KEYRING": "1",
        "SUPABASE_EXPERIMENTAL_STACK": "1",
        "DOCKER_HOST": f"unix://{root / 'docker-unavailable.sock'}",
    })
    base_env.pop("DOCKER_CONTEXT", None)
    base_env.pop("SUPABASE_PROJECT_ID", None)
    base_env.pop("SUPABASE_NETWORK_ID", None)
    if args.trace_file is not None:
        trace = args.trace_file.resolve()
        trace.parent.mkdir(parents=True, exist_ok=True)
        base_env["SUPABASE_STACK_TRACE_FILE"] = str(trace)

    record: dict[str, Any] = {
        "schema_version": 1, "benchmark": "macos-repeat-cached-eager-native",
        "status": "running", "sample": args.sample, "started_at": timestamp(),
        "cli": str(cli), "repetitions_requested": args.repetitions,
        "host": {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version()},
        "paths": {"root": str(root), "home": str(home), "resources": str(resources), "trace": str(args.trace_file.resolve()) if args.trace_file else None},
        "warmup": None, "control_before": None, "repetitions": [], "control_after": None, "cleanup": [],
    }
    persist(output, record)
    all_phases = ["warmup", "control_before", *[f"repetition_{index}" for index in range(1, args.repetitions + 1)], "control_after"]

    def own_phase(label: str, monitored: bool) -> dict[str, Any]:
        project = root / f"project-{label}"
        env = base_env.copy()
        env["SUPABASE_WORKDIR"] = str(project)
        project_id = "repeat" + hashlib.sha256(label.encode()).hexdigest()[:14]
        trace_path = Path(base_env["SUPABASE_STACK_TRACE_FILE"]) if "SUPABASE_STACK_TRACE_FILE" in base_env else None
        trace_start = trace_path.stat().st_size if trace_path is not None and trace_path.exists() else 0
        phase: dict[str, Any] = {"label": label, "project": str(project), "init": None}
        try:
            phase["init"] = init_owned(cli, project, project_id, env)
            if phase["init"].get("ok") and phase["init"].get("config_exists"):
                sample_dir = resources / "samplers" / label if monitored else None
                phase.update(run_start(cli, project, env, sample_dir))
                phase["stop"] = stack.stop_command(cli, "new", project, project_id, env)
                if label.startswith("repetition_"):
                    if phase.get("ready") and phase["stop"].get("ok"):
                        restart_dir = resources / "samplers" / f"{label}_restart"
                        phase["restart"] = run_start(cli, project, env, restart_dir)
                        phase["restart_ready"] = phase["restart"].get("ready", False)
                        phase["stop_after_restart"] = stack.stop_command(cli, "new", project, project_id, env)
                    else:
                        phase["restart_skipped"] = "initial start was not ready or retained-data stop failed"
            else:
                phase["failure"] = "project initialization or config creation failed"
        except BaseException as error:
            phase["exception"] = {"type": type(error).__name__, "message": str(error), "at": timestamp()}
            phase["interrupted"] = isinstance(error, (KeyboardInterrupt, SystemExit))
        finally:
            phase["destroy"] = destroy(cli, project, env)
            if trace_path is not None:
                trace_end = trace_path.stat().st_size if trace_path.exists() else trace_start
                trace_dir = resources / "trace-slices"
                trace_dir.mkdir(exist_ok=True)
                trace_slice = trace_dir / f"{label}.jsonl"
                if trace_path.exists():
                    with trace_path.open("rb") as source:
                        source.seek(trace_start)
                        trace_slice.write_bytes(source.read(max(0, trace_end - trace_start)))
                else:
                    trace_slice.write_bytes(b"")
                phase["trace"] = {
                    "source": str(trace_path), "byte_start": trace_start,
                    "byte_end": trace_end, "slice": str(trace_slice),
                    "available": trace_end > trace_start,
                }
                if trace_end <= trace_start:
                    phase["trace_failure"] = "configured lifecycle trace produced no bytes for this phase"
                    phase["ready"] = False
        phase["finished_at"] = timestamp()
        return phase

    try:
        for label in all_phases:
            is_repeat = label.startswith("repetition_")
            phase = own_phase(label, is_repeat)
            if label == "warmup":
                record["warmup"] = phase
            elif label == "control_before":
                record["control_before"] = phase
            elif label == "control_after":
                record["control_after"] = phase
            else:
                record["repetitions"].append(phase)
            persist(output, record)
            if label == "warmup" and not phase.get("ready"):
                record["aborted_after"] = "warmup did not reach full eager readiness"
                break
            if phase.get("interrupted"):
                record["aborted_after"] = f"execution interrupted during {label}"
                break
            if not phase.get("destroy", {}).get("ok", False):
                record["aborted_after"] = f"owned stack cleanup failed for {label}"
                break
    except BaseException as error:
        record["error"] = {"type": type(error).__name__, "message": str(error), "at": timestamp()}
        raise
    finally:
        phases = [record.get("warmup"), record.get("control_before"), *record.get("repetitions", []), record.get("control_after")]
        phases = [phase for phase in phases if isinstance(phase, dict)]
        measurements_ok = all(
            phase.get("ready") and phase.get("destroy", {}).get("ok", False)
            and phase.get("stop", {}).get("ok", False)
            and (phase.get("stop_after_restart", {"ok": True}).get("ok", False))
            and (phase.get("restart", {"ready": True}).get("ready", True))
            for phase in phases
        )
        record["status"] = "completed" if len(record["repetitions"]) == args.repetitions and measurements_ok else "failed"
        can_remove_root = all(phase.get("destroy", {}).get("ok", False) for phase in phases)
        if can_remove_root:
            shutil.rmtree(root)
        record["cleanup"].append({"runtime_root_removed": can_remove_root, "completed_at": timestamp()})
        record["finished_at"] = timestamp()
        persist(output, record)
    return 0 if record["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
