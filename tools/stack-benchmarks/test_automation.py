#!/usr/bin/env python3
"""Small integration check for raw-cell aggregation and report rendering."""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import os
from urllib.parse import urlsplit
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import aggregate
import provenance
import run as automation_run


CASES = ["legacy", "legacy-pooler", "new-container-default", "new-container-eager", "new-native-default", "new-native-eager"]


def check_provenance_fetch_retries() -> None:
    calls: dict[str, int] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path).path
            calls[path] = calls.get(path, 0) + 1
            if path == "/transient" and calls[path] == 1:
                self.send_response(504)
                self.end_headers()
                return
            if path == "/missing":
                self.send_response(404)
                self.end_headers()
                return
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            return

    server = HTTPServer(("127.0.0.1", 0), Handler)
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        thread = __import__("threading").Thread(target=server.serve_forever, daemon=True)
        thread.start()
        assert provenance.fetch(f"{base}/transient") == b"ok"
        assert calls["/transient"] == 2
        try:
            provenance.fetch(f"{base}/missing")
        except RuntimeError as error:
            assert "/missing" in str(error) and "HTTP 404" in str(error)
        else:
            raise AssertionError("404 should fail without retry")
        assert calls["/missing"] == 1
    finally:
        server.shutdown()
        server.server_close()


def write_fixture(root: Path) -> Path:
    campaign = root / "campaign"
    for host in ("macos", "ubuntu-22.04"):
        for mode in ("cold", "hot"):
            for sample in (1, 2, 3):
              for case in CASES:
                cell_dir = campaign / "results" / host / mode / case / f"sample-{sample}"
                cell_dir.mkdir(parents=True)
                cell = {"platform": host, "mode": mode, "case": case, "sample": sample, "cellId": f"{host}/{mode}/{case}/{sample}"}
                failed = host == "macos" and mode == "hot" and case == "new-native-eager" and sample == 3
                (cell_dir / "cell-status.json").write_text(json.dumps({"status": "failed" if failed else "completed", "cell": cell}))
                if failed:
                    (cell_dir / "runner-result.json").write_text(json.dumps({"status": "failed", "cell": cell, "returncode": 1}))
                    continue
                if case in ("legacy", "legacy-pooler"):
                    memory = {"median": {"rssBytes": (100 + sample) * 1024 * 1024, "pssBytes": (50 + sample) * 1024 * 1024}, "snapshots": [{"requestedOffsetMs": offset, "actualOffsetMs": offset + sample, "snapshot": {"totals": {"rssBytes": (100 + sample) * 1024 * 1024, "pssBytes": (50 + sample) * 1024 * 1024}}} for offset in (30_000, 35_000, 40_000)]} if mode == "hot" else None
                    elapsed = (4_000 if case == "legacy-pooler" else 1_000) + sample * 100
                    fresh = {"kind": "fresh", "sample": sample, "start": {"exitCode": 0, "elapsedMs": elapsed}}
                    if memory is not None:
                        fresh["memoryCapture"] = memory
                    measurements = [fresh]
                    if mode == "hot":
                        restart_elapsed = (1_500 if case == "legacy-pooler" else 500) + sample * 10
                        measurements.append({"kind": "retained-data-restart", "sample": sample, "start": {"exitCode": 0, "elapsedMs": restart_elapsed}})
                    (cell_dir / "legacy-results.json").write_text(json.dumps({"cli": {"version": "2.116.0"}, "measurements": measurements}))
                else:
                    runtime = "container" if "container" in case else "native"
                    scenario = "eager" if case.endswith("eager") else "default"
                    # Harness-local BENCHMARK_SAMPLES=1 means every summary
                    # records sample one; the enclosing campaign cell carries
                    # the matrix sample number.
                    measurement = {"runtime": {"kind": runtime}, "scenario": scenario, "sample": 1, "startMs": 2_000 + sample * 100}
                    measurement["artifactBarrier"] = {"artifactReadyMs": 900 + sample, "barrierWaitMs": 300 + sample}
                    measurement["status"] = {"artifacts": [{"workloadId": "database:database"}, {"workloadId": "rest:rest"}]}
                    measurement["startStatusObservations"] = [
                        {"observedOffsetMs": 1_000, "status": {"artifacts": [{"workloadId": "database:database", "state": "ready"}]}},
                        {"observedOffsetMs": 2_000, "status": {"artifacts": [{"workloadId": "database:database", "state": "ready"}, {"workloadId": "rest:rest", "state": "ready"}]}},
                    ]
                    if mode == "hot":
                        measurement["memoryCapture"] = {"median": {"rssBytes": (200 + sample) * 1024 * 1024, "pssBytes": (100 + sample) * 1024 * 1024}, "snapshots": [{"requestedOffsetMs": offset, "actualOffsetMs": offset + sample, "snapshot": {"totals": {"rssBytes": (200 + sample) * 1024 * 1024, "pssBytes": (100 + sample) * 1024 * 1024}}} for offset in (30_000, 35_000, 40_000)]}
                    if mode == "hot":
                        measurement["restart"] = {"startMs": 600 + sample * 10}
                    summary = cell_dir / "new-stack" / "summary" / "new-stack-summary.json"
                    summary.parent.mkdir(parents=True)
                    summary.write_text(json.dumps({"measurements": [measurement]}))
                (cell_dir / "runner-result.json").write_text(json.dumps({"status": "completed", "cell": cell}))
    archived = campaign / "results" / "macos" / "cold" / "legacy" / "attempts" / "sample-1-old"
    archived.mkdir(parents=True)
    archived_cell = {"platform": "macos", "mode": "cold", "case": "legacy", "sample": 1, "cellId": "macos/cold/legacy/1"}
    (archived / "cell-status.json").write_text(json.dumps({"status": "setup-invalid", "cell": archived_cell, "reason": "Docker socket forwarding mismatch"}))
    product_failure = campaign / "results" / "macos" / "cold" / "legacy" / "attempts" / "sample-1-failed"
    product_failure.mkdir(parents=True)
    (product_failure / "cell-status.json").write_text(json.dumps({"status": "failed", "cell": archived_cell, "reason": "service did not become ready"}))
    (product_failure / "runner-result.json").write_text(json.dumps({"status": "failed", "cell": archived_cell, "returncode": 1}))
    return campaign


