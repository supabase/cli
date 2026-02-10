// Main exports
export { loadConfig, parseEnvironment } from "./config/loader.ts";
export { createOrchestrator, type Orchestrator } from "./core/orchestrator.ts";
export { createApiServer, type ApiServer } from "./api/server.ts";
export { createLogger, type Logger } from "./logging/logger.ts";

// Type exports
export type {
  ProjectConfig,
  ProcessConfig,
  DependencyConfig,
  ProbeConfig,
  ExecProbeConfig,
  HttpProbeConfig,
  ShutdownConfig,
  AvailabilityConfig,
  ProcessStatus,
  HealthStatus,
  ProcessState,
  ProcessesState,
  LogsResponse,
  ProcessEvent,
} from "./types.ts";

// Convenience function to start everything
export interface ProcessComposeOptions {
  configPath: string;
  apiPort?: number;
  startApi?: boolean;
}

export interface ProcessCompose {
  orchestrator: import("./core/orchestrator.ts").Orchestrator;
  api: import("./api/server.ts").ApiServer | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Create and start a process-compose instance from a YAML file
 */
export async function createProcessCompose(
  options: ProcessComposeOptions,
): Promise<ProcessCompose> {
  const { loadConfig } = await import("./config/loader.ts");
  const { createOrchestrator } = await import("./core/orchestrator.ts");
  const { createApiServer } = await import("./api/server.ts");

  const config = await loadConfig(options.configPath);
  const orchestrator = createOrchestrator(config);

  const api =
    options.startApi !== false ? createApiServer(orchestrator, options.apiPort ?? 8080) : null;

  let stopped = false;

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;

    // Remove signal handlers to allow process to exit
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);

    await orchestrator.stop();
    if (api) {
      api.stop();
    }
  }

  async function handleSignal(): Promise<void> {
    console.log("\nReceived shutdown signal, stopping...");
    await stop();
    process.exit(0);
  }

  async function start(): Promise<void> {
    if (api) {
      api.start();
    }
    await orchestrator.start();
  }

  // Handle shutdown signals
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return {
    orchestrator,
    api,
    start,
    stop,
  };
}
