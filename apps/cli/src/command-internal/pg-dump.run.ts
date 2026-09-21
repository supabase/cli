import { Effect, Option } from "effect";
import { postgres, type Stack } from "@supabase/stack/effect";
type StackRuntimePreference =
  | { readonly kind: "native" }
  | { readonly kind: "container"; readonly engine: "docker" | "podman" };

import { NetworkIdFlag } from "./global-flags.ts";
import { viperEnvStringWithProjectFallback } from "./viper-env.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { DockerRun } from "./docker-run.service.ts";
import { DockerRunError } from "./docker-run.errors.ts";
import { getRegistryImageUrl } from "./docker-registry.ts";
import { BundledPostgresClient, resolveBundledPostgresRuntime } from "./bundled-postgres-client.ts";
import { Output } from "../shared/output/output.service.ts";

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

  // Dump never falls back to generated `supabase_network_*`; host is the default.
  const network = dumpNetworkMode(
    Option.getOrUndefined(networkIdFlag),
    params.forceHostNetwork === true,
    params.projectEnvValues ?? {},
  );
  const extraHosts = runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];

  const image = yield* getRegistryImageUrl(params.image, params.projectEnvValues).pipe(
    Effect.mapError(
      (cause) =>
        new DockerRunError({
          message: `failed to resolve Docker image registry configuration: ${cause.message}`,
          reason: "config",
          daemonDown: false,
        }),
    ),
  );

  return yield* docker.runStream<E>(
    {
      image,
      cmd: ["bash", "-c", params.script, "--"],
      env: params.env,
      binds: [],
      workingDir: Option.none(),
      securityOpt: [],
      extraHosts,
      network,
      projectEnvValues: params.projectEnvValues,
    },
    { onStdout: params.onStdout, teeStderr: true },
  );
});

export type PgDumpClient =
  | { readonly kind: "container" }
  | {
      readonly kind: "stack";
      readonly stack: Stack;
      readonly command: "pg_dump" | "pg_dumpall";
      readonly major: 15 | 17;
    }
  | {
      readonly kind: "bundled";
      readonly command: "pg_dump" | "pg_dumpall";
      readonly version: string;
      readonly runtime?: StackRuntimePreference;
    };

export const pgDumpClientExitMessage = (client: PgDumpClient, exitCode: number): string =>
  client.kind === "stack" || (client.kind === "bundled" && client.runtime?.kind === "native")
    ? `error running ${client.command}: exit ${exitCode}`
    : `error running container: exit ${exitCode}`;

const dumpNetworkMode = (
  networkId: string | undefined,
  forceHostNetwork: boolean,
  projectEnvValues: Readonly<Record<string, string>>,
): { readonly _tag: "named"; readonly name: string } | { readonly _tag: "host" } => {
  if (networkId !== undefined && networkId.length > 0) return { _tag: "named", name: networkId };
  if (forceHostNetwork) return { _tag: "host" };
  const envNetworkId = viperEnvStringWithProjectFallback("SUPABASE_NETWORK_ID", projectEnvValues);
  return envNetworkId.length > 0 ? { _tag: "named", name: envNetworkId } : { _tag: "host" };
};

const bundledDumpNetwork = (
  networkId: string | undefined,
  forceHostNetwork: boolean,
  projectEnvValues: Readonly<Record<string, string>>,
): "host" | { readonly name: string } => {
  const network = dumpNetworkMode(networkId, forceHostNetwork, projectEnvValues);
  return network._tag === "host" ? "host" : { name: network.name };
};

