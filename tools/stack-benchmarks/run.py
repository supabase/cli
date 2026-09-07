#!/usr/bin/env python3
"""Single command campaign, aggregation, and report build entrypoint."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from provenance import catalog_provenance

HERE = Path(__file__).resolve().parent
PACKAGE_REPO = HERE.parents[1]
RUNNER = HERE / "runner/campaign.py"
HARNESS = HERE / "harness"
REPORT_TOOLS = HERE / "report-tools"
SOURCE_REPO = PACKAGE_REPO


def run(args: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None, input: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(args, cwd=cwd, env=env, input=input, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def text_run(args: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    return run(args, cwd=cwd, env=env).stdout.decode().strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def safe_error(error: subprocess.CalledProcessError) -> str:
    output = (error.stderr or b"").decode(errors="replace").strip().splitlines()
    return "\n".join(output[-4:]) if output else f"command failed with status {error.returncode}"


def resolve_ref(repo: Path, ref: str) -> str:
    # A locally available immutable SHA needs no network round trip. For a
    # branch or tag, fetch that exact ref into FETCH_HEAD and resolve only it;
    # this avoids stale tracking branches and unrelated repository updates.
    if re.fullmatch(r"[0-9a-f]{40}", ref):
        try:
            return text_run(["git", "-C", str(repo), "rev-parse", "--verify", f"{ref}^{{commit}}"])
        except subprocess.CalledProcessError:
            pass
    remotes = text_run(["git", "-C", str(repo), "remote"]).splitlines()
    if not remotes:
        raise RuntimeError(f"ref is unavailable locally and source has no remote: {ref}")
    run(["git", "-C", str(repo), "fetch", "--no-tags", "--no-prune", remotes[0], ref])
    return text_run(["git", "-C", str(repo), "rev-parse", "--verify", "FETCH_HEAD^{commit}"])


def clone_source(repo: Path, destination: Path, commit: str) -> None:
    run(["git", "clone", "--no-hardlinks", str(repo), str(destination)])
    run(["git", "-C", str(destination), "checkout", "--detach", commit])


def ensure_clean_checkout(repo: Path, label: str) -> None:
    status = text_run(["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=no"])
    if status:
        raise RuntimeError(f"{label} source checkout has tracked changes; refusing to benchmark it")


def remote_command(host: str, command: list[str]) -> str:
    return text_run(["ssh", "-o", "BatchMode=yes", host, shlex.join(command)])


def remote_shell(host: str, script: str) -> str:
    return text_run(["ssh", "-o", "BatchMode=yes", host, shlex.join(["sh", "-lc", script])])


def remote_status(host: str) -> dict[str, str]:
    values = {}
    for key, command in {
        "os": ["uname", "-s"],
        "arch": ["uname", "-m"],
        "bun": ["bun", "--version"],
        "pnpm": ["pnpm", "--version"],
        "docker": ["docker", "version", "--format", "{{.Server.Version}}"],
        "sudo": ["sudo", "-n", "true"],
        "hostDockerInternal": ["getent", "hosts", "host.docker.internal"],
        "kernel": ["uname", "-srvm"],
        "cpuCount": ["nproc"],
        "memoryBytes": ["awk", "/^MemTotal:/ {print $2}", "/proc/meminfo"],
        "osRelease": ["sh", "-c", "sed -n 's/^PRETTY_NAME=//p' /etc/os-release"],
    }.items():
        try:
            values[key] = remote_command(host, command)
        except subprocess.CalledProcessError as error:
            raise RuntimeError(f"VM preflight failed for {key}: {safe_error(error)}") from error
    try:
        values["memoryLimitBytes"] = remote_command(host, ["cat", "/sys/fs/cgroup/memory.max"])
    except subprocess.CalledProcessError:
        pass
    values["osRelease"] = values["osRelease"].strip('"')
    if values["os"] != "Linux" or values["arch"] not in ("aarch64", "arm64") or not values["osRelease"].startswith("Ubuntu 22.04"):
        raise RuntimeError(f"VM must be Ubuntu 22.04 ARM64 Linux, got {values['osRelease']} {values['arch']}")
    return values


def verify_shared_paths(host: str, run_dir: Path) -> None:
    """Verify the OrbStack mounts before creating any benchmark cells."""
    try:
        for path in (Path("/Users"), Path("/private/tmp")):
            remote_command(host, ["test", "-d", str(path)])
        marker = run_dir / ".vm-shared-path-check"
        marker.write_text("stack benchmark path check\n")
        try:
            remote_command(host, ["test", "-r", str(marker)])
        finally:
            marker.unlink(missing_ok=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError(
            "OrbStack shared paths are unavailable: /Users and /private/tmp must be "
            "mounted at the same paths on the Ubuntu VM"
        ) from error


def host_preflight() -> dict[str, str]:
    if sys.platform != "darwin" or platform.machine() not in ("arm64", "aarch64"):
        raise RuntimeError(f"benchmark host must be macOS arm64, got {sys.platform} {platform.machine()}")
    for command in ("git", "pnpm", "bun", "gh", "ssh", "scp", "python3"):
        if shutil.which(command) is None:
            raise RuntimeError(f"required host command is unavailable: {command}")
    details = {
        "os": platform.system(),
        "arch": platform.machine(),
        "macos": platform.mac_ver()[0],
        "python": platform.python_version(),
    }
    for key, command in (
        ("cpuModel", ["sysctl", "-n", "machdep.cpu.brand_string"]),
        ("cpuCount", ["sysctl", "-n", "hw.ncpu"]),
        ("memoryBytes", ["sysctl", "-n", "hw.memsize"]),
    ):
        try:
            details[key] = text_run(command)
        except (OSError, subprocess.CalledProcessError):
            pass
    return details


def configuration_digest(state: dict[str, Any]) -> str:
    immutable = dict(state)
    immutable.pop("configurationHash", None)
    immutable.pop("status", None)
    return hashlib.sha256(json.dumps(immutable, sort_keys=True).encode()).hexdigest()


def setup_run(args: argparse.Namespace, run_dir: Path, commit: str) -> dict[str, Any]:
    host_status = host_preflight()
    vm = args.vm or "orb"
    vm_status = remote_status(vm)
    verify_shared_paths(vm, run_dir)
    source = Path(args.existing_source).resolve() if args.existing_source else run_dir / "source-host"
    if args.existing_source:
        if text_run(["git", "-C", str(source), "rev-parse", "HEAD"]) != commit:
            raise RuntimeError("existing source checkout is not at the resolved commit")
        ensure_clean_checkout(source, "host")
    else:
        clone_source(SOURCE_REPO, source, commit)
        run(["pnpm", "install", "--frozen-lockfile"], cwd=source)
        ensure_clean_checkout(source, "host")

    legacy_cli = Path(args.legacy_cli).resolve() if args.legacy_cli else run_dir / "legacy-cli" / "node_modules/.bin/supabase"
    if args.legacy_cli is None:
        (run_dir / "legacy-cli").mkdir(parents=True, exist_ok=True)
        run(["pnpm", "add", "--ignore-workspace", "--dir", str(run_dir / "legacy-cli"), "supabase@2.116.0"], cwd=run_dir)
    if not legacy_cli.is_file():
        raise RuntimeError(f"legacy CLI executable is unavailable: {legacy_cli}")
    try:
        legacy_version = run([str(legacy_cli), "--version"])
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"host legacy CLI failed --version: {safe_error(error)}") from error
    if b"2.116.0" not in legacy_version.stdout + legacy_version.stderr:
        raise RuntimeError(f"host legacy CLI must be 2.116.0, got {(legacy_version.stdout + legacy_version.stderr).decode(errors='replace').strip()}")

    remote_home = remote_command(vm, ["sh", "-c", "printf '%s' \"$HOME\""])
    remote_root = f"{remote_home}/sbr-stack-benchmarks/{run_dir.name}"
    remote_harness = f"{remote_root}/harness"
    remote_runner = f"{remote_root}/runner"
    remote_command(vm, ["mkdir", "-p", remote_root])
    if args.existing_linux_source:
        source_linux = args.existing_linux_source
        actual_linux_commit = remote_command(vm, ["git", "-C", source_linux, "rev-parse", "HEAD"])
        if actual_linux_commit != commit:
            raise RuntimeError("existing VM source checkout is not at the resolved commit")
        if remote_command(vm, ["git", "-C", source_linux, "status", "--porcelain", "--untracked-files=no"]):
            raise RuntimeError("VM source checkout has tracked changes; refusing to benchmark it")
    else:
        bundle = run_dir / "source.bundle"
        run(["git", "-C", str(source), "bundle", "create", str(bundle), "HEAD"])
        run(["scp", "-q", str(bundle), f"{vm}:{remote_root}/source.bundle"])
        source_linux = f"{remote_root}/source-linux"
        remote_command(vm, ["git", "clone", "--quiet", f"{remote_root}/source.bundle", source_linux])
        remote_command(vm, ["git", "-C", source_linux, "checkout", "--detach", commit])
        # Keep the remote install command in one quoted argv so paths cannot be
        # interpreted by the local shell. The command runs in the cloned checkout.
        remote_shell(vm, " && ".join([
            shlex.join(["cd", source_linux]),
            shlex.join(["pnpm", "install", "--frozen-lockfile"]),
        ]))
        if remote_command(vm, ["git", "-C", source_linux, "status", "--porcelain", "--untracked-files=no"]):
            raise RuntimeError("VM source checkout has tracked changes after install; refusing to benchmark it")

    # Keep the runner and harness beside the isolated source and dependencies;
    # the campaign's Linux-root override then makes remote outputs resumable
    # without relying on a shared /tmp or a pre-existing VM checkout.
    run(["scp", "-q", "-r", str(HARNESS), f"{vm}:{remote_root}/harness"])
    run(["scp", "-q", "-r", str(RUNNER.parent), f"{vm}:{remote_root}/runner"])

    remote_command(vm, ["mkdir", "-p", remote_root])
    remote_legacy = f"{remote_root}/legacy-cli/node_modules/.bin/supabase"
    if args.linux_legacy:
        remote_legacy = args.linux_legacy
    else:
        remote_command(vm, ["mkdir", "-p", f"{remote_root}/legacy-cli"])
        remote_shell(vm, " && ".join([
            shlex.join(["cd", f"{remote_root}/legacy-cli"]),
            shlex.join(["pnpm", "add", "--ignore-workspace", "supabase@2.116.0"]),
        ]))
    try:
        remote_version = remote_command(vm, [remote_legacy, "--version"])
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"VM legacy CLI failed --version: {safe_error(error)}") from error
    if "2.116.0" not in remote_version:
        raise RuntimeError(f"VM legacy CLI must be 2.116.0, got {remote_version}")
    provenance = catalog_provenance(source)
    state = {
        "schemaVersion": 1,
        "runId": run_dir.name,
        "resolvedCommit": commit,
        "requestedRef": args.ref,
        "vm": vm,
        "sourceHost": str(source),
        "sourceLinux": source_linux,
        "remoteRoot": remote_root,
        "harnessHost": str(HARNESS),
        "harnessLinux": remote_harness,
        "runnerLinux": remote_runner,
        "legacyCliHost": str(legacy_cli),
        "legacyCliLinux": remote_legacy,
        "runnerManifestSha256": sha256(RUNNER.parent / "manifest.json"),
        "catalog": provenance,
        "hostPreflight": host_status,
        "vmPreflight": vm_status,
        "status": "prepared",
    }
    state["configurationHash"] = configuration_digest(state)
    write_json(run_dir / "run.json", state)
    write_json(run_dir / "catalog-provenance.json", provenance)
    return state


def verify_resume(run_dir: Path, args: argparse.Namespace) -> dict[str, Any]:
    state = json.loads((run_dir / "run.json").read_text())
    if state.get("schemaVersion") != 1:
        raise RuntimeError("unsupported run state schema")
    expected = state.get("configurationHash")
    actual = configuration_digest(state)
    if expected != actual:
        raise RuntimeError("run state configuration hash mismatch")
    if args.vm and args.vm != state.get("vm"):
        raise RuntimeError("resume VM does not match the original run")
    if sha256(RUNNER.parent / "manifest.json") != state.get("runnerManifestSha256"):
        raise RuntimeError("runner manifest changed; refusing to mix campaign definitions")
    source = Path(str(state["sourceHost"]))
    if text_run(["git", "-C", str(source), "rev-parse", "HEAD"]) != state.get("resolvedCommit"):
        raise RuntimeError("resolved source commit changed; refusing to resume")
    ensure_clean_checkout(source, "host")
    if remote_command(str(state["vm"]), ["git", "-C", str(state["sourceLinux"]), "rev-parse", "HEAD"]) != state.get("resolvedCommit"):
        raise RuntimeError("resolved VM source commit changed; refusing to resume")
    if remote_command(str(state["vm"]), ["git", "-C", str(state["sourceLinux"]), "status", "--porcelain", "--untracked-files=no"]):
        raise RuntimeError("VM source checkout has tracked changes; refusing to resume")
    if catalog_provenance(source) != state.get("catalog"):
        raise RuntimeError("public catalog or artifact SHA metadata changed; refusing to resume")
    return state


def ensure_renderer_deps() -> Path:
    package_root = HERE / "render"
    modules = package_root / "node_modules"
    if not (modules / "@resvg/resvg-js").is_dir():
        run(["pnpm", "install", "--frozen-lockfile", "--ignore-workspace"], cwd=package_root)
    if not (modules / "@resvg/resvg-js").is_dir():
        raise RuntimeError("renderer dependency @resvg/resvg-js was not installed")
    return modules


def build_report(data: Path, output: Path) -> None:
    modules = ensure_renderer_deps()
    env = {**os.environ, "RESVG_NODE_MODULES": str(modules)}
    run([sys.executable, str(REPORT_TOOLS / "build-report.py"), str(data), "--output", str(output)], env=env)


def load_report_metadata(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if isinstance(value, dict) and isinstance(value.get("metadata"), dict):
        value = value["metadata"]
    if not isinstance(value, dict):
        raise RuntimeError(f"metadata file must contain an object: {path}")
    return value


def run_campaign(run_dir: Path, state: dict[str, Any]) -> None:
    campaign = run_dir / "campaign"
    env = {
        **os.environ,
        "SBR_GO": "1",
        "SBR_LINUX_ROOT": state.get("remoteRoot", ""),
        "SBR_ENGINE_PARENTS": str(campaign / "engines"),
    }
    command = [sys.executable, str(RUNNER), "--run", "--ref", state["resolvedCommit"], "--output", str(campaign), "--source", state["sourceHost"], "--linux-source", state["sourceLinux"], "--linux-root", state["remoteRoot"], "--linux-runner", state["runnerLinux"], "--harness", str(HARNESS), "--linux-harness", state["harnessLinux"], "--legacy", state["legacyCliHost"], "--linux-legacy", state["legacyCliLinux"], "--vm", state["vm"]]
    subprocess.run(command, env=env, check=True)


def verify_campaign_complete(campaign: Path) -> None:
    """Refuse to build a full report while any planned cell is incomplete."""
    missing: list[str] = []
    for platform_name in ("macos", "ubuntu-22.04"):
        for mode in ("cold", "hot"):
            cases = CASES + ["legacy-pooler"]
            for case in cases:
                for sample in (1, 2, 3):
                    cell_id = f"{platform_name}/{mode}/{case}/{sample}"
                    cell_dir = campaign / "results" / platform_name / mode / case / f"sample-{sample}"
                    try:
                        status = json.loads((cell_dir / "cell-status.json").read_text())
                        result = json.loads((cell_dir / "runner-result.json").read_text())
                    except (OSError, ValueError):
                        missing.append(cell_id)
                        continue
                    if status.get("status") != "completed" or result.get("status") != "completed":
                        missing.append(cell_id)
    if missing:
        preview = ", ".join(missing[:5])
        suffix = "..." if len(missing) > 5 else ""
        raise RuntimeError(f"campaign matrix is incomplete ({len(missing)} planned cells): {preview}{suffix}")


def report_metadata(state: dict[str, Any]) -> dict[str, Any]:
    host = state.get("hostPreflight", {})
    vm = state.get("vmPreflight", {})
    host_version = host.get("macos", "unknown") if isinstance(host, dict) else "unknown"
    host_cpu = host.get("cpuModel", "Apple Silicon") if isinstance(host, dict) else "Apple Silicon"
    host_cpu_count = host.get("cpuCount", "unknown") if isinstance(host, dict) else "unknown"
    def gibibytes(value: Any, *, kibibytes: bool = False) -> str:
        try:
            amount = float(value)
        except (TypeError, ValueError):
            return "unknown"
        if amount <= 0:
            return "unknown"
        if kibibytes:
            amount *= 1024
        return f"{amount / (1024 ** 3):.0f} GiB"

    host_memory = gibibytes(host.get("memoryBytes")) if isinstance(host, dict) else "unknown"
    vm_os = vm.get("osRelease", "Ubuntu 22.04") if isinstance(vm, dict) else "Ubuntu 22.04"
    vm_cpu_count = vm.get("cpuCount", "unknown") if isinstance(vm, dict) else "unknown"
    vm_memory_value = vm.get("memoryLimitBytes") if isinstance(vm, dict) else None
    if not vm_memory_value or vm_memory_value == "max":
        vm_memory = gibibytes(vm.get("memoryBytes"), kibibytes=True) if isinstance(vm, dict) else "unknown"
    else:
        vm_memory = gibibytes(vm_memory_value)
    docker_version = vm.get("docker", "unknown") if isinstance(vm, dict) else "unknown"
    return {
        "pullRequest": "6440",
        "pullRequestUrl": "https://github.com/supabase/cli/pull/6440",
        "sourceProvenance": ["benchmark-data.json"],
        "catalog": state.get("catalog"),
        "environment": (
            f"{host_cpu} macOS ARM64 host (macOS {host_version}, {host_cpu_count} CPU, {host_memory}) + "
            f"{vm_os} ARM64 VM ({vm_cpu_count} CPU, {vm_memory} cgroup limit, Docker {docker_version}); "
            "Docker backend used for both platform clients via SSH Unix-socket forwarding; normal desktop activity"
        ),
        "artifactBarrier": "Memory sampling waits until background artifact preparation finishes; default startup ends at database readiness.",
    }


def dry_run(args: argparse.Namespace) -> None:
    print(json.dumps({"timed": False, "requestedRef": args.ref, "vm": args.vm or "orb", "matrix": {"platforms": ["macos", "ubuntu-22.04"], "modes": ["cold", "hot"], "samplesPerCase": 3, "startupCases": ["legacy", "legacy-pooler", *CASES[1:]]}}, indent=2))


CASES = ["legacy", "new-container-default", "new-container-eager", "new-native-default", "new-native-eager"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", help="git ref to resolve and benchmark")
    parser.add_argument("--vm", "--vm-ssh", type=str, help="SSH alias for the Ubuntu 22.04 ARM64 VM (default: orb)")
    parser.add_argument("--output", "--output-dir", type=Path, help="fresh run directory or report output for --render")
    parser.add_argument("--resume", "--resume-run-dir", "--resume-run", type=Path, help="resume this existing run directory")
    parser.add_argument("--legacy-cli", help="existing host legacy CLI executable")
    parser.add_argument("--linux-legacy", help="existing VM legacy CLI executable")
    parser.add_argument("--existing-source", help="reuse a verified host checkout at the resolved commit")
    parser.add_argument("--existing-linux-source", help="reuse a verified VM checkout at the resolved commit")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--render", type=Path, metavar="DATA", help="build a report from saved canonical JSON")
    parser.add_argument("--aggregate", type=Path, metavar="CAMPAIGN", help="aggregate saved campaign results")
    parser.add_argument("--metadata", type=Path, help="metadata JSON for --aggregate when no adjacent run.json exists")
    parser.add_argument("--prepare-only", action="store_true", help="complete isolated setup and write run state without starting cells")
    args = parser.parse_args()
    if args.dry_run:
        dry_run(args)
        return 0
    if args.render:
        output = args.output or args.render.parent / "report"
        build_report(args.render, output)
        return 0
    if args.aggregate:
        metadata: dict[str, Any]
        adjacent_state = args.aggregate.parent / "run.json"
        if args.metadata:
            metadata = load_report_metadata(args.metadata)
        elif adjacent_state.is_file():
            metadata = report_metadata(load_report_metadata(adjacent_state))
        else:
            parser.error("--aggregate requires adjacent run.json or --metadata PATH; provenance cannot be inferred")
        metadata_commit = metadata.get("commit")
        if args.ref and metadata_commit and args.ref != metadata_commit:
            parser.error(f"--aggregate --ref {args.ref} disagrees with metadata.commit {metadata_commit}")
        commit = args.ref or metadata_commit
        if not isinstance(commit, str) or not commit:
            parser.error("--aggregate requires --ref or metadata.commit")
        output = args.output or args.aggregate.parent / "benchmark-data.json"
        data = __import__("aggregate").aggregate(args.aggregate, commit=commit, metadata=metadata)
        write_json(output, data)
        return 0
    if args.resume:
        run_dir = args.resume.resolve()
        state = verify_resume(run_dir, args)
    else:
        if not args.ref:
            parser.error("--ref is required for a fresh campaign")
        if not args.output:
            parser.error("--output is required for a fresh campaign")
        if os.environ.get("SBR_GO") != "1":
            raise RuntimeError("refusing timed run: set SBR_GO=1 after publication and metadata verification (or use --dry-run)")
        run_dir = args.output.resolve()
        if run_dir.exists() and any(run_dir.iterdir()):
            raise RuntimeError(f"fresh run directory is not empty: {run_dir}")
        run_dir.mkdir(parents=True, exist_ok=True)
        commit = resolve_ref(Path(args.existing_source).resolve() if args.existing_source else SOURCE_REPO, args.ref)
        state = setup_run(args, run_dir, commit)
    if args.prepare_only:
        print(json.dumps({"runDirectory": str(run_dir), "resolvedCommit": state["resolvedCommit"], "status": "prepared"}))
        return 0
    run_campaign(run_dir, state)
    verify_campaign_complete(run_dir / "campaign")
    end_catalog = catalog_provenance(Path(state["sourceHost"]))
    if end_catalog != state.get("catalog"):
        raise RuntimeError("public catalog or artifact SHA metadata changed during campaign")
    write_json(run_dir / "catalog-provenance-end.json", end_catalog)
    data_path = run_dir / "benchmark-data.json"
    aggregate_module = __import__("aggregate")
    write_json(data_path, aggregate_module.aggregate(run_dir / "campaign", commit=state["resolvedCommit"], metadata=report_metadata(state)))
    build_report(data_path, run_dir / "report")
    state["status"] = "completed"
    write_json(run_dir / "run.json", state)
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error) if isinstance(error, RuntimeError) else safe_error(error), file=sys.stderr)
        raise SystemExit(1)
