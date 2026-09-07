#!/usr/bin/env -S pnpm exec bun

/**
 * Benchmark harness for the published legacy Supabase CLI.
 *
 * Creates isolated projects below BENCHMARK_RUN_ROOT, reuses images after
 * one warmup, and only
 * discovers/stops Docker resources carrying the exact project label for the
 * project currently under test. It never uses `supabase stop --all`, prune, or
 * any Docker-wide cleanup operation.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { captureAtOffsets } from "./memory-collector.ts";

const PROJECT_LABEL = "com.supabase.cli.project";
const DEFAULT_OUTPUT = "/tmp/stack-platform-comparison/legacy-results.json";
const DEFAULT_RUN_ROOT = "/tmp/stack-platform-comparison/runs";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

type CommandResult = {
  command: string[];
  exitCode: number | null;
  signal: string | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
};

type ContainerState = {
  id: string;
  shortId: string;
  name: string;
  image: string | null;
  imageId: string | null;
  createdAt: string | null;
  status: string | null;
  running: boolean;
  healthy: boolean | null;
  healthStatus: string | null;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  labels: JsonRecord;
};

type DockerSnapshot = {
  projectLabel: string;
  containerCount: number;
  runningServiceCount: number;
  unhealthyServiceCount: number;
  containers: ContainerState[];
  stats: JsonRecord;
  commands: JsonRecord;
};

type Measurement = {
  kind: "warmup" | "fresh" | "retained-data-restart";
  sample: number | null;
  projectId: string;
  projectDir: string;
  startedAt: string;
  start: CommandResult;
  docker: DockerSnapshot | null;
  memoryCapture?: Awaited<ReturnType<typeof captureAtOffsets>>;
  config: JsonRecord;
  cleanup: CommandResult | null;
  cleanupRetained: CommandResult | null;
  error?: string;
};

type Results = {
  schemaVersion: 1;
  benchmark: "supabase-cli-legacy";
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  cli: JsonRecord;
  host: JsonRecord;
  options: JsonRecord;
  runRoot: string;
  outputPath: string;
  measurements: Measurement[];
  events: JsonRecord[];
  error?: string;
};

const envValue = (name: string, fallback: string) => process.env[name] ?? fallback;

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function enablePooler(projectDir: string): void {
  const path = join(projectDir, "supabase", "config.toml");
  const text = readFileSync(path, "utf8");
  const updated = text.replace(/(\[db\.pooler\][\s\S]*?\benabled\s*=\s*)false/u, "$1true");
  if (updated === text)
    throw new Error("BENCHMARK_ENABLE_POOLER=1 could not find [db.pooler] enabled=false");
  writeFileSync(path, updated, "utf8");
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.trim().toLowerCase())) return false;
  throw new Error(`${name} must be a boolean, got ${JSON.stringify(raw)}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendChunk(target: { value: string }, chunk: unknown): void {
  target.value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
}

/** Spawn without a shell so project IDs and paths are passed as exact argv values. */
async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const started = performance.now();
  const stdout = { value: "" };
  const stderr = { value: "" };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  let spawnError: string | undefined;

  const result = await new Promise<{ exitCode: number | null; signal: string | null }>((done) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => appendChunk(stdout, chunk));
    child.stderr.on("data", (chunk) => appendChunk(stderr, chunk));
    child.once("error", (error) => {
      spawnError = error.message;
      if (!settled) {
        settled = true;
        done({ exitCode: null, signal: null });
      }
    });
    child.once("close", (exitCode, signal) => {
      if (!settled) {
        settled = true;
        done({ exitCode, signal });
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      // A CLI process should exit promptly after SIGTERM. This second signal is
      // a timeout guard only, never part of readiness or sampling semantics.
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5_000).unref();
    }, timeoutMs);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  });

  return {
    command: [command, ...args],
    exitCode: result.exitCode,
    signal: result.signal,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    stdout: stdout.value,
    stderr: stderr.value,
    timedOut,
    ...(spawnError === undefined ? {} : { spawnError }),
  };
}