def main() -> int:
    check_provenance_fetch_retries()
    with tempfile.TemporaryDirectory(prefix="sbr-automation-test-") as temporary:
        root = Path(temporary)
        campaign = write_fixture(root)
        data = aggregate.aggregate(
            campaign,
            commit="fixture-commit",
            metadata={
                "pullRequest": "6440",
                "pullRequestUrl": "https://github.com/supabase/cli/pull/6440",
                "environment": "synthetic fixture",
            },
        )
        assert data["metadata"]["pullRequest"] == "6440"
        assert data["metadata"]["pullRequestUrl"].endswith("/6440")
        assert data["startup"]["linux"]["legacy"]["cached"]["medianSeconds"] == 1.2
        assert data["startup"]["linux"]["legacy"]["cached"]["attempts"] == 3
        assert data["startup"]["linux"]["legacyEager"]["cached"]["attempts"] == 3
        assert data["startup"]["linux"]["legacyEager"]["cached"]["medianSeconds"] == 4.2
        assert data["startup"]["macos"]["legacyEager"]["cold"] == {"attempts": 3, "successes": 3, "failures": 0, "medianSeconds": 4.2, "rangeSeconds": [4.1, 4.3]}
        assert data["startup"]["macos"]["legacy"]["cold"] == {"attempts": 4, "successes": 3, "failures": 1, "medianSeconds": 1.2, "rangeSeconds": [1.1, 1.3]}
        assert data["startup"]["macos"]["nativeEager"]["cached"]["failures"] == 1
        assert data["startup"]["linux"]["restarts"]["dockerDefault"]["medianSeconds"] == 0.62
        assert data["startup"]["linux"]["restarts"]["legacy"]["successes"] == 3
        assert data["startup"]["linux"]["restarts"]["legacyEager"]["medianSeconds"] == 1.52
        assert data["processMemory"]["observations"] == {"starts": 35, "snapshots": 105, "windowSeconds": "30–40"}
        assert len(data["observations"]["startup"]) == 73
        assert sum(1 for row in data["observations"]["startup"] if not row["success"]) == 2
        assert any(row.get("artifactBarrier", {}).get("artifactReadyMs") == 901 for row in data["observations"]["startup"])
        assert any(row.get("artifactsPreparedObservedSeconds") == 2.0 for row in data["observations"]["startup"])
        assert len(data["observations"]["restarts"]) == 35
        assert sum(1 for row in data["observations"]["restarts"] if row["case"] == "legacyEager") == 6
        assert len(data["observations"]["memory"]) == 105
        assert len(data["setupFailures"]) == 1
        data_path = root / "benchmark-data.json"
        data_path.write_text(json.dumps(data))
        serialized_data = data_path.read_text()
        assert "/tmp/sbr0907" not in serialized_data and "pending" not in serialized_data
        assert all(not Path(source).is_absolute() for source in data["metadata"]["sourceProvenance"])
        incomplete_path = root / "incomplete.json"
        incomplete = json.loads(data_path.read_text())
        incomplete["metadata"].pop("pullRequest")
        incomplete_path.write_text(json.dumps(incomplete))
        metadata_path = root / "metadata.json"
        metadata_path.write_text(json.dumps({"commit": "metadata-commit"}))
        mismatch = subprocess.run([sys.executable, str(automation_run.HERE / "run.py"), "--aggregate", str(campaign), "--metadata", str(metadata_path), "--ref", "cli-commit", "--output", str(root / "mismatch.json")], capture_output=True, text=True)
        assert mismatch.returncode != 0 and "disagrees with metadata.commit" in mismatch.stderr
        modules = Path(os.environ.get("SBR_TEST_RESVG_NODE_MODULES", Path(__file__).parent / "render" / "node_modules"))
        if shutil.which("node") is None or not (modules / "@resvg" / "resvg-js").is_dir():
            print("aggregate fixture checks passed; report render skipped (install render dependencies first)")
            return 0
        environment = {**os.environ, "RESVG_NODE_MODULES": str(modules)}
        rejected = subprocess.run([sys.executable, str(automation_run.REPORT_TOOLS / "build-report.py"), str(incomplete_path), "--output", str(root / "rejected")], capture_output=True, text=True, env=environment)
        assert rejected.returncode != 0 and "pullRequest" in rejected.stderr
        output = root / "report"
        subprocess.run([sys.executable, str(automation_run.REPORT_TOOLS / "build-report.py"), str(data_path), "--output", str(output)], check=True, env=environment)
        assets = list((output / "assets").glob("*.png")) + list((output / "assets").glob("*.svg"))
        assert len(assets) == 12
        assert "benchmark-data.json" in (output / "README.md").read_text()
        readme = (output / "README.md").read_text()
        assert "4.2s → 2.2s" in readme and "48% less waiting" in readme
        chart_text = "\n".join(path.read_text() for path in (output / "assets").glob("*.svg"))
        assert "pooler-enabled current CLI baseline" in chart_text
        cached_default_svg = (output / "assets" / "cached-default.svg").read_text()
        assert 'y="400.0" width="84.0" height="390.0" rx="10.0" fill="#47504b"' in cached_default_svg
        cold_svg = (output / "assets" / "cold-startup.svg").read_text()
        assert "4s → 2s for full startup" in cold_svg
        assert "Docker eager: 48% less waiting" in cold_svg
        assert cold_svg.count("1.2s → 2.2s") >= 2
        assert cold_svg.count("4.2s → 2.2s") >= 2
        print("aggregate and report rendering checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
