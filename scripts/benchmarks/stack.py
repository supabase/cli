#!/usr/bin/env python3
"""Measure isolated legacy and managed-stack CLI startup cases on CI runners.

Run one case per invocation on a fresh CI runner. The invocation measures a
cold start, a fresh project with the resulting caches, and a retained-data
restart, then writes every command and observation to one JSON file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
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


def init_project(cli: Path, project: Path, env: dict[str, str]) -> dict[str, Any]:
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
        if section:
            body = section.group(0)
            if re.search(r"(?m)^stack\s*=", body):
                body = re.sub(r"(?m)^stack\s*=\s*(?:true|false)\s*$", "stack = true", body, count=1)
            else:
                body = body.rstrip() + "\nstack = true\n"
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
                digest = None
                if size <= 4 * 1024 * 1024:
                    hasher = hashlib.sha256()
                    with path.open("rb") as stream:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            hasher.update(chunk)
                    digest = hasher.hexdigest()
                files.append({"path": str(path.relative_to(root)), "bytes": size, "sha256": digest})
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
            "memory_stats": state.get("MemoryStats"),
        })
    stat_rows = [json_value(line) for line in stats["stdout"].splitlines() if line.strip()] if stats else []
    normalized_stats = []
    for row in stat_rows:
        if not isinstance(row, dict):
            continue
        memory_text = str(row.get("MemUsage", "")).split("/", 1)[0].strip()
        cpu_text = str(row.get("CPUPerc", "")).rstrip("%").strip()
        normalized_stats.append({
            **row,
            "memory_used_bytes": parse_size(memory_text),
            "cpu_percent": float(cpu_text) if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", cpu_text) else None,
        })
    return {
        "available": ps["ok"], "label": label, "containers": image_records,
        "stats": normalized_stats,
        "memory_used_bytes_total": sum(row.get("memory_used_bytes") or 0 for row in normalized_stats),
        "cpu_percent_total": sum(row.get("cpu_percent") or 0 for row in normalized_stats),
        "commands": {"ps": ps, "inspect": inspect, "stats": stats},
    }


def parse_size(value: str) -> int | None:
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)?", value.strip(), re.IGNORECASE)
    if not match:
        return None
    units = {"B": (1, 0), "KB": (1000, 1), "MB": (1000, 2), "GB": (1000, 3), "TB": (1000, 4), "PB": (1000, 5),
             "KIB": (1024, 1), "MIB": (1024, 2), "GIB": (1024, 3), "TIB": (1024, 4), "PIB": (1024, 5)}
    unit = (match.group(2) or "B").upper()
    scale = units.get(unit)
    return None if scale is None else int(float(match.group(1)) * scale[0]**scale[1])


def container_process_memory(
    containers: list[dict[str, Any]], env: dict[str, str], cwd: Path,
) -> dict[str, Any] | None:
    if platform.system() != "Linux":
        return None
    per_container = []
    for container in containers:
        container_id = container.get("id")
        if not isinstance(container_id, str):
            continue
        top = run(["docker", "top", container_id, "-eo", "pid="], cwd=cwd, env=env, timeout=30)
        pids = []
        for line in top["stdout"].splitlines():
            try:
                pids.append(int(line.strip()))
            except ValueError:
                continue
        process_records = []
        for pid in pids:
            target = Path("/proc") / str(pid) / "smaps_rollup"
            try:
                content = target.read_text(encoding="utf-8")
                source = "proc"
            except OSError:
                elevated = run(["sudo", "-n", "cat", str(target)], cwd=cwd, env=env, timeout=10)
                content = elevated["stdout"]
                source = "sudo-proc" if elevated["ok"] else "unavailable"
            values: dict[str, int] = {}
            for line in content.splitlines():
                if line.startswith(("Rss:", "Pss:")):
                    key, amount, *_ = line.split()
                    values[key[:-1].lower() + "_bytes"] = int(amount) * 1024
            process_records.append({
                "pid": pid, "rss_bytes": values.get("rss_bytes"),
                "pss_bytes": values.get("pss_bytes"), "source": source,
            })
        per_container.append({
            "container_id": container_id, "process_count": len(pids),
            "processes": process_records,
            "rss_bytes": sum(row.get("rss_bytes") or 0 for row in process_records),
            "pss_bytes": sum(row.get("pss_bytes") or 0 for row in process_records),
            "collector": top, "available": top["ok"] and bool(pids) and all(row["source"] != "unavailable" for row in process_records),
        })
    return {
        "sampled_at": now(), "containers": per_container,
        "rss_bytes_total": sum(row["rss_bytes"] for row in per_container),
        "pss_bytes_total": sum(row["pss_bytes"] for row in per_container),
        "scope": "host-process RSS/PSS for processes inside exact stack-labeled containers",
    }


def docker_image_inventory(env: dict[str, str], cwd: Path) -> dict[str, Any]:
    if shutil.which("docker") is None:
        return {"available": False, "images": [], "command": None}
    command = run(
        ["docker", "image", "ls", "--no-trunc", "--format", "{{json .}}"],
        cwd=cwd, env=env, timeout=60,
    )
    images = [json_value(line) for line in command["stdout"].splitlines() if line.strip()]
    return {
        "available": command["ok"],
        "images": [image for image in images if isinstance(image, dict)],
        "ids": sorted({str(image["ID"]) for image in images if isinstance(image, dict) and image.get("ID")}),
        "command": command,
    }


def inspect_images(image_ids: list[str], env: dict[str, str], cwd: Path) -> list[dict[str, Any]]:
    if not image_ids:
        return []
    result = run(["docker", "image", "inspect", *image_ids], cwd=cwd, env=env, timeout=120)
    payload = json_value(result["stdout"])
    if not result["ok"] or not isinstance(payload, list):
        return [{"inspect_error": result}]
    return [{
        "id": image.get("Id"),
        "repo_tags": image.get("RepoTags") or [],
        "repo_digests": image.get("RepoDigests") or [],
        "expanded_size_bytes": image.get("Size"),
        "layer_count": len((image.get("RootFS") or {}).get("Layers", [])),
    } for image in payload if isinstance(image, dict)]


def remove_sample_images(
    image_ids: list[str], baseline_ids: set[str], env: dict[str, str], cwd: Path
) -> list[dict[str, Any]]:
    results = []
    for image_id in sorted(set(image_ids) - baseline_ids):
        containers = run(
            ["docker", "ps", "-a", "-q", "--filter", f"ancestor={image_id}"],
            cwd=cwd, env=env, timeout=60,
        )
        if not containers["ok"] or containers["stdout"].strip():
            results.append({"image_id": image_id, "removed": False, "reason": "image is referenced by a container", "container_check": containers})
            continue
        removed = run(["docker", "image", "rm", image_id], cwd=cwd, env=env, timeout=120)
        results.append({"image_id": image_id, "removed": removed["ok"], "command": removed})
    return results


def network_counters() -> dict[str, int] | None:
    if not Path("/proc/net/dev").is_file():
        return None
    received = sent = 0
    for line in Path("/proc/net/dev").read_text().splitlines()[2:]:
        if ":" not in line:
            continue
        interface, counters = line.split(":", 1)
        if interface.strip() == "lo":
            continue
        fields = counters.split()
        if len(fields) >= 9:
            received += int(fields[0])
            sent += int(fields[8])
    return {"received_bytes": received, "sent_bytes": sent}


def network_delta(before: dict[str, int] | None, after: dict[str, int] | None) -> dict[str, int] | None:
    if before is None or after is None:
        return None
    return {key: after[key] - before[key] for key in before}


def memory_sample(
    implementation: str, runtime: str, project_id: str, stack_id: str | None,
    env: dict[str, str], cwd: Path,
) -> dict[str, Any]:
    containers = docker_snapshot(project_id, stack_id, env, cwd) if runtime == "docker" else None
    processes = process_snapshot(stack_id) if implementation == "new" else None
    return {
        "sampled_at": now(),
        "stack_host_processes": processes,
        "docker_engine_stats": containers,
        "container_process_rss_pss": container_process_memory(
            containers.get("containers", []), env, cwd
        ) if isinstance(containers, dict) else None,
    }


def settled_memory_samples(
    implementation: str, runtime: str, project_id: str, stack_id: str | None,
    env: dict[str, str], cwd: Path, offsets: tuple[int, ...] = (30, 35, 40),
) -> list[dict[str, Any]]:
    started = time.monotonic()
    samples = []
    for offset in offsets:
        remaining = offset - (time.monotonic() - started)
        if remaining > 0:
            time.sleep(remaining)
        sample = memory_sample(implementation, runtime, project_id, stack_id, env, cwd)
        sample["offset_seconds"] = offset
        sample["runtime"] = runtime
        samples.append(sample)
    return samples


def prepare_new_stack(
    *, cli: Path, output_record: dict[str, Any], args: argparse.Namespace,
    root: Path, project_id: str, env: dict[str, str],
    baseline_image_ids: set[str],
) -> None:
    project = root / "project-prepare"
    home = root / "prepare-home"
    prepare_env = env.copy()
    prepare_env.update({"SUPABASE_HOME": str(home), "SUPABASE_WORKDIR": str(project)})
    init_result = init_project(cli, project, prepare_env)
    configure_project(project, project_id, stack=True, pooler=args.mode == "eager")
    cache_root = home / "cache" / "stack"
    before = cache_inventory(cache_root)
    if not init_result["ok"] or not (project / "supabase" / "config.toml").exists():
        output_record["preparation"] = {
            "status": "failed", "stage": "init", "init": init_result,
            "cache_before": before, "cache_after": before, "cache_bytes_delta": 0,
        }
        return
    command_args = [str(cli), "stack", "prepare"]
    if not (args.mode == "default" and args.runtime == "native"):
        command_args += ["--runtime", args.runtime]
    command_args += ["--output-format", "json", "--workdir", str(project)]
    network_before = network_counters()
    started = time.perf_counter()
    prepared = run(command_args, cwd=project, env=prepare_env, timeout=args.timeout)
    elapsed = round((time.perf_counter() - started) * 1000, 2)
    network_after_prepare = network_counters()
    after = cache_inventory(cache_root)
    prepare_record = {
        "status": "completed" if init_result["ok"] and prepared["ok"] else "failed",
        "runtime": args.runtime,
        "init": init_result,
        "command": prepared,
        "elapsed_ms": elapsed,
        "cache_before": before,
        "cache_after": after,
        "cache_bytes_delta": after["bytes"] - before["bytes"],
        "network_before": network_before,
        "network_after": network_after_prepare,
        "network_delta": network_delta(network_before, network_after_prepare),
        "image_inventory_before": output_record["preflight"].get("docker_images"),
        "notes": ["Native uses an independent fresh artifact cache. Docker image cache is daemon-global and its inventory delta is measured separately."],
    }
    prepare_record["stack_id"] = find_stack_id(prepared.get("stdout", ""))
    before_ids = set((output_record["preflight"].get("docker_images") or {}).get("ids", []))
    if args.runtime == "docker":
        current = docker_image_inventory(prepare_env, project)
        new_ids = sorted(set(current.get("ids", [])) - before_ids)
        prepare_record["images_added"] = inspect_images(new_ids, prepare_env, project)
        prepare_record["images_removed_to_preserve_start_cold_state"] = remove_sample_images(new_ids, before_ids, prepare_env, project)
        prepare_record["image_inventory_after_reset"] = docker_image_inventory(prepare_env, project)
    if init_result["ok"]:
        prepare_record["cleanup"] = destroy_new(cli, project, prepare_env)
    removal_results = prepare_record.get("images_removed_to_preserve_start_cold_state", [])
    prepare_record["cold_start_cache"] = (
        "cold" if not before_ids and all(item.get("removed") for item in removal_results)
        and not prepare_record.get("image_inventory_after_reset", {}).get("ids")
        else "runner-baseline-cache-present" if before_ids
        else "partial-image-cleanup"
    )
    prepare_record["status"] = "completed" if (
        prepared["ok"] and prepare_record.get("cleanup", {}).get("ok", False)
        and all(item.get("removed") for item in removal_results)
    ) else "failed"
    output_record["preparation"] = prepare_record


def legacy_image_pull_replay(
    output_record: dict[str, Any], env: dict[str, str], cwd: Path, baseline_ids: set[str],
) -> dict[str, Any]:
    before = docker_image_inventory(env, cwd)
    new_ids = sorted(set(before.get("ids", [])) - baseline_ids)
    images = inspect_images(new_ids, env, cwd)
    removed = remove_sample_images(new_ids, baseline_ids, env, cwd)
    removed_ids = {item["image_id"] for item in removed if item.get("removed")}
    references = sorted({
        (image.get("repo_digests") or image.get("repo_tags") or [None])[0]
        for image in images if not image.get("inspect_error") and image.get("id") in removed_ids
    })
    references = [ref for ref in references if isinstance(ref, str) and ref not in {"<none>:<none>"}]
    network_before = network_counters()
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=4) as executor:
        pulls = list(executor.map(
            lambda reference: run(["docker", "pull", reference], cwd=cwd, env=env, timeout=DEFAULT_TIMEOUT),
            references,
        ))
    pull_elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    network_after = network_counters()
    after_pull = docker_image_inventory(env, cwd)
    reloaded_ids = sorted(set(after_pull.get("ids", [])) - baseline_ids)
    cleanup_after_pull = remove_sample_images(reloaded_ids, baseline_ids, env, cwd)
    return {
        "kind": "sample-owned-image-pull-replay",
        "images": images,
        "image_refs": references,
        "status": "completed" if (
            all(item.get("removed") for item in removed)
            and len(references) == len(removed_ids)
            and all(command["ok"] for command in pulls)
            and all(item.get("removed") for item in cleanup_after_pull)
        ) else "failed",
        "expanded_size_bytes": sum(image.get("expanded_size_bytes", 0) for image in images if isinstance(image.get("expanded_size_bytes"), int)),
        "compressed_download_bytes": None,
        "removed_exact_sample_images": removed,
        "pull_commands": pulls,
        "elapsed_ms": pull_elapsed_ms,
        "network_before": network_before,
        "network_after": network_after,
        "network_delta": network_delta(network_before, network_after),
        "image_inventory_after": after_pull,
        "cleanup_after_pull": cleanup_after_pull,
        "note": "Elapsed time is concurrent pull replay after removing only new sample image IDs with no referencing containers. Linux host RX delta is recorded; Docker does not report exact transferred layer bytes here. Expanded image sizes are not download sizes.",
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


def find_project_stack_id(cli: Path, project: Path, env: dict[str, str]) -> tuple[str | None, dict[str, Any]]:
    listing = run(
        [str(cli), "stack", "list", "--output-format", "json", "--workdir", str(project)],
        cwd=project, env=env, timeout=30,
    )
    payload = json_value(listing["stdout"])
    target = str(project.resolve())
    for item in walk(payload):
        project_root = item.get("project_root", item.get("projectRoot"))
        stack_id = item.get("id")
        if project_root == target and isinstance(stack_id, str):
            return stack_id, listing
    return None, listing


def failure_diagnostics(
    cli: Path, implementation: str, runtime: str, project: Path,
    project_id: str, stack_id: str | None, env: dict[str, str],
) -> dict[str, Any]:
    diagnostics: dict[str, Any] = {
        "captured_at": now(),
        "docker_snapshot": docker_snapshot(project_id, stack_id, env, project) if runtime == "docker" else None,
    }
    if implementation == "new":
        if stack_id is None:
            stack_id, listing = find_project_stack_id(cli, project, env)
            diagnostics["stack_list"] = listing
        diagnostics["stack_id"] = stack_id
        diagnostics["logs"] = run(
            [str(cli), "stack", "logs", *(["--stack-id", stack_id] if stack_id else []), "--output-format", "stream-json"],
            cwd=project, env=env, timeout=5,
        )
    if runtime == "docker":
        snapshot = diagnostics.get("docker_snapshot")
        containers = snapshot.get("containers", []) if isinstance(snapshot, dict) else []
        ids = [str(item.get("id")) for item in containers if item.get("id")]
        with ThreadPoolExecutor(max_workers=4) as executor:
            diagnostics["container_logs"] = list(executor.map(
                lambda container_id: run(
                    ["docker", "logs", "--tail", "150", container_id],
                    cwd=project, env=env, timeout=5,
                ),
                ids,
            ))
    return diagnostics


def start_args(cli: Path, implementation: str, runtime: str, mode: str, project: Path, stack_name: str) -> list[str]:
    args = [str(cli), "start", "--workdir", str(project)]
    if implementation == "new":
        if not (mode == "default" and runtime == "native"):
            args += ["--runtime", runtime]
        args += ["--output-format", "json"]
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
    headers = {} if anon_key is None else {"apikey": anon_key, "Authorization": f"Bearer {anon_key}"}
    request = urllib.request.Request(url.rstrip("/") + "/rest/v1/", method="GET", headers=headers)
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
    init_record = init_project(cli, project, env)
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
    network_before = network_counters()
    started = time.perf_counter()
    start = run(start_args(cli, implementation, runtime, mode, project, stack_name), cwd=project, env=env)
    network_after_start = network_counters()
    phase_data["commands"]["start"] = start
    phase_data["start_ms"] = start["elapsed_ms"]
    phase_data["timer_ms"] = round((time.perf_counter() - started) * 1000, 2)
    stack_id = find_stack_id(start.get("stdout", "")) if implementation == "new" else None
    phase_data["stack_id"] = stack_id
    status = status_command(cli, implementation, project, env)
    phase_data["commands"]["status"] = status
    phase_data["service_observation"] = json_value(status.get("stdout", ""))
    if implementation == "new" and stack_id is None and (not start["ok"] or not status["ok"]):
        stack_id, phase_data["commands"]["stack_list"] = find_project_stack_id(cli, project, env)
        phase_data["stack_id"] = stack_id
    phase_data["ready"] = bool(start["ok"] and status["ok"])
    phase_data["network_before_start"] = network_before
    phase_data["network_after_start"] = network_after_start
    phase_data["network_delta_during_start"] = network_delta(network_before, network_after_start)
    phase_data["peak_memory"] = None
    phase_data["peak_memory_note"] = "Not sampled; managed children detach from the CLI process and continuous ownership sampling is not yet implemented."
    if phase_data["ready"] and mode == "default" and implementation == "new":
        env_status = env_status_command(cli, implementation, project, env)
        phase_data["commands"]["status_env"] = env_status
        phase_data["service_readiness"] = service_readiness(phase_data["service_observation"], mode)
    else:
        phase_data["service_readiness"] = service_readiness(phase_data["service_observation"], mode)
    if implementation == "new":
        phase_data["ready"] = phase_data["ready"] and phase_data["service_readiness"]["expected_ready"]
    phase_data["memory_idle_samples"] = settled_memory_samples(
        implementation, runtime, project_id, stack_id, env, project
    ) if phase_data["ready"] else []
    if phase_data["ready"] and mode == "default" and implementation == "new":
        first = request_first_api(env_status, project, env)
        phase_data["first_api_request"] = first
        if first is None:
            phase_data["api_readiness_error"] = "Unable to obtain an API endpoint and anon key from status --env."
        elif not first.get("success"):
            phase_data["api_readiness_error"] = "Authenticated REST root request did not return a 2xx or 3xx response."
        phase_data["memory_after_first_api_request"] = memory_sample(
            implementation, runtime, project_id, stack_id, env, project
        )
        if first is not None and first.get("success"):
            time.sleep(65)
            phase_data["memory_after_65s_idle"] = memory_sample(
                implementation, runtime, project_id, stack_id, env, project
            )
            phase_data["status_after_65s_idle"] = status_command(cli, implementation, project, env)
            reactivated_env = env_status_command(cli, implementation, project, env)
            phase_data["commands"]["status_env_after_idle"] = reactivated_env
            phase_data["reactivation_request"] = request_first_api(reactivated_env, project, env)
            phase_data["memory_after_reactivation"] = memory_sample(
                implementation, runtime, project_id, stack_id, env, project
            )
            if not phase_data["reactivation_request"] or not phase_data["reactivation_request"].get("success"):
                phase_data["api_readiness_error"] = "Authenticated REST request failed after the 65-second idle interval."
        if "api_readiness_error" in phase_data:
            phase_data["ready"] = False
    cache_after = cache_inventory(cache_root)
    phase_data["cache_before"] = cache_before
    phase_data["cache_after"] = cache_after
    phase_data["cache_bytes_delta"] = cache_after["bytes"] - cache_before["bytes"]
    phase_data["finished_at"] = now()
    if not start["ok"]:
        phase_data["failure"] = {"stage": "start", "exit_code": start["exit_code"], "stdout": start["stdout"], "stderr": start["stderr"]}
    elif not status["ok"]:
        phase_data["failure"] = {"stage": "status", "exit_code": status["exit_code"], "stdout": status["stdout"], "stderr": status["stderr"]}
    elif "api_readiness_error" in phase_data:
        phase_data["failure"] = {"stage": "lazy-api", "message": phase_data["api_readiness_error"]}
    elif implementation == "new" and not phase_data["service_readiness"]["expected_ready"]:
        phase_data["failure"] = {"stage": "readiness", "message": "Selected service readiness did not match requested mode."}
    if not phase_data["ready"]:
        phase_data["failure_diagnostics"] = failure_diagnostics(
            cli, implementation, runtime, project, project_id, stack_id, env
        )
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
    parser.add_argument("--output", required=True, type=Path, help="Shared result directory")
    parser.add_argument("--root", type=Path, help="Fresh temporary data root; defaults to RUNNER_TEMP")
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

    docker_images_before = docker_image_inventory(env, root) if args.runtime == "docker" else None
    baseline_image_ids = set((docker_images_before or {}).get("ids", []))
    record: dict[str, Any] = {
        "schema_version": 1,
        "benchmark": "supabase-cli-stack",
        "status": "running",
        "started_at": now(),
        "case": {"implementation": args.implementation, "runtime": args.runtime, "mode": args.mode, "sample": args.sample},
        "cli": {"path": str(cli), "version_command": None},
        "host": {"system": platform.platform(), "os": platform.system(), "release": platform.release(), "machine": platform.machine(), "cpu_count": os.cpu_count(), "python": platform.python_version()},
        "paths": {"root": str(root), "home": str(home), "project_cold": str(project_cold), "project_cached": str(project_cached)},
        "preflight": {"dockerless": dockerless_probe, "docker_images": docker_images_before},
        "phases": [],
        "cleanup": [],
        "limitations": [
            "Start wall time includes CLI bootstrap and artifact preparation; cache byte deltas are extracted on-disk growth, not network download bytes.",
            "Docker expanded image size is not compressed download size. Linux network counters include all non-loopback traffic during the measured interval.",
            "CPU and peak RSS are not sampled continuously. Idle RSS/PSS/container memory are sampled at 30/35/40 seconds after readiness; cold peaks are null.",
        ],
    }
    if args.implementation == "new":
        prepare_new_stack(
            cli=cli, output_record=record, args=args, root=root,
            project_id=project_id + "p", env=env,
            baseline_image_ids=baseline_image_ids,
        )
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

    if args.implementation == "legacy" and args.runtime == "docker":
        record["image_pull_replay"] = legacy_image_pull_replay(
            record, env, root, baseline_image_ids
        )
    elif args.implementation == "new" and args.runtime == "docker":
        after_phases = docker_image_inventory(env, root)
        new_image_ids = sorted(set(after_phases.get("ids", [])) - baseline_image_ids)
        record["post_run_docker_images"] = after_phases
        record["docker_image_cleanup"] = remove_sample_images(
            new_image_ids, baseline_image_ids, env, root
        )

    preparation_ok = record.get("preparation", {}).get("status", "completed") == "completed"
    replay_ok = record.get("image_pull_replay", {}).get("status", "completed") == "completed"
    image_cleanup_ok = all(item.get("removed", False) for item in record.get("docker_image_cleanup", []))
    record["status"] = "completed" if (
        error is None and preparation_ok and replay_ok and image_cleanup_ok
        and all(item.get("ok", True) for item in record["cleanup"])
    ) else "failed"
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
    cleaned = text
    if payload is not None:
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
        cleaned = json.dumps(clean(payload))
    cleaned = re.sub(
        r"(?i)(postgres(?:ql)?://[^:/\s]+:)[^@/\s]+(@)",
        r"\1<redacted>\2",
        cleaned,
    )
    return re.sub(
        r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
        "<redacted-jwt>",
        cleaned,
    )


if __name__ == "__main__":
    raise SystemExit(main())