function makeChildEnv(projectDir: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  // Keep HOME and Docker's normal context/socket resolution intact. Scope only
  // CLI-owned state so credentials, telemetry, and service-version metadata do
  // not leak between benchmark projects.
  childEnv.SUPABASE_HOME = join(projectDir, ".supabase-home");
  childEnv.SUPABASE_NO_KEYRING = "1";
  childEnv.SUPABASE_TELEMETRY_DISABLED = "1";
  delete childEnv.SUPABASE_PROJECT_ID;
  delete childEnv.SUPABASE_WORKDIR;
  delete childEnv.SUPABASE_NETWORK_ID;
  return childEnv;
}

function parseProjectId(configText: string, fallback: string): string {
  const match = configText.match(/^\s*project_id\s*=\s*["']([^"']+)["']\s*$/m);
  return match?.[1] ?? fallback;
}

function parseTomlScalar(
  configText: string,
  section: string,
  key: string,
): string | number | boolean | null {
  let currentSection = "";
  for (const rawLine of configText.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1).trim();
      continue;
    }
    if (currentSection !== section) continue;
    const match = line.match(
      new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+)$`),
    );
    if (!match) continue;
    const value = match[1]!.trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
    if (value === "true" || value === "false") return value === "true";
    const number = Number(value);
    return Number.isNaN(number) ? value : number;
  }
  return null;
}

function readConfig(projectDir: string, projectId: string): JsonRecord {
  const path = join(projectDir, "supabase", "config.toml");
  try {
    const text = readFileSync(path, "utf8");
    const tempDir = join(projectDir, "supabase", ".temp");
    const overrides: JsonRecord = {};
    for (const [service, filename] of [
      ["auth", "gotrue-version"],
      ["postgrest", "rest-version"],
      ["storage", "storage-version"],
      ["realtime", "realtime-version"],
      ["studio", "studio-version"],
      ["pgmeta", "pgmeta-version"],
      ["analytics", "logflare-version"],
      ["pooler", "pooler-version"],
    ] as const) {
      try {
        const version = readFileSync(join(tempDir, filename), "utf8").trim();
        if (version) overrides[service] = version;
      } catch {
        // Unlinked default projects have no .temp service pin files.
      }
    }
    return {
      projectId,
      path,
      dbMajorVersion: parseTomlScalar(text, "db", "major_version"),
      edgeRuntimeDenoVersion: parseTomlScalar(text, "edge_runtime", "deno_version"),
      experimentalOrioledbVersion: parseTomlScalar(text, "experimental", "orioledb_version"),
      serviceVersionOverrides: overrides,
    };
  } catch (error) {
    return {
      projectId,
      path,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseJsonLines(stdout: string): JsonRecord[] {
  const rows: JsonRecord[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        rows.push(value as JsonRecord);
      }
    } catch {
      // Keep malformed output in the command record; callers receive parseError.
    }
  }
  return rows;
}

function parseInspect(stdout: string): unknown[] {
  try {
    const value: unknown = JSON.parse(stdout);
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inspectToContainer(value: unknown): ContainerState | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as JsonRecord;
  const state = (raw.State ?? {}) as JsonRecord;
  const health = (state.Health ?? {}) as JsonRecord;
  const config = (raw.Config ?? {}) as JsonRecord;
  const labels = (config.Labels ?? {}) as JsonRecord;
  const id = textOrNull(raw.Id);
  if (!id) return null;
  const healthStatus = textOrNull(health.Status);
  return {
    id,
    shortId: id.slice(0, 12),
    name: textOrNull(raw.Name)?.replace(/^\//, "") ?? id.slice(0, 12),
    image: textOrNull(config.Image),
    imageId: textOrNull(raw.Image),
    createdAt: textOrNull(raw.Created),
    status: textOrNull(state.Status),
    running: boolOrNull(state.Running) ?? state.Status === "running",
    healthy: healthStatus === null ? null : healthStatus === "healthy",
    healthStatus,
    exitCode: numberOrNull(state.ExitCode),
    startedAt: textOrNull(state.StartedAt),
    finishedAt: textOrNull(state.FinishedAt),
    labels,
  };
}

function parsePercent(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Docker uses decimal units in stats output (e.g. 17.4MiB / 12.24GiB). */
function parseBytes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "B").toUpperCase();
  const powers: Record<string, number> = {
    B: 0,
    KB: 1,
    MB: 2,
    GB: 3,
    TB: 4,
    PB: 5,
    KIB: 1,
    MIB: 2,
    GIB: 3,
    TIB: 4,
    PIB: 5,
  };
  const power = powers[unit];
  return power === undefined ? null : Math.round(amount * 1024 ** power);
}

function parseMemUsage(value: unknown): { usedBytes: number | null; limitBytes: number | null } {
  if (typeof value !== "string") return { usedBytes: null, limitBytes: null };
  const parts = value.split("/").map((part) => part.trim());
  return { usedBytes: parseBytes(parts[0]), limitBytes: parseBytes(parts[1]) };
}

async function dockerSnapshot(
  projectId: string,
  runDocker: (args: string[]) => Promise<CommandResult>,
): Promise<DockerSnapshot> {
  const projectLabel = `${PROJECT_LABEL}=${projectId}`;
  const ps = await runDocker([
    "ps",
    "--all",
    "--filter",
    `label=${projectLabel}`,
    "--format",
    "{{json .}}",
  ]);
  const psRows = parseJsonLines(ps.stdout);
  const ids = psRows.map((row) => textOrNull(row.ID)).filter((id): id is string => id !== null);
  const inspect = ids.length > 0 ? await runDocker(["inspect", ...ids]) : null;
  const containers =
    inspect === null
      ? []
      : parseInspect(inspect.stdout)
          .map(inspectToContainer)
          .filter((container): container is ContainerState => container !== null);
  const runningIds = containers
    .filter((container) => container.running)
    .map((container) => container.id);
  const stats =
    runningIds.length > 0
      ? await runDocker(["stats", "--no-stream", "--format", "{{json .}}", ...runningIds])
      : null;
  const statsRows = stats === null ? [] : parseJsonLines(stats.stdout);
  const parsedStats = statsRows.map((row) => {
    const memory = parseMemUsage(row.MemUsage);
    return {
      container: row.Name ?? row.Container ?? null,
      containerId: row.ID ?? row.ContainerID ?? null,
      cpuPercent: parsePercent(row.CPUPerc),
      memoryUsedBytes: memory.usedBytes,
      memoryLimitBytes: memory.limitBytes,
      memoryPercent: parsePercent(row.MemPerc),
      pids: numberOrNull(typeof row.PIDs === "string" ? Number(row.PIDs) : row.PIDs),
      raw: row,
    };
  });
  const cpuPercentTotal = parsedStats.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0);
  const memoryUsedBytesTotal = parsedStats.reduce(
    (sum, row) => sum + (row.memoryUsedBytes ?? 0),
    0,
  );
  const memoryLimitBytesTotal = parsedStats.reduce(
    (sum, row) => sum + (row.memoryLimitBytes ?? 0),
    0,
  );
  const unhealthy = containers.filter((container) => container.healthStatus === "unhealthy");
  return {
    projectLabel,
    containerCount: containers.length,
    runningServiceCount: containers.filter((container) => container.running).length,
    unhealthyServiceCount: unhealthy.length,
    containers,
    stats: {
      sampledAt: nowIso(),
      workloadCount: runningIds.length,
      cpuPercentTotal,
      memoryUsedBytesTotal,
      memoryLimitBytesTotal,
      containers: parsedStats,
      ...(stats === null
        ? {}
        : { rawStdout: stats.stdout, rawStderr: stats.stderr, exitCode: stats.exitCode }),
    },
    commands: {
      ps,
      ...(inspect === null ? {} : { inspect }),
      ...(stats === null ? {} : { stats }),
    },
  };
}

function commandOk(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.spawnError === undefined;
}

function makeResults(outputPath: string, runRoot: string, options: JsonRecord): Results {
  return {
    schemaVersion: 1,
    benchmark: "supabase-cli-legacy",
    status: "running",
    startedAt: nowIso(),
    cli: {},
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      dockerHost: process.env.DOCKER_HOST ?? null,
      dockerContext: process.env.DOCKER_CONTEXT ?? null,
    },
    options,
    runRoot,
    outputPath,
    measurements: [],
    events: [],
  };
}

function persist(results: Results): void {
  mkdirSync(resolve(results.outputPath, ".."), { recursive: true });
  const temporaryPath = `${results.outputPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, results.outputPath);
}

