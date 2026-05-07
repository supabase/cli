import { execSync } from "node:child_process";
import { prefetch } from "@supabase/stack";

async function timedWarmup(label: string, warmup: Promise<unknown>): Promise<void> {
  const startedAt = Date.now();
  console.info(`[cli-e2e-global-setup] ${label} warmup started`);
  await warmup;
  console.info(`[cli-e2e-global-setup] ${label} warmup finished in ${Date.now() - startedAt}ms`);
}

function hasDockerDaemon(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  const startedAt = Date.now();
  const dockerAvailable = hasDockerDaemon();
  console.info(
    `[cli-e2e-global-setup] warming stack assets; dockerAvailable=${String(dockerAvailable)}`,
  );

  const warmups = [timedWarmup("auto", prefetch())];

  if (dockerAvailable) {
    warmups.push(timedWarmup("docker", prefetch({ mode: "docker" })));
  }

  await Promise.all(warmups);
  console.info(`[cli-e2e-global-setup] all warmups finished in ${Date.now() - startedAt}ms`);
}
