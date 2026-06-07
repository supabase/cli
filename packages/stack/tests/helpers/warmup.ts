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
    execSync("docker info", { stdio: "ignore" });
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

  try {
    const warmups = [prefetchDeps()];
    if (dockerAvailable) {
      warmups.push(prefetchDeps({ mode: "docker" }));
    }
    await Promise.all(warmups);
  } catch (error) {
    logger.warn(
      `[stack-e2e] Warmup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (shouldFailOnError) {
      throw error;
    }
  }
}
