import { execSync } from "node:child_process";
import { prefetch } from "@supabase/stack";

function hasDockerDaemon(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  const warmups = [prefetch()];

  if (hasDockerDaemon()) {
    warmups.push(prefetch({ mode: "docker" }));
  }

  await Promise.all(warmups);
}
