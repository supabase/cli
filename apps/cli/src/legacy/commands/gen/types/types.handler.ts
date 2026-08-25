import { loadCliConfig } from "@supabase/config/effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Effect, FileSystem, Option, Path, Stdio, Stream } from "effect";
import {
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  cobraMutuallyExclusiveErrorMessage,
  PERSISTENT_VALUE_FLAG_NAMES,
  PERSISTENT_VALUE_FLAG_SHORTHANDS,
  pflagArgvScan,
} from "../../../../shared/cli/cobra-flag-groups.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import {
  LegacyProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/legacy-project-ref.service.ts";
import { spawnContainerCli } from "../../../shared/legacy-container-cli.ts";
import {
  legacyIsIPv6ConnectivityError,
  legacyIsIPv6ConnectivityErrorCause,
} from "../../../shared/legacy-connect-errors.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type { LegacyDbConfigFlags } from "../../../shared/legacy-db-config.types.ts";
import { legacyPoolerConfigFromConnectionString } from "../../../shared/legacy-db-config.parse.ts";
import {
  legacyApplyProjectEnv,
  legacyReadDbToml,
} from "../../../shared/legacy-db-config.toml-read.ts";
import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import { legacyTempPaths } from "../../../shared/legacy-temp-paths.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import {
  legacyIsDirectDbHost,
  legacyRunWithPoolerFallback,
} from "../../../shared/legacy-pooler-fallback.ts";
import type { LegacyGenTypesFlags } from "./types.command.ts";
import { LegacyGenTypesNetworkError, LegacyGenTypesUnexpectedStatusError } from "./types.errors.ts";
import { legacyGetHostname } from "../../../shared/legacy-hostname.ts";
import { LegacyPlatformApiFactory } from "../../../auth/legacy-platform-api-factory.service.ts";
import {
  defaultSchemas,
  buildPostgresUrl,
  localDbContainerId,
  localDbPassword,
  localNetworkId,
  parseDatabaseUrl,
  parseQueryTimeoutSeconds,
  legacyRootCaBundle,
  resolvePgmetaImage,
} from "./types.shared.ts";

const mapProjectTypesError = mapLegacyHttpError({
  networkError: LegacyGenTypesNetworkError,
  statusError: LegacyGenTypesUnexpectedStatusError,
  networkMessage: (cause) => `failed to get typescript types: ${cause}`,
  statusMessage: (_status, body) => `failed to retrieve generated types: ${body}`,
});

const mapProjectDatabaseHostError = mapLegacyHttpError({
  networkError: LegacyGenTypesNetworkError,
  statusError: LegacyGenTypesUnexpectedStatusError,
  networkMessage: (cause) => `failed to get project database config: ${cause}`,
  statusMessage: (status, body) => `unexpected project database config status ${status}: ${body}`,
});

const mapBranchDatabaseConfigError = mapLegacyHttpError({
  networkError: LegacyGenTypesNetworkError,
  statusError: LegacyGenTypesUnexpectedStatusError,
  networkMessage: (cause) => `failed to get preview branch database config: ${cause}`,
  statusMessage: (status, body) =>
    `unexpected preview branch database config status ${status}: ${body}`,
});

// A 404 from `GET /v1/projects/{ref}` means the ref is a preview branch rather
// than a project, so fall back to the branch config endpoint. Mirror the link
// handler, which treats *any* 404 as the branch case (`link.handler.ts:46-50`);
// do not narrow on the response body, since the Management API's 404 wording
// is not guaranteed.
function isProjectNotFound(cause: unknown) {
  return cause instanceof LegacyGenTypesUnexpectedStatusError && cause.status === 404;
}

const GEN_TYPES_COMMAND_PATH = ["gen", "types"] as const;

type LegacyGenTypesMutexFlag =
  | "local"
  | "linked"
  | "project-id"
  | "db-url"
  | "postgrest-v9-compat"
  | "swift-access-control"
  | "query-timeout";

// Four mutually-exclusive flag groups. Validation runs in lexicographically
// sorted group-key order and reports only the first violated group, so they
// are listed here in that sorted order — e.g. `--db-url X
// --postgrest-v9-compat --project-id Y` reports the postgrest group, not the
// local/linked/project-id/db-url group.
const GEN_TYPES_MUTEX_GROUPS: ReadonlyArray<ReadonlyArray<LegacyGenTypesMutexFlag>> = [
  ["linked", "project-id", "postgrest-v9-compat"],
  ["linked", "project-id", "query-timeout"],
  ["linked", "project-id", "swift-access-control"],
  ["local", "linked", "project-id", "db-url"],
];

