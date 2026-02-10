import { spawn } from "bun";
import type { ProbeConfig, ExecProbeConfig, HttpProbeConfig } from "../types.ts";

type ProbeResult = "success" | "failure";

/**
 * Execute an HTTP GET health probe
 */
async function checkHttpProbe(config: HttpProbeConfig, timeout: number): Promise<ProbeResult> {
  const port = typeof config.port === "string" ? parseInt(config.port, 10) : config.port;
  const url = `${config.scheme}://${config.host}:${port}${config.path}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    return response.ok ? "success" : "failure";
  } catch {
    return "failure";
  }
}

/**
 * Execute an exec health probe
 */
async function checkExecProbe(
  config: ExecProbeConfig,
  timeout: number,
  env?: Record<string, string>,
): Promise<ProbeResult> {
  try {
    const proc = spawn({
      cmd: ["sh", "-c", config.command],
      env: { ...Bun.env, ...env },
      stdout: "ignore",
      stderr: "ignore",
    });

    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => {
        setTimeout(() => {
          proc.kill();
          resolve(-1);
        }, timeout * 1000);
      }),
    ]);

    return exitCode === 0 ? "success" : "failure";
  } catch {
    return "failure";
  }
}

export interface ProbeRunner {
  start(): void;
  stop(): void;
  isHealthy(): boolean;
  waitUntilHealthy(timeout?: number): Promise<boolean>;
}

/**
 * Create a probe runner that periodically checks health
 */
export function createProbeRunner(
  config: ProbeConfig,
  env?: Record<string, string>,
  onHealthChange?: (healthy: boolean) => void,
): ProbeRunner {
  let healthy = false;
  let running = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let successCount = 0;
  let failureCount = 0;
  let _initialDelayDone = false;
  const healthyWaiters: Array<(healthy: boolean) => void> = [];

  const successThreshold = config.success_threshold ?? 1;
  const failureThreshold = config.failure_threshold ?? 3;
  const periodSeconds = config.period_seconds ?? 10;
  const timeoutSeconds = config.timeout_seconds ?? 1;
  const initialDelaySeconds = config.initial_delay_seconds ?? 0;

  async function check(): Promise<void> {
    let result: ProbeResult;

    if (config.http_get) {
      result = await checkHttpProbe(config.http_get, timeoutSeconds);
    } else if (config.exec) {
      result = await checkExecProbe(config.exec, timeoutSeconds, env);
    } else {
      return;
    }

    if (result === "success") {
      successCount++;
      failureCount = 0;

      if (!healthy && successCount >= successThreshold) {
        healthy = true;
        onHealthChange?.(true);
        // Notify waiters
        for (const waiter of healthyWaiters) {
          waiter(true);
        }
        healthyWaiters.length = 0;
      }
    } else {
      failureCount++;
      successCount = 0;

      if (healthy && failureCount >= failureThreshold) {
        healthy = false;
        onHealthChange?.(false);
      }
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    healthy = false;
    successCount = 0;
    failureCount = 0;
    _initialDelayDone = false;

    // Initial delay before first check
    setTimeout(() => {
      if (!running) return;
      _initialDelayDone = true;

      // First check
      void check();

      // Periodic checks
      intervalId = setInterval(check, periodSeconds * 1000);
    }, initialDelaySeconds * 1000);
  }

  function stop(): void {
    running = false;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    // Reject any waiters
    for (const waiter of healthyWaiters) {
      waiter(false);
    }
    healthyWaiters.length = 0;
  }

  function isHealthy(): boolean {
    return healthy;
  }

  function waitUntilHealthy(timeout?: number): Promise<boolean> {
    if (healthy) return Promise.resolve(true);

    return new Promise((resolve) => {
      healthyWaiters.push(resolve);

      if (timeout) {
        setTimeout(() => {
          const idx = healthyWaiters.indexOf(resolve);
          if (idx >= 0) {
            healthyWaiters.splice(idx, 1);
            resolve(false);
          }
        }, timeout);
      }
    });
  }

  return { start, stop, isHealthy, waitUntilHealthy };
}
