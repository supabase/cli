import { Effect, Option } from "effect";

import { LegacyNetworkIdFlag } from "../../../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";

/**
 * Runs a pg_dump / pg_dumpall bash script in a one-shot container, streaming its
 * stdout chunk-by-chunk to `onStdout` and teeing stderr live, returning the exit
 * code + captured stderr for failure classification. Mirrors Go's `dockerExec`
 * (`apps/cli-go/internal/db/dump/dump.go`): host networking by default (overridden
 * by the global `--network-id`), no security-opt, and the Linux-only
 * `host.docker.internal:host-gateway` extra host.
 *
 * Shared by `db dump` (streams to `--file`/stdout) and `db pull`'s initial-migra
 * schema dump (streams to the migration file). The pooler-fallback *decision*
 * stays with the caller — this helper runs a single attempt and surfaces its
 * exit/stderr so the caller can classify with `legacyIsIPv6ConnectivityError`.
 */
export const legacyStreamPgDump = Effect.fnUntraced(function* <E>(params: {
  /** Resolved Postgres image tag (pre-registry-URL); the helper applies the registry mirror. */
  readonly image: string;
  /** The bash pg_dump/pg_dumpall script (`legacyDump{Schema,Data,Role}Script`). */
  readonly script: string;
  readonly env: Readonly<Record<string, string>>;
  /** Receives each stdout chunk in arrival order; its failure aborts the run as `E`. */
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
}) {
  const docker = yield* LegacyDockerRun;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* LegacyNetworkIdFlag;

  const networkId = Option.getOrUndefined(networkIdFlag);
  const network =
    networkId !== undefined && networkId.length > 0
      ? { _tag: "named" as const, name: networkId }
      : { _tag: "host" as const };
  const extraHosts = runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];

  return yield* docker.runStream<E>(
    {
      image: legacyGetRegistryImageUrl(params.image),
      cmd: ["bash", "-c", params.script, "--"],
      env: params.env,
      binds: [],
      workingDir: Option.none(),
      securityOpt: [],
      extraHosts,
      network,
    },
    { onStdout: params.onStdout, teeStderr: true },
  );
});