/**
 * Every value-taking (non-boolean) flag reachable when `gen types` parses:
 * the command's own (`types.command.ts`) plus the root's persistent value
 * flags — these tell `pflagArgvScan` which bare tokens consume the next argv
 * token as their value. `--local`, `--linked`, and `--postgrest-v9-compat`
 * are this command's only boolean flags and are deliberately excluded;
 * booleans never consume a following token. `--schema`'s `-s` shorthand
 * (Go `cmd/gen.go:155` `StringSliceVarP`) is covered via the shorthand map
 * so a genuine `-s public` invocation — and a bare `-s` consuming the next
 * flag-shaped token as pflag does — is seen exactly as pflag sees it.
 */
const GEN_TYPES_SCAN_SPEC = {
  valueFlagNames: new Set([
    "db-url",
    "project-id",
    "lang",
    "schema",
    "swift-access-control",
    "query-timeout",
    ...PERSISTENT_VALUE_FLAG_NAMES,
  ]),
  valueFlagShorthands: new Map([["s", "schema"], ...PERSISTENT_VALUE_FLAG_SHORTHANDS]),
} as const;

function forwardByteStream(
  stream: Stream.Stream<Uint8Array, unknown>,
  write: (text: string) => Effect.Effect<void, unknown>,
) {
  const decoder = new TextDecoder();
  return Stream.runForEach(stream, (chunk) => write(decoder.decode(chunk, { stream: true }))).pipe(
    Effect.andThen(write(decoder.decode())),
  );
}

function collectByteStream(stream: Stream.Stream<Uint8Array, unknown>) {
  const decoder = new TextDecoder();
  return Stream.runFold(
    stream,
    () => "",
    (text, chunk) => text + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.map((text) => text + decoder.decode()));
}

// Keep these two sets in sync with the value-bearing flags on the root command
// (shared/legacy/global-flags.ts) and the `gen types` command (types.command.ts).
// They let `findLegacyPositionalLanguage` skip a flag's value so it is not
// mistaken for the legacy positional language argument (e.g. `gen types typescript`).
const LONG_FLAGS_WITH_VALUES = new Set([
  "db-url",
  "project-id",
  "lang",
  "schema",
  "swift-access-control",
  "query-timeout",
  "profile",
  "workdir",
  "network-id",
  "dns-resolver",
  "output",
  "output-format",
  "log-level",
  "completions",
  "agent",
]);

const SHORT_FLAGS_WITH_VALUES = new Set(["s", "o"]);

