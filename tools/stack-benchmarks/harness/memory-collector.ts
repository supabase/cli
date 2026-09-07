import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

type ProcessMemory = {
  pid: number;
  comm: string;
  rssBytes: number;
  pssBytes: number | null;
  privateBytes: number | null;
  swapBytes: number | null;
  containerId?: string;
};
type Options = {
  runtime: "native" | "container";
  stackId: string;
  projectLabel?: string;
  sampleAtOffsetMs: number;
};
const helperImage = process.env.BENCHMARK_MEMORY_HELPER_IMAGE ?? "python:3.12-slim";
const linux = process.platform === "linux";
const pythonCommand = process.env.BENCHMARK_PYTHON_COMMAND ?? "python3";
const linuxPrivilegePrefix = process.env.BENCHMARK_LINUX_PRIVILEGE === "none" ? [] : ["sudo", "-n"];
function runLinuxPython(input: string): string {
  if (linuxPrivilegePrefix.length === 0) return run(pythonCommand, ["-c", python], input);
  return run(
    linuxPrivilegePrefix[0]!,
    [linuxPrivilegePrefix[1]!, pythonCommand, "-c", python],
    input,
  );
}
function run(command: string, args: string[], input?: string): string {
  return execFileSync(command, args, {
    input,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
function psRows() {
  return run("ps", ["-axo", "pid=,ppid=,rss=,command="])
    .split("\n")
    .flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      return m
        ? [{ pid: Number(m[1]), ppid: Number(m[2]), rssBytes: Number(m[3]) * 1024, command: m[4]! }]
        : [];
    });
}
function ownedNative(stackId: string) {
  const rows = psRows();
  const roots = rows.filter(
    (r) =>
      r.command.includes(stackId) &&
      (r.command.includes("supervisor-node.ts") ||
        r.command.includes("__supabase_stack_supervisor__")),
  );
  if (roots.length !== 1)
    throw new Error(`Expected one exact Supervisor for ${stackId}, found ${roots.length}`);
  const selected = new Set([roots[0]!.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows)
      if (selected.has(r.ppid) && !selected.has(r.pid)) {
        selected.add(r.pid);
        changed = true;
      }
  }
  return { rows: rows.filter((r) => selected.has(r.pid)), root: roots[0]!.pid };
}
const python = String.raw`import json,os,sys,time
from pathlib import Path
req=json.loads(sys.argv[1]) if len(sys.argv)>1 else json.load(sys.stdin)
def identity(pid):
 text=Path(f'/proc/{pid}/stat').read_text(); close=text.rfind(')'); tail=text[close+2:].split()
 return text[text.find('(')+1:close],tail[19]
def readproc(item):
 pid=int(item['pid']); comm,start=identity(pid)
 if item.get('starttime') is not None and item['starttime'] != start: raise RuntimeError(f'PID reused: {pid}')
 container=item.get('containerId')
 if container and container not in Path(f'/proc/{pid}/cgroup').read_text(): raise RuntimeError(f'PID {pid} not in expected container')
 fields={}
 for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
  if ':' not in line: continue
  key,value=line.split(':',1); fields[key]=int(value.strip().split()[0])*1024
 for key in ('Rss','Pss','Private_Clean','Private_Dirty','Swap'):
  if key not in fields: raise RuntimeError(f'Missing {key} for PID {pid}')
 if identity(pid)[1] != start: raise RuntimeError(f'PID changed during capture: {pid}')
 if container and container not in Path(f'/proc/{pid}/cgroup').read_text(): raise RuntimeError(f'PID container changed: {pid}')
 return dict(pid=pid,comm=comm,starttime=start,containerId=container,rssBytes=fields['Rss'],pssBytes=fields['Pss'],privateBytes=fields['Private_Clean']+fields['Private_Dirty'],swapBytes=fields['Swap'])
processes=[readproc(item) for item in req['pids']]
engine=[]; engineErrors=[]
for entry in Path('/proc').iterdir():
 if not entry.name.isdigit(): continue
 try:
  comm=(entry/'comm').read_text().strip()
  if comm in ('dockerd','containerd'):
   try: engine.append(readproc({'pid':int(entry.name)}))
   except Exception as e: engineErrors.append(str(e))
 except (FileNotFoundError,PermissionError,ProcessLookupError): pass
mem={}
for line in Path('/proc/meminfo').read_text().splitlines():
 key,value=line.split(':',1)
 if key in ('MemTotal','MemAvailable','MemFree','Cached','SwapTotal','SwapFree'): mem[key+'Bytes']=int(value.strip().split()[0])*1024
print(json.dumps(dict(processes=processes,engine=engine,engineErrors=engineErrors,meminfo=mem,sampledAtUnixSeconds=time.time())))`;
function validateProcesses(rows: ProcessMemory[], expected: number, pssRequired: boolean) {
  if (rows.length !== expected || new Set(rows.map((r) => r.pid)).size !== expected)
    throw new Error("Incomplete or duplicate process capture");
  for (const r of rows)
    for (const key of pssRequired
      ? ["rssBytes", "pssBytes", "privateBytes", "swapBytes"]
      : ["rssBytes"]) {
      const v = r[key as keyof ProcessMemory];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        throw new Error(`Invalid ${key} for ${r.pid}`);
    }
}
function nativeCapture(stackId: string) {
  const owned = ownedNative(stackId);
  if (!linux) {
    const rows = psRows().filter((r) => owned.rows.some((o) => o.pid === r.pid));
    const processes: ProcessMemory[] = rows.map((r) => ({
      pid: r.pid,
      comm: r.command.split(/\s+/u)[0]!.split("/").pop()!,
      rssBytes: r.rssBytes,
      pssBytes: null,
      privateBytes: null,
      swapBytes: null,
    }));
    validateProcesses(processes, owned.rows.length, false);
    return {
      method: "macos-ps-rss",
      supervisorPid: owned.root,
      processes,
      engine: [],
      engineErrors: [],
      meminfo: null,
    };
  }
  const pids = owned.rows.map((r) => {
    const stat = readFileSync(`/proc/${r.pid}/stat`, "utf8");
    return { pid: r.pid, starttime: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/u)[19] };
  });
  const result = JSON.parse(runLinuxPython(JSON.stringify({ pids })));
  validateProcesses(result.processes, pids.length, true);
  return { method: "linux-smaps-rollup", supervisorPid: owned.root, ...result };
}
function dockerCapture(label: string, stackId: string) {
  const ids = run("docker", ["ps", "-q", "--no-trunc", "--filter", `label=${label}`])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!ids.length) throw new Error(`No active owned containers for ${label}`);
  const inspected = JSON.parse(run("docker", ["inspect", ...ids]));
  const pids: { pid: number; containerId: string }[] = [];
  const containers = inspected.map((r: any) => ({
    id: r.Id,
    name: r.Name.replace(/^\//u, ""),
    image: r.Config.Image,
    status: r.State.Status,
    health: r.State.Health?.Status ?? null,
  }));
  for (const c of containers) {
    if (c.status !== "running" || c.health === "unhealthy")
      throw new Error(`Container not healthy: ${c.name}`);
    const rows = run("docker", ["top", c.id, "-eo", "pid,ppid,comm"])
      .split("\n")
      .slice(1)
      .filter((l) => l.trim());
    if (!rows.length) throw new Error(`No processes for ${c.name}`);
    for (const row of rows) {
      const m = /^\s*(\d+)\s+\d+\s+.+$/u.exec(row);
      if (!m) throw new Error(`Cannot parse docker top row: ${row}`);
      pids.push({ pid: Number(m[1]), containerId: c.id });
    }
  }
  if (new Set(pids.map((r) => r.pid)).size !== pids.length)
    throw new Error("PID belongs to multiple owned containers");
  const helperName = `stack-memory-reader-${randomUUID()}`;
  let result;
  let helperId: string | undefined;
  try {
    helperId = run("docker", [
      "create",
      "--name",
      helperName,
      "--pid=host",
      "--cap-add",
      "SYS_PTRACE",
      "--security-opt",
      "apparmor=unconfined",
      "--read-only",
      "--user",
      "0",
      helperImage,
      "python3",
      "-c",
      python,
      JSON.stringify({ pids }),
    ]).trim();
    run("docker", ["start", helperId]);
    const exitCode = run("docker", ["wait", helperId]).trim();
    const output = run("docker", ["logs", helperId]);
    if (exitCode !== "0") throw new Error(`memory helper exited ${exitCode}: ${output}`);
    result = JSON.parse(output);
  } finally {
    try {
      run("docker", ["rm", "-f", helperId ?? helperName]);
    } catch {
      /* exact helper may already be gone */
    }
  }
  validateProcesses(result.processes, pids.length, true);
  const hostSupervisor = label.startsWith("com.supabase.stack.stackId=")
    ? nativeCapture(stackId)
    : null;
  return { method: "docker-host-smaps-rollup", containers, ...result, hostSupervisor };
}
function sum(
  rows: ProcessMemory[],
  key: "rssBytes" | "pssBytes" | "privateBytes" | "swapBytes",
): number | null {
  if (rows.some((r) => r[key] === null)) return null;
  return rows.reduce((a, r) => a + r[key]!, 0);
}
function totals(snapshot: any) {
  const p: ProcessMemory[] = snapshot.processes;
  const host: ProcessMemory[] = snapshot.hostSupervisor?.processes ?? [];
  return {
    workloadRssBytes: sum(p, "rssBytes"),
    hostSupervisorRssBytes: sum(host, "rssBytes"),
    rssBytes: sum([...p, ...host], "rssBytes"),
    workloadPssBytes: sum(p, "pssBytes"),
    hostSupervisorPssBytes: sum(host, "pssBytes"),
    pssBytes: sum([...p, ...host], "pssBytes"),
    privateBytes: sum([...p, ...host], "privateBytes"),
    swapBytes: sum([...p, ...host], "swapBytes"),
  };
}
function macVmContext() {
  if (linux) return null;
  const processPrefix =
    process.env.BENCHMARK_DOCKER_VM_PROCESS_PREFIX ?? "/Applications/OrbStack.app/";
  return {
    basis: "Whole shared Docker VM host processes, not attributable Docker-only overhead",
    processPrefix,
    processes: psRows()
      .filter((r) => r.command.startsWith(processPrefix))
      .map((r) => ({
        pid: r.pid,
        process: r.command.includes("Helper") ? "VM Helper" : "VM",
        rssBytes: r.rssBytes,
      })),
  };
}
export async function captureMemory(options: Options) {
  const snapshot =
    options.runtime === "native"
      ? nativeCapture(options.stackId)
      : dockerCapture(
          options.projectLabel ?? `com.supabase.cli.project=${options.stackId}`,
          options.stackId,
        );
  return { ...snapshot, totals: totals(snapshot), macVmContext: macVmContext() };
}
export async function captureAtOffsets(options: Omit<Options, "sampleAtOffsetMs">) {
  const origin = performance.now();
  const snapshots = [];
  for (const requestedOffsetMs of [30_000, 35_000, 40_000]) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, requestedOffsetMs - (performance.now() - origin))),
    );
    let snapshot;
    let attempts = 0;
    const captureStartedOffsetMs = performance.now() - origin;
    for (;;) {
      attempts++;
      try {
        snapshot = await captureMemory({ ...options, sampleAtOffsetMs: requestedOffsetMs });
        break;
      } catch (error) {
        if (attempts >= 2) throw error;
      }
    }
    snapshots.push({
      requestedOffsetMs,
      captureStartedOffsetMs,
      actualOffsetMs: performance.now() - origin,
      attempts,
      snapshot,
    });
  }
  const median: Record<string, number | null> = {};
  for (const key of Object.keys(snapshots[0]!.snapshot.totals)) {
    const values = snapshots.map((r) => r.snapshot.totals[key as keyof typeof r.snapshot.totals]);
    median[key] = values.some((v) => v === null)
      ? null
      : values.map(Number).sort((a, b) => a - b)[1]!;
  }
  return {
    enabled: true,
    requestedOffsetsMs: [30_000, 35_000, 40_000],
    helperImage,
    snapshots,
    median,
  };
}
