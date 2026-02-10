import { EventEmitter } from "node:events";
import type { ProcessConfig, ProcessStatus, HealthStatus, ProcessState } from "../types.ts";
import { spawnProcess, type SpawnedProcess } from "./executor.ts";
import { createProbeRunner, type ProbeRunner } from "../health/probes.ts";
import { parseEnvironment } from "../config/loader.ts";
import type { Logger } from "../logging/logger.ts";

export interface Process {
  readonly name: string;
  readonly config: ProcessConfig;
  getState(): ProcessState;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  waitForStarted(): Promise<void>;
  waitForCompletion(): Promise<number>;
  waitUntilHealthy(timeout?: number): Promise<boolean>;
  on(event: "stateChange", handler: (state: ProcessState) => void): void;
  off(event: "stateChange", handler: (state: ProcessState) => void): void;
}

export function createProcess(name: string, config: ProcessConfig, logger: Logger): Process {
  const emitter = new EventEmitter();

  let status: ProcessStatus = "Pending";
  let health: HealthStatus = "Unknown";
  let restarts = 0;
  let exitCode = 0;
  let pid = 0;
  let startedAt: number | undefined;
  let spawned: SpawnedProcess | null = null;
  let probeRunner: ProbeRunner | null = null;
  let stopRequested = false;

  // Waiters
  const startedWaiters: Array<() => void> = [];
  const completionWaiters: Array<(code: number) => void> = [];

  const env = parseEnvironment(config.environment);

  function getState(): ProcessState {
    return {
      name,
      status,
      health,
      hasHealthProbe: !!config.readiness_probe,
      restarts,
      exitCode,
      pid,
      isRunning: status === "Running" || status === "Ready" || status === "Launching",
      startedAt,
      age: startedAt ? Date.now() - startedAt : 0,
    };
  }

  function setStatus(newStatus: ProcessStatus): void {
    status = newStatus;
    emitter.emit("stateChange", getState());
  }

  function setHealth(newHealth: HealthStatus): void {
    health = newHealth;
    emitter.emit("stateChange", getState());
  }

  async function start(): Promise<void> {
    if (status === "Running" || status === "Ready" || status === "Launching") {
      return;
    }

    stopRequested = false;
    setStatus("Launching");

    try {
      spawned = spawnProcess({
        command: config.command,
        env,
        onStdout: (data) => logger.log(name, "stdout", data),
        onStderr: (data) => logger.log(name, "stderr", data),
      });

      pid = spawned.pid;
      startedAt = Date.now();
      setStatus("Running");

      // Notify started waiters
      for (const waiter of startedWaiters) {
        waiter();
      }
      startedWaiters.length = 0;

      // Start health probe if configured
      if (config.readiness_probe) {
        probeRunner = createProbeRunner(config.readiness_probe, env, (healthy) => {
          setHealth(healthy ? "Ready" : "Not Ready");
          if (healthy && status === "Running") {
            setStatus("Ready");
          }
        });
        probeRunner.start();
      } else {
        // No probe = immediately healthy
        setHealth("Ready");
        setStatus("Ready");
      }

      // Wait for process to exit
      const code = await spawned.waitForExit();
      exitCode = code;

      // Stop probe
      if (probeRunner) {
        probeRunner.stop();
        probeRunner = null;
      }

      spawned = null;
      pid = 0;
      setHealth("Unknown");

      // Notify completion waiters
      for (const waiter of completionWaiters) {
        waiter(code);
      }
      completionWaiters.length = 0;

      // Handle restart policy
      if (!stopRequested && shouldRestart(code)) {
        restarts++;
        const backoff = config.availability?.backoff_seconds ?? 1;
        setStatus("Restarting");
        await sleep(backoff * 1000);
        if (!stopRequested) {
          await start();
        }
      } else {
        setStatus(code === 0 ? "Completed" : "Error");
      }
    } catch (error) {
      setStatus("Error");
      logger.log(name, "stderr", `Failed to start: ${String(error)}`);
    }
  }

  function shouldRestart(code: number): boolean {
    const restart = config.availability?.restart ?? "no";
    const maxRestarts = config.availability?.max_restarts ?? 0;

    if (restart === "no") return false;
    if (maxRestarts > 0 && restarts >= maxRestarts) return false;

    if (restart === "always") return true;
    if (restart === "on_failure" && code !== 0) return true;

    return false;
  }

  async function stop(): Promise<void> {
    stopRequested = true;

    if (!spawned) {
      setStatus("Completed");
      return;
    }

    setStatus("Terminating");

    // Stop health probe
    if (probeRunner) {
      probeRunner.stop();
      probeRunner = null;
    }

    const signal = config.shutdown?.signal ?? 15;
    const timeout = config.shutdown?.timeout_seconds ?? 10;

    // Send signal
    spawned.kill(signal);

    // Wait for exit with timeout
    const exited = await Promise.race([
      spawned.waitForExit().then(() => true),
      sleep(timeout * 1000).then(() => false),
    ]);

    // Force kill if still running
    if (!exited && spawned) {
      spawned.kill(9); // SIGKILL
      await spawned.waitForExit();
    }

    spawned = null;
    pid = 0;
    setStatus("Completed");
  }

  async function restart(): Promise<void> {
    await stop();
    restarts++;
    await start();
  }

  function waitForStarted(): Promise<void> {
    if (status === "Running" || status === "Ready") {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      startedWaiters.push(resolve);
    });
  }

  function waitForCompletion(): Promise<number> {
    if (status === "Completed" || status === "Error") {
      return Promise.resolve(exitCode);
    }

    return new Promise((resolve) => {
      completionWaiters.push(resolve);
    });
  }

  function waitUntilHealthy(timeout?: number): Promise<boolean> {
    if (health === "Ready") {
      return Promise.resolve(true);
    }

    if (probeRunner) {
      return probeRunner.waitUntilHealthy(timeout);
    }

    // No probe, wait for process to be running
    return waitForStarted().then(() => true);
  }

  function on(event: "stateChange", handler: (state: ProcessState) => void): void {
    emitter.on(event, handler);
  }

  function off(event: "stateChange", handler: (state: ProcessState) => void): void {
    emitter.off(event, handler);
  }

  return {
    name,
    config,
    getState,
    start,
    stop,
    restart,
    waitForStarted,
    waitForCompletion,
    waitUntilHealthy,
    on,
    off,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
