#!/usr/bin/env python3
"""Build the complete benchmark report and six original-style chart cards."""
from __future__ import annotations
import argparse, json, shutil, sys
from pathlib import Path
from statistics import median
from typing import Any

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import render

def fsec(x: float) -> str: return f"{x:.1f}s"
def pct(x: float) -> str: return f"{x:.0f}%"
CASE_LABELS = {
    "legacy": "Current CLI · Docker",
    "legacyEager": "Current CLI + pooler · Docker",
    "dockerDefault": "New default · Docker",
    "dockerEager": "New eager · Docker",
    "nativeDefault": "New default · native",
    "nativeEager": "New eager · native",
    "legacy-default": "Current CLI · Docker",
    "legacy-pooler": "Current CLI + pooler · Docker",
    "docker-default": "New default · Docker",
    "native-default": "New default · native",
    "docker-eager": "New eager · Docker",
    "native-eager": "New eager · native",
}
HOST_LABELS = {"linux": "Ubuntu 22.04", "macos": "macOS"}


def fmt_range(value: Any, unit: str = "") -> str:
    if isinstance(value, (list, tuple)) and len(value) == 2 and all(isinstance(item, (int, float)) for item in value):
        return f"{float(value[0]):.3f}–{float(value[1]):.3f}{unit}"
    return "—"


def label_case(case: str) -> str:
    return CASE_LABELS.get(case, case)


def short_digest(value: Any) -> str:
    text = str(value)
    return text[:19] + "…" if len(text) > 19 else text


def workload_provenance_lines(metadata: dict[str, Any]) -> list[str]:
    catalog = metadata.get("catalog")
    artifacts = catalog.get("artifacts") if isinstance(catalog, dict) else None
    lines = [
        "Public catalog provenance records the selected workload versions and identities; these are release metadata, not runtime measurements.",
        "",
        "| Workload | Version | Docker image digest | macOS archive SHA | Linux archive SHA |",
        "| --- | --- | --- | --- | --- |",
    ]
    if not isinstance(artifacts, list) or not artifacts:
        lines.append("| — | Catalog provenance not supplied | — | — | — |")
        return lines + ["", "Full release hashes are preserved in `benchmark-data.json` when catalog provenance is supplied."]
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        archives = artifact.get("archives") if isinstance(artifact.get("archives"), list) else []
        archive_hashes = {
            str(item.get("target")): short_digest(item.get("sha256"))
            for item in archives
            if isinstance(item, dict) and item.get("target") and item.get("sha256")
        }
        name = artifact.get("service") or artifact.get("id") or "unknown"
        lines.append(
            f"| {name} | {artifact.get('version', '—')} | {short_digest(artifact.get('imageDigest', '—'))} | "
            f"{archive_hashes.get('darwin-arm64', '—')} | {archive_hashes.get('linux-arm64', '—')} |"
        )
    lines += ["", "Full release hashes are preserved in `benchmark-data.json`; manifest runtime fields are not used as benchmark measurements."]
    return lines


def cold_native_artifact_lines(data: dict[str, Any]) -> list[str]:
    observations = data.get("observations", {}).get("startup", [])
    lines = [
        "## Cold native artifact preparation",
        "",
        "For cold native eager starts, this compares the measured start median with the first status poll where every artifact in the final measurement status was ready. The later interval is not assigned to any individual service; it describes a preparation-to-start performance gap and does not by itself confirm a defect.",
        "",
        "| Host | Start median | All artifacts observed ready | Observations |",
        "| --- | ---: | ---: | ---: |",
    ]
    for host in ("linux", "macos"):
        values = [
            row["artifactsPreparedObservedSeconds"]
            for row in observations
            if isinstance(row, dict)
            and row.get("platform") == host
            and row.get("mode") == "cold"
            and row.get("case") == "nativeEager"
            and row.get("success")
            and isinstance(row.get("artifactsPreparedObservedSeconds"), (int, float))
        ]
        start = data["startup"][host]["nativeEager"]["cold"]
        observed = f"{median(values):.2f}s" if values else "—"
        lines.append(f"| {HOST_LABELS[host]} | {start['medianSeconds']:.2f}s | {observed} | {len(values)}/{start['successes']} |")
    return lines


