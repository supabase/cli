import { Effect, Option } from "effect";

import { NetworkIdFlag } from "./global-flags.ts";
import { viperEnvStringWithProjectFallback } from "./viper-env.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { getRegistryImageUrl } from "./docker-registry.ts";
import { DockerRun } from "./docker-run.service.ts";
import { currentStackBackend } from "../commands/experimental/stack/stack-backend.ts";
import { requireHostPostgresClient, streamHostCommand } from "./postgres-client.run.ts";

/**
 * Runs a pg_dump/pg_dumpall bash script in a one-shot container, streaming stdout
 * chunk-by-chunk to `onStdout` and teeing stderr live, and returning the exit code and
 * captured stderr for the caller to classify (e.g. with `isIPv6ConnectivityError`). Host
 * networking by default, overridden by `--network-id`, `SUPABASE_NETWORK_ID`, or a project
 * `supabase/.env` value, in that precedence.
 *
 * Shared by `db dump`, `db pull`'s initial-migra schema dump, and `migration squash`'s
 * before/after/full dumps. Runs a single attempt only; the pooler-fallback decision stays
 * with the caller.
 */
export const streamPgDump = Effect.fnUntraced(function* <E>(params: {
  /** Resolved Postgres image tag (pre-registry-URL); the helper applies the registry mirror. */
  readonly image: string;
  /** The bash pg_dump/pg_dumpall script (`dump{Schema,Data,Role}Script`). */
  readonly script: string;
  readonly env: Readonly<Record<string, string>>;
  /** Receives each stdout chunk in arrival order; its failure aborts the run as `E`. */
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
  /**
   * Loaded project `supabase/.env` map, consulted for a `SUPABASE_NETWORK_ID`
   * value when neither `--network-id` nor the ambient shell env set one. Omitted
   * (or `{}`) by callers that haven't loaded a project env map.
   */
  readonly projectEnvValues?: Readonly<Record<string, string>>;
  /**
   * Stack dumps always talk to published credentials. Ignore compose
   * `SUPABASE_NETWORK_ID` so the tool container never joins `supabase_network_*`.
   * An explicit `--network-id` still wins.
   */
  readonly forceHostNetwork?: boolean;
}) {
  const docker = yield* DockerRun;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* NetworkIdFlag;

  // Host networking by default; a resolved flag/env/project-env value wins in that
  // precedence order. The generated `supabase_network_*` fallback used elsewhere never
  // applies here, since this path always sets a NetworkMode.
  const networkId = Option.getOrUndefined(networkIdFlag);
  const envNetworkId = params.forceHostNetwork
    ? ""
    : viperEnvStringWithProjectFallback("SUPABASE_NETWORK_ID", params.projectEnvValues ?? {});
  const network =
    networkId !== undefined && networkId.length > 0
      ? { _tag: "named" as const, name: networkId }
      : envNetworkId.length > 0
        ? { _tag: "named" as const, name: envNetworkId }
        : { _tag: "host" as const };
  const extraHosts = runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];

  return yield* docker.runStream<E>(
    {
      image: getRegistryImageUrl(params.image),
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

export type PgDumpClient =
  | { readonly kind: "container" }
  | {
      readonly kind: "host";
      readonly command: "pg_dump" | "pg_dumpall";
      readonly expectedMajor: number;
    };

/** Container dump, or PATH `pg_dump`/`pg_dumpall` when the stack engine is native. */
export const streamPgDumpWithClient = Effect.fnUntraced(function* <E>(params: {
  readonly image: string;
  readonly script: string;
  readonly env: Readonly<Record<string, string>>;
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
  readonly client: PgDumpClient;
}) {
  if (params.client.kind === "host") {
    yield* requireHostPostgresClient(params.client.command, params.client.expectedMajor);
    return yield* streamHostCommand({
      command: "bash",
      args: ["-c", params.script, "--"],
      env: params.env,
      onStdout: params.onStdout,
      teeStderr: true,
    });
  }
  const backend = yield* currentStackBackend;
  return yield* streamPgDump({
    ...params,
    forceHostNetwork: backend.kind === "stack",
  });
});
