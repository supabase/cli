#!/usr/bin/env python3
"""Measure isolated legacy and managed-stack CLI startup cases on CI runners.

Run one case per invocation on a fresh CI runner. The invocation measures a
cold start, a fresh project with the resulting caches, and a retained-data
restart, then writes every command and observation to one JSON file.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_LABEL = "com.supabase.cli.project"
STACK_LABEL = "com.supabase.stack"
DEFAULT_TIMEOUT = 1200


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout: int = DEFAULT_TIMEOUT,
    check: bool = False,
) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        record = {
            "argv": command,
            "exit_code": result.returncode,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "stdout": result.stdout,
            "stderr": result.stderr,
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as error:
        record = {
            "argv": command,
            "exit_code": None,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "stdout": decode(error.stdout),
            "stderr": decode(error.stderr),
            "timed_out": True,
        }
    except OSError as error:
        record = {
            "argv": command,
            "exit_code": None,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "stdout": "",
            "stderr": str(error),
            "timed_out": False,
            "spawn_error": str(error),
        }
    record["ok"] = record["exit_code"] == 0 and not record["timed_out"]
    if check and not record["ok"]:
        raise RuntimeError(f"command failed: {command!r}; see command record")
    return record


def decode(value: str | bytes | None) -> str:
    if value is None:
        return ""
    return value.decode(errors="replace") if isinstance(value, bytes) else value


def json_value(text: str) -> Any:
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def find_stack_id(text: str) -> str | None:
    payload = json_value(text)
    if isinstance(payload, dict):
        for item in walk(payload):
            if isinstance(item.get("id"), str) and re.fullmatch(r"[a-f0-9]{64}", item["id"]):
                return item["id"]
    return None


def init_project(
    cli: Path, project: Path, project_id: str, *, stack: bool, pooler: bool,
    env: dict[str, str],
) -> dict[str, Any]:
    project.mkdir(parents=True, exist_ok=True)
    result = run([str(cli), "init"], cwd=project, env=env)
    return result


def configure_project(project: Path, project_id: str, *, stack: bool, pooler: bool) -> None:
    config = project / "supabase" / "config.toml"
    if not config.exists():
        return
    text = config.read_text(encoding="utf-8")
    text = re.sub(r"(?m)^project_id\s*=\s*['\"].*?['\"]\s*$", f'project_id = "{project_id}"', text, count=1)
    pooler_section = re.search(r"(?ms)^\[db\.pooler\]\s*$.*?(?=^\[|\Z)", text)
    if pooler_section:
        section = pooler_section.group(0)
        if re.search(r"(?m)^enabled\s*=", section):
            section = re.sub(r"(?m)^enabled\s*=\s*(?:true|false)\s*$", f"enabled = {'true' if pooler else 'false'}", section, count=1)
        else:
            section = section.rstrip() + f"\nenabled = {'true' if pooler else 'false'}\n"
        text = text[:pooler_section.start()] + section + text[pooler_section.end():]
    else:
        text = text.rstrip() + f"\n\n[db.pooler]\nenabled = {'true' if pooler else 'false'}\n"
    if stack and not re.search(r"(?m)^\[experimental\]\s*$", text):
        text = text.rstrip() + "\n\n[experimental]\nstack = true\n"
    elif stack:
        section = re.search(r"(?ms)^\[experimental\]\s*$.*?(?=^\[|\Z)", text)
        if section and not re.search(r"(?m)^stack\s*=", section.group(0)):
            body = section.group(0).rstrip() + "\nstack = true\n"
            text = text[:section.start()] + body + text[section.end():]
    config.write_text(text, encoding="utf-8")


def cache_inventory(root: Path) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    total = 0
    if root.exists():
        for path in sorted(root.rglob("*")):
            try:
                if not path.is_file():
                    continue
                size = path.stat().st_size
                total += size
                files.append({"path": str(path.relative_to(root)), "bytes": size})
            except (OSError, ValueError):
                continue
    return {"bytes": total, "file_count": len(files), "files": files}


def docker_snapshot(project_id: str | None, stack_id: str | None, env: dict[str, str], cwd: Path) -> dict[str, Any] | None:
    if shutil.which("docker") is None:
        return None
    label = f"{STACK_LABEL}={stack_id}" if stack_id else (f"{PROJECT_LABEL}={project_id}" if project_id else None)
    if label is None:
        return {"available": True, "label": None, "containers": [], "stats": None}
    ps = run(["docker", "ps", "-a", "--filter", f"label={label}", "--format", "{{json .}}"], cwd=cwd, env=env, timeout=60)
    rows = [json_value(line) for line in ps["stdout"].splitlines() if line.strip()]
    containers = [row for row in rows if isinstance(row, dict) and row.get("ID")]
    ids = [str(row["ID"]) for row in containers]
    inspect = run(["docker", "inspect", *ids], cwd=cwd, env=env, timeout=60) if ids else None
    stats = run(["docker", "stats", "--no-stream", "--format", "{{json .}}", *ids], cwd=cwd, env=env, timeout=60) if ids else None
    inspected = json_value(inspect["stdout"]) if inspect else []
    image_records = []
    for item in inspected if isinstance(inspected, list) else []:
        config = item.get("Config", {}) if isinstance(item, dict) else {}
        state = item.get("State", {}) if isinstance(item, dict) else {}
        image_records.append({
            "id": item.get("Id"), "name": item.get("Name"), "image": config.get("Image"),
            "image_id": item.get("Image"), "running": state.get("Running"),
            "health": (state.get("Health") or {}).get("Status"), "labels": config.get("Labels", {}),
        })
    stat_rows = [json_value(line) for line in stats["stdout"].splitlines() if line.strip()] if stats else []
    return {
        "available": ps["ok"], "label": label, "containers": image_records,
        "stats": [row for row in stat_rows if isinstance(row, dict)],
        "commands": {"ps": ps, "inspect": inspect, "stats": stats},
    }


def process_snapshot(stack_id: str | None) -> dict[str, Any] | None:
    if not stack_id:
        return None
    listing = run(["ps", "-axo", "pid=,ppid=,rss=,command="], cwd=Path.cwd(), env=os.environ.copy(), timeout=20)
    if not listing["ok"]:
        return {"available": False, "command": listing}
    processes: dict[int, dict[str, Any]] = {}
    roots: set[int] = set()
    for line in listing["stdout"].splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) < 4:
            continue
        try:
            pid, ppid, rss_kib = (int(parts[index]) for index in range(3))
        except ValueError:
            continue
        command = parts[3]
        processes[pid] = {"pid": pid, "ppid": ppid, "rss_bytes": rss_kib * 1024, "command": command}
        if stack_id in command:
            roots.add(pid)
    owned = set(roots)
    while True:
        children = {pid for pid, process in processes.items() if process["ppid"] in owned}
        updated = owned | children
        if updated == owned:
            break
        owned = updated
    rows = [processes[pid] for pid in sorted(owned) if pid in processes]
    for row in rows:
        if sys.platform == "linux":
            try:
                values = {}
                for line in (Path("/proc") / str(row["pid"]) / "smaps_rollup").read_text().splitlines():
                    if line.startswith(("Pss:", "Rss:")):
                        key, value, *_ = line.split()
                        values[key[:-1].lower() + "_bytes"] = int(value) * 1024
                row.update(values)
            except (OSError, ValueError):
                pass
    return {
        "sampled_at": now(), "processes": rows,
        "rss_bytes": sum(row["rss_bytes"] for row in rows),
        "pss_bytes": sum(row.get("pss_bytes", 0) for row in rows) if sys.platform == "linux" else None,
        "scope": "stack-host process and descendants identified by stack id" if rows else "no matching process found",
    }


def status_command(cli: Path, implementation: str, project: Path, env: dict[str, str]) -> dict[str, Any]:
    if implementation == "new":
        args = ["status", "--output-format", "json"]
    else:
        args = ["status", "--output", "json"]
    return run([str(cli), *args, "--workdir", str(project)], cwd=project, env=env)


def env_status_command(cli: Path, implementation: str, project: Path, env: dict[str, str]) -> dict[str, Any]:
    args = ["status", "--env", "--output-format", "json"] if implementation == "new" else ["status", "--output", "json"]
    if implementation == "legacy":
        return {"ok": False, "exit_code": None, "stdout": "", "stderr": "legacy CLI does not expose machine-readable env export", "elapsed_ms": None}
    return run([str(cli), *args, "--workdir", str(project)], cwd=project, env=env)


def service_readiness(payload: Any, mode: str) -> dict[str, Any]:
    members = []
    for item in walk(payload):
        value = item.get("members")
        if isinstance(value, list) and any(isinstance(entry, dict) and "service" in entry for entry in value):
            members = value
            break
    services = [
        {"service": row.get("service"), "lifecycle": row.get("lifecycle"), "state": row.get("state"), "health": row.get("health")}
        for row in members if isinstance(row, dict)
    ]
    running = [row for row in services if row.get("lifecycle") == "running" or row.get("state") == "running"]
    ready = bool(services) and (len(running) == len(services) if mode == "eager" else any(row.get("service") == "database" for row in running))
    return {"services": services, "selected_service_count": len(services), "running_service_count": len(running), "expected_ready": ready}


def stop_command(
    cli: Path, implementation: str, project: Path, project_id: str, env: dict[str, str], *,
    delete_data: bool = False,
) -> dict[str, Any]:
    if implementation == "new":
        args = [str(cli), "stop", "--workdir", str(project)]
    else:
        args = [str(cli), "stop", "--project-id", project_id]
        if delete_data:
            args.append("--no-backup")
    return run(args, cwd=project, env=env)


def destroy_new(cli: Path, project: Path, env: dict[str, str]) -> dict[str, Any]:
    return run([str(cli), "stack", "destroy", "--yes", "--workdir", str(project)], cwd=project, env=env)


def start_args(cli: Path, implementation: str, runtime: str, mode: str, project: Path, stack_name: str) -> list[str]:
    args = [str(cli), "start", "--workdir", str(project)]
    if implementation == "new":
        if not (mode == "default" and runtime == "native"):
            args += ["--runtime", runtime]
        args += ["--stack", stack_name, "--output-format", "json"]
        if mode == "eager":
            args.append("--eager")
    else:
        args += ["--output", "json"]
    return args


def request_first_api(status: dict[str, Any], cwd: Path, env: dict[str, str]) -> dict[str, Any] | None:
    payload = json_value(status.get("stdout", ""))
    if not isinstance(payload, dict):
        return None
    url = None
    anon_key = None
    for item in walk(payload):
        for key, value in item.items():
            if key.upper() == "ANON_KEY" and isinstance(value, str):
                anon_key = value
        for key, value in item.items():
            if key.upper() in {"API_URL", "REST_URL"} and isinstance(value, str) and value.startswith("http"):
                url = value
                break
        if url:
            break
    if not url:
        return None
    started = time.perf_counter()
    request = urllib.request.Request(url.rstrip("/") + "/rest/v1/", method="GET", headers={} if anon_key is None else {"apikey": anon_key})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            code = response.status
    except urllib.error.HTTPError as error:
        code = error.code
    except (OSError, TimeoutError) as error:
        return {"url": url, "elapsed_ms": round((time.perf_counter() - started) * 1000, 2), "error": str(error)}
    return {"url": url, "elapsed_ms": round((time.perf_counter() - started) * 1000, 2), "http_status": code, "success": 200 <= code < 400}


def phase(
    *, cli: Path, implementation: str, runtime: str, mode: str, project: Path,
    project_id: str, stack_name: str, env: dict[str, str], cache_root: Path,
    phase_name: str, eager_pooler: bool,
) -> dict[str, Any]:
    phase_data: dict[str, Any] = {"name": phase_name, "project": str(project), "started_at": now(), "commands": {}}
    init_record = init_project(
        cli, project, project_id, stack=implementation == "new", pooler=eager_pooler, env=env
    )
    phase_data["commands"]["init"] = init_record
    configure_project(project, project_id, stack=implementation == "new", pooler=eager_pooler)
    if not init_record["ok"] or not (project / "supabase" / "config.toml").exists():
        phase_data["failure"] = {
            "stage": "init", "exit_code": init_record["exit_code"],
            "stdout": init_record["stdout"], "stderr": init_record["stderr"],
        }
        phase_data["ready"] = False
        phase_data["finished_at"] = now()
        return phase_data
    phase_data["config"] = {"project_id": project_id, "pooler_enabled": eager_pooler, "stack_enabled": implementation == "new"}
    cache_before = cache_inventory(cache_root)
    started = time.perf_counter()
    start = run(start_args(cli, implementation, runtime, mode, project, stack_name), cwd=project, env=env)
    phase_data["commands"]["start"] = start
    phase_data["start_ms"] = start["elapsed_ms"]
    phase_data["timer_ms"] = round((time.perf_counter() - started) * 1000, 2)
    stack_id = find_stack_id(start.get("stdout", "")) if implementation == "new" else None
    phase_data["stack_id"] = stack_id
    status = status_command(cli, implementation, project, env)
    phase_data["commands"]["status"] = status
    phase_data["service_observation"] = json_value(status.get("stdout", ""))
    phase_data["ready"] = bool(start["ok"] and status["ok"])
    if phase_data["ready"] and mode == "default" and implementation == "new":
        env_status = env_status_command(cli, implementation, project, env)
        phase_data["commands"]["status_env"] = env_status
        phase_data["service_readiness"] = service_readiness(phase_data["service_observation"], mode)
        phase_data["first_api_request"] = request_first_api(env_status, project, env)
    else:
        phase_data["service_readiness"] = service_readiness(phase_data["service_observation"], mode)
    phase_data["memory_after_ready"] = docker_snapshot(project_id, stack_id, env, project)
    phase_data["native_processes_after_ready"] = process_snapshot(stack_id)
    cache_after = cache_inventory(cache_root)
    phase_data["cache_before"] = cache_before
    phase_data["cache_after"] = cache_after
    phase_data["cache_bytes_delta"] = cache_after["bytes"] - cache_before["bytes"]
    phase_data["finished_at"] = now()
    if not start["ok"]:
        phase_data["failure"] = {"stage": "start", "exit_code": start["exit_code"], "stdout": start["stdout"], "stderr": start["stderr"]}
    elif not status["ok"]:
        phase_data["failure"] = {"stage": "status", "exit_code": status["exit_code"], "stdout": status["stdout"], "stderr": status["stderr"]}
    return phase_data


def cleanup_phase(cli: Path, implementation: str, project: Path, project_id: str, env: dict[str, str]) -> dict[str, Any]:
    results: dict[str, Any] = {"started_at": now()}
    try:
        results["stop"] = stop_command(cli, implementation, project, project_id, env, delete_data=True)
        if implementation == "new":
            results["destroy"] = destroy_new(cli, project, env)
    finally:
        results["project_deleted"] = False
    results["ok"] = all(command.get("ok") for command in results.values() if isinstance(command, dict) and "ok" in command)
    results["finished_at"] = now()
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path, help="Compiled CLI or pinned legacy executable")
    parser.add_argument("--implementation", required=True, choices=("new", "legacy"))
    parser.add_argument("--runtime", required=True, choices=("native", "docker"))
    parser.add_argument("--mode", required=True, choices=("default", "eager"))
    parser.add_argument("--sample", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path, help="JSON output file")
    parser.add_argument("--root", type=Path, help="Isolated runner data root; defaults beside output")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    args = parser.parse_args()

    cli = args.cli.resolve()
    if not cli.is_file() or not os.access(cli, os.X_OK):
        parser.error(f"CLI must be an executable file: {cli}")
    if args.sample < 1:
        parser.error("--sample must be >= 1")
    if args.implementation == "legacy" and args.runtime != "docker":
        parser.error("the legacy CLI benchmark supports Docker only")
    if args.implementation == "legacy" and args.mode == "eager":
        # Legacy start already waits for all configured services; `eager` identifies
        # the pooler-enabled comparison with the new stack's eager service set.
        pass
    output_dir = args.output.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    owned_name = f"stack-{args.implementation}-{args.runtime}-{args.mode}-sample-{args.sample}"
    owned = output_dir / owned_name
    if owned.exists():
        owned = output_dir / f"{owned_name}-{datetime.now(timezone.utc).strftime('%H%M%S%f')}"
    temp_parent = Path(os.environ.get("RUNNER_TEMP", "/tmp")).resolve()
    root = (args.root or temp_parent / f"supabase-stack-benchmark-{os.getpid()}-{time.time_ns()}").resolve()
    if root.exists():
        parser.error(f"work root must be a fresh path owned by this invocation: {root}")
    root.mkdir(parents=True)
    marker = root / ".supabase-stack-benchmark-owned"
    marker.write_text(str(os.getpid()), encoding="utf-8")
    owned.mkdir(parents=True, exist_ok=True)
    logs_dir = owned / "logs"
    logs_dir.mkdir()
    output = owned / "stack-results.json"
    project_prefix = f"bench-{args.implementation}-{args.runtime}-{args.mode}-{args.sample}"
    project_id = f"{project_prefix.replace('-', '')[:20]}"
    stack_name = project_prefix
    home = root / "supabase-home"
    cache_root = home / "cache" / "stack"
    project_cold = root / "project-cold"
    project_cached = root / "project-cached"
    env = os.environ.copy()
    env.update({
        "SUPABASE_HOME": str(home),
        "SUPABASE_NO_UPDATE_NOTIFIER": "1",
        "SUPABASE_TELEMETRY_DISABLED": "1",
        "SUPABASE_NO_KEYRING": "1",
        "SUPABASE_WORKDIR": str(project_cold),
    })
    env.pop("SUPABASE_PROJECT_ID", None)
    env.pop("SUPABASE_NETWORK_ID", None)
    env["SUPABASE_EXPERIMENTAL_STACK"] = "1" if args.implementation == "new" else "0"
    dockerless_probe: dict[str, Any] | None = None
    if args.runtime == "native":
        docker_host = f"unix://{root / 'docker-unavailable.sock'}"
        env["DOCKER_HOST"] = docker_host
        env.pop("DOCKER_CONTEXT", None)
        dockerless_probe = run(["docker", "info"], cwd=root, env=env, timeout=20) if shutil.which("docker") else {"available": False, "reason": "docker executable absent"}
    elif shutil.which("docker") is None:
        parser.error("Docker runtime selected but docker executable is absent")

    record: dict[str, Any] = {
        "schema_version": 1,
        "benchmark": "supabase-cli-stack",
        "status": "running",
        "started_at": now(),
        "case": {"implementation": args.implementation, "runtime": args.runtime, "mode": args.mode, "sample": args.sample},
        "cli": {"path": str(cli), "version_command": None},
        "host": {"system": platform.platform(), "os": platform.system(), "release": platform.release(), "machine": platform.machine(), "cpu_count": os.cpu_count(), "python": platform.python_version()},
        "paths": {"root": str(root), "home": str(home), "project_cold": str(project_cold), "project_cached": str(project_cached)},
        "preflight": {"dockerless": dockerless_probe},
        "phases": [],
        "cleanup": [],
        "limitations": [
            "Start wall time includes CLI bootstrap and artifact preparation; cache byte deltas are extracted on-disk growth, not network download bytes.",
            "CPU and peak RSS are not sampled continuously. Native process RSS/PSS and Docker stats are point-in-time after readiness; cold peaks are null.",
        ],
    }
    version = run([str(cli), "--version"], cwd=root, env=env, timeout=30)
    record["cli"]["version_command"] = version
    error: BaseException | None = None
    for name, project in (("cold", project_cold), ("cached-fresh-project", project_cached)):
        phase_env = env.copy()
        phase_env["SUPABASE_WORKDIR"] = str(project)
        this_project_id = project_id + ("a" if name == "cold" else "b")
        try:
            data = phase(
                cli=cli, implementation=args.implementation, runtime=args.runtime, mode=args.mode,
                project=project, project_id=this_project_id,
                stack_name=stack_name, env=phase_env, cache_root=cache_root,
                phase_name=name, eager_pooler=args.mode == "eager",
            )
        except BaseException as failure:
            data = {"name": name, "project": str(project), "started_at": now(), "ready": False,
                    "failure": {"stage": "harness", "error": repr(failure)}}
        record["phases"].append(data)
        if data["ready"] and name == "cached-fresh-project":
            stopped = stop_command(cli, args.implementation, project, this_project_id, phase_env)
            restarted = run(start_args(cli, args.implementation, args.runtime, args.mode, project, stack_name), cwd=project, env=phase_env) if stopped["ok"] else None
            restarted_status = status_command(cli, args.implementation, project, phase_env) if restarted and restarted["ok"] else None
            data["retained_restart"] = {
                "stop": stopped, "start": restarted, "status": restarted_status,
                "elapsed_ms": None if restarted is None else restarted["elapsed_ms"],
                "ready": bool(restarted and restarted["ok"] and restarted_status and restarted_status["ok"]),
            }
            if not data["retained_restart"]["ready"]:
                error = RuntimeError("retained-data restart failed; raw CLI outputs are in the result")
        cleanup = (
            cleanup_phase(cli, args.implementation, project, this_project_id, phase_env)
            if "start" in data.get("commands", {})
            else {"ok": True, "skipped": "start was not attempted"}
        )
        record["cleanup"].append({"phase": name, **cleanup})
        if not data["ready"]:
            error = RuntimeError(f"{name} phase failed; raw CLI outputs are in the result")
            break

    record["status"] = "completed" if error is None and all(item.get("ok", True) for item in record["cleanup"]) else "failed"
    record["finished_at"] = now()
    record["elapsed_ms"] = round(sum(float(p.get("timer_ms", 0)) for p in record["phases"]), 2)
    # Env exports may contain local JWTs and database passwords.
    for item in walk(record):
        if "argv" in item and isinstance(item.get("stdout"), str):
            item["stdout"] = redact_secrets(item["stdout"])
        if "argv" in item and isinstance(item.get("stderr"), str):
            item["stderr"] = redact_secrets(item["stderr"])
    command_counter = 0
    for item in walk(record):
        if not isinstance(item.get("argv"), list) or "stdout" not in item or "stderr" not in item:
            continue
        command_counter += 1
        stem = f"command-{command_counter:03d}"
        stdout_path = logs_dir / f"{stem}.stdout.txt"
        stderr_path = logs_dir / f"{stem}.stderr.txt"
        stdout_path.write_text(str(item["stdout"]), encoding="utf-8")
        stderr_path.write_text(str(item["stderr"]), encoding="utf-8")
        item["log_files"] = {"stdout": str(stdout_path), "stderr": str(stderr_path)}
    output.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if marker.is_file() and marker.read_text(encoding="utf-8") == str(os.getpid()):
        shutil.rmtree(root)
        for phase_record in record["cleanup"]:
            phase_record["project_deleted"] = True
        output.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": record["status"], "output": str(output), "phases": len(record["phases"])}))
    return 0 if record["status"] == "completed" else 1


def redact_secrets(text: str) -> str:
    payload = json_value(text)
    if payload is None:
        return text
    secret_names = {"ANON_KEY", "SERVICE_ROLE_KEY", "DATABASE_URL", "JWT_SECRET", "PASSWORD"}
    def clean(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: "<redacted>" if key.upper() in secret_names or key.upper().endswith(("_KEY", "_PASSWORD")) else clean(child)
                for key, child in value.items()
            }
        if isinstance(value, list):
            return [clean(child) for child in value]
        return value
    return json.dumps(clean(payload))


if __name__ == "__main__":
    raise SystemExit(main())
