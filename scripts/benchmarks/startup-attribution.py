#!/usr/bin/env python3
"""Alternate matched cached starts through the compiled CLI and stack package API."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stack


EXPECTED_SERVICES = {
    "database", "analytics", "pgmeta", "rest", "auth", "realtime", "storage", "vector",
    "functions", "studio", "mail",
}


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def persist(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def phase_window(command: list[str], *, cwd: Path, env: dict[str, str], timeout: int = stack.DEFAULT_TIMEOUT) -> dict[str, Any]:
    executable = Path(command[0]).name
    operation = " ".join(command[1:4])
    print(f"[startup-attribution] running {executable} {operation}", flush=True)
    started_at = time.time()
    result = stack.run(command, cwd=cwd, env=env, timeout=timeout)
    result["started_epoch_ms"] = round(started_at * 1000, 2)
    result["finished_epoch_ms"] = round(time.time() * 1000, 2)
    return result


def api_command(api: Path, action: str, runtime: str, project: Path, home: Path, *, mode: str, stack_id: str | None = None) -> list[str]:
    command = [
        str(api), "--action", action, "--runtime", runtime, "--mode", mode,
        "--project", str(project), "--state-root", str(home / "stacks"),
        "--cache-root", str(home / "cache" / "stack"),
    ]
    if stack_id is not None:
        command += ["--stack-id", stack_id]
    return command


def cli_command(cli: Path, action: str, project: Path, stack_id: str | None = None, *, mode: str = "default", runtime: str = "native") -> list[str]:
    if action == "start":
        command = [str(cli), "start", "--workdir", str(project), "--runtime", runtime, "--output-format", "json"]
        if mode == "eager":
            command.append("--eager")
        return command
    if action == "stop":
        return [str(cli), "stack", "stop", "--stack-id", str(stack_id), "--workdir", str(project), "--output-format", "json"]
    if action == "destroy":
        return [str(cli), "stack", "destroy", "--stack-id", str(stack_id), "--yes", "--workdir", str(project), "--output-format", "json"]
    if action == "status":
        return [str(cli), "stack", "status", "--stack-id", str(stack_id), "--workdir", str(project), "--output-format", "json"]
    raise ValueError(action)


def parse_last_json(text: str) -> Any:
    complete = stack.json_value(text)
    if isinstance(complete, dict):
        return complete
    for line in reversed(text.splitlines()):
        parsed = stack.json_value(line)
        if parsed is not None:
            return parsed
    return None


def output_stack_id(result: dict[str, Any]) -> str | None:
    payload = parse_last_json(result.get("stdout", ""))
    for item in stack.walk(payload):
        value = item.get("stack_id", item.get("id"))
        if isinstance(value, str) and value:
            return value
    return None


def readiness(payload: Any, mode: str) -> dict[str, Any]:
    members: list[dict[str, Any]] = []
    for item in stack.walk(payload):
        composition = item.get("composition")
        direct = composition.get("members") if isinstance(composition, dict) else None
        if isinstance(direct, list):
            members = [member for member in direct if isinstance(member, dict)]
            break
        direct = item.get("services")
        if isinstance(direct, list):
            members = [member for member in direct if isinstance(member, dict)]
            break
    if not members:
        members = stack.service_readiness(payload, mode).get("services", [])
    names = {str(member.get("service")) for member in members if isinstance(member, dict)}
    states = {}
    for member in members:
        service = str(member.get("service"))
        state = member.get("state") or member.get("lifecycle")
        wake_enabled = member.get("wake_enabled", member.get("wakeEnabled", False))
        states[service] = "sleeping" if state == "stopped" and wake_enabled else state
    eager = mode == "eager"
    ready = names == EXPECTED_SERVICES and (
        all(states.get(name) == "running" for name in EXPECTED_SERVICES)
        if eager else states.get("database") == "running" and all(
            states.get(name) in {"sleeping", "running"} for name in EXPECTED_SERVICES - {"database"}
        )
    )
    return {
        "services": sorted(names), "expected_services": sorted(EXPECTED_SERVICES),
        "selected_service_count": len(names), "all_expected_services_selected": names == EXPECTED_SERVICES,
        "states": states, "expected_ready": ready,
    }


def docker_events(env: dict[str, str], cwd: Path, stack_id: str | None, start_ms: float | None) -> dict[str, Any] | None:
    if shutil.which("docker") is None or stack_id is None or start_ms is None:
        return None
    start = datetime.fromtimestamp(start_ms / 1000, timezone.utc).isoformat()
    end = datetime.now(timezone.utc).isoformat()
    return stack.run([
        "docker", "events", "--since", start, "--until", end,
        "--filter", f"label=com.supabase.stack={stack_id}", "--format", "{{json .}}",
    ], cwd=cwd, env=env, timeout=60)


def runner_metadata() -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "platform": platform.platform(), "system": platform.system(),
        "machine": platform.machine(), "python": platform.python_version(),
        "logical_cpu_count": os.cpu_count(),
    }
    if Path("/proc/cpuinfo").is_file():
        try:
            metadata["cpuinfo"] = Path("/proc/cpuinfo").read_text(encoding="utf-8")[:16_000]
        except OSError as error:
            metadata["cpuinfo_error"] = str(error)
    return metadata


def make_project(cli: Path, root: Path, label: str, env: dict[str, str]) -> tuple[Path, dict[str, Any]]:
    project = root / f"project-{label}"
    project_id = "attr" + hashlib.sha256(label.encode()).hexdigest()[:14]
    print(f"[startup-attribution] initializing project {label}", flush=True)
    initialized = stack.init_project(cli, project, env)
    stack.configure_project(project, project_id, stack=True, pooler=False)
    (project / "supabase" / ".temp" / "stack-uploads").mkdir(parents=True, exist_ok=True)
    (project / "supabase" / "functions").mkdir(parents=True, exist_ok=True)
    initialized.update({"project": str(project), "project_id": project_id, "config_exists": (project / "supabase" / "config.toml").is_file()})
    return project, initialized


def lifecycle(
    *, cli: Path, api: Path, implementation: str, runtime: str, mode: str, label: str,
    root: Path, home: Path, base_env: dict[str, str], traced: bool,
    result_record: dict[str, Any], result_key: str, result_path: Path,
) -> dict[str, Any]:
    project, init = make_project(cli, root, label, base_env)
    trace_path = root / "traces" / f"{label}.jsonl"
    env = base_env.copy()
    if traced:
        trace_path.parent.mkdir(parents=True, exist_ok=True)
        trace_path.write_text("", encoding="utf-8")
        env["SUPABASE_STARTUP_SPANS_FILE"] = str(trace_path)
    else:
        env.pop("SUPABASE_STARTUP_SPANS_FILE", None)
    env["SUPABASE_WORKDIR"] = str(project)
    phase: dict[str, Any] = {
        "label": label, "implementation": implementation, "runtime": runtime,
        "mode": mode, "traced": traced, "started_at": timestamp(), "init": init,
        "trace_path": str(trace_path) if traced else None, "commands": [],
        "start": None, "status": None, "stop": None, "restart": None,
        "restart_status": None, "destroy": None, "cleanup_verified": False,
    }
    phase_path = root / f"{label}.json"
    persist(phase_path, phase)
    stack_id: str | None = None
    try:
        if implementation == "cli":
            started = phase_window(cli_command(cli, "start", project, mode=mode, runtime=runtime), cwd=project, env=env)
        else:
            started = phase_window(api_command(api, "start", runtime, project, home, mode=mode), cwd=project, env=env)
        phase["start"] = started
        phase["commands"].append({"name": "start", "window": {"started_epoch_ms": started["started_epoch_ms"], "finished_epoch_ms": started["finished_epoch_ms"]}, "result": started})
        persist(phase_path, phase)
        if implementation == "api":
            stack_id = output_stack_id(started)
        else:
            stack_id, listing = stack.find_project_stack_id(cli, project, env)
            phase["stack_list"] = listing
        if stack_id is None:
            stack_id, listing = stack.find_project_stack_id(cli, project, env)
            phase["stack_list_after_start"] = listing
            if stack_id is None and listing.get("ok"):
                phase["cleanup_verified"] = True
        phase["stack_id"] = stack_id
        if stack_id is None:
            phase["failure"] = "start succeeded without a discoverable stack id"
        else:
            if implementation == "cli":
                status = phase_window(cli_command(cli, "status", project, stack_id), cwd=project, env=env)
                payload = parse_last_json(status["stdout"])
                phase["status"] = status
            else:
                payload = parse_last_json(started["stdout"])
                phase["status"] = {"ok": started["ok"], "source": "API start observations", "payload": payload}
            phase["readiness"] = readiness(payload, mode)
            phase["ready"] = bool(started["ok"] and phase["readiness"]["expected_ready"])
            persist(phase_path, phase)
            if not phase["ready"]:
                phase["failure"] = "initial start did not satisfy selected-service/readiness checks"

        if phase.get("ready") and stack_id is not None:
            if implementation == "cli":
                stopped = phase_window(cli_command(cli, "stop", project, stack_id), cwd=project, env=env)
            else:
                stopped = phase_window(api_command(api, "stop", runtime, project, home, mode=mode, stack_id=stack_id), cwd=project, env=env)
            phase["stop"] = stopped
            phase["commands"].append({"name": "stop", "window": {"started_epoch_ms": stopped["started_epoch_ms"], "finished_epoch_ms": stopped["finished_epoch_ms"]}, "result": stopped})
            persist(phase_path, phase)
            if stopped["ok"]:
                if implementation == "cli":
                    restarted = phase_window(cli_command(cli, "start", project, mode=mode, runtime=runtime), cwd=project, env=env)
                else:
                    restarted = phase_window(api_command(api, "start", runtime, project, home, mode=mode, stack_id=stack_id), cwd=project, env=env)
                phase["restart"] = restarted
                phase["commands"].append({"name": "restart", "window": {"started_epoch_ms": restarted["started_epoch_ms"], "finished_epoch_ms": restarted["finished_epoch_ms"]}, "result": restarted})
                persist(phase_path, phase)
                if implementation == "cli":
                    restart_status = phase_window(cli_command(cli, "status", project, stack_id), cwd=project, env=env)
                    restart_payload = parse_last_json(restart_status["stdout"])
                    phase["restart_status"] = restart_status
                else:
                    restart_payload = parse_last_json(restarted["stdout"])
                    phase["restart_status"] = {"ok": restarted["ok"], "source": "API restart observations", "payload": restart_payload}
                phase["restart_readiness"] = readiness(restart_payload, mode)
                phase["restart_ready"] = bool(restarted["ok"] and phase["restart_readiness"]["expected_ready"])
                persist(phase_path, phase)
                if not phase["restart_ready"]:
                    phase["failure"] = "retained-data restart did not satisfy selected-service/readiness checks"
            else:
                phase["failure"] = "retained-data stop failed"

        if phase.get("failure"):
            phase["diagnostics"] = stack.failure_diagnostics(
                cli, "new", runtime, project, init.get("project_id", ""), stack_id, env,
            )
    except BaseException as error:
        phase["exception"] = {"type": type(error).__name__, "message": str(error), "at": timestamp()}
        phase["interrupted"] = isinstance(error, (KeyboardInterrupt, SystemExit))
        phase["diagnostics"] = stack.failure_diagnostics(
            cli, "new", runtime, project, init.get("project_id", ""), stack_id, env,
        )
    finally:
        if stack_id is not None:
            if implementation == "cli":
                destroyed = phase_window(cli_command(cli, "destroy", project, stack_id), cwd=project, env=env, timeout=120)
            else:
                destroyed = phase_window(api_command(api, "destroy", runtime, project, home, mode=mode, stack_id=stack_id), cwd=project, env=env, timeout=120)
            phase["destroy"] = destroyed
            phase["commands"].append({"name": "destroy", "window": {"started_epoch_ms": destroyed["started_epoch_ms"], "finished_epoch_ms": destroyed["finished_epoch_ms"]}, "result": destroyed})
            remaining_stack_id, listing = stack.find_project_stack_id(cli, project, env)
            phase["cleanup_verification"] = {"stack_list": listing, "remaining_stack_id": remaining_stack_id}
            cleanup_checks = [destroyed.get("ok") is True, listing.get("ok") is True, remaining_stack_id is None]
            if runtime == "docker":
                snapshot = stack.docker_snapshot(None, stack_id, env, project)
                phase["cleanup_verification"]["docker_snapshot"] = snapshot
                commands = snapshot.get("commands") if isinstance(snapshot, dict) else None
                ps = commands.get("ps") if isinstance(commands, dict) else None
                cleanup_checks.append(
                    isinstance(snapshot, dict)
                    and snapshot.get("available") is True
                    and isinstance(ps, dict)
                    and ps.get("ok") is True
                    and not ps.get("stdout", "").strip()
                )
            else:
                processes = stack.process_snapshot(stack_id)
                phase["cleanup_verification"]["native_processes"] = processes
                cleanup_checks.append(
                    isinstance(processes, dict)
                    and processes.get("processes") == []
                )
            if traced and implementation == "cli" and phase.get("start", {}).get("ok") is True:
                events = [
                    stack.json_value(line)
                    for line in trace_path.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ] if trace_path.exists() else []
                completed = {
                    str(event.get("attributes", {}).get("service"))
                    for event in events
                    if isinstance(event, dict)
                    and event.get("event") == "StackCatalogSetup.temporaryService.destroy"
                    and event.get("status") == "ok"
                }
                phase["cleanup_verification"]["temporary_service_destroyed"] = sorted(completed)
                cleanup_checks.append({"auth", "storage", "realtime"}.issubset(completed))
            phase["cleanup_verified"] = all(cleanup_checks)
        phase["docker_events"] = docker_events(env, project, stack_id, phase["start"].get("started_epoch_ms") if phase.get("start") else None) if runtime == "docker" else None
        if traced and trace_path.exists():
            phase["trace"] = {
                "path": str(trace_path),
                "events": [stack.json_value(line) for line in trace_path.read_text(encoding="utf-8").splitlines() if line.strip()],
            }
        phase["finished_at"] = timestamp()
        persist(phase_path, phase)
        result_record[result_key] = phase
        persist(result_path, result_record)
    return phase


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path, help="Compiled CLI executable")
    parser.add_argument("--api", required=True, type=Path, help="Compiled direct package API executable")
    parser.add_argument("--runtime", choices=("native", "docker"), required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--baseline-cli", type=Path, help="Baseline compiled CLI for a paired CLI comparison")
    parser.add_argument("--changed-cli", type=Path, help="Changed compiled CLI for a paired CLI comparison")
    args = parser.parse_args()
    cli, api = args.cli.resolve(), args.api.resolve()
    for label, executable in (("CLI", cli), ("API", api)):
        if not executable.is_file() or not os.access(executable, os.X_OK):
            parser.error(f"{label} must be an executable file: {executable}")
    if args.samples < 1:
        parser.error("--samples must be >= 1")
    if (args.baseline_cli is None) != (args.changed_cli is None):
        parser.error("--baseline-cli and --changed-cli must be supplied together")
    if args.baseline_cli is not None and args.changed_cli is not None:
        args.baseline_cli = args.baseline_cli.resolve()
        args.changed_cli = args.changed_cli.resolve()
        for label, executable in (("baseline CLI", args.baseline_cli), ("changed CLI", args.changed_cli)):
            if not executable.is_file() or not os.access(executable, os.X_OK):
                parser.error(f"{label} must be an executable file: {executable}")

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    root = Path(os.environ.get("RUNNER_TEMP", "/tmp")).resolve() / f"startup-attribution-{os.getpid()}-{time.time_ns()}"
    root.mkdir(parents=True)
    home = root / "supabase-home"
    base_env = os.environ.copy()
    base_env.update({
        "SUPABASE_HOME": str(home), "SUPABASE_NO_UPDATE_NOTIFIER": "1",
        "SUPABASE_TELEMETRY_DISABLED": "1", "SUPABASE_NO_KEYRING": "1",
        "SUPABASE_EXPERIMENTAL_STACK": "1",
    })
    for name in ("DOCKER_CONTEXT", "SUPABASE_PROJECT_ID", "SUPABASE_NETWORK_ID", "SUPABASE_STARTUP_SPANS_FILE", "SUPABASE_STARTUP_TRACE_FILE", "SUPABASE_STACK_TRACE_FILE"):
        base_env.pop(name, None)
    if args.runtime == "native":
        base_env["DOCKER_HOST"] = f"unix://{root / 'docker-unavailable.sock'}"

    if args.baseline_cli is not None and args.changed_cli is not None:
        record: dict[str, Any] = {
            "schema_version": 1,
            "benchmark": "paired-fresh-cli-startup-catalog-concurrency",
            "status": "running",
            "started_at": timestamp(),
            "runtime": args.runtime,
            "samples_requested_per_mode": args.samples,
            "baseline_cli": str(args.baseline_cli),
            "changed_cli": str(args.changed_cli),
            "host": runner_metadata(),
            "paths": {"root": str(root), "home": str(home)},
            "warmups": {},
            "pairs": [],
            "failures": [],
        }
        persist(output, record)

        def run_cli(executable: Path, variant: str, mode: str, label: str) -> dict[str, Any]:
            return lifecycle(
                cli=executable,
                api=executable,
                implementation="cli",
                runtime=args.runtime,
                mode=mode,
                label=label,
                root=root,
                home=home,
                base_env=base_env,
                traced=True,
                result_record=record,
                result_key=f"active_{variant}",
                result_path=output,
            )

        variants = (("baseline", args.baseline_cli), ("changed", args.changed_cli))
        for variant, executable in variants:
            label = f"warmup_{variant}"
            phase = run_cli(executable, variant, "eager", label)
            record["warmups"][variant] = phase
            record.pop(f"active_{variant}", None)
            if phase.get("failure") or phase.get("exception") or not phase.get("cleanup_verified"):
                record["failures"].append({"phase": label, "reason": phase.get("failure", phase.get("exception", "warmup cleanup failed"))})
                record["status"] = "warmup_failed"
                persist(output, record)
                return 1
            persist(output, record)

        for mode in ("default", "eager"):
            for sample in range(1, args.samples + 1):
                order = variants if sample % 2 == 1 else tuple(reversed(variants))
                pair: dict[str, Any] = {
                    "mode": mode,
                    "sample": sample,
                    "order": [variant for variant, _ in order],
                    "cache_before": stack.cache_inventory(home / "cache" / "stack"),
                    "results": {},
                }
                record["pairs"].append(pair)
                persist(output, record)
                for variant, executable in order:
                    label = f"{mode}_sample_{sample}_{variant}"
                    phase = run_cli(executable, variant, mode, label)
                    record.pop(f"active_{variant}", None)
                    pair["results"][variant] = phase
                    pair[f"cache_after_{variant}"] = stack.cache_inventory(home / "cache" / "stack")
                    if phase.get("failure") or phase.get("exception"):
                        record["failures"].append({"phase": label, "reason": phase.get("failure", phase.get("exception"))})
                    persist(output, record)
                    if not phase.get("cleanup_verified"):
                        record["failures"].append({"phase": label, "reason": "cleanup verification failed; stopping before another lifecycle"})
                        record["status"] = "cleanup_failed"
                        persist(output, record)
                        return 1

        summary: dict[str, Any] = {}
        for mode in ("default", "eager"):
            summary[mode] = {}
            for variant in ("baseline", "changed"):
                samples = [
                    result["start"]["elapsed_ms"]
                    for pair in record["pairs"]
                    if pair["mode"] == mode
                    and isinstance((result := pair["results"].get(variant)), dict)
                    and isinstance(result.get("start"), dict)
                    and isinstance(result["start"].get("elapsed_ms"), (int, float))
                ]
                summary[mode][variant] = {
                    "samples_ms": samples,
                    "median_ms": statistics.median(samples) if samples else None,
                }
        record["summary"] = summary

        record["status"] = "complete" if not record["failures"] else "completed_with_failures"
        record["finished_at"] = timestamp()
        persist(output, record)
        return 0 if not record["failures"] else 1

    record: dict[str, Any] = {
        "schema_version": 1, "benchmark": "compiled-cli-versus-stack-api-startup-attribution",
        "status": "running", "started_at": timestamp(), "runtime": args.runtime,
        "samples_requested_per_mode": args.samples, "cli": str(cli), "api": str(api),
        "host": runner_metadata(), "paths": {"root": str(root), "home": str(home)},
        "warmups": {}, "pairs": [], "untraced_cli_controls": [], "failures": [],
    }
    persist(output, record)

    def run_lifecycle(implementation: str, mode: str, label: str, traced: bool) -> dict[str, Any]:
        key = f"active_{label}"
        phase = lifecycle(
            cli=cli, api=api, implementation=implementation, runtime=args.runtime, mode=mode,
            label=label, root=root, home=home, base_env=base_env, traced=traced,
            result_record=record, result_key=key, result_path=output,
        )
        record.pop(key, None)
        return phase

    for implementation in ("cli", "api"):
        label = f"warmup_{implementation}"
        before = stack.cache_inventory(home / "cache" / "stack")
        phase = run_lifecycle(implementation, "eager", label, traced=True)
        record["warmups"][implementation] = {"cache_before": before, **phase}
        persist(output, record)
        if phase.get("failure") or phase.get("exception") or phase.get("start", {}).get("ok") is not True:
            record["failures"].append({"phase": label, "reason": phase.get("failure", phase.get("exception", "warmup command failed"))})
            record["status"] = "warmup_failed"
            persist(output, record)
            return 1
        if not phase.get("cleanup_verified"):
            record["failures"].append({"phase": label, "reason": "cleanup failed; stopping before another lifecycle"})
            record["status"] = "cleanup_failed"
            persist(output, record)
            return 1

    for mode in ("default", "eager"):
        for sample in range(1, args.samples + 1):
            order = ("cli", "api") if (sample + (mode == "eager")) % 2 else ("api", "cli")
            pair: dict[str, Any] = {"mode": mode, "sample": sample, "order": list(order), "cache_before": stack.cache_inventory(home / "cache" / "stack"), "results": {}}
            record["pairs"].append(pair)
            persist(output, record)
            for implementation in order:
                label = f"{mode}_sample_{sample}_{implementation}"
                result = lifecycle(
                    cli=cli, api=api, implementation=implementation, runtime=args.runtime,
                    mode=mode, label=label, root=root, home=home, base_env=base_env,
                    traced=True, result_record={"holder": None}, result_key="holder", result_path=root / f"{label}-result.json",
                )
                pair["results"][implementation] = result
                pair["cache_after_" + implementation] = stack.cache_inventory(home / "cache" / "stack")
                if result.get("failure") or result.get("exception"):
                    record["failures"].append({"phase": label, "reason": result.get("failure", result.get("exception"))})
                persist(output, record)
                if not result.get("cleanup_verified"):
                    record["failures"].append({"phase": label, "reason": "cleanup failed; stopping before another lifecycle"})
                    record["status"] = "cleanup_failed"
                    persist(output, record)
                    return 1

    for mode in ("default", "eager"):
        label = f"untraced_control_{mode}"
        control = lifecycle(
            cli=cli, api=api, implementation="cli", runtime=args.runtime, mode=mode,
            label=label, root=root, home=home, base_env=base_env, traced=False,
            result_record={"holder": None}, result_key="holder", result_path=root / f"{label}-result.json",
        )
        record["untraced_cli_controls"].append(control)
        if control.get("failure") or control.get("exception"):
            record["failures"].append({"phase": label, "reason": control.get("failure", control.get("exception"))})
        persist(output, record)
        if not control.get("cleanup_verified"):
            record["failures"].append({"phase": label, "reason": "cleanup failed; stopping before another lifecycle"})
            record["status"] = "cleanup_failed"
            persist(output, record)
            return 1

    record["status"] = "complete" if not record["failures"] else "completed_with_failures"
    record["finished_at"] = timestamp()
    persist(output, record)
    return 0 if not record["failures"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