def legacy_image_lines(metadata: dict[str, Any]) -> list[str]:
    images = metadata.get("legacyImages")
    lines = [
        "Legacy image tags are collected from sanitized successful hot memory snapshots; container names, PIDs, configuration, and credentials are excluded.",
        "",
        "| Baseline | Observed image tags |",
        "| --- | --- |",
    ]
    if not isinstance(images, dict):
        return lines + ["| Current CLI | No sanitized image tags supplied |"]
    for case, label in (("legacy", "Current CLI"), ("legacy-pooler", "Current CLI + pooler")):
        values = images.get(case)
        tags = ", ".join(f"`{value}`" for value in values if isinstance(value, str)) if isinstance(values, list) else ""
        lines.append(f"| {label} | {tags or 'No sanitized image tags supplied'} |")
    return lines


def src_links(data: dict[str, Any]) -> str:
    p = data["metadata"]["sourceProvenance"]
    if isinstance(p, dict): p = list(p.values())
    return ", ".join(f"[{Path(str(x)).name}]({x})" for x in p)


def validate_metadata(data: dict[str, Any]) -> None:
    metadata = data.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("metadata is required")
    required = ("date", "commit", "legacyVersion", "pullRequest", "pullRequestUrl", "environment", "sourceProvenance")
    missing = [key for key in required if not metadata.get(key)]
    if missing:
        raise ValueError("required metadata is missing: " + ", ".join(missing))
    provenance = metadata["sourceProvenance"]
    if not isinstance(provenance, list) or not provenance:
        raise ValueError("metadata.sourceProvenance must contain at least one relative source")
    if any(not isinstance(source, str) or not source or Path(source).is_absolute() for source in provenance):
        raise ValueError("metadata.sourceProvenance entries must be relative paths")