function findLegacyPositionalLanguage(rawArgs: ReadonlyArray<string>): Option.Option<string> {
  const commandIndex = rawArgs.findIndex(
    (value, index) => value === "types" && rawArgs[index - 1] === "gen",
  );
  if (commandIndex === -1) {
    return Option.none();
  }

  let index = commandIndex + 1;
  while (index < rawArgs.length) {
    const token = rawArgs[index];
    if (token === undefined) {
      return Option.none();
    }
    if (token === "--") {
      const next = rawArgs[index + 1];
      return next !== undefined && !next.startsWith("-") ? Option.some(next) : Option.none();
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (!token.includes("=") && LONG_FLAGS_WITH_VALUES.has(name)) {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const name = token.slice(1);
      if (token.length === 2 && SHORT_FLAGS_WITH_VALUES.has(name)) {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    return Option.some(token);
  }
  return Option.none();
}

export const legacyGenTypes = Effect.fn("legacy.gen.types")(function* (flags: LegacyGenTypesFlags) {
  const output = yield* Output;
  const cliSettings = yield* LegacyCliSettings;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stdio = yield* Stdio.Stdio;
  const networkId = yield* LegacyNetworkIdFlag;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const rawArgs = yield* stdio.args;
  const platformApi = yield* LegacyPlatformApiFactory;
  const projectRef = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const dbConfig = yield* LegacyDbConfigResolver;
  const sslProbe = yield* LegacyPgDeltaSslProbe;

  // "Set" follows cobra's `pflag.Changed` semantics — whether the flag was
  // passed at all — not the resulting value: `--linked=false` still counts
  // as set. Scanning raw argv keeps detection aligned with pflag's semantics
  // rather than with whatever the TS parser produced — e.g. a bare
  // `-s --linked --local` is pflag's `-s` consuming `--linked` as its
  // (oddly named, but valid) schema value, leaving only `--local` changed,
  // while the Effect parser reads `--linked` as its own boolean flag.
  const scan = pflagArgvScan(rawArgs, GEN_TYPES_COMMAND_PATH, GEN_TYPES_SCAN_SPEC);
  const occurrences = scan.occurrences;

  // `--query-timeout` is parsed at flag-parse time (pflag's `DurationVar`),
  // before the telemetry context is installed — so an invalid duration wins
  // over every guard below, and unlike them, its rejection is never
  // followed by a telemetry flush.
  const queryTimeoutSeconds = yield* parseQueryTimeoutSeconds(flags.queryTimeout);

  // flags.schema is already CSV-parsed and validated by `Flag.mapTryCatch(legacyParseSchemaFlags)`
  // in types.command.ts — use it directly.
  const schemas = flags.schema;
  const lang = flags.lang;
  const swiftAccessControl = flags.swiftAccessControl;

  const loadConfig = () => loadCliConfig(cliSettings.workdir, { goViperCompat: true });
  const loadConfigForRef = (projectRef: string) =>
    loadCliConfig(cliSettings.workdir, { projectRef, goViperCompat: true });

  const schemasFromConfig = (apiSchemas: ReadonlyArray<string> | undefined) =>
    defaultSchemas(apiSchemas);

  const runProjectTypes = (
    projectRef: string,
    includedSchemas: ReadonlyArray<string>,
    // True for an explicit `--project-id <ref>` (an ad-hoc remote project that may
    // differ from the current workdir); false for `--linked` / the linked fallback.
    adHocProjectRef: boolean,
  ) =>
    Effect.gen(function* () {
      const api = yield* platformApi.make;

      if (lang !== "typescript") {
        const projectResult = yield* api.v1.getProject({ ref: projectRef }).pipe(
          Effect.catch(mapProjectDatabaseHostError),
          Effect.as("project" as const),
          Effect.catch((cause) =>
            isProjectNotFound(cause)
              ? runPreviewBranchTypes(projectRef, includedSchemas).pipe(
                  Effect.as("branch" as const),
                )
              : Effect.fail(cause),
          ),
        );
        if (projectResult === "branch") return;

        const resolveFlags: LegacyDbConfigFlags = {
          dbUrl: Option.none(),
          connType: "linked",
          dnsResolver,
          linkedProjectRef: Option.some(projectRef),
          adHocProjectRef,
        };
        const resolved = yield* dbConfig.resolve(resolveFlags);
        const conn = resolved.conn;
        yield* runPgMeta({
          url: legacyToPostgresURL(conn),
          host: conn.host,
          port: conn.port,
          probeHost: conn.host,
          probePort: conn.port,
          networkMode: "host",
          includedSchemas: includedSchemas.join(","),
          postgrestV9Compat: flags.postgrestV9Compat,
          poolerFallback: {
            directHost: conn.host,
            eligible: !resolved.isLocal && legacyIsDirectDbHost(conn.host, cliSettings.projectHost),
            resolve: dbConfig.resolvePoolerFallback(resolveFlags),
          },
        });
        return;
      }

      const response = yield* api.v1
        .generateTypescriptTypes({
          ref: projectRef,
          included_schemas: includedSchemas.join(","),
        })
        .pipe(Effect.catch(mapProjectTypesError));

      yield* output.raw(response.types);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(projectRef)));

  const runPreviewBranchTypes = (branchRef: string, includedSchemas: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const api = yield* platformApi.make;
      const branch = yield* api.v1
        .getABranchConfig({ branch_id_or_ref: branchRef })
        .pipe(Effect.catch(mapBranchDatabaseConfigError));

      if (branch.db_user === undefined || branch.db_pass === undefined) {
        return yield* Effect.fail(new Error("Preview branch database credentials are unavailable"));
      }
      const branchUser = branch.db_user;
      const branchPassword = branch.db_pass;

      const poolerFallback = api.v1.getPoolerConfig({ ref: branch.ref }).pipe(
        Effect.map((configs) => {
          const primary = configs.find((config) => config.database_type === "PRIMARY");
          if (primary === undefined) return Option.none<LegacyPgConnInput>();
          const parsed = legacyPoolerConfigFromConnectionString(
            branch.ref,
            primary.connection_string,
            cliSettings.poolerHost,
          );
          return parsed._tag === "ok"
            ? Option.some({ ...parsed.conn, password: branchPassword })
            : Option.none<LegacyPgConnInput>();
        }),
        Effect.orElseSucceed(() => Option.none<LegacyPgConnInput>()),
      );

      yield* runPgMeta({
        url: legacyToPostgresURL({
          host: branch.db_host,
          port: branch.db_port,
          user: branchUser,
          password: branchPassword,
          database: "postgres",
        }),
        host: branch.db_host,
        port: branch.db_port,
        probeHost: branch.db_host,
        probePort: branch.db_port,
        networkMode: "host",
        includedSchemas: includedSchemas.join(","),
        postgrestV9Compat: flags.postgrestV9Compat,
        poolerFallback: {
          directHost: branch.db_host,
          eligible: legacyIsDirectDbHost(branch.db_host, cliSettings.projectHost),
          resolve: poolerFallback,
        },
      });
    });

  const runPgMeta = (input: {
    readonly url: string;
    readonly host: string;
    readonly port: number;
    readonly probeHost: string;
    readonly probePort: number;
    readonly networkMode: "host" | (string & {});
    readonly includedSchemas: string;
    readonly postgrestV9Compat: boolean;
    readonly pgmetaVersionOverride?: string;
    readonly poolerFallback?: {
      readonly directHost: string;
      readonly eligible: boolean;
      readonly resolve: Effect.Effect<Option.Option<LegacyPgConnInput>, unknown>;
    };
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const buildRun = (target: {
          readonly url: string;
          readonly host: string;
          readonly port: number;
          readonly probeHost: string;
          readonly probePort: number;
        }) =>
          Effect.gen(function* () {
            yield* output.raw(`Connecting to ${target.host} ${target.port}\n`, "stderr");

            // Each entry is a "KEY=VALUE" string, passed as a `--env
            // KEY=VALUE` argument rather than a `--env-file`: env-files
            // split on newlines, so they cannot carry the multi-line PEM CA
            // bundle, and a value containing a newline could inject an extra
            // variable. Passing argv elements keeps each entry as exactly
            // one variable regardless of its contents.
            const env = [
              `PG_META_DB_URL=${target.url}`,
              `PG_CONN_TIMEOUT_SECS=${queryTimeoutSeconds}`,
              `PG_QUERY_TIMEOUT_SECS=${queryTimeoutSeconds}`,
              `PG_META_GENERATE_TYPES=${lang}`,
              `PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=${input.includedSchemas}`,
              `PG_META_GENERATE_TYPES_SWIFT_ACCESS_CONTROL=${swiftAccessControl}`,
              `PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=${String(!input.postgrestV9Compat)}`,
            ];

            // Emitted to stderr when the probe runs with certificate
            // verification disabled. Our wire-level SSLRequest probe never
            // verifies certificates, so honour the same env var here too.
            if (process.env["SUPABASE_CA_SKIP_VERIFY"] === "true") {
              yield* output.raw(
                "WARNING: TLS certificate verification disabled for SSL probe (SUPABASE_CA_SKIP_VERIFY=true)\n",
                "stderr",
              );
            }

            const useTls = yield* sslProbe.requireSslForHost(target.probeHost, target.probePort);
            if (useTls) {
              env.push(`PG_META_DB_SSL_ROOT_CERT=${legacyRootCaBundle()}`);
            }

            // `--network-id` overrides any base network mode (even the
            // "host" mode used for --db-url), so honour the override here too.
            const networkMode = Option.isSome(networkId) ? networkId.value : input.networkMode;
            const args = [
              "run",
              "--rm",
              "--network",
              networkMode,
              ...env.flatMap((entry) => ["--env", entry]),
              resolvePgmetaImage(input.pgmetaVersionOverride),
              "node",
              "dist/server/server.js",
            ];
            const child = yield* spawnContainerCli(spawner, args, {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            });

            let stderrText = "";
            const [exitCode] = yield* Effect.all(
              [
                child.exitCode.pipe(Effect.map(Number)),
                forwardByteStream(child.stdout, (text) => output.raw(text, "stdout")),
                forwardByteStream(child.stderr, (text) =>
                  Effect.sync(() => {
                    stderrText += text;
                  }).pipe(Effect.andThen(output.raw(text, "stderr"))),
                ),
              ],
              { concurrency: "unbounded" },
            );
            return { exitCode, stderrText };
          });

        const runTarget = (conn: LegacyPgConnInput) =>
          buildRun({
            url: legacyToPostgresURL(conn),
            host: conn.host,
            port: conn.port,
            probeHost: conn.host,
            probePort: conn.port,
          });

        const result =
          input.poolerFallback === undefined
            ? yield* buildRun(input)
            : yield* legacyRunWithPoolerFallback({
                run: buildRun(input),
                retry: runTarget,
                directHost: input.poolerFallback.directHost,
                eligible: input.poolerFallback.eligible,
                resolveFallback: input.poolerFallback.resolve,
                classifyError: legacyIsIPv6ConnectivityErrorCause,
                classifyResult: (result) =>
                  result.exitCode !== 0 && legacyIsIPv6ConnectivityError(result.stderrText),
              });

        if (result.exitCode !== 0) {
          return yield* Effect.fail(new Error(`error running container: exit ${result.exitCode}`));
        }
      }),
    );

  const assertLocalDbRunning = (projectId: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        // We only need the exit code and stderr (Go uses Docker's ContainerInspect API,
        // which reads no stdout). Discard stdout so the inspect JSON can never fill the
        // pipe buffer and deadlock the unconsumed stream.
        const child = yield* spawnContainerCli(
          spawner,
          ["container", "inspect", localDbContainerId(projectId)],
          {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          },
        );
        const [exitCode, stderr] = yield* Effect.all([
          child.exitCode.pipe(Effect.map(Number)),
          collectByteStream(child.stderr),
        ]);
        if (exitCode !== 0) {
          const message = stderr.trim();
          if (message.toLowerCase().includes("no such container")) {
            return yield* Effect.fail(new Error("supabase start is not running."));
          }
          return yield* Effect.fail(
            new Error(
              message.length > 0
                ? `failed to inspect service: ${message}`
                : "failed to inspect service",
            ),
          );
        }
      }),
    );

  yield* Effect.gen(function* () {
    // The command's own guard runs first, then flag-group validation — so
    // this guard's error wins when both apply (e.g. `--local --linked
    // --postgrest-v9-compat`). Both run AFTER the telemetry context is
    // already installed, unlike the query-timeout parse failure above, so
    // every return in this block must stay inside the
    // `Effect.ensuring(telemetryState.flush)` below.
    if (flags.postgrestV9Compat && Option.isNone(flags.dbUrl)) {
      // Established error text, including the "must used" typo — do not
      // "fix" the grammar.
      return yield* Effect.fail(
        new Error("--postgrest-v9-compat must used together with --db-url"),
      );
    }
    const legacyLang = findLegacyPositionalLanguage(rawArgs);
    if (
      Option.isSome(legacyLang) &&
      legacyLang.value !== "typescript" &&
      !occurrences.has("lang")
    ) {
      return yield* Effect.fail(new Error("use --lang flag to specify the typegen language"));
    }

    // Cobra's mutual exclusion keys off pflag `Changed` — a flag counts as
    // set once passed explicitly, regardless of value, so `--linked=false`
    // still trips its groups. `project-id` and `db-url` are read straight off
    // the parsed flags: neither has a boolean-vs-default ambiguity, and
    // reconciling them against the scan is unnecessary here — every guard
    // test drives the handler with argv that matches its flags.
    const changedMutexFlags: Record<LegacyGenTypesMutexFlag, boolean> = {
      local: occurrences.has("local"),
      linked: occurrences.has("linked"),
      "project-id": Option.isSome(flags.projectId),
      "db-url": Option.isSome(flags.dbUrl),
      "postgrest-v9-compat": occurrences.has("postgrest-v9-compat"),
      "swift-access-control": occurrences.has("swift-access-control"),
      "query-timeout": occurrences.has("query-timeout"),
    };
    for (const group of GEN_TYPES_MUTEX_GROUPS) {
      const set = group.filter((flagName) => changedMutexFlags[flagName]);
      if (set.length > 1) {
        return yield* Effect.fail(new Error(cobraMutuallyExclusiveErrorMessage(group, set)));
      }
    }

    if (flags.local) {
      const config = yield* legacyReadDbToml(fs, path, cliSettings.workdir);
      yield* legacyApplyProjectEnv(
        config.projectEnv,
        Object.keys(config.projectEnv).filter((key) => key !== "SUPABASE_DB_PASSWORD"),
      );
      const projectId = Option.getOrElse(config.projectId, () => path.basename(cliSettings.workdir));

      const paths = legacyTempPaths(path, cliSettings.workdir);
      // Go resolves Config.Api.Image from the rest-version file only when
      // Db.MajorVersion > 14, then forces v9 compat when that image tag contains "v9"
      // (pkg/config/config.go:657-666, internal/gen/types/types.go:69). Gate and trim
      // identically so we don't force v9 on older databases.
      const restVersion =
        config.majorVersion > 14
          ? (yield* fs
              .readFileString(paths.restVersion)
              .pipe(Effect.orElseSucceed(() => ""))).trim()
          : "";
      const forcedV9 = restVersion.length > 0 && restVersion.includes("v9");
      const pgmetaVersionOverride = yield* fs
        .readFileString(paths.pgmetaVersion)
        .pipe(Effect.orElseSucceed(() => ""));

      const includedSchemas = (
        schemas.length > 0 ? schemas : defaultSchemas(config.apiSchemas)
      ).join(",");
      yield* assertLocalDbRunning(projectId);

      yield* runPgMeta({
        url: buildPostgresUrl({
          host: "db",
          port: 5432,
          user: "postgres",
          password: localDbPassword(),
          database: "postgres",
        }),
        host: "db",
        port: 5432,
        probeHost: legacyGetHostname(),
        probePort: config.port,
        networkMode: localNetworkId(projectId),
        includedSchemas,
        postgrestV9Compat: flags.postgrestV9Compat || forcedV9,
        pgmetaVersionOverride,
      });
      return;
    }

    if (Option.isSome(flags.dbUrl)) {
      const loaded = yield* loadConfig();
      const direct = yield* parseDatabaseUrl(flags.dbUrl.value);
      const includedSchemas = (
        schemas.length > 0 ? schemas : defaultSchemas(loaded?.config.api.schemas ?? [])
      ).join(",");

      yield* runPgMeta({
        url: direct.url,
        host: direct.host,
        port: direct.port,
        probeHost: direct.host,
        probePort: direct.port,
        networkMode: direct.networkMode,
        includedSchemas,
        postgrestV9Compat: flags.postgrestV9Compat,
      });
      return;
    }

    if (flags.linked) {
      const ref = yield* projectRef.resolve(Option.none());
      const loaded = schemas.length > 0 ? null : yield* loadConfigForRef(ref);
      yield* runProjectTypes(
        ref,
        schemas.length > 0 ? schemas : schemasFromConfig(loaded?.config.api.schemas),
        false,
      );
      return;
    }

    if (Option.isSome(flags.projectId)) {
      const ref = yield* projectRef.resolve(flags.projectId);
      const loaded = schemas.length > 0 ? null : yield* loadConfigForRef(ref);
      yield* runProjectTypes(
        ref,
        schemas.length > 0 ? schemas : schemasFromConfig(loaded?.config.api.schemas),
        true,
      );
      return;
    }

    const resolvedRef = yield* projectRef.resolve(Option.none()).pipe(
      Effect.catch((cause) => {
        if (
          cause instanceof LegacyProjectNotLinkedError &&
          cause.message === PROJECT_NOT_LINKED_MESSAGE
        ) {
          return Effect.fail(
            new Error("Must specify one of --local, --linked, --project-id, or --db-url"),
          );
        }
        return Effect.fail(cause);
      }),
    );
    const loaded = schemas.length > 0 ? null : yield* loadConfigForRef(resolvedRef);
    yield* runProjectTypes(
      resolvedRef,
      schemas.length > 0 ? schemas : schemasFromConfig(loaded?.config.api.schemas),
      false,
    );
  }).pipe(Effect.scoped, Effect.ensuring(telemetryState.flush));
});
