import type { ProjectConfig, ProcessesState, ProcessState } from "../types.ts";
import { createProcess, type Process } from "./process.ts";
import { createLogger } from "../logging/logger.ts";

export interface Orchestrator {
  readonly projectName: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  startProcess(name: string): Promise<void>;
  stopProcess(name: string): Promise<void>;
  restartProcess(name: string): Promise<void>;
  getProcessState(name: string): ProcessState | null;
  getProcessesState(): ProcessesState;
  getProcessLogs(name: string, offset?: number, limit?: number): string[];
  truncateProcessLogs(name: string): void;
}

export function createOrchestrator(config: ProjectConfig): Orchestrator {
  const processes = new Map<string, Process>();
  const logger = createLogger(config.log_location);
  let isRunning = false;

  // Initialize all processes
  for (const [name, processConfig] of Object.entries(config.processes)) {
    const process = createProcess(name, processConfig, logger);
    processes.set(name, process);
  }

  /**
   * Start all processes respecting dependencies
   */
  async function start(): Promise<void> {
    if (isRunning) return;
    isRunning = true;

    // Get processes in dependency order
    const startOrder = getStartOrder(config);

    // Start processes in parallel where possible
    const started = new Set<string>();
    const starting = new Map<string, Promise<void>>();

    async function startWithDeps(name: string): Promise<void> {
      if (started.has(name)) return;
      if (starting.has(name)) {
        await starting.get(name);
        return;
      }

      const process = processes.get(name);
      if (!process) return;

      // Wait for dependencies first
      const deps = process.config.depends_on;
      if (deps) {
        await Promise.all(
          Object.entries(deps).map(async ([depName, depConfig]) => {
            // Ensure dependency is started
            await startWithDeps(depName);

            const depProcess = processes.get(depName);
            if (!depProcess) return;

            // Wait for condition
            switch (depConfig.condition) {
              case "process_started":
                await depProcess.waitForStarted();
                break;
              case "process_healthy":
                const healthy = await depProcess.waitUntilHealthy(60000);
                if (!healthy) {
                  throw new Error(`Dependency "${depName}" did not become healthy`);
                }
                break;
              case "process_completed":
                await depProcess.waitForCompletion();
                break;
              case "process_completed_successfully":
                const code = await depProcess.waitForCompletion();
                if (code !== 0) {
                  throw new Error(`Dependency "${depName}" failed with exit code ${code}`);
                }
                break;
            }
          }),
        );
      }

      // Start this process
      const startPromise = process.start();
      starting.set(name, startPromise);

      // Don't await here - let it run
      startPromise
        .catch((err) => {
          console.error(`Failed to start process "${name}":`, err);
        })
        .finally(() => {
          started.add(name);
          starting.delete(name);
        });

      // Wait until the process is at least started
      await process.waitForStarted();
      started.add(name);
    }

    // Start all processes
    for (const name of startOrder) {
      try {
        await startWithDeps(name);
      } catch (err) {
        console.error(`Failed to start "${name}":`, err);
      }
    }
  }

  /**
   * Stop all processes in reverse dependency order
   */
  async function stop(): Promise<void> {
    if (!isRunning) return;
    isRunning = false;

    // Stop in reverse dependency order
    const stopOrder = getStartOrder(config).reverse();

    for (const name of stopOrder) {
      const process = processes.get(name);
      if (process) {
        try {
          await process.stop();
        } catch (err) {
          console.error(`Failed to stop process "${name}":`, err);
        }
      }
    }

    await logger.close();
  }

  /**
   * Start a single process
   */
  async function startProcess(name: string): Promise<void> {
    const process = processes.get(name);
    if (!process) {
      throw new Error(`Process "${name}" not found`);
    }
    // Start the process without blocking until exit
    process.start().catch((err) => {
      console.error(`Process "${name}" failed:`, err);
    });
    // Only wait until it's running
    await process.waitForStarted();
  }

  /**
   * Stop a single process
   */
  async function stopProcess(name: string): Promise<void> {
    const process = processes.get(name);
    if (!process) {
      throw new Error(`Process "${name}" not found`);
    }
    await process.stop();
  }

  /**
   * Restart a single process
   */
  async function restartProcess(name: string): Promise<void> {
    const process = processes.get(name);
    if (!process) {
      throw new Error(`Process "${name}" not found`);
    }
    await process.restart();
  }

  /**
   * Get state of a single process
   */
  function getProcessState(name: string): ProcessState | null {
    const process = processes.get(name);
    return process ? process.getState() : null;
  }

  /**
   * Get state of all processes
   */
  function getProcessesState(): ProcessesState {
    const states: ProcessState[] = [];
    for (const process of processes.values()) {
      states.push(process.getState());
    }
    return { data: states };
  }

  /**
   * Get logs for a process
   */
  function getProcessLogs(name: string, offset = 0, limit = 100): string[] {
    return logger.getProcessLogs(name, offset, limit);
  }

  /**
   * Truncate logs for a process
   */
  function truncateProcessLogs(name: string): void {
    logger.truncateProcessLogs(name);
  }

  return {
    projectName: config.name,
    start,
    stop,
    startProcess,
    stopProcess,
    restartProcess,
    getProcessState,
    getProcessesState,
    getProcessLogs,
    truncateProcessLogs,
  };
}

/**
 * Get topological sort order for starting processes
 */
function getStartOrder(config: ProjectConfig): string[] {
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);

    const process = config.processes[name];
    if (process?.depends_on) {
      for (const depName of Object.keys(process.depends_on)) {
        visit(depName);
      }
    }

    order.push(name);
  }

  for (const name of Object.keys(config.processes)) {
    visit(name);
  }

  return order;
}