def build_readme(d: dict[str, Any]) -> str:
    m, s, obs, cases = d["metadata"], d["startup"], d["processMemory"]["observations"], d["processMemory"]["cases"]
    linux=s["linux"]
    vals=lambda mode, runtimes=("docker","native"): [s[h]["legacy" if mode == "Default" else "legacyEager"]["cached"]["medianSeconds"]/s[h][r+mode]["cached"]["medianSeconds"] for h in ("linux","macos") for r in runtimes]
    default, eager, docker_default, docker_eager = vals("Default"), vals("Eager"), vals("Default", ("docker",)), vals("Eager", ("docker",))
    old,new=linux["legacyEager"]["cold"]["medianSeconds"],linux["dockerEager"]["cold"]["medianSeconds"]; red=100*(1-new/old)
    cold_claim=f"{pct(red)} less waiting" if red>=0 else f"{pct(abs(red))} more waiting"
    mac_legacy_cold = s["macos"]["legacyEager"]["cold"]
    mac_docker_eager_cold = s["macos"]["dockerEager"]["cold"]
    mac_native_eager_cold = s["macos"]["nativeEager"]["cold"]
    mac_cold_summary = (
        f"On macOS, cold eager startup measured {mac_legacy_cold['medianSeconds']:.1f}s for the pooler-enabled current CLI, "
        f"{mac_docker_eager_cold['medianSeconds']:.1f}s with the new Docker stack, and "
        f"{mac_native_eager_cold['medianSeconds']:.1f}s with the new native stack "
        f"({mac_legacy_cold['successes']}/{mac_legacy_cold['attempts']}, "
        f"{mac_docker_eager_cold['successes']}/{mac_docker_eager_cold['attempts']}, and "
        f"{mac_native_eager_cold['successes']}/{mac_native_eager_cold['attempts']} successful observations, respectively)."
    )
    def rss(h,c): return cases[h][c]["metrics"]["rssMiB"]["median"]
    dr=[100*(1-rss(h,c)/rss(h,"legacy-default")) for h,c in (("linux","docker-default"),("linux","native-default"),("macos","docker-default"),("macos","native-default"))]
    mem_head=f"{min(dr):.0f}–{max(dr):.0f}% lower default-mode process RSS" if min(dr)>=0 else "mixed default-mode process RSS results"
    def change_phrase(value: float) -> str:
        if value > 0:
            return f"{value:.1f}% higher"
        if value < 0:
            return f"{abs(value):.1f}% lower"
        return "no change"
    linux_pooler_pss = cases["linux"]["legacy-pooler"]["metrics"]["pssMiB"]["median"]
    linux_docker_eager_pss = cases["linux"]["docker-eager"]["metrics"]["pssMiB"]["median"]
    linux_native_eager_pss = cases["linux"]["native-eager"]["metrics"]["pssMiB"]["median"]
    mac_pooler_rss = rss("macos", "legacy-pooler")
    mac_docker_eager_rss = rss("macos", "docker-eager")
    mac_native_eager_rss = rss("macos", "native-eager")
    eager_memory_summary = (
        f"Against the pooler-enabled legacy baseline, eager Linux PSS was {change_phrase(100 * (linux_docker_eager_pss / linux_pooler_pss - 1))} for the new Docker stack and "
        f"{change_phrase(100 * (linux_native_eager_pss / linux_pooler_pss - 1))} for the new native stack. On macOS RSS, the corresponding results were "
        f"{change_phrase(100 * (mac_docker_eager_rss / mac_pooler_rss - 1))} for Docker and "
        f"{change_phrase(100 * (mac_native_eager_rss / mac_pooler_rss - 1))} for native."
    )
    def ct(p,k): return sum(s[h][c][p][k] for h in ("linux","macos") for c in render.REQUIRED_STARTUP)
    def table(mode):
        rows=[]
        for c,label in (("legacy","Current CLI · Docker"),("legacyEager","Current CLI + pooler · Docker"),("dockerDefault","New default · Docker"),("nativeDefault","New default · native"),("dockerEager","New eager · Docker"),("nativeEager","New eager · native")):
            baseline = "legacy" if c in ("legacy", "dockerDefault", "nativeDefault") else "legacyEager"
            rows.append(f"| {label} | {s['linux'][c]['cached']['medianSeconds']:.1f} s" + (" · baseline" if c==baseline else f" · **{s['linux'][baseline]['cached']['medianSeconds']/s['linux'][c]['cached']['medianSeconds']:.1f}×**") + f" | {s['macos'][c]['cached']['medianSeconds']:.1f} s" + (" · baseline" if c==baseline else f" · **{s['macos'][baseline]['cached']['medianSeconds']/s['macos'][c]['cached']['medianSeconds']:.1f}×**") + " |")
        return "\n".join(rows)
    def restart_sentence(case: str, label: str) -> str:
        linux_restart = s["linux"]["restarts"][case]
        mac_restart = s["macos"]["restarts"][case]
        return (
            f"{label} retained-data restarts had medians of {linux_restart['medianSeconds']:.2f}s on Ubuntu "
            f"({linux_restart['successes']}/{linux_restart['attempts']} successful) and "
            f"{mac_restart['medianSeconds']:.2f}s on macOS ({mac_restart['successes']}/{mac_restart['attempts']} successful)."
        )
    restart_summary = " ".join((
        restart_sentence("legacy", "The current CLI"),
        restart_sentence("legacyEager", "The pooler-enabled current CLI"),
        restart_sentence("nativeDefault", "The new native default"),
        restart_sentence("dockerDefault", "The new Docker default"),
        "The complete six-case, two-host restart table is in BENCHMARK_NOTES.md.",
    ))
    return f'''# New local stack: faster startup, less waiting

**Benchmark results · {m["date"]}**  
Proposed stack package ([PR #{m["pullRequest"]}]({m["pullRequestUrl"]})), commit `{m["commit"]}`, compared with the released Supabase CLI **{m["legacyVersion"]}**. The new stack was measured through its programmatic API, before CLI integration.

The measurements answer two practical questions: how quickly a working database becomes available, and how quickly the complete enabled service set starts when it is needed.

- **{min(docker_default):.1f}–{max(docker_default):.1f}× faster cached Docker default startup**, across Ubuntu and macOS.
- **{min(docker_eager):.1f}–{max(docker_eager):.1f}× faster cached Docker eager startup**, with all enabled services ready.
- **{fsec(old)} → {fsec(new)}** for the Ubuntu Docker eager cold run ({cold_claim}).
- **{mem_head}** across Docker/native and both platforms.

## What “ready” means

The new-stack timer covers the public `start()` call. The legacy timer covers process spawn through readiness exit. Creating the stack, importing packages, installing dependencies, and setting up the project are outside both timers.

**Default mode** starts the database and prepares the other enabled services in the background. Those services start when requested, so first-request activation latency is not measured. **Eager mode** starts all enabled services before returning. The released CLI defaults to 12 containers; enabling its pooler starts 13 and supplies the eager baseline. The new stack starts 11 workloads, while Kong and Vector remain separate legacy services, with release versions and artifact identities recorded in the notes. {m.get("artifactBarrier", "Artifact preparation and readiness semantics are recorded per case in the notes.")}

## Everyday startup: artifacts already downloaded

These runs use cached images or native artifacts and **fresh project data**. Each configuration targets three starts and its timing median uses successful starts; the matrix contains {ct("cached","successes")}/{ct("cached","attempts")} successful cached observations. Default bars use the current CLI baseline; eager bars use the pooler-enabled current CLI baseline. **Higher is faster.**

### Default mode: up to {max(default):.1f}× faster database readiness

![Default-mode cached startup](assets/cached-default.png)

### Eager mode: up to {max(eager):.1f}× faster full startup

![Eager-mode cached startup](assets/cached-eager.png)

| Configuration | Ubuntu 22.04 | macOS |
| --- | ---: | ---: |
{table('cached')}

The default-mode comparison measures database readiness while remaining services prepare in the background. Eager mode measures all enabled services ready. Ranges, exact counts, and failures are preserved in the benchmark notes.

## First startup: downloads included

Ubuntu cold runs began with empty artifact or Docker image stores. This includes downloads, extraction, and fresh database initialization. The campaign recorded **{ct("cold","successes")}/{ct("cold","attempts")} successful observations**; failed attempts remain visible in [BENCHMARK_NOTES.md](BENCHMARK_NOTES.md).

![Cold startup on Ubuntu](assets/cold-startup.png)

For Docker eager startup, **{fsec(old)} → {fsec(new)}** means **{cold_claim}** against the pooler-enabled current CLI. Default and native cases use their declared readiness semantics; background preparation and any reliability failures are reported separately.

{mac_cold_summary}

## Retained-data restarts

{restart_summary}

## Memory: now measured against the current CLI

The memory campaign covers **{obs['starts']} starts and {obs['snapshots']} snapshots**, settled at **{obs['windowSeconds']} seconds after readiness and preparation**. These are observations, not peak memory or application-load measurements. Figures include new-stack service processes, Supervisor, and helpers; Docker engine and VM are excluded.

### Default mode: {mem_head}

![Default process RSS compared with the current CLI](assets/memory-default-rss.png)

| Configuration | Ubuntu RSS | macOS RSS | Ubuntu PSS |
| --- | ---: | ---: | ---: |
| Current CLI · Docker | {rss('linux','legacy-default'):,.0f} MiB | {rss('macos','legacy-default'):,.0f} MiB | {cases['linux']['legacy-default']['metrics']['pssMiB']['median']:,.0f} MiB |
| Current CLI + pooler · Docker | {rss('linux','legacy-pooler'):,.0f} MiB | {rss('macos','legacy-pooler'):,.0f} MiB | {cases['linux']['legacy-pooler']['metrics']['pssMiB']['median']:,.0f} MiB |
| New default · Docker | {rss('linux','docker-default'):,.0f} MiB | {rss('macos','docker-default'):,.0f} MiB | {cases['linux']['docker-default']['metrics']['pssMiB']['median']:,.0f} MiB |
| New default · native | {rss('linux','native-default'):,.0f} MiB | {rss('macos','native-default'):,.0f} MiB | {cases['linux']['native-default']['metrics']['pssMiB']['median']:,.0f} MiB |
| New eager · Docker | {rss('linux','docker-eager'):,.0f} MiB | {rss('macos','docker-eager'):,.0f} MiB | {cases['linux']['docker-eager']['metrics']['pssMiB']['median']:,.0f} MiB |
| New eager · native | {rss('linux','native-eager'):,.0f} MiB | {rss('macos','native-eager'):,.0f} MiB | {cases['linux']['native-eager']['metrics']['pssMiB']['median']:,.0f} MiB |

RSS counts resident pages in each process and can count shared pages more than once. PSS apportions shared pages on Linux; PSS is unavailable on macOS, so macOS memory results use RSS.

macOS native RSS comes from macOS process accounting, while Linux container RSS comes from the Ubuntu VM; the kernels account differently. RSS grows as dormant services activate, so the default-mode reduction describes a database-first state rather than an equivalent full-stack workload. These RSS values do not establish physical RAM saved on macOS.

### Eager mode: compare the whole service set

The eager RSS comparison is included in [BENCHMARK_NOTES.md](BENCHMARK_NOTES.md#eager-process-rss) because it uses the pooler-enabled legacy baseline.

{eager_memory_summary}

![Linux proportional process memory](assets/memory-linux-pss.png)

## How to interpret these numbers

Speedup means current CLI time divided by new stack time. Ratios use unrounded measurements. Environment, workload definitions, exclusions, ranges, failures, and source provenance are documented in [BENCHMARK_NOTES.md](BENCHMARK_NOTES.md). Source files: {src_links(d)}.
'''

