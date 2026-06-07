import type { ExternalCleanupAction } from "@supabase/process-compose";
import { execFileSync } from "node:child_process";
import { Effect } from "effect";

export const dockerServiceCleanup = (containerName: string): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      execFileSync("docker", ["rm", "-f", containerName], {
        stdio: "ignore",
        timeout: 5_000,
      });
    } catch {}
  });

export const dockerServiceOrphanCleanup = (
  containerName: string,
): ReadonlyArray<ExternalCleanupAction> => [{ _tag: "DockerRemove", containerName }];

export const removePathOnOrphanCleanup = (
  path: string,
  opts: {
    readonly recursive?: boolean;
    readonly force?: boolean;
  } = {},
): ReadonlyArray<ExternalCleanupAction> => [
  { _tag: "RemovePath", path, recursive: opts.recursive, force: opts.force },
];
