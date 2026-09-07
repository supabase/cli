#!/usr/bin/env python3
"""Turn a campaign directory into the report-tools canonical input.

Only measurements that are present in completed runner cells are consumed.
Logs, command output, credentials, and container metadata never cross this
boundary: the resulting JSON contains timings, memory numbers, counts, and
safe provenance strings only.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from datetime import date
from pathlib import Path
from statistics import median
from typing import Any, Iterable

CASES = ("legacy", "legacyEager", "dockerDefault", "dockerEager", "nativeDefault", "nativeEager")
MEMORY_CASES = (
    "legacy-default",
    "legacy-pooler",
    "docker-default",
    "native-default",
    "docker-eager",
    "native-eager",
)
RAW_CASES = {
    "legacy": "legacy",
    "legacy-pooler": "legacyEager",
    "new-container-default": "dockerDefault",
    "new-container-eager": "dockerEager",
    "new-native-default": "nativeDefault",
    "new-native-eager": "nativeEager",
}
MEMORY_CASE = {
    "legacy": "legacy-default",
    "legacy-pooler": "legacy-pooler",
    "new-container-default": "docker-default",
    "new-native-default": "native-default",
    "new-container-eager": "docker-eager",
    "new-native-eager": "native-eager",
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and value > 0 else None


def number_at(value: Any, *keys: str) -> float | None:
    for key in keys:
        if isinstance(value, dict):
            value = value.get(key)
        else:
            return None
    return finite_number(value)


def all_cell_dirs(campaign: Path) -> list[tuple[Path, dict[str, Any]]]:
    result: list[tuple[Path, dict[str, Any]]] = []
    for status_path in sorted(campaign.glob("results/**/cell-status.json")):
        try:
            status = read_json(status_path)
        except (OSError, ValueError):
            continue
        cell = status.get("cell") if isinstance(status, dict) else None
        if not isinstance(cell, dict):
            try:
                cell = read_json(status_path.parent / "runner-result.json").get("cell")
            except (OSError, ValueError, AttributeError):
                cell = None
        if isinstance(cell, dict):
            result.append((status_path.parent, cell))
    return result


def cell_status(cell_dir: Path) -> dict[str, Any]:
    try:
        value = read_json(cell_dir / "cell-status.json")
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def setup_failure(cell_dir: Path, cell: dict[str, Any]) -> dict[str, Any] | None:
    status = cell_status(cell_dir)
    value = str(status.get("status", ""))
    if value not in {"setup-failed", "setup-invalid"}:
        return None
    return {
        "cellId": cell.get("cellId"),
        "platform": cell.get("platform"),
        "mode": cell.get("mode"),
        "case": cell.get("case"),
        "sample": cell.get("sample"),
        "status": value,
        "reason": status.get("reason") or status.get("error"),
    }


def phase_row(values: list[float], attempts: int) -> dict[str, Any]:
    successes = len(values)
    row: dict[str, Any] = {
        "attempts": attempts,
        "successes": successes,
        "failures": max(0, attempts - successes),
    }
    if values:
        row.update({"medianSeconds": median(values), "rangeSeconds": [min(values), max(values)]})
    return row


def result_completed(cell_dir: Path) -> bool:
    try:
        value = read_json(cell_dir / "runner-result.json")
    except (OSError, ValueError):
        return False
    return isinstance(value, dict) and value.get("status") == "completed"


def command_ok(command: Any) -> bool:
    return isinstance(command, dict) and command.get("exitCode") == 0 and not command.get("timedOut", False)


def legacy_measurements(cell_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    path = cell_dir / "legacy-results.json"
    if not path.is_file():
        return [], []
    try:
        data = read_json(path)
    except (OSError, ValueError):
        return [], []
    rows = data.get("measurements", []) if isinstance(data, dict) else []
    if not isinstance(rows, list):
        return [], []
    fresh = [row for row in rows if isinstance(row, dict) and row.get("kind") == "fresh"]
    restart = [row for row in rows if isinstance(row, dict) and row.get("kind") == "retained-data-restart"]
    return fresh, restart


def new_measurements(cell_dir: Path) -> list[dict[str, Any]]:
    paths = list(cell_dir.glob("new-stack/**/new-stack-summary.json"))
    rows: list[dict[str, Any]] = []
    for path in paths:
        try:
            data = read_json(path)
        except (OSError, ValueError):
            continue
        values = data.get("measurements", []) if isinstance(data, dict) else []
        if isinstance(values, list):
            rows.extend(row for row in values if isinstance(row, dict))
    return rows


def timing(row: dict[str, Any], restart: bool = False) -> float | None:
    if restart:
        value = number_at(row, "restart", "startMs")
        if value is None:
            value = number_at(row, "start", "elapsedMs")
    elif "start" in row:
        value = number_at(row, "start", "elapsedMs")
    else:
        value = number_at(row, "startMs")
    return None if value is None else value / 1000


def memory_value(row: dict[str, Any], key: str) -> float | None:
    capture = row.get("memoryCapture")
    if not isinstance(capture, dict):
        return None
    value = number_at(capture, "median", key)
    if value is None:
        return None
    return value / (1024 * 1024)


def legacy_images(row: dict[str, Any]) -> list[str]:
    capture = row.get("memoryCapture")
    snapshots = capture.get("snapshots") if isinstance(capture, dict) else None
    if not isinstance(snapshots, list):
        return []
    images: set[str] = set()
    for item in snapshots:
        snapshot = item.get("snapshot") if isinstance(item, dict) else None
        containers = snapshot.get("containers") if isinstance(snapshot, dict) else None
        if not isinstance(containers, list):
            continue
        for container in containers:
            image = container.get("image") if isinstance(container, dict) else None
            if isinstance(image, str) and image:
                images.add(image)
    return sorted(images)


def artifact_barrier(row: dict[str, Any]) -> dict[str, float] | None:
    """Keep the numeric artifact readiness timings for each startup sample."""
    value = row.get("artifactBarrier")
    if not isinstance(value, dict):
        return None
    ready = finite_number(value.get("artifactReadyMs"))
    wait = finite_number(value.get("barrierWaitMs"))
    result: dict[str, float] = {}
    if ready is not None:
        result["artifactReadyMs"] = ready
    if wait is not None:
        result["barrierWaitMs"] = wait
    return result or None


def artifacts_prepared_observed_seconds(row: dict[str, Any]) -> float | None:
    """Find the first status poll where every final artifact is ready."""
    final_status = row.get("status")
    final_artifacts = final_status.get("artifacts") if isinstance(final_status, dict) else None
    expected = {
        item.get("workloadId")
        for item in final_artifacts or []
        if isinstance(item, dict) and isinstance(item.get("workloadId"), str) and item.get("workloadId")
    }
    if not expected:
        return None
    observations = row.get("startStatusObservations")
    if not isinstance(observations, list):
        return None
    for item in observations:
        if not isinstance(item, dict):
            continue
        status = item.get("status")
        artifacts = status.get("artifacts") if isinstance(status, dict) else None
        ready = {
            artifact.get("workloadId")
            for artifact in artifacts or []
            if isinstance(artifact, dict) and artifact.get("state") == "ready" and isinstance(artifact.get("workloadId"), str)
        }
        if expected.issubset(ready):
            offset = finite_number(item.get("observedOffsetMs"))
            if offset is not None:
                return offset / 1000
    return None


def memory_metric(values: list[float], key: str) -> dict[str, Any]:
    if not values:
        return {"median": None, "rangeMiB": []}
    return {"median": median(values), "rangeMiB": [min(values), max(values)]}


def snapshot_observations(row: dict[str, Any], host: str, case: str, sample: int) -> list[dict[str, Any]]:
    capture = row.get("memoryCapture")
    if not isinstance(capture, dict) or not isinstance(capture.get("snapshots"), list):
        return []
    observations: list[dict[str, Any]] = []
    for item in capture["snapshots"]:
        if not isinstance(item, dict):
            continue
        actual = finite_number(item.get("actualOffsetMs"))
        requested = finite_number(item.get("requestedOffsetMs"))
        snapshot = item.get("snapshot")
        totals = snapshot.get("totals") if isinstance(snapshot, dict) else None
        rss = finite_number(totals.get("rssBytes")) if isinstance(totals, dict) else None
        pss = finite_number(totals.get("pssBytes")) if isinstance(totals, dict) else None
        if actual is None or rss is None:
            continue
        observation: dict[str, Any] = {
            "platform": host,
            "case": case,
            "sample": sample,
            "actualOffsetMs": actual,
            "rssMiB": rss / (1024 * 1024),
        }
        if requested is not None:
            observation["requestedOffsetMs"] = requested
        if pss is not None:
            observation["pssMiB"] = pss / (1024 * 1024)
        observations.append(observation)
    return observations


def extract_legacy_version(campaign: Path) -> str:
    for path in sorted(campaign.glob("results/*/*/*/*/legacy-results.json")):
        try:
            data = read_json(path)
        except (OSError, ValueError):
            continue
        cli = data.get("cli", {}) if isinstance(data, dict) else {}
        value = cli.get("version") if isinstance(cli, dict) else None
        if isinstance(value, str):
            match = re.search(r"\d+\.\d+\.\d+", value)
            if match:
                return match.group(0)
    return "2.116.0"


def aggregate(campaign: Path, *, commit: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    metadata = dict(metadata or {})
    startup: dict[str, dict[str, Any]] = {host: {} for host in ("linux", "macos")}
    timings: dict[tuple[str, str, str, str], list[float]] = {}
    attempts: dict[tuple[str, str, str, str], int] = {}
    restart_values: dict[tuple[str, str], list[float]] = {}
    restart_attempts: dict[tuple[str, str], int] = {}
    memory_values: dict[tuple[str, str], dict[str, list[float]]] = {}
    snapshots = 0
    starts = 0
    startup_observations: list[dict[str, Any]] = []
    restart_observations: list[dict[str, Any]] = []
    memory_observations: list[dict[str, Any]] = []
    legacy_image_sets: dict[str, set[str]] = {"legacy": set(), "legacy-pooler": set()}

    records = all_cell_dirs(campaign)
    setup_failures: list[dict[str, Any]] = []
    for cell_dir, cell in records:
        failure = setup_failure(cell_dir, cell)
        if failure is not None:
            setup_failures.append(failure)
    # Archived attempts are independent observations. A retry can reuse the
    # same cell id, so do not collapse it with the current directory. Only
    # setup failures are excluded above; product failures remain attempts.
    for cell_dir, cell in records:
        if setup_failure(cell_dir, cell) is not None:
            continue
        host = "linux" if cell.get("platform") == "ubuntu-22.04" else str(cell.get("platform"))
        mode = str(cell.get("mode"))
        raw_case = str(cell.get("case"))
        canonical = RAW_CASES.get(raw_case)
        if host not in ("linux", "macos") or canonical is None or mode not in ("cold", "hot"):
            continue
        phase = "cold" if mode == "cold" else "cached"
        key = (host, canonical, phase, "startup")
        attempts[key] = attempts.get(key, 0) + 1
        complete = result_completed(cell_dir)
        fresh: list[dict[str, Any]] = []
        restarts: list[dict[str, Any]] = []
        if raw_case.startswith("new-"):
            rows = new_measurements(cell_dir)
            # campaign.py invokes the harness once per cell with
            # BENCHMARK_SAMPLES=1, so its local sample is always one. The
            # campaign cell itself owns the matrix sample identity.
            fresh = rows[:1]
            restarts = fresh
        else:
            fresh, restarts = legacy_measurements(cell_dir)
        fresh_ok = [row for row in fresh if complete and timing(row) is not None and (not row.get("start") or command_ok(row.get("start")))]
        if mode == "hot" and raw_case in legacy_image_sets:
            for row in fresh_ok:
                legacy_image_sets[raw_case].update(legacy_images(row))
        timings.setdefault(key, []).extend(value for value in (timing(row) for row in fresh_ok) if value is not None)
        fresh_value = timing(fresh[0]) if fresh else None
        observation: dict[str, Any] = {
            "platform": host,
            "mode": mode,
            "case": canonical,
            "sample": int(cell.get("sample", 0)),
            "success": bool(fresh_ok),
        }
        if fresh_value is not None and fresh_ok:
            observation["seconds"] = fresh_value
        barrier = artifact_barrier(fresh[0]) if fresh else None
        if barrier is not None:
            observation["artifactBarrier"] = barrier
        prepared = artifacts_prepared_observed_seconds(fresh[0]) if fresh else None
        if prepared is not None:
            observation["artifactsPreparedObservedSeconds"] = prepared
        startup_observations.append(observation)

        memory_case = MEMORY_CASE[raw_case]
        for row in fresh_ok:
            rss = memory_value(row, "rssBytes")
            pss = memory_value(row, "pssBytes")
            if rss is not None:
                bucket = memory_values.setdefault((host, memory_case), {"rss": [], "pss": []})
                bucket["rss"].append(rss)
                if pss is not None:
                    bucket["pss"].append(pss)
                capture = row.get("memoryCapture")
                if isinstance(capture, dict):
                    snapshots += len(capture.get("snapshots", [])) if isinstance(capture.get("snapshots"), list) else 0
                    starts += 1
                memory_observations.extend(snapshot_observations(row, host, memory_case, int(cell.get("sample", 0))))

        if mode == "hot":
            restart_key = (host, canonical)
            restart_attempts[restart_key] = restart_attempts.get(restart_key, 0) + len(restarts) if restarts else restart_attempts.get(restart_key, 0)
            for row in restarts:
                value = timing(row, restart=True)
                restart_observations.append({
                    "platform": host,
                    "case": canonical,
                    "sample": int(cell.get("sample", 0)),
                    "success": bool(value is not None and complete),
                    **({"seconds": value} if value is not None and complete else {}),
                })
                if value is not None and complete and (row.get("start") is None or command_ok(row.get("start"))):
                    restart_values.setdefault(restart_key, []).append(value)

    for host in ("linux", "macos"):
        for case in CASES:
            startup[host][case] = {}
            for phase in ("cached", "cold"):
                key = (host, case, phase, "startup")
                startup[host][case][phase] = phase_row(timings.get(key, []), attempts.get(key, 0))
        per_case: dict[str, Any] = {}
        for case in CASES:
            key = (host, case)
            per_case[case] = phase_row(restart_values.get(key, []), restart_attempts.get(key, 0))
        all_restarts = [value for key, values in restart_values.items() if key[0] == host for value in values]
        all_attempts = sum(value for key, value in restart_attempts.items() if key[0] == host)
        # The renderer consumes the six case keys directly. Keep a small
        # host-level summary alongside them for notes/provenance, rather than
        # nesting the required case rows under an auxiliary key.
        startup[host]["restarts"] = {
            **per_case,
            **phase_row(all_restarts, all_attempts),
        }

    memory: dict[str, Any] = {"observations": {"starts": starts, "snapshots": snapshots, "windowSeconds": "30–40"}, "cases": {}}
    for host in ("linux", "macos"):
        memory["cases"][host] = {}
        for case in MEMORY_CASES:
            bucket = memory_values.get((host, case), {"rss": [], "pss": []})
            metrics: dict[str, Any] = {"rssMiB": memory_metric(bucket["rss"], "rssMiB")}
            if host == "linux":
                metrics["pssMiB"] = memory_metric(bucket["pss"], "pssMiB")
            memory["cases"][host][case] = {"metrics": metrics}

    result_metadata = {
        "date": metadata.pop("date", date.today().isoformat()),
        "commit": commit,
        "legacyVersion": metadata.pop("legacyVersion", extract_legacy_version(campaign)),
        "environment": metadata.pop("environment", "macOS ARM64 host + Ubuntu 22.04 ARM64 VM; runtime versions are recorded in run state"),
        "sourceProvenance": metadata.pop("sourceProvenance", ["benchmark-data.json"]),
        "legacyImages": metadata.pop("legacyImages", {case: sorted(images) for case, images in legacy_image_sets.items()}),
        **metadata,
    }
    return {
        "metadata": result_metadata,
        "startup": startup,
        "processMemory": memory,
        "observations": {
            "startup": startup_observations,
            "restarts": restart_observations,
            "memory": memory_observations,
        },
        "setupFailures": setup_failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("campaign", type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    data = aggregate(args.campaign, commit=args.commit)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