const transformDumpLine = (
  line: string,
  script: string,
  env: Readonly<Record<string, string>>,
): string | undefined => {
  const applyExtraSed = (value: string | undefined): string | undefined =>
    env["EXTRA_SED"] === "/^--/d" && value?.startsWith("--") ? undefined : value;
  if (script.includes("--data-only")) {
    return line.replace(/^\\(?:un)?restrict /u, "-- $&");
  }
  if (script.includes("pg_dumpall")) {
    if (/^\\(?:un)?restrict /u.test(line)) return applyExtraSed(`-- ${line}`);
    const reservedRoles = env["RESERVED_ROLES"] ?? "";
    const allowedConfigs = env["ALLOWED_CONFIGS"]?.split("|").filter(Boolean) ?? [];
    const reservedRole = new RegExp(`^(CREATE|ALTER) ROLE "(${reservedRoles})"`, "u");
    const allowedConfig = new RegExp(`^ALTER ROLE ".*" SET "(${allowedConfigs.join("|")})" `, "u");
    const dropComments = (value: string): string | undefined => applyExtraSed(value);
    if (reservedRole.test(line))
      return dropComments(allowedConfig.test(line) ? line : `-- ${line}`);
    if (new RegExp(`GRANT ".*" TO "(${reservedRoles})"`, "u").test(line))
      return dropComments(`-- ${line}`);
    if (line.startsWith("-- ") && allowedConfig.test(line.slice(3)))
      return dropComments(line.slice(3));
    if (line.startsWith("-- ") && line.includes(" GRANT ")) return dropComments(line);
    if (line.startsWith("-- ") && line.includes("ALTER ROLE ")) return dropComments(line);
    return applyExtraSed(line.replaceAll(/ (NOSUPERUSER|NOREPLICATION)/gu, ""));
  }
  const replacements: ReadonlyArray<readonly [RegExp, string]> = [
    [/^CREATE SCHEMA "/u, 'CREATE SCHEMA IF NOT EXISTS "'],
    [/^CREATE TABLE "/u, 'CREATE TABLE IF NOT EXISTS "'],
    [/^CREATE SEQUENCE "/u, 'CREATE SEQUENCE IF NOT EXISTS "'],
    [/^CREATE VIEW "/u, 'CREATE OR REPLACE VIEW "'],
    [/^CREATE FUNCTION "/u, 'CREATE OR REPLACE FUNCTION "'],
    [/^CREATE TRIGGER "/u, 'CREATE OR REPLACE TRIGGER "'],
    [/^CREATE PUBLICATION "supabase_realtime/u, '-- CREATE PUBLICATION "supabase_realtime'],
    [/^CREATE EVENT TRIGGER /u, "-- CREATE EVENT TRIGGER "],
    [/^         WHEN TAG IN /u, "--         WHEN TAG IN "],
    [/^   EXECUTE FUNCTION /u, "--   EXECUTE FUNCTION "],
    [/^ALTER EVENT TRIGGER /u, "-- ALTER EVENT TRIGGER "],
    [/^ALTER PUBLICATION "supabase_realtime_/u, '-- ALTER PUBLICATION "supabase_realtime_'],
    [/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /u, "-- $&"],
    [/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/u, "-- $&"],
    [/^COMMENT ON EXTENSION /u, "-- $&"],
    [/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/u, "-- $&"],
    [/^CREATE POLICY "cron_job_/u, "-- $&"],
    [/^ALTER TABLE "cron"/u, "-- $&"],
    [/^SET transaction_timeout = 0;/u, "-- SET transaction_timeout = 0;"],
  ];
  if (/^\\(?:un)?restrict /u.test(line)) return applyExtraSed(`-- ${line}`);
  const excludedSchemas = env["EXCLUDED_SCHEMAS"]?.split("|").filter(Boolean) ?? [];
  const excludedSchemaPattern = excludedSchemas.join("|");
  if (
    excludedSchemaPattern.length > 0 &&
    new RegExp(`^(GRANT|REVOKE) (.+) ON (.+) "(${excludedSchemaPattern})"`, "u").test(line)
  )
    return applyExtraSed(`-- ${line}`);
  for (const [pattern, replacement] of replacements)
    if (pattern.test(line)) return applyExtraSed(line.replace(pattern, replacement));
  if (/^CREATE EXTENSION IF NOT EXISTS "(?:pg_tle|pgsodium|pgmq)"/u.test(line))
    return applyExtraSed(
      line.replace(/^(CREATE EXTENSION IF NOT EXISTS "(?:pg_tle|pgsodium|pgmq)").+$/u, "$1;"),
    );
  return applyExtraSed(line);
};

export const transformManagedDumpLine = transformDumpLine;

const stackDumpStdout = <E>(
  script: string,
  env: Readonly<Record<string, string>>,
  emit: (bytes: Uint8Array) => Effect.Effect<void, E>,
) => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";
  let previous: string | undefined;
  const onChunk = (bytes: Uint8Array) =>
    Effect.suspend(() => {
      carry += decoder.decode(bytes, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      return Effect.forEach(
        lines,
        (line) => {
          const transformed = transformDumpLine(line, script, env);
          if (
            transformed === undefined ||
            (script.includes("pg_dumpall") && transformed === previous)
          )
            return Effect.void;
          previous = transformed;
          return emit(encoder.encode(`${transformed}\n`));
        },
        { discard: true },
      );
    });
  const flush = () =>
    Effect.suspend(() => {
      carry += decoder.decode();
      const final = transformDumpLine(carry, script, env);
      return final === undefined ||
        final.length === 0 ||
        (script.includes("pg_dumpall") && final === previous)
        ? Effect.void
        : emit(encoder.encode(final));
    });
  return { onChunk, flush };
};

/** Compose dump, or catalog `pg_dump`/`pg_dumpall` on the stack backend. */
export const streamPgDumpWithClient = Effect.fn("streamPgDumpWithClient")(function* <E>(params: {
  readonly image: string;
  readonly script: string;
  readonly env: Readonly<Record<string, string>>;
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
  readonly client: PgDumpClient;
  readonly forceHostNetwork?: boolean;
}) {
  if (params.client.kind === "stack") {
    const output = yield* Output;
    const flags =
      params.client.command === "pg_dumpall"
        ? [
            "--roles-only",
            "--role",
            "postgres",
            "--quote-all-identifier",
            "--no-role-passwords",
            "--no-comments",
          ]
        : [
            params.script.includes("--data-only") ? "--data-only" : "--schema-only",
            "--quote-all-identifier",
            "--role",
            "postgres",
          ];
    const extraFlags = params.env["EXTRA_FLAGS"]?.match(/(?:[^\s"]+|"[^"]*")+/gu) ?? [];
    const excludedSchemas = params.env["EXCLUDED_SCHEMAS"]?.split("|").filter(Boolean) ?? [];
    const includedSchemas = params.env["INCLUDED_SCHEMAS"];
    const args = [
      ...flags,
      ...excludedSchemas.flatMap((schema) => ["--exclude-schema", schema]),
      ...(includedSchemas === undefined ? [] : ["--schema", includedSchemas]),
      ...(params.script.includes("--data-only")
        ? [
            "--exclude-table",
            "auth.schema_migrations",
            "--exclude-table",
            "storage.migrations",
            "--exclude-table",
            "supabase_functions.migrations",
          ]
        : []),
      ...extraFlags,
      "--host",
      params.env["PGHOST"] ?? "127.0.0.1",
      "--port",
      params.env["PGPORT"] ?? "5432",
      "--username",
      params.env["PGUSER"] ?? "postgres",
      ...(params.client.command === "pg_dump"
        ? ["--dbname", params.env["PGDATABASE"] ?? "postgres"]
        : []),
    ];
    let stderr = "";
    const stderrDecoder = new TextDecoder();
    const emit = stackDumpStdout(params.script, params.env, params.onStdout);
    if (params.script.includes("--data-only"))
      yield* params.onStdout(new TextEncoder().encode("SET session_replication_role = replica;\n"));
    const result = yield* params.client.stack.tools.run(
      params.client.command === "pg_dump"
        ? postgres.pgDump({ major: params.client.major })
        : postgres.pgDumpAll({ major: params.client.major }),
      {
        args,
        env: params.env,
        stdout: emit.onChunk,
        stderr: (chunk) =>
          Effect.gen(function* () {
            yield* output.rawBytes(chunk, "stderr");
            stderr += stderrDecoder.decode(chunk, { stream: true });
          }),
      },
    );
    stderr += stderrDecoder.decode();
    yield* emit.flush();
    if (params.script.includes("--data-only") || params.script.includes("pg_dumpall"))
      yield* params.onStdout(new TextEncoder().encode("RESET ALL;\n"));
    return { exitCode: result.exitCode, stderr };
  }
  if (params.client.kind === "bundled") {
    const bundled = yield* BundledPostgresClient;
    const runtimeInfo = yield* RuntimeInfo;
    const networkIdFlag = yield* NetworkIdFlag;
    const runtime =
      params.client.runtime ??
      (yield* resolveBundledPostgresRuntime(undefined, runtimeInfo.platform, runtimeInfo.arch));
    const extraHosts =
      runtime.kind === "container" && runtimeInfo.platform === "linux"
        ? ["host.docker.internal:host-gateway"]
        : [];
    return yield* bundled.run({
      version: params.client.version,
      runtime,
      argv: ["bash", "-c", params.script, "--"],
      env: params.env,
      network: bundledDumpNetwork(
        Option.getOrUndefined(networkIdFlag),
        params.forceHostNetwork === true,
        params.projectEnvValues ?? {},
      ),
      extraHosts,
      onStdout: params.onStdout,
      teeStderr: true,
    });
  }
  return yield* streamPgDump({
    ...params,
    forceHostNetwork: params.forceHostNetwork === true,
  });
});
