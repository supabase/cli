import type { ProjectConfig, ProcessConfig } from "../types.ts";

/**
 * Load and parse a process-compose YAML file using Bun's native YAML parser
 */
export async function loadConfig(filePath: string): Promise<ProjectConfig> {
  const file = Bun.file(filePath);
  const content = await file.text();

  // Use Bun's native YAML parser
  const config = Bun.YAML.parse(content) as ProjectConfig;

  // Apply defaults and transformations
  for (const [name, process] of Object.entries(config.processes)) {
    config.processes[name] = applyDefaults(name, process);
  }

  // Validate configuration
  validateConfig(config);

  return config;
}

/**
 * Apply default values to process configuration
 */
function applyDefaults(name: string, process: ProcessConfig): ProcessConfig {
  return {
    ...process,
    shutdown: {
      signal: process.shutdown?.signal ?? 15, // SIGTERM
      timeout_seconds: process.shutdown?.timeout_seconds ?? 10,
    },
    availability: {
      restart: process.availability?.restart ?? "no",
      backoff_seconds: process.availability?.backoff_seconds ?? 1,
      max_restarts: process.availability?.max_restarts ?? 0,
    },
    readiness_probe: process.readiness_probe
      ? {
          ...process.readiness_probe,
          initial_delay_seconds: process.readiness_probe.initial_delay_seconds ?? 0,
          period_seconds: process.readiness_probe.period_seconds ?? 10,
          timeout_seconds: process.readiness_probe.timeout_seconds ?? 1,
          success_threshold: process.readiness_probe.success_threshold ?? 1,
          failure_threshold: process.readiness_probe.failure_threshold ?? 3,
        }
      : undefined,
  };
}

/**
 * Validate the configuration for errors
 */
function validateConfig(config: ProjectConfig): void {
  const processNames = new Set(Object.keys(config.processes));

  for (const [name, process] of Object.entries(config.processes)) {
    // Validate dependencies exist
    if (process.depends_on) {
      for (const depName of Object.keys(process.depends_on)) {
        if (!processNames.has(depName)) {
          throw new Error(`Process "${name}" depends on unknown process "${depName}"`);
        }
        if (depName === name) {
          throw new Error(`Process "${name}" cannot depend on itself`);
        }
      }
    }

    // Validate probe configuration
    if (process.readiness_probe) {
      if (!process.readiness_probe.exec && !process.readiness_probe.http_get) {
        throw new Error(`Process "${name}" readiness_probe must have either exec or http_get`);
      }
    }
  }

  // Check for circular dependencies
  detectCircularDependencies(config);
}

/**
 * Detect circular dependencies using DFS
 */
function detectCircularDependencies(config: ProjectConfig): void {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(name: string, path: string[]): void {
    if (recursionStack.has(name)) {
      throw new Error(`Circular dependency detected: ${[...path, name].join(" -> ")}`);
    }
    if (visited.has(name)) {
      return;
    }

    visited.add(name);
    recursionStack.add(name);

    const process = config.processes[name];
    if (process?.depends_on) {
      for (const depName of Object.keys(process.depends_on)) {
        dfs(depName, [...path, name]);
      }
    }

    recursionStack.delete(name);
  }

  for (const name of Object.keys(config.processes)) {
    dfs(name, []);
  }
}

/**
 * Parse environment variables from list format to Record
 */
export function parseEnvironment(env?: string[]): Record<string, string> {
  if (!env) return {};

  const result: Record<string, string> = {};
  for (const item of env) {
    const eqIndex = item.indexOf("=");
    if (eqIndex > 0) {
      const key = item.substring(0, eqIndex);
      const value = item.substring(eqIndex + 1);
      result[key] = value;
    }
  }
  return result;
}