function recordEvent(results: Results, event: JsonRecord): void {
  results.events.push({ at: nowIso(), ...event });
  persist(results);
}

async function measureProject(
  results: Results,
  cli: string,
  projectDir: string,
  projectId: string,
  kind: Measurement["kind"],
  sample: number | null,
  timeoutMs: number,
  runDocker: (args: string[]) => Promise<CommandResult>,
  stopWithBackup: boolean,
  captureMemory: boolean,
): Promise<Measurement> {
  const env = makeChildEnv(projectDir);
  const startedAt = nowIso();
  recordEvent(results, { type: "start-begin", kind, sample, projectId, projectDir });
  const start = await runCommand(cli, ["start"], { cwd: projectDir, env, timeoutMs });
  const memory =
    captureMemory && kind === "fresh" && commandOk(start)
      ? await captureAtOffsets({
          runtime: "container",
          stackId: projectId,
          projectLabel: `${PROJECT_LABEL}=${projectId}`,
        })
      : undefined;
  const configText = (() => {
    try {
      return readFileSync(join(projectDir, "supabase", "config.toml"), "utf8");
    } catch {
      return "";
    }
  })();
  const actualProjectId = parseProjectId(configText, projectId);
  const config = readConfig(projectDir, actualProjectId);
  config.poolerEnabled = parseBoolean("BENCHMARK_ENABLE_POOLER", false);
  let docker: DockerSnapshot | null = null;
  try {
    docker = await dockerSnapshot(actualProjectId, runDocker);
  } catch (error) {
    config.dockerSnapshotError = error instanceof Error ? error.message : String(error);
  }
  const measurement: Measurement = {
    kind,
    sample,
    projectId: actualProjectId,
    projectDir,
    startedAt,
    start,
    docker,
    ...(memory === undefined ? {} : { memoryCapture: memory }),
    config,
    cleanup: null,
    cleanupRetained: null,
    ...(!commandOk(start)
      ? { error: start.spawnError ?? (start.stderr || `supabase start exited ${start.exitCode}`) }
      : {}),
  };
  results.measurements.push(measurement);
  persist(results);
  recordEvent(results, {
    type: "start-finished",
    kind,
    sample,
    projectId: actualProjectId,
    exitCode: start.exitCode,
    elapsedMs: start.elapsedMs,
    runningServiceCount: docker?.runningServiceCount ?? null,
    unhealthyServiceCount: docker?.unhealthyServiceCount ?? null,
  });

  // `stop --no-backup` is always project-scoped and is the only cleanup path
  // used for this project. A retained stop is used only for the optional
  // restart measurement and is followed by this destructive exact-project stop.
  const cleanup = await runCommand(
    cli,
    ["stop", "--project-id", actualProjectId, ...(stopWithBackup ? ["--no-backup"] : [])],
    { cwd: projectDir, env, timeoutMs },
  );
  measurement.cleanup = cleanup;
  persist(results);
  recordEvent(results, {
    type: "cleanup-finished",
    kind,
    sample,
    projectId: actualProjectId,
    noBackup: stopWithBackup,
    exitCode: cleanup.exitCode,
  });
  return measurement;
}

