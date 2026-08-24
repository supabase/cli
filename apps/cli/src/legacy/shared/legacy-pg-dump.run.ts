import { Effect, Option } from "effect";

import { LegacyNetworkIdFlag } from "../../shared/legacy/global-flags.ts";
import { legacyViperEnvStringWithProjectFallback } from "../../shared/legacy/legacy-viper-env.ts";
import { LegacyViperEnv } from "../../shared/legacy/legacy-viper-env.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { legacyGetRegistryImageUrl } from "./legacy-docker-registry.ts";
import { LegacyDockerRun } from "./legacy-docker-run.service.ts";

/**
 * Runs a pg_dump / pg_dumpall bash script in a one-shot container, streaming its
 * stdout chunk-by-chunk to `onStdout` and teeing stderr live, returning the exit
 * code + captured stderr for failure classification. Mirrors `dockerExec`:
 * host networking by default (overridden
 * by the global `--network-id` flag, the ambient `SUPABASE_NETWORK_ID` env var, or
 * a project `supabase/.env` value, in that precedence), no security-opt, and the
 * Linux-only `host.docker.internal:host-gateway` extra host.
 *
 * Shared by `db dump` (streams to `--file`/stdout), `db pull`'s initial-migra
 * schema dump (streams to the migration file), and (CLI-1969) `migration
 * squash`'s three one-shot dumps (before/after `auth`/`storage` diff buffers,
 * plus the full dump streamed straight into the target migration file) — the
 * third consumer is why this module lives in `legacy/shared/` rather than
 * `commands/db/shared/`. The pooler-fallback *decision* stays with the caller —
 * this helper runs a single attempt and surfaces its exit/stderr so the caller
 * can classify with `legacyIsIPv6ConnectivityError`.
 */
export const legacyStreamPgDump = Effect.fnUntraced(function* <E>(params: {
  /** Resolved Postgres image tag (pre-registry-URL); the helper applies the registry mirror. */
  readonly image: string;
  /** The bash pg_dump/pg_dumpall script (`legacyDump{Schema,Data,Role}Script`). */
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
}) {
  const docker = yield* LegacyDockerRun;
  const runtimeInfo = yield* RuntimeInfo;
  const networkIdFlag = yield* LegacyNetworkIdFlag;
  yield* LegacyViperEnv;

  // `dockerExec` sets `NetworkMode` to host, but
  // `DockerStart` then overrides it with `viper.GetString("network-id")` whenever
  // that resolves non-empty — a bound flag/env value wins,
  // flag > ambient env > project-`.env` (`legacyViperEnvStringWithProjectFallback`
  // precedence). Only when NEITHER the flag nor the env resolves does Go fall back
  // to `NetId` — but that branch only fires when the caller
  // left `NetworkMode` empty, which the dump path never does, so the effective
  // pg_dump fallback is host networking, not the generated `supabase_network_*`.
  const networkId = Option.getOrUndefined(networkIdFlag);
  const envNetworkId = yield* legacyViperEnvStringWithProjectFallback(
    "SUPABASE_NETWORK_ID",
    params.projectEnvValues ?? {},
  );
  const network =
    networkId !== undefined && networkId.length > 0
      ? { _tag: "named" as const, name: networkId }
      : envNetworkId.length > 0
        ? { _tag: "named" as const, name: envNetworkId }
        : { _tag: "host" as const };
  const extraHosts = runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];

  return yield* docker.runStream<E>(
    {
      image: legacyGetRegistryImageUrl(params.image, params.projectEnvValues ?? {}),
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
