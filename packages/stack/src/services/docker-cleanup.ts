import type { ExternalCleanupAction } from "@supabase/process-compose";
import { execFileSync } from "node:child_process";
import { Effect } from "effect";
import type { ContainerRuntime } from "../ContainerRuntime.ts";

export interface DockerDataOwnershipCleanup {
  readonly runtime: ContainerRuntime;
  readonly image: string;
  readonly hostPath: string;
  readonly containerPath: string;
  readonly uid: number;
  readonly gid: number;
  /** Remove the host path after restoring its ownership (orphan cleanup only). */
  readonly removeHostPath?: boolean;
}

const ownershipArgs = (opts: DockerDataOwnershipCleanup): ReadonlyArray<string> => [
  "run",
  "--rm",
  "--user",
  "0",
  "-v",
  `${opts.hostPath}:${opts.containerPath}`,
  "--entrypoint",
  "/usr/bin/sh",
  opts.image,
  "-ec",
  `busybox chown -R ${opts.uid}:${opts.gid} ${opts.containerPath}`,
];

const restoreOwnership = (opts: DockerDataOwnershipCleanup): void => {
  execFileSync(opts.runtime, ownershipArgs(opts), {
    stdio: "ignore",
    timeout: 30_000,
  });
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const orphanCleanupScript = (
  containerName: string,
  opts: DockerDataOwnershipCleanup,
): ReadonlyArray<string> => {
  const ownershipCommand = [
    shellQuote(opts.runtime),
    "run",
    "--rm",
    "--user",
    "0",
    "-v",
    `"$1:${opts.containerPath}"`,
    "--entrypoint",
    shellQuote("/usr/bin/sh"),
    shellQuote(opts.image),
    "-ec",
    shellQuote(`busybox chown -R ${opts.uid}:${opts.gid} ${opts.containerPath}`),
  ].join(" ");

  const script = [
    `${shellQuote(opts.runtime)} rm -f ${shellQuote(containerName)} >/dev/null 2>&1 || true`,
    ownershipCommand,
    ...(opts.removeHostPath ? ['rm -rf -- "$1"'] : []),
  ].join("\n");

  // `$0` is the descriptive shell name and `$1` is the path supplied by the
  // caller. Passing the path as an argument avoids interpolating host paths in
  // the script while keeping the ownership and removal operations ordered.
  return ["-ec", script, "supabase-stack-docker-cleanup", opts.hostPath];
};

export const dockerServiceCleanup = (
  runtime: ContainerRuntime,
  containerName: string,
  ownership?: DockerDataOwnershipCleanup,
): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      execFileSync(runtime, ["rm", "-f", containerName], {
        stdio: "ignore",
        timeout: 5_000,
      });
    } catch {}

    if (ownership !== undefined) {
      // Preserve the cleanup failure so process-compose records it in the
      // service log. A missing container is harmless, but a failed ownership
      // bridge leaves the mounted data unusable by native mode.
      restoreOwnership(ownership);
    }
  });

export const dockerServiceOrphanCleanup = (
  runtime: ContainerRuntime,
  containerName: string,
  ownership?: DockerDataOwnershipCleanup,
): ReadonlyArray<ExternalCleanupAction> =>
  ownership === undefined
    ? [
        {
          _tag: "RunCommand",
          executable: runtime,
          args: ["rm", "-f", containerName],
          timeoutMs: 5_000,
        },
      ]
    : [
        {
          _tag: "RunCommand",
          executable: "/bin/sh",
          args: orphanCleanupScript(containerName, ownership),
          timeoutMs: 30_000,
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
