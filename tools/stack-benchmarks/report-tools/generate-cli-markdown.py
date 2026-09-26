#!/usr/bin/env python3
"""Generate the benchmark index, narrative pages, and methodology notes from report-data.json."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

FORMAT = "supabase-cli-benchmark-report-data-v1"
STACK_CHARTS = ("cached-default", "cached-eager", "cold-startup", "payload-size", "memory-default-rss", "memory-eager-rss")
SCHEMA_CHARTS = ("db-diff", "declarative-loop")


def load(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("format") != FORMAT:
        raise ValueError(f"unsupported report data format: {data.get('format')!r}")
    return data


def stats(value: dict[str, Any] | None, divisor: float = 1, digits: int = 2, unit: str = "") -> str:
    if not value or value.get("median") is None:
        return "—"
    med, low, high = (value[k] / divisor for k in ("median", "min", "max"))
    count = value.get("count", 0)
    suffix = f" {unit}" if unit else ""
    return f"{med:.{digits}f} ({low:.{digits}f}–{high:.{digits}f}; n={count}){suffix}"


def median(value: dict[str, Any] | None) -> float | None:
    return value.get("median") if value else None


def group_label(group: dict[str, Any]) -> str:
    mode = {"default": "default", "eager": "eager", "eager-pooler": "eager + pooler"}.get(group.get("mode"), str(group.get("mode")))
    return f"{group.get('implementation', 'unknown')} · {group.get('runtime', 'unknown')} · {mode} · {group.get('platform', 'unknown')}"


def stack_lookup(data: dict[str, Any], implementation: str, runtime: str, mode: str, platform: str = "linux-x64") -> dict[str, Any] | None:
    return next((row for row in data["stack"] if (row.get("implementation"), row.get("runtime"), row.get("mode"), row.get("platform")) == (implementation, runtime, mode, platform)), None)


def chart(name: str, alt: str) -> str:
    return f"![{alt}](assets/{name}.png)\n"


def campaign_text(data: dict[str, Any]) -> str:
    c = data["campaign"]
    return (f"The report combines {c.get('observed_groups', 0)} observed groups and {c.get('observed_samples', 0)} samples: "
            f"{c.get('new_samples', 0)} new CLI samples, {c.get('legacy_run_samples', 0)} legacy stack samples, and "
            f"{c.get('reused_legacy_schema_samples', 0)} reused legacy schema samples. Expected coverage is "
            f"{c.get('expected_groups', 0)} groups × {c.get('expected_samples_per_group', 0)} samples. "
            f"{len(data.get('missing_groups', []))} missing or incomplete group entries are recorded.")


def source_line(data: dict[str, Any]) -> str:
    sha = data.get("source_sha", "unavailable")
    run = data.get("run_id", "unavailable")
    harness = data.get("harness_sha", "unavailable")
    return (f"The new CLI source is [`{sha[:12]}`](https://github.com/supabase/cli/commit/{sha}). "
            f"Its benchmark workflow is [run {run}](https://github.com/supabase/cli/actions/runs/{run}) "
            f"(head `{harness}`). Separate sources are listed in [shared benchmark notes](../BENCHMARK_NOTES.md).")


def stack_page(data: dict[str, Any], output: Path) -> str:
    lines = ["# Local stack benchmarks", "", "**Benchmark results · September 26, 2026 · PR 6831**", "", "## Observed outcomes", ""]
    legacy_default = stack_lookup(data, "legacy", "docker", "default")
    for runtime in ("docker", "native"):
        new = stack_lookup(data, "new", runtime, "default")
        old_ms, new_ms = median((legacy_default or {}).get("cached_ready_ms")), median((new or {}).get("cached_ready_ms"))
        if old_ms is not None and new_ms not in (None, 0):
            lines.append(f"- Cached default readiness: new {runtime} reached database-ready in {new_ms/1000:.2f} s; legacy Docker reached full-stack-ready in {old_ms/1000:.2f} s ({old_ms/new_ms:.2f}× observed-time ratio).")
    eager_old = stack_lookup(data, "legacy", "docker", "default")
    for runtime in ("docker", "native"):
        new = stack_lookup(data, "new", runtime, "eager")
        old_ms, new_ms = median((eager_old or {}).get("cached_ready_ms")), median((new or {}).get("cached_ready_ms"))
        if old_ms is not None and new_ms not in (None, 0):
            lines.append(f"- Cached eager readiness: new {runtime} {new_ms/1000:.2f} s; legacy Docker default {old_ms/1000:.2f} s ({old_ms/new_ms:.2f}× observed-time ratio).")
    rss_values = []
    for impl, runtime, mode in (("new", "docker", "eager"), ("new", "native", "eager"), ("new", "docker", "eager-pooler"), ("new", "native", "eager-pooler"), ("legacy", "docker", "default"), ("legacy", "docker", "eager-pooler")):
        row = stack_lookup(data, impl, runtime, mode)
        value = median((row or {}).get("idle_rss", {}).get("rss_mib"))
        if value is not None: rss_values.append(value)
    eager_old = stack_lookup(data, "legacy", "docker", "default")
    pooler_old = stack_lookup(data, "legacy", "docker", "eager-pooler")
    comparisons = []
    for runtime in ("docker", "native"):
        eager = stack_lookup(data, "new", runtime, "eager")
        pooler = stack_lookup(data, "new", runtime, "eager-pooler")
        if eager and eager_old and median(eager["idle_rss"]["rss_mib"]) is not None and median(eager_old["idle_rss"]["rss_mib"]) is not None:
            comparisons.append(f"{runtime} no-pooler {median(eager['idle_rss']['rss_mib']):.0f} vs {median(eager_old['idle_rss']['rss_mib']):.0f} MiB")
        if pooler and pooler_old and median(pooler["idle_rss"]["rss_mib"]) is not None and median(pooler_old["idle_rss"]["rss_mib"]) is not None:
            comparisons.append(f"{runtime} pooler {median(pooler['idle_rss']['rss_mib']):.0f} vs {median(pooler_old['idle_rss']['rss_mib']):.0f} MiB")
    if comparisons:
        lines.append("- Idle RSS comparisons are mixed across pooler modes: " + "; ".join(comparisons) + ". Docker sums host and container process RSS and may double count shared pages.")
    lines += ["", "Default readiness ends when the database is ready while other enabled services prepare in the background. Eager modes wait for selected services; legacy readiness waits for its configured stack. These endpoints and service sets differ, so readiness ratios describe observed wait rather than equal work.", "",
              "## Cached readiness and retained-data restart", "", chart("cached-default", "Cached default readiness; new Docker and native are compared with legacy Docker on Linux."),
              chart("cached-eager", "Cached eager readiness, with and without pooler."), "",
              "Times are medians with observed ranges and sample counts. Retained restart uses the cached-fresh-project restart measurement.", "",
              "| Linux x64 configuration | Cached ready | Retained-data restart |", "|---|---:|---:|"]
    linux_stack = [r for r in data["stack"] if r.get("platform") == "linux-x64"]
    mode_order = {"default": 0, "eager": 1, "eager-pooler": 2}
    impl_order = {"new": 0, "legacy": 1}
    for row in sorted(linux_stack, key=lambda r: (impl_order.get(r["implementation"], 9), mode_order.get(r["mode"], 9), r["runtime"])):
        label = f"{row['implementation'].title()} · {row['runtime'].title()} · {row['mode'].replace('-', ' + ')}"
        lines.append(f"| {label} | {stats(row['cached_ready_ms'], 1000, 2, 's')} | {stats(row['cached_retained_restart_ms'], 1000, 2, 's')} |")
    lines += ["", "## First startup", "", chart("cold-startup", "Cold startup readiness; cache preparation and service readiness are part of the measured operation."),
              "Cold startup includes downloads, extraction, and fresh database initialization. Preparation is a separate timer and must not be added to cold readiness.", "",
              "| Linux x64 configuration | Cold ready | Preparation |", "|---|---:|---:|"]
    for row in sorted(linux_stack, key=lambda r: (impl_order.get(r["implementation"], 9), mode_order.get(r["mode"], 9), r["runtime"])):
        label = f"{row['implementation'].title()} · {row['runtime'].title()} · {row['mode'].replace('-', ' + ')}"
        lines.append(f"| {label} | {stats(row['cold_ready_ms'], 1000, 2, 's')} | {stats(row['preparation_ms'], 1000, 2, 's')} ({row['preparation_measurement']}) |")
    lines += ["", "## Payload estimates", "", chart("payload-size", "Metadata-derived compressed payload size estimates."),
              "Payload sizes come from artifact and image registry metadata. They are not measured network transfer bytes.", "",
              "| Configuration | Compressed payload | Samples with estimate |", "|---|---:|---:|"]
    for row in sorted(data["stack"], key=lambda r: (impl_order.get(r["implementation"], 9), r["platform"], mode_order.get(r["mode"], 9), r["runtime"])):
        size = (row.get("payload") or {}).get("compressed_payload_bytes", {})
        amount = median(size)
        rendered = "—" if amount is None else f"{amount / 1_000_000:.1f} MB"
        lines.append(f"| {group_label(row)} | {rendered} | {size.get('count', 0)} |")
    lines += ["", "## Idle resident memory", "", chart("memory-default-rss", "Default-mode idle process RSS."), chart("memory-eager-rss", "Eager-mode idle process RSS."),
              "Native RSS is host process RSS. Docker RSS adds host and container process RSS per sample; shared pages may be counted twice, so the sum is not physical memory. RSS is sampled during idle windows. CPU utilization and peak RSS were not collected.", "",
              "| Configuration | Idle RSS | Measurement |", "|---|---:|---|"]
    for row in sorted(data["stack"], key=lambda r: (impl_order.get(r["implementation"], 9), r["platform"], mode_order.get(r["mode"], 9), r["runtime"])):
        lines.append(f"| {group_label(row)} | {stats(row['idle_rss']['rss_mib'],1,1,'MiB')} | {row['idle_rss']['measurement']} |")
    mac = [r for r in data["stack"] if r.get("platform") == "macos-arm64"]
    if mac:
        lines += ["", "## macOS arm64", "", "These are new native measurements; there is no legacy macOS or Docker comparison.", "",
                  "| Mode | Cached ready | Cold ready | Retained restart | Idle RSS |", "|---|---:|---:|---:|---:|"]
        for row in sorted(mac, key=lambda r: mode_order.get(r["mode"], 9)):
            lines.append(f"| {row['mode'].replace('-', ' + ')} | {stats(row['cached_ready_ms'],1000,2,'s')} | {stats(row['cold_ready_ms'],1000,2,'s')} | {stats(row['cached_retained_restart_ms'],1000,2,'s')} | {stats(row['idle_rss']['rss_mib'],1,1,'MiB')} |")
    lines += ["", "## Commands", "", "The new stack benchmark enabled `[experimental] stack = true`. It used `supabase start` for default mode, `supabase start --runtime docker` for Docker, and added `--eager` for eager startup. Pooler cases enabled `[db.pooler]`. The legacy baseline used released CLI 2.117.0 with `supabase start`. Compilation is excluded.", "",
              "## Failures, coverage, and provenance", "", campaign_text(data)]
    if data.get("missing_groups"):
        lines.append("Missing or incomplete groups: " + "; ".join(data["missing_groups"]) + ".")
    lines += ["", source_line(data), "", "The new eager configuration selected 11 services while legacy default starts 12 containers. Their service sets, versions, and architecture differ. Linux comparisons use a legacy baseline collected in a separate run; heterogeneous runners prevent causal attribution."]
    cache = data.get("native_cache_digest_consistency", {})
    if cache:
        lines.append(f"Native artifact metadata digest check: {cache['native_sample_count']}/{cache['expected_native_sample_count']} samples, {cache['artifact_service_platform_count']} service/platform pairs, consistent={str(cache['consistent']).lower()}, {len(cache['inconsistencies'])} mismatches.")
    lines += ["", "See the [schema benchmark report](../schema/README.md) and [shared benchmark notes](../BENCHMARK_NOTES.md).", ""]
    return "\n".join(lines)


def schema_page(data: dict[str, Any], output: Path) -> str:
    def command_row(implementation: str, runtime: str, label: str) -> dict[str, Any] | None:
        matches = [r for r in data["schema_commands"] if r["implementation"] == implementation and r["runtime"] == runtime
                   and r["label"] == label and str(r["platform"]).startswith("Linux-")]
        return matches[0] if len(matches) == 1 else None

    def median_ms(implementation: str, runtime: str, label: str) -> float | None:
        row = command_row(implementation, runtime, label)
        return median(row.get("duration_ms")) if row else None

    lines = ["# Database schema benchmarks", "", "**Benchmark results · September 26, 2026 · PR 6831**", "",
             "## Observed outcomes", ""]
    for size in ("small", "large"):
        label = f"{size}.db-diff.changed"
        old, docker, native = (median_ms(impl, runtime, label) for impl, runtime in (("legacy", "docker"), ("new", "docker"), ("new", "native")))
        if old is not None and docker is not None and native is not None:
            lines.append(f"- Changed diff · {size}: legacy Docker {old/1000:.2f} s, new Docker {docker/1000:.2f} s, new native {native/1000:.2f} s. Observed Linux ratios: {old/docker:.2f}× Docker, {old/native:.2f}× native.")
    for size in ("small", "large"):
        label = f"{size}.db-diff.no-change.repeat"
        old, docker, native = (median_ms(impl, runtime, label) for impl, runtime in (("legacy", "docker"), ("new", "docker"), ("new", "native")))
        if old is not None and docker is not None and native is not None:
            lines.append(f"- Repeated no-change diff · {size}: legacy Docker {old/1000:.2f} s, new Docker {docker/1000:.2f} s, new native {native/1000:.2f} s.")
    lines += ["", "These are median observed timings from separate runs and heterogeneous runners. The ratios do not establish causal speedups.", "",
              "## Database diff", "", chart("db-diff", "Changed database diff timings by schema size and runtime."),
              "## Linux changed and repeated no-change diffs", "",
              "Times are median (min–max; sample count). Changed and repeat-no-change are separate operations.", "",
              "| Operation | Size | Legacy Docker | New Docker | New native | Docker ratio | Native ratio |", "|---|---|---:|---:|---:|---:|---:|"]
    for operation, label_tail in (("Changed diff", "changed"), ("Repeat no-change diff", "no-change.repeat")):
        for size in ("small", "large"):
            label = f"{size}.db-diff.{label_tail}"
            old_row, docker_row, native_row = (command_row(impl, runtime, label) for impl, runtime in (("legacy", "docker"), ("new", "docker"), ("new", "native")))
            old, docker, native = (median(row.get("duration_ms")) if row else None for row in (old_row, docker_row, native_row))
            def ratio(value: float | None) -> str:
                return "—" if old in (None, 0) or value in (None, 0) else f"{old/value:.2f}×"
            lines.append(f"| {operation} | {size} | {stats(old_row.get('duration_ms') if old_row else None,1000,2,'s')} | {stats(docker_row.get('duration_ms') if docker_row else None,1000,2,'s')} | {stats(native_row.get('duration_ms') if native_row else None,1000,2,'s')} | {ratio(docker)} | {ratio(native)} |")
    lines += ["", "## Declarative schema workflow", "", chart("declarative-loop", "Repeated declarative no-change check timings."),
              "The chart shows the repeated no-change declarative command after its first check. The scenario table below compares complete validated change cycles.", "",
              "| Environment | Scenario | Successful | Failed | Total duration | Validation checks (pass/fail) |", "|---|---|---:|---:|---:|---:|"]
    cycle_rows = []
    for group in data["schema"]:
        key = group["group"]
        platform = "macOS arm64" if str(key.get("platform", "")).lower().startswith("mac") else "Linux"
        for scenario, cycle in group.get("declarative_cycles", {}).items():
            checks = {"passed": 0, "failed": 0}
            for sample in cycle.get("samples", []):
                for result in sample.get("validation", []):
                    checks["passed" if result.get("passed") is True else "failed"] += 1
            cycle_rows.append((key, platform, scenario, cycle, checks))
    cycle_rows.sort(key=lambda item: (item[0].get("implementation", ""), item[1], item[0].get("runtime", ""), item[2]))
    for key, platform, scenario, cycle, checks in cycle_rows:
        lines.append(f"| {key.get('implementation','').title()} · {key.get('runtime','').title()} · {platform} | {scenario} | {cycle.get('successful',0)}/{cycle.get('attempts',0)} | {cycle.get('failed',0)} | {stats(cycle.get('successful_total_duration_ms_per_sample'),1000,2,'s')} | {checks['passed']}/{checks['failed']} |")
    lines += ["", "## Semantic correctness", "", "| Environment | Passed | Failed | Unverified | Unavailable |", "|---|---:|---:|---:|---:|"]
    for group in data["schema"]:
        key, counts = group["group"], group.get("correctness", {}).get("counts", {})
        platform = "macOS arm64" if str(key.get("platform", "")).lower().startswith("mac") else "Linux"
        lines.append(f"| {key.get('implementation','').title()} · {key.get('runtime','').title()} · {platform} | {counts.get('passed',0)} | {counts.get('failed',0)} | {counts.get('unverified',0)} | {counts.get('unavailable',0)} |")
    lines += ["", "Catalog/convergence checks, seed state, and reset behavior are represented when present in the harness. The summarizer's `unverified` category can include exit-zero commands without a matching semantic assertion; it is distinct from a failed assertion.", "",
              "## Workload and commands", "",
              "The small fixture contains the benchmark table; the large fixture adds 100 tables (101 total). Both use a database-only local stack with non-database services excluded. New cycles use `supabase --experimental db schema declarative sync --name <scenario> --apply`. Legacy cycles use `supabase db diff --local -f <scenario>` followed by `supabase migration up --local`. Compilation is excluded.", "",
              "Full command timings and ranges for changed/no-change diffs, declarative first/repeat/no-cache checks, generated cycles, apply/reset, and seed reset are in [measurements.md](../../measurements.md).",
              "", "## Coverage and provenance", "", campaign_text(data), "", source_line(data),
              "", "Legacy schema results are reused from their own run. New schema measurements are from the current run. There are no legacy native, legacy macOS, or macOS Docker measurements.",
              "", "See the [stack startup report](../stack/README.md) and [shared benchmark notes](../BENCHMARK_NOTES.md).", ""]
    return "\n".join(lines)


def notes_page(data: dict[str, Any]) -> str:
    runs = data.get("runs", [])
    lines = ["# Benchmark notes", "", "These notes describe the sources, measurement boundaries, and limits for the [stack report](stack/README.md) and [schema report](schema/README.md).", "",
             "**Benchmark results · September 26, 2026 · PR 6831**", "",
             "## Campaign and source runs", "", campaign_text(data), "", "| Measurement source | Workflow run | Workflow head | Workflow build/source SHA |", "|---|---:|---|---|"]
    for run in runs:
        lines.append(f"| {run['name']} | [{run['id']}]({run['url']}) | `{run.get('workflow_head_sha','unavailable')}` | `{run.get('source_sha','unavailable')}` |")
    lines += ["", f"The new CLI source is [`{data.get('source_sha','unavailable')}`](https://github.com/supabase/cli/commit/{data.get('source_sha','unavailable')}); harness/workflow head `{data.get('harness_sha','unavailable')}`. For legacy rows, this SHA identifies workflow build/source provenance; the measured executable remains CLI 2.117.0. Each included group's raw provenance is retained in [report-data.json](../report-data.json).", "",
              "## Stack startup measurements", "",
              "New default readiness ends when the database is ready, while other enabled services can prepare in the background. Eager modes wait for selected services. In these measurements, new eager selects 11 services while legacy default starts 12 containers. Legacy readiness waits for its full configured stack. Service sets, versions, and architecture differ; readiness times do not represent equal work.", "",
              "Preparation is a separate timer and must not be added to cold startup. Legacy image-pull replay is not the CLI scheduler. macOS has new native measurements only; there is no legacy macOS or Docker comparison. Linux comparisons reuse a separately collected legacy baseline, so heterogeneous runner CPUs prevent causal attribution.", "",
              "## Schema measurements and correctness", "",
              "Schema measurements use database-only environments. Declarative scenario cycle times include the harness-recorded generate/apply operations; legacy generation and application can be separate commands. Command completion and semantic validation are recorded separately. A successful command exit alone is not proof that the expected catalog state, no-change behavior, seed state, or reset state is correct. The summarizer's `unverified` category can include commands that exited zero without a corresponding semantic assertion; it is distinct from a failed assertion.", "",
              "## Memory and payload", "",
              "Native RSS reports host process RSS. Docker RSS adds host RSS and container process RSS for each sample; shared pages may be counted twice, so the sum is not physical memory. RSS is sampled in idle windows, not continuously. CPU utilization and peak RSS were not collected for stack startup.", "",
              "Compressed payload estimates are derived from artifact and image metadata, not wire transfer measurements. Registry metadata does not measure retries, protocol overhead, or actual bytes transferred.", "",
              "## Coverage and failures", ""]
    if data.get("missing_groups"):
        lines.append("Missing or incomplete coverage is recorded: " + "; ".join(data["missing_groups"]) + ".")
    else:
        lines.append("The report-data builder found no missing or incomplete expected groups.")
    failed_commands = sum(row.get("failed", 0) or 0 for row in data.get("schema_commands", []))
    failed_stack_phases = sum(phase.get("failed", 0) for group in data.get("groups", []) for phase in group.get("phases", {}).values())
    failed_cycles = sum(cycle.get("failed", 0) for group in data.get("schema", []) for cycle in group.get("declarative_cycles", {}).values())
    failed_correctness = sum(group.get("correctness", {}).get("counts", {}).get("failed", 0) for group in data.get("schema", []))
    lines.append(f"Recorded failures: {failed_stack_phases} stack phase attempts, {failed_commands} schema command attempts, {failed_cycles} declarative cycles, and {failed_correctness} semantic checks. Per-group attempt counts and failure details are in [report-data.json](../report-data.json).")
    if not data.get("missing_groups") and not any((failed_stack_phases, failed_commands, failed_cycles, failed_correctness)):
        lines.append("No missing groups or failures were recorded in these inputs.")
    cache = data.get("native_cache_digest_consistency", {})
    if cache:
        lines += ["", f"Native cached artifact metadata digest check: {cache.get('native_sample_count',0)}/{cache.get('expected_native_sample_count',0)} samples observed; {cache.get('artifact_service_platform_count',0)} service/platform pairs; consistent={str(cache.get('consistent',False)).lower()}; mismatches={len(cache.get('inconsistencies',[]))}; missing digest metadata={len(cache.get('missing_digests',[]))}."]
    lines += ["", "## Data and audit", "", "The [measurement tables](../measurements.md) provide the aggregate view. The [report dataset](../report-data.json) contains group-level metrics and provenance; the [audit](../audit.json) records raw status, readiness, cleanup, and image identity checks. Chart assets are under [stack/assets](stack/assets/) and [schema/assets](schema/assets/).", ""]
    return "\n".join(lines)


def index_page(data: dict[str, Any]) -> str:
    return (f"# CLI benchmarks · September 26, 2026 · PR 6831\n\n{campaign_text(data)}\n\n"
            f"New CLI source [`{data.get('source_sha','unavailable')[:12]}`](https://github.com/supabase/cli/commit/{data.get('source_sha','unavailable')}) · "
            f"workflow [run {data.get('run_id','unavailable')}](https://github.com/supabase/cli/actions/runs/{data.get('run_id','unavailable')}).\n\n"
            "- [Local stack startup and memory](stack/README.md)\n- [Database diff and declarative schema workflows](schema/README.md)\n- [Shared methodology, provenance, and limitations](BENCHMARK_NOTES.md)\n- [Measurement tables](../measurements.md)\n- [Report data and group-level provenance](../report-data.json)\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True, help="report-data.json")
    parser.add_argument("--output", type=Path, required=True, help="report directory already containing rendered chart assets")
    args = parser.parse_args()
    data = load(args.data)
    args.output.mkdir(parents=True, exist_ok=True)
    outputs = {"README.md": index_page(data), "stack/README.md": stack_page(data, args.output),
               "schema/README.md": schema_page(data, args.output), "BENCHMARK_NOTES.md": notes_page(data)}
    referenced = [*(args.output / "stack/assets" / f"{name}.png" for name in STACK_CHARTS),
                  *(args.output / "schema/assets" / f"{name}.png" for name in SCHEMA_CHARTS)]
    missing = [str(path) for path in referenced if not path.is_file()]
    if missing:
        raise SystemExit("render chart assets before generating Markdown; missing: " + ", ".join(missing))
    for relative, body in outputs.items():
        target = args.output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
    print("Generated report Markdown: " + ", ".join(str(args.output / path) for path in outputs))


if __name__ == "__main__":
    main()
