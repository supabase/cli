// oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- E2e warmup invokes the native package manager/process boundary.

import { execSync } from "node:child_process";
import { prefetch, type PrefetchOptions, type PrefetchResult } from "../../src/node.ts";

interface WarmupLogger {
  warn(message: string): void;
}

interface WarmStackE2eDependenciesOptions {
  readonly failOnError?: boolean;
  readonly hasDockerDaemon?: () => boolean;
  readonly logger?: WarmupLogger;
  readonly prefetch?: (options?: PrefetchOptions) => Promise<PrefetchResult>;
}

export function hasDockerDaemon(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

export async function warmStackE2eDependencies(
  options: WarmStackE2eDependenciesOptions = {},
): Promise<void> {
  const logger = options.logger ?? console;
  const prefetchDeps = options.prefetch ?? prefetch;
  const shouldFailOnError = options.failOnError ?? false;
  const dockerAvailable = (options.hasDockerDaemon ?? hasDockerDaemon)();

  const modes: PrefetchOptions[] = [{ mode: "native" }];
  if (dockerAvailable) modes.push({ mode: "docker" });

  for (const mode of modes) {
    try {
      await prefetchDeps(mode);
    } catch (error) {
      logger.warn(
        `[stack-e2e] Warmup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (shouldFailOnError) {
        throw error;
      }
    }
  }
}