def build_notes(d: dict[str, Any]) -> str:
    m, s = d["metadata"], d["startup"]
    lines = [
        f"# Benchmark notes · {m['date']}",
        "",
        f"Commit: `{m['commit']}`  ",
        f"Legacy CLI: `{m['legacyVersion']}`  ",
        f"Pull request: [#{m['pullRequest']}]({m['pullRequestUrl']})  ",
        f"Environment: {m['environment']}",
        "",
        "## Methodology",
        "",
        "Container cases use the shared Ubuntu private Docker backend for both the Ubuntu and macOS clients; macOS container measurements use SSH Unix-socket forwarding. Native workloads execute directly on their named host. Cold cases use fresh artifact, image, and project-data caches, while the operating system and upstream CDN caches are not reset. Every hot sample performs its own warmup outside the measured timer.",
        "",
        "The new-stack timer covers its public start() call; the legacy timer covers process spawn through readiness exit. Creating the stack, importing packages, installing dependencies, and setting up the project are outside both timers.",
        "",
        "Default mode measures database readiness while the remaining services prepare in the background. Eager mode measures all 11 enabled new-stack workloads ready. The released CLI default is its full 12-container service set; enabling its pooler starts 13 and supplies the eager baseline for startup, restart, and memory comparisons. Kong and Vector remain separate legacy services. Imgproxy is disabled on both sides. The plain legacy baseline measures the released CLI's full default service set, not database-only readiness. The new eager comparison uses the 13-container legacy baseline against 11 new workloads.",
        "",
        "Each new-stack memory start reports the median of three settled snapshots requested at 30, 35, and 40 seconds after readiness and the artifact prefetch barrier; legacy starts use readiness as their baseline. The process-level memory summary then reports the median across the three starts for each case. These are observations, not peak memory or application-load measurements. Linux PSS is reported where available; macOS PSS is unavailable and macOS memory results use RSS.",
        "",
        "Default RSS rises as dormant services activate. macOS native RSS and Linux VM/container RSS come from different kernels, so the macOS RSS comparison does not claim physical RAM saved.",
        "",
        "## Startup observations",
        "",
        "All rows contain median seconds and explicit attempts, successes, failures, and ranges.",
        "",
    ]
    lines += ["## New-stack workload provenance", ""]
    lines += workload_provenance_lines(m)
    lines += ["", "## Legacy workload image provenance", ""]
    lines += legacy_image_lines(m)
    lines += [""]
    for host in ("linux", "macos"):
        lines.extend([f"### {HOST_LABELS[host]}", "", "| Configuration | Phase | Median | Range | Attempts | Successes | Failures |", "| --- | --- | ---: | --- | ---: | ---: | ---: |"])
        for case in render.REQUIRED_STARTUP:
            for phase in ("cached", "cold"):
                x = s[host][case][phase]
                lines.append(f"| {label_case(case)} | {phase} | {x['medianSeconds']:.3f}s | {fmt_range(x.get('rangeSeconds'), 's')} | {x['attempts']} | {x['successes']} | {x['failures']} |")
        lines.append("")

    lines += cold_native_artifact_lines(d)

    lines += ["## Retained-data restarts", "", "| Host | Configuration | Median | Range | Attempts | Successes | Failures |", "| --- | --- | ---: | --- | ---: | ---: | ---: |"]
    for host in ("linux", "macos"):
        for case in render.REQUIRED_STARTUP:
            r = s[host]["restarts"][case]
            lines.append(f"| {HOST_LABELS[host]} | {label_case(case)} | {r['medianSeconds']:.2f}s | {fmt_range(r.get('rangeSeconds'), 's')} | {r['attempts']} | {r['successes']} | {r['failures']} |")

    observations = d["processMemory"]["observations"]
    lines += ["", "## Process memory campaign", "", f"The campaign contains {observations['starts']} measured starts and {observations['snapshots']} snapshots; each start is summarized from three snapshots at the requested 30, 35, and 40 second offsets after readiness and prefetch.", "", "| Host | Configuration | RSS median MiB | RSS range | PSS median MiB |", "| --- | --- | ---: | --- | ---: |"]
    for host in ("linux", "macos"):
        for case in render.REQUIRED_MEMORY:
            metrics = d["processMemory"]["cases"][host][case]["metrics"]
            rss = metrics["rssMiB"]
            pss = metrics.get("pssMiB", {})
            pss_median = f"{pss['median']:,.0f}" if isinstance(pss.get("median"), (int, float)) else "—"
            lines.append(f"| {HOST_LABELS[host]} | {label_case(case)} | {rss['median']:,.0f} | {fmt_range(rss.get('rangeMiB'), ' MiB')} | {pss_median} |")

    startup_failures = sum(row.get("failures", 0) for host in s.values() if isinstance(host, dict) for case in render.REQUIRED_STARTUP if isinstance(host.get(case), dict) for phase in ("cached", "cold") for row in [host[case][phase]])
    restart_failures = sum(s[host]["restarts"][case].get("failures", 0) for host in ("linux", "macos") for case in render.REQUIRED_STARTUP)
    product_failures = startup_failures + restart_failures
    setup_failures = d.get("setupFailures", [])
    lines += ["", "## Reliability", ""]
    if product_failures:
        lines.append(f"The completed campaign recorded {product_failures} product measurement failure(s) across startup and retained-data restart observations; these remain in the counts above and are excluded from medians.")
    else:
        lines.append("All product measurement attempts completed successfully; no product reliability failures were recorded.")
    lines.append("")
    lines.append("Setup failures are tracked separately and never treated as product startup failures.")
    lines.append("")
    if setup_failures:
        for failure in setup_failures:
            reason = failure.get("reason") or "unspecified setup error"
            lines.append(f"- {HOST_LABELS.get(str(failure.get('platform')), str(failure.get('platform')))} · {label_case(str(failure.get('case')))} · sample {failure.get('sample')}: {reason}")
    else:
        lines.append("- None recorded.")

    lines += ["", "## Eager process RSS", "", "![Eager process RSS](assets/memory-eager-rss.png)", "", "This chart compares the pooler-enabled legacy baseline with the new eager cases. Imgproxy is disabled on both sides; Kong and Vector remain separate legacy services.", "", "## Reproducibility", "", "See the [benchmark runner instructions](../../../tools/stack-benchmarks/README.md) for prerequisites and setup. From the repository root, run `SBR_GO=1 python3 tools/stack-benchmarks/run.py --ref <commit> --vm orb --output /tmp/stack-benchmarks-run` on a macOS ARM64 host with an OrbStack Ubuntu 22.04 ARM64 VM. The report builder then consumes the canonical JSON produced by the aggregation step.", "", "## Readiness and accounting", "", "Default reports database readiness with background preparation; eager reports all enabled services ready. RSS counts resident pages per process and may count shared pages repeatedly; Linux PSS apportions shared pages. Docker engine and VM memory are excluded.", "", f"Source provenance: {src_links(d)}"]
    return "\n".join(lines) + "\n"

def main() -> int:
    ap=argparse.ArgumentParser(); ap.add_argument("data",type=Path); ap.add_argument("--output",type=Path,required=True); a=ap.parse_args()
    data=json.loads(a.data.read_text()); validate_metadata(data); render.render(data,a.output)
    (a.output/"README.md").write_text(build_readme(data)); (a.output/"BENCHMARK_NOTES.md").write_text(build_notes(data)); shutil.copy2(a.data,a.output/"benchmark-data.json")
    return 0
if __name__ == '__main__': raise SystemExit(main())
