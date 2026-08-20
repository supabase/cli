import type { ExternalCleanupAction } from "@supabase/process-compose";
import { execFileSync } from "node:child_process";
import { Effect } from "effect";
import type { ContainerRuntime } from "../ContainerRuntime.ts";

export const dockerServiceCleanup = (
  runtime: ContainerRuntime,
  containerName: string,
): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      execFileSync(runtime, ["rm", "-f", containerName], {
        stdio: "ignore",
        timeout: 5_000,
      });
    } catch {}
  });

export const dockerServiceOrphanCleanup = (
  runtime: ContainerRuntime,
  containerName: string,
): ReadonlyArray<ExternalCleanupAction> => [
  {
    _tag: "RunCommand",
    executable: runtime,
    args: ["rm", "-f", containerName],
    timeoutMs: 5_000,
  },
];

export const removePathOnOrphanCleanup = (
  path: string,
  opts: {
    readonly recursive?: boolean;
    readonly force?: boolean;
  } = {},
): ReadonlyArray<ExternalCleanupAction> => [
  { _tag: "RemovePath", path, recursive: opts.recursive, force: opts.force },
];
