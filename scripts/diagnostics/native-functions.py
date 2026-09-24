#!/usr/bin/env python3
"""Reproduce cached native eager startup failures while retaining runtime output."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "native-functions-diagnostics"
PROJECTS = ROOT / "projects"
HOME = ROOT / "supabase-home"
LOGS = ROOT / "logs"
MAX_ATTEMPTS = 20
TIMEOUT = 900


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        secrets = {"ANON_KEY", "SERVICE_ROLE_KEY", "DATABASE_URL", "JWT_SECRET", "PASSWORD"}
        return {k: "<redacted>" if k.upper() in secrets or k.upper().endswith(("_KEY", "_PASSWORD")) else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"(?i)(postgres(?:ql)?://[^:/\s]+:)[^@/\s]+(@)", r"\1<redacted>\2", value)
        return re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "<redacted-jwt>", value)
    return value


def save(path: Path, value: Any) -> None:
    path.write_text(json.dumps(redact(value), indent=2) + "\n", encoding="utf-8")


def run(argv: list[str], cwd: Path, env: dict[str, str], timeout: int = TIMEOUT) -> dict[str, Any]:
    started = time.monotonic()
    try:
        result = subprocess.run(argv, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        return {"argv": argv, "exit_code": result.returncode, "elapsed_seconds": round(time.monotonic() - started, 3), "stdout": result.stdout, "stderr": result.stderr}
    except subprocess.TimeoutExpired as exc:
        return {"argv": argv, "exit_code": None, "elapsed_seconds": round(time.monotonic() - started, 3), "stdout": (exc.stdout or b"").decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""), "stderr": (exc.stderr or b"").decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or ""), "timed_out": True}


def configure(project: Path, project_id: str) -> None:
    config = project / "supabase" / "config.toml"
    text = config.read_text(encoding="utf-8")
    text = re.sub(r"(?m)^project_id\s*=\s*['\"].*?['\"]\s*$", f'project_id = "{project_id}"', text, count=1)
    pooler = re.search(r"(?ms)^\[db\.pooler\]\s*$.*?(?=^\[|\Z)", text)
    if pooler:
        section = re.sub(r"(?m)^enabled\s*=.*$", "enabled = false", pooler.group(0), count=1)
        text = text[:pooler.start()] + section + text[pooler.end():]
    else:
        text += "\n\n[db.pooler]\nenabled = false\n"
    exp = re.search(r"(?ms)^\[experimental\]\s*$.*?(?=^\[|\Z)", text)
    if exp:
        section = exp.group(0)
        section = re.sub(r"(?m)^stack\s*=.*$", "stack = true", section, count=1) if re.search(r"(?m)^stack\s*=", section) else section.rstrip() + "\nstack = true\n"
        text = text[:exp.start()] + section + text[exp.end():]
    else:
        text += "\n\n[experimental]\nstack = true\n"
    config.write_text(text, encoding="utf-8")


def wrap_cached_runtime() -> tuple[Path, str]:
    candidates = [p for p in HOME.rglob("edge-runtime") if p.is_file() and os.access(p, os.X_OK) and not p.name.endswith(".real")]
    if not candidates:
        raise RuntimeError("stack prepare completed without a cached executable named edge-runtime")
    binary = candidates[0]
    original_wrapper = binary.read_bytes()
    real = binary.with_name(".edge-runtime-wrapped")
    if not real.is_file():
        raise RuntimeError(f"expected wrapped native runtime ELF beside {binary}")
    digest = hashlib.sha256(real.read_bytes()).hexdigest()
    original_copy = binary.with_name(".edge-runtime-original-wrapper")
    original_copy.write_bytes(original_wrapper)
    original_copy.chmod(binary.stat().st_mode | 0o111)
    wrapper = f'''#!/usr/bin/env bash
set -uo pipefail
id="$(date -u +%Y%m%dT%H%M%S.%N)-$$"
printf '%s\\n' "$@" > {str(LOGS)!r}/"edge-runtime-$id.argv"
exec {str(original_copy)!r} "$@" > >(tee -a {str(LOGS)!r}/"edge-runtime-$id.stdout") 2> >(tee -a {str(LOGS)!r}/"edge-runtime-$id.stderr" >&2)
'''
    binary.write_text(wrapper, encoding="utf-8")
    binary.chmod(0o755)
    return binary, digest


def members(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        values = payload.get("members")
        if isinstance(values, list) and any(isinstance(row, dict) and "service" in row for row in values):
            return values
        for value in payload.values():
            found = members(value)
            if found:
                return found
    if isinstance(payload, list):
        for value in payload:
            found = members(value)
            if found:
                return found
    return []


def healthy(status: dict[str, Any]) -> tuple[bool, list[dict[str, Any]]]:
    try:
        payload = json.loads(status["stdout"])
    except (ValueError, KeyError):
        return False, []
    rows = members(payload)
    return len(rows) == 11 and all(row.get("lifecycle") == "running" and row.get("health") == "healthy" for row in rows), rows


def redact_logs() -> None:
    for path in LOGS.glob("*"):
        if path.is_file():
            content = path.read_text(errors="replace")
            content = re.sub(r"(?i)(postgres(?:ql)?://[^:/\s]+:)[^@/\s]+(@)", r"\1<redacted>\2", content)
            content = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "<redacted-jwt>", content)
            path.write_text(content, encoding="utf-8")


def main() -> int:
    cli = Path(os.environ["COMPILED_CLI"]).resolve()
    ROOT.mkdir(parents=True, exist_ok=True)
    PROJECTS.mkdir(exist_ok=True)
    LOGS.mkdir(exist_ok=True)
    runner_metadata = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "compiled-cli" / "benchmark-runner.json"
    if runner_metadata.exists():
        shutil.copyfile(runner_metadata, ROOT / "build-runner.json")
        runner = json.loads(runner_metadata.read_text(encoding="utf-8"))
    else:
        runner = {}
    env = os.environ.copy()
    for inherited in ("SUPABASE_WORKDIR", "SUPABASE_PROJECT_ID", "SUPABASE_NETWORK_ID"):
        env.pop(inherited, None)
    env.update({"SUPABASE_HOME": str(HOME), "SUPABASE_EXPERIMENTAL_STACK": "1", "SUPABASE_NO_KEYRING": "1", "SUPABASE_NO_UPDATE_NOTIFIER": "1", "SUPABASE_TELEMETRY_DISABLED": "1"})
    record: dict[str, Any] = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "cli_sha256": hashlib.sha256(cli.read_bytes()).hexdigest(),
        "runner": {
            "image_os": runner.get("image_os", os.environ.get("ImageOS", "unknown")),
            "image_version": runner.get("image_version", os.environ.get("ImageVersion", "unknown")),
            "platform": platform.platform(),
            "architecture": platform.machine(),
            "cpu_count": os.cpu_count(),
        },
        "attempts": [],
    }
    summary = ROOT / "summary.json"
    prepare = PROJECTS / "prepare"
    prepare.mkdir(parents=True, exist_ok=True)
    try:
        init = run([str(cli), "init"], prepare, env)
        record["cache_prepare"] = {"init": init}
        if init["exit_code"] != 0:
            raise RuntimeError("cache project initialization failed")
        configure(prepare, f"native-cache-{uuid.uuid4().hex[:10]}")
        prepared = run([str(cli), "stack", "prepare", "--runtime", "native"], prepare, env)
        record["cache_prepare"]["prepare"] = prepared
        if prepared["exit_code"] != 0:
            raise RuntimeError("cache preparation failed")
        destroyed = run([str(cli), "stack", "destroy", "--yes"], prepare, env)
        record["cache_prepare"]["destroy"] = destroyed
        if destroyed["exit_code"] != 0:
            raise RuntimeError("cache preparation cleanup failed")
        wrapper, binary_hash = wrap_cached_runtime()
        record["cached_edge_runtime"] = {"path": str(wrapper), "elf_path": str(wrapper.with_name(".edge-runtime-wrapped")), "elf_sha256_before_wrap": binary_hash, "original_wrapper_sha256": hashlib.sha256(wrapper.with_name(".edge-runtime-original-wrapper").read_bytes()).hexdigest(), "original_wrapper": wrapper.with_name(".edge-runtime-original-wrapper").read_text(errors="replace")}
        save(summary, record)
        for number in range(1, MAX_ATTEMPTS + 1):
            project = PROJECTS / f"attempt-{number:02d}"
            project.mkdir(parents=True)
            project_id = f"native-eager-{number:02d}-{uuid.uuid4().hex[:8]}"
            attempt: dict[str, Any] = {"number": number, "project_id": project_id}
            record["attempts"].append(attempt)
            try:
                initialized = run([str(cli), "init"], project, env)
                attempt["init"] = initialized
                if initialized["exit_code"] != 0:
                    attempt["failed_at"] = "init"
                    break
                configure(project, project_id)
                print(f"Starting cached native eager attempt {number}/{MAX_ATTEMPTS} ({project_id})", flush=True)
                start = run([str(cli), "start", "--runtime", "native", "--eager", "--output-format", "json"], project, env, timeout=120)
                attempt["start"] = start
                # Capture native process output and status before cleanup can remove the composition.
                status = run([str(cli), "status", "--output-format", "json"], project, env, timeout=120)
                attempt["status"] = status
                attempt["service_members"] = members(json.loads(status["stdout"])) if status["stdout"].lstrip().startswith(("{", "[")) else []
                attempt["healthy"] = start["exit_code"] == 0 and status["exit_code"] == 0 and healthy(status)[0]
                print(f"Attempt {number}: {'healthy' if attempt['healthy'] else 'failed'}; CLI exit={start['exit_code']}; status exit={status['exit_code']}", flush=True)
                if not attempt["healthy"]:
                    attempt["failed_at"] = "start" if start["exit_code"] != 0 else "status"
                    attempt["runtime_logs_at_failure"] = sorted(p.name for p in LOGS.glob("edge-runtime-*"))
                    break
            finally:
                stop = run([str(cli), "stop", "--workdir", str(project)], project, env, timeout=180)
                destroy = run([str(cli), "stack", "destroy", "--yes", "--workdir", str(project)], project, env, timeout=180)
                attempt["cleanup"] = {"stop": stop, "destroy": destroy}
                if stop["exit_code"] != 0 or destroy["exit_code"] != 0:
                    attempt["cleanup_failed"] = True
                    attempt.setdefault("failed_at", "cleanup")
                save(summary, record)
            if attempt.get("failed_at"):
                break
        return 0 if all(item.get("healthy") and not item.get("cleanup_failed") for item in record["attempts"]) and len(record["attempts"]) == MAX_ATTEMPTS else 1
    except Exception as exc:
        record["harness_error"] = str(exc)
        return 1
    finally:
        if prepare.exists():
            cleanup = run([str(cli), "stack", "destroy", "--yes", "--workdir", str(prepare)], prepare, env, timeout=180)
            record["cache_prepare_cleanup"] = cleanup
        save(summary, record)
        for binary in HOME.rglob("edge-runtime") if HOME.exists() else []:
            original_copy = binary.with_name(".edge-runtime-original-wrapper")
            if original_copy.exists():
                binary.unlink(missing_ok=True)
                original_copy.rename(binary)
        record["finished_at"] = datetime.now(timezone.utc).isoformat()
        redact_logs()
        save(summary, record)


if __name__ == "__main__":
    raise SystemExit(main())