async function initProject(
  results: Results,
  cli: string,
  projectDir: string,
  projectId: string,
  timeoutMs: number,
): Promise<{ command: CommandResult; actualProjectId: string }> {
  const env = makeChildEnv(projectDir);
  const command = await runCommand(cli, ["init"], { cwd: projectDir, env, timeoutMs });
  const configText = (() => {
    try {
      return readFileSync(join(projectDir, "supabase", "config.toml"), "utf8");
    } catch {
      return "";
    }
  })();
  const actualProjectId = parseProjectId(configText, projectId);
  recordEvent(results, {
    type: "init-finished",
    projectId: actualProjectId,
    projectDir,
    exitCode: command.exitCode,
    elapsedMs: command.elapsedMs,
    stdout: command.stdout,
    stderr: command.stderr,
  });
  if (!commandOk(command)) {
    throw new Error(
      command.spawnError ?? (command.stderr || `supabase init exited ${command.exitCode}`),
    );
  }
  return { command, actualProjectId };
}

async function main(): Promise<void> {
  const cli = process.env.BENCHMARK_CLI;
  if (!cli) throw new Error("BENCHMARK_CLI must point to the published supabase executable");
  const outputPath = resolve(envValue("BENCHMARK_OUTPUT", DEFAULT_OUTPUT));
  const runRoot = resolve(
    envValue(
      "BENCHMARK_RUN_ROOT",
      join(DEFAULT_RUN_ROOT, `legacy-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`),
    ),
  );
  const samples = parsePositiveInt("BENCHMARK_SAMPLES", 3);
  const timeoutMs = parsePositiveInt("BENCHMARK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const retainedRestart = parseBoolean("BENCHMARK_RESTART", false);
  const captureMemory = parseBoolean("BENCHMARK_MEMORY", false);
  const enablePoolerOption = parseBoolean("BENCHMARK_ENABLE_POOLER", false);
  const skipWarmup = parseBoolean("BENCHMARK_SKIP_WARMUP", false);
  mkdirSync(runRoot, { recursive: true });
  const options = {
    samples,
    retainedRestart,
    skipWarmup,
    timeoutMs,
    sampling: captureMemory
      ? "docker stats plus exact-container process RSS/PSS observations at 30/35/40 seconds after successful fresh start readiness"
      : "single docker stats --no-stream sample immediately after supabase start readiness",
    memoryCapture: captureMemory,
    poolerEnabled: enablePoolerOption,
    startTiming:
      "supabase executable process spawn through exit; excludes pnpm launcher/install, init, and image warming",
    cleanup: "supabase stop --project-id <exact config project_id> --no-backup; never --all",
    projectData:
      "fresh project directory and fresh data volumes per sample; images reused after warmup",
  };
  const results = makeResults(outputPath, runRoot, options);
  persist(results);
  const runDocker = (args: string[]) => runCommand("docker", args, { timeoutMs });
  let activeProjectDir: string | null = null;
  let activeProjectId: string | null = null;

  try {
    const version = await runCommand(cli, ["--version"], { timeoutMs });
    results.cli = {
      path: cli,
      version: version.stdout.trim() || version.stderr.trim(),
      versionCommand: version,
    };
    persist(results);

    // Warm images exactly once before measured samples. Its timing is retained
    // as a warmup record but is excluded from fresh/restart measurements.
    if (!skipWarmup) {
      const warmupId = `legacybench-${Date.now()}-warmup-${randomUUID().slice(0, 8)}`;
      const warmupDir = join(runRoot, warmupId);
      activeProjectDir = warmupDir;
      activeProjectId = warmupId;
      mkdirSync(warmupDir, { recursive: true });
      const warmupInit = await initProject(results, cli, warmupDir, warmupId, timeoutMs);
      if (enablePoolerOption) enablePooler(warmupDir);
      activeProjectId = warmupInit.actualProjectId;
      const warmup = await measureProject(
        results,
        cli,
        warmupDir,
        warmupInit.actualProjectId,
        "warmup",
        null,
        timeoutMs,
        runDocker,
        true,
        false,
      );
      if (!commandOk(warmup.start) || !commandOk(warmup.cleanup!)) {
        throw new Error("warmup did not complete successfully; measured samples were not started");
      }
    }

    for (let sample = 1; sample <= samples; sample++) {
      const projectId = `legacybench-${Date.now()}-${sample}-${randomUUID().slice(0, 8)}`;
      const projectDir = join(runRoot, projectId);
      activeProjectDir = projectDir;
      activeProjectId = projectId;
      mkdirSync(projectDir, { recursive: true });
      const initialized = await initProject(results, cli, projectDir, projectId, timeoutMs);
      if (enablePoolerOption) enablePooler(projectDir);
      activeProjectId = initialized.actualProjectId;
      const fresh = await measureProject(
        results,
        cli,
        projectDir,
        initialized.actualProjectId,
        "fresh",
        sample,
        timeoutMs,
        runDocker,
        !retainedRestart,
        captureMemory,
      );
      if (!commandOk(fresh.start) || !commandOk(fresh.cleanup!)) {
        throw new Error(
          `fresh sample ${sample} failed: start=${fresh.start.exitCode}, cleanup=${fresh.cleanup?.exitCode}`,
        );
      }
      if (retainedRestart) {
        // The first stop retained volumes. Time the exact same project's
        // restart, then always remove its data in the final stop below.
        const env = makeChildEnv(projectDir);
        const retained = await runCommand(cli, ["start"], { cwd: projectDir, env, timeoutMs });
        let docker: DockerSnapshot | null = null;
        try {
          docker = await dockerSnapshot(fresh.projectId, runDocker);
        } catch (error) {
          fresh.config.retainedDockerSnapshotError =
            error instanceof Error ? error.message : String(error);
        }
        const restart: Measurement = {
          kind: "retained-data-restart",
          sample,
          projectId: fresh.projectId,
          projectDir,
          startedAt: nowIso(),
          start: retained,
          docker,
          config: readConfig(projectDir, fresh.projectId),
          cleanup: null,
          cleanupRetained: null,
          ...(!commandOk(retained)
            ? {
                error:
                  retained.spawnError ??
                  (retained.stderr || `supabase start exited ${retained.exitCode}`),
              }
            : {}),
        };
        results.measurements.push(restart);
        persist(results);
        recordEvent(results, {
          type: "retained-restart-finished",
          sample,
          projectId: fresh.projectId,
          exitCode: retained.exitCode,
          elapsedMs: retained.elapsedMs,
          runningServiceCount: docker?.runningServiceCount ?? null,
          unhealthyServiceCount: docker?.unhealthyServiceCount ?? null,
        });
        const cleanup = await runCommand(
          cli,
          ["stop", "--project-id", fresh.projectId, "--no-backup"],
          { cwd: projectDir, env, timeoutMs },
        );
        restart.cleanup = cleanup;
        fresh.cleanupRetained = cleanup;
        persist(results);
        recordEvent(results, {
          type: "retained-cleanup-finished",
          sample,
          projectId: fresh.projectId,
          noBackup: true,
          exitCode: cleanup.exitCode,
        });
        if (!commandOk(retained) || !commandOk(cleanup)) {
          throw new Error(
            `retained restart sample ${sample} failed: start=${retained.exitCode}, cleanup=${cleanup.exitCode}`,
          );
        }
      }
    }
    results.status = "completed";
    results.finishedAt = nowIso();
    persist(results);
  } catch (error) {
    if (activeProjectDir !== null && activeProjectId !== null) {
      const forcedCleanup = await runCommand(
        cli,
        ["stop", "--project-id", activeProjectId, "--no-backup"],
        { cwd: activeProjectDir, env: makeChildEnv(activeProjectDir), timeoutMs },
      );
      recordEvent(results, {
        type: "failure-cleanup-finished",
        projectId: activeProjectId,
        projectDir: activeProjectDir,
        noBackup: true,
        exitCode: forcedCleanup.exitCode,
        stderr: forcedCleanup.stderr,
      });
    }
    results.status = "failed";
    results.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    results.finishedAt = nowIso();
    persist(results);
    throw error;
  }
}

if (import.meta.main) {
  await main();
}
