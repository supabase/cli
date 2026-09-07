#!/usr/bin/env python3
"""Render the six benchmark cards from the fresh campaign schema.

The SVG/PNG primitives and card layout are imported from the original renderers
in ``original/``.  This module only adapts the stable measurement schema.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
ORIGINAL = ROOT / "original"

def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

charts = _load("benchmark_original_charts", ORIGINAL / "charts.py")
sys.modules["charts"] = charts
memory = _load("benchmark_original_memory", ORIGINAL / "memory-charts.py")

REQUIRED_STARTUP = ("legacy", "legacyEager", "dockerDefault", "dockerEager", "nativeDefault", "nativeEager")
REQUIRED_MEMORY = ("legacy-default", "legacy-pooler", "docker-default", "native-default", "docker-eager", "native-eager")

def number(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{path} must be numeric")
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{path} must be a positive finite number")
    return result

def validate(data: dict[str, Any]) -> None:
    """Reject incomplete campaigns so no chart can contain invented values."""
    for platform in ("linux", "macos"):
        p = data.get("startup", {}).get(platform)
        if not isinstance(p, dict):
            raise ValueError(f"startup.{platform} is required")
        for case in REQUIRED_STARTUP:
            if case not in p:
                raise ValueError(f"startup.{platform}.{case} is required")
            for phase in ("cached", "cold"):
                if phase not in p[case] or "medianSeconds" not in p[case][phase]:
                    raise ValueError(f"startup.{platform}.{case}.{phase}.medianSeconds is required")
                number(p[case][phase]["medianSeconds"], f"startup.{platform}.{case}.{phase}.medianSeconds")
                for count_key in ("attempts", "successes", "failures"):
                    count = p[case][phase].get(count_key)
                    if not isinstance(count, int) or count < 0:
                        raise ValueError(f"startup.{platform}.{case}.{phase}.{count_key} must be a nonnegative integer")
        if "restarts" not in p or not isinstance(p["restarts"], dict):
            raise ValueError(f"startup.{platform}.restarts is required")
        for case in REQUIRED_STARTUP:
            x = p["restarts"].get(case)
            if not isinstance(x, dict) or "medianSeconds" not in x:
                raise ValueError(f"startup.{platform}.restarts.{case}.medianSeconds is required")
            number(x["medianSeconds"], f"startup.{platform}.restarts.{case}.medianSeconds")
            for key in ("attempts", "successes", "failures"):
                if not isinstance(x.get(key), int) or x[key] < 0:
                    raise ValueError(f"startup.{platform}.restarts.{case}.{key} must be a nonnegative integer")
    cases = data.get("processMemory", {}).get("cases")
    if not isinstance(cases, dict):
        raise ValueError("processMemory.cases is required")
    for platform in ("linux", "macos"):
        for case in REQUIRED_MEMORY:
            metrics = cases.get(platform, {}).get(case, {}).get("metrics")
            if not isinstance(metrics, dict) or "rssMiB" not in metrics:
                raise ValueError(f"processMemory.cases.{platform}.{case}.metrics.rssMiB is required")
            rss = metrics["rssMiB"]
            if not isinstance(rss, dict) or "median" not in rss:
                raise ValueError(f"processMemory.cases.{platform}.{case}.metrics.rssMiB.median is required")
            number(rss["median"], f"processMemory.cases.{platform}.{case}.metrics.rssMiB.median")
            if platform == "linux" and "pssMiB" not in metrics:
                raise ValueError(f"processMemory.cases.linux.{case}.metrics.pssMiB is required")
            if platform == "linux":
                pss = metrics["pssMiB"]
                if not isinstance(pss, dict) or "median" not in pss:
                    raise ValueError(f"processMemory.cases.linux.{case}.metrics.pssMiB.median is required")
    observations = data.get("processMemory", {}).get("observations")
    if not isinstance(observations, dict):
        raise ValueError("processMemory.observations is required")
    for key in ("starts", "snapshots"):
        number(observations.get(key), f"processMemory.observations.{key}")
    if "windowSeconds" not in observations:
        raise ValueError("processMemory.observations.windowSeconds is required")

def render(data: dict[str, Any], output: Path) -> None:
    validate(data)
    output.mkdir(parents=True, exist_ok=True)
    charts.OUT = output
    charts.ASSETS = output / "assets"
    memory.OUT = output
    memory.ASSETS = charts.ASSETS
    memory.D = data["processMemory"]
    memory.REPORT = data["processMemory"]["observations"]
    memory.write_chart = charts.write_chart
    s = data["startup"]
    def sample_label(phase: str) -> str:
        counts = [s[host][case][phase]["attempts"] for host in ("linux", "macos") for case in REQUIRED_STARTUP]
        return f"n={counts[0]}" if len(set(counts)) == 1 else f"n={min(counts)}–{max(counts)}"
    def groups(mode: str, phase: str, readiness: str) -> list[dict[str, Any]]:
        baseline = "legacy" if mode == "Default" else "legacyEager"
        return [charts.row("Ubuntu · Docker", s["linux"][baseline][phase]["medianSeconds"], s["linux"]["docker" + mode][phase]["medianSeconds"], readiness), charts.row("macOS · Docker", s["macos"][baseline][phase]["medianSeconds"], s["macos"]["docker" + mode][phase]["medianSeconds"], readiness), charts.row("Ubuntu · native", s["linux"][baseline][phase]["medianSeconds"], s["linux"]["native" + mode][phase]["medianSeconds"], readiness), charts.row("macOS · native", s["macos"][baseline][phase]["medianSeconds"], s["macos"]["native" + mode][phase]["medianSeconds"], readiness)]
    default_groups, eager_groups = groups("Default", "cached", "database ready"), groups("Eager", "cached", "all services ready")
    max_default, max_eager = max(g["ratio"] for g in default_groups), max(g["ratio"] for g in eager_groups)
    cold = [charts.row("Docker · default", s["linux"]["legacy"]["cold"]["medianSeconds"], s["linux"]["dockerDefault"]["cold"]["medianSeconds"], "database ready"), charts.row("native · default", s["linux"]["legacy"]["cold"]["medianSeconds"], s["linux"]["nativeDefault"]["cold"]["medianSeconds"], "database ready"), charts.row("Docker · eager", s["linux"]["legacyEager"]["cold"]["medianSeconds"], s["linux"]["dockerEager"]["cold"]["medianSeconds"], "all services ready"), charts.row("native · eager", s["linux"]["legacyEager"]["cold"]["medianSeconds"], s["linux"]["nativeEager"]["cold"]["medianSeconds"], "all services ready")]
    legacy_cold, docker_eager_cold = cold[2]["old"], cold[2]["new"]
    charts.card("cached-default", "LOCAL STACK · DEFAULT MODE · CACHED STARTUP", f"up to {max_default:.1f}× faster starts", "Database ready sooner; remaining services prepare in background and start on demand.", default_groups, ["Higher = faster · current CLI baseline → new database readiness", f"Cached fresh projects · {sample_label('cached')} medians"], "Cached Supabase local stack startup comparison.")
    charts.card("cached-eager", "LOCAL STACK · EAGER MODE · CACHED STARTUP", f"up to {max_eager:.1f}× faster full starts", "All enabled services ready.", eager_groups, ["Higher = faster · pooler-enabled current CLI baseline → new full startup", f"Cached fresh projects · {sample_label('cached')} medians"], "Cached Supabase local stack full startup comparison.")
    reduction = 100 * (1 - docker_eager_cold / legacy_cold)
    cold_subtitle = f"Docker eager: {reduction:.0f}% less waiting, downloads + extraction included." if reduction >= 0 else f"Docker eager: {abs(reduction):.0f}% more waiting, downloads + extraction included."
    cold_successes = sum(s["linux"][case]["cold"]["successes"] for case in REQUIRED_STARTUP)
    cold_attempts = sum(s["linux"][case]["cold"]["attempts"] for case in REQUIRED_STARTUP)
    charts.card("cold-startup", "UBUNTU 22.04 · COLD STARTUP", f"{legacy_cold:.0f}s → {docker_eager_cold:.0f}s for full startup", cold_subtitle, cold, ["Higher = faster · default baseline: current CLI · eager baseline: current CLI + pooler", f"{cold_successes}/{cold_attempts} successful cold observations · default: database ready · eager: all enabled services ready"], "Cold Supabase local stack startup comparison.")
    memory.paired("default")
    memory.paired("eager")
    memory.pss()

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", type=Path, help="fresh campaign JSON matching SCHEMA.md")
    parser.add_argument("--output", type=Path, default=ROOT.parent / "report-draft")
    args = parser.parse_args()
    render(json.loads(args.data.read_text()), args.output)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
