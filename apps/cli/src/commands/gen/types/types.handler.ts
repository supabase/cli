import type { LoadedCliConfig } from "@supabase/config/effect";
import { loadCliConfig } from "@supabase/config/internal";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Effect, FileSystem, Option, Path, Predicate, Stdio, Stream } from "effect";
import { DnsResolverFlag, NetworkIdFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  cobraMutuallyExclusiveErrorMessage,
  PERSISTENT_VALUE_FLAG_NAMES,
  PERSISTENT_VALUE_FLAG_SHORTHANDS,
  pflagArgvScan,
} from "../../../shared/cli/cobra-flag-groups.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import {
  ProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
} from "../../../config/project-ref.service.ts";
import { spawnContainerCli } from "../../../command-internal/container-cli.ts";
import { makeDockerImageResolver } from "../../../command-internal/docker-image-resolve.ts";
import {
  isIPv6ConnectivityError,
  isIPv6ConnectivityErrorCause,
} from "../../../command-internal/connect-errors.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags } from "../../../command-internal/db-config.types.ts";
import { poolerConfigFromConnectionString } from "../../../command-internal/db-config.parse.ts";
import { applyProjectEnv, readDbToml } from "../../../command-internal/db-config.toml-read.ts";
import type { PgConnInput } from "../../../command-internal/db-connection.service.ts";
import { toPostgresURL } from "../../../command-internal/postgres-url.ts";
import { tempPaths } from "../../../command-internal/temp-paths.ts";
import {
  missingProjectConfigMessageEffect,
  relativeConfigPath,
} from "../../../command-internal/workdir-project.ts";
import { shouldSearchAncestors } from "../../../command-internal/workdir-search.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { PgDeltaSslProbe } from "../../../command-internal/pgdelta-ssl-probe.service.ts";
import {
  isDirectDbHost,
  runWithPoolerFallback,
} from "../../../command-internal/pooler-fallback.ts";
import type { GenTypesFlags } from "./types.command.ts";
import {
  GenTypesMissingProjectConfigError,
  GenTypesNetworkError,
  GenTypesParseConfigError,
  GenTypesUnexpectedStatusError,
  GenTypesWorkdirError,
} from "./types.errors.ts";
import { getHostname } from "../../../command-internal/hostname.ts";
import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import {
  defaultSchemas,
  buildPostgresUrl,
  localDbContainerId,
  localDbPassword,
  localNetworkId,
  parseDatabaseUrl,
  parseQueryTimeoutSeconds,
  rootCaBundle,
  resolvePgmetaImage,
} from "./types.shared.ts";

const mapProjectTypesError = mapHttpError({
  networkError: GenTypesNetworkError,
  statusError: GenTypesUnexpectedStatusError,
  networkMessage: (cause) => `failed to get typescript types: ${cause}`,
  statusMessage: (_status, body) => `failed to retrieve generated types: ${body}`,
});

const mapProjectDatabaseHostError = mapHttpError({
  networkError: GenTypesNetworkError,
  statusError: GenTypesUnexpectedStatusError,
  networkMessage: (cause) => `failed to get project database config: ${cause}`,
  statusMessage: (status, body) => `unexpected project database config status ${status}: ${body}`,
});

const mapBranchDatabaseConfigError = mapHttpError({
  networkError: GenTypesNetworkError,
  statusError: GenTypesUnexpectedStatusError,
  networkMessage: (cause) => `failed to get preview branch database config: ${cause}`,
  statusMessage: (status, body) =>
    `unexpected preview branch database config status ${status}: ${body}`,
});

// A 404 from `GET /v1/projects/{ref}` means the ref is a preview branch, not a project — fall
// back to the branch config endpoint. Don't narrow on the response body; its wording isn't guaranteed.
function isProjectNotFound(cause: unknown) {
  return cause instanceof GenTypesUnexpectedStatusError && cause.status === 404;
}

const GEN_TYPES_COMMAND_PATH = ["gen", "types"] as const;

type GenTypesMutexFlag =
  | "local"
  | "linked"
  | "project-id"
  | "db-url"
  | "postgrest-v9-compat"
  | "swift-access-control"
  | "query-timeout";

// Validation reports only the first violated group, in this listed order — e.g. `--db-url X
// --postgrest-v9-compat --project-id Y` reports the postgrest group, not the
// local/linked/project-id/db-url group.
const GEN_TYPES_MUTEX_GROUPS: ReadonlyArray<ReadonlyArray<GenTypesMutexFlag>> = [
  ["linked", "project-id", "postgrest-v9-compat"],
  ["linked", "project-id", "query-timeout"],
  ["linked", "project-id", "swift-access-control"],
  ["local", "linked", "project-id", "db-url"],
];

/**
 * Every value-taking flag `gen types` parses, telling `pflagArgvScan` which bare tokens
 * consume the next argv token as their value. Boolean flags (`--local`, `--linked`,
 * `--postgrest-v9-compat`) are excluded since they never consume a following token.
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

// Keep in sync with the value-bearing flags on the root command and `gen types` itself.
// Lets `findPositionalLanguage` skip a flag's value so it isn't mistaken for the legacy
// positional language argument (e.g. `gen types typescript`).
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

function findPositionalLanguage(rawArgs: ReadonlyArray<string>): Option.Option<string> {
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

export const genTypes = Effect.fn("gen.types")(function* (flags: GenTypesFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stdio = yield* Stdio.Stdio;
  const networkId = yield* NetworkIdFlag;
  const dnsResolver = yield* DnsResolverFlag;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolveImage = makeDockerImageResolver(spawner);
  const rawArgs = yield* stdio.args;
  const platformApi = yield* CommandPlatformApiFactory;
  const projectRef = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const dbConfig = yield* DbConfigResolver;
  const sslProbe = yield* PgDeltaSslProbe;

  // "Set" means the flag appeared in argv at all (pflag's `Changed` semantics), not its parsed
  // value — `--linked=false` still counts. Argv is scanned directly since a token like
  // `-s --linked` consumes `--linked` as `-s`'s value, not as its own boolean flag.
  const scan = pflagArgvScan(rawArgs, GEN_TYPES_COMMAND_PATH, GEN_TYPES_SCAN_SPEC);
  const occurrences = scan.occurrences;

  // Parsed before the telemetry context is installed, so an invalid `--query-timeout` wins
  // over every guard below and, unlike them, is never followed by a telemetry flush.
  const queryTimeoutSeconds = yield* parseQueryTimeoutSeconds(flags.queryTimeout);

  const schemas = flags.schema;
  const lang = flags.lang;
  const swiftAccessControl = flags.swiftAccessControl;

  const toRelativeConfigPath = (path: string) => relativeConfigPath(cliSettings.workdir, path);

  // `projectRef` is passed only for the `--linked`/`--project-id` paths, so a matching
  // `[remotes.*]` overlay is merged in the same load; omitted for `--local`/`--db-url`.
  const loadConfig = (projectRef?: string) =>
    loadCliConfig(cliSettings.workdir, {
      ...(projectRef === undefined ? {} : { projectRef }),
      goViperCompat: true,
      search: shouldSearchAncestors(cliSettings),
    }).pipe(
      // `cause.path` names the actual failed file; `loadCliConfig` probes `config.json`
      // before falling back to `config.toml`, so hardcoding `.toml` here would mislabel it.
      // Caught before `requireProjectConfigWhenExplicit`, since a parse failure is distinct
      // from the "no project here" case that guard handles.
      Effect.catchTag(
        "CliConfigParseError",
        (cause) =>
          new GenTypesParseConfigError({
            message: `failed to parse ${toRelativeConfigPath(cause.path)}: ${String(cause.cause)}`,
          }),
      ),
      Effect.catchTag(
        "DuplicateRemoteProjectIdError",
        (cause) => new GenTypesParseConfigError({ message: cause.message }),
      ),
      Effect.flatMap(requireProjectConfigWhenExplicit),
    );

  // An explicit --workdir that holds no project must not silently resolve to the embedded
  // default schemas (dropping a declared [api].schemas and writing a public-only file at exit
  // 0). A defaulted workdir keeps the tolerant fallback.
  const requireProjectConfigWhenExplicit = (loaded: LoadedCliConfig | null) =>
    loaded === null && cliSettings.explicitWorkdir
      ? Effect.gen(function* () {
          return yield* new GenTypesMissingProjectConfigError({
            message: yield* missingProjectConfigMessageEffect(cliSettings),
          });
        })
      : Effect.succeed(loaded);

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

        const resolveFlags: DbConfigFlags = {
          dbUrl: Option.none(),
          connType: "linked",
          dnsResolver,
          linkedProjectRef: Option.some(projectRef),
          adHocProjectRef,
        };
        const resolved = yield* dbConfig.resolve(resolveFlags);
        const conn = resolved.conn;
        yield* runPgMeta({
          url: toPostgresURL(conn),
          host: conn.host,
          port: conn.port,
          probeHost: conn.host,
          probePort: conn.port,
          networkMode: "host",
          includedSchemas: includedSchemas.join(","),
          postgrestV9Compat: flags.postgrestV9Compat,
          poolerFallback: {
            directHost: conn.host,
            eligible: !resolved.isLocal && isDirectDbHost(conn.host, cliSettings.projectHost),
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
          if (primary === undefined) return Option.none<PgConnInput>();
          const parsed = poolerConfigFromConnectionString(
            branch.ref,
            primary.connection_string,
            cliSettings.poolerHost,
          );
          return parsed._tag === "ok"
            ? Option.some({ ...parsed.conn, password: branchPassword })
            : Option.none<PgConnInput>();
        }),
        Effect.orElseSucceed(() => Option.none<PgConnInput>()),
      );

      yield* runPgMeta({
        url: toPostgresURL({
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
          eligible: isDirectDbHost(branch.db_host, cliSettings.projectHost),
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
      readonly resolve: Effect.Effect<Option.Option<PgConnInput>, unknown>;
    };
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Cached so the pooler retry reuses one resolve; the resolver's candidate rewrite is
        // idempotent on this already-rewritten reference.
        const resolvedImage = yield* Effect.cached(
          resolveImage(resolvePgmetaImage(input.pgmetaVersionOverride)),
        );
        const buildRun = (target: {
          readonly url: string;
          readonly host: string;
          readonly port: number;
          readonly probeHost: string;
          readonly probePort: number;
        }) =>
          Effect.gen(function* () {
            yield* output.raw(`Connecting to ${target.host} ${target.port}\n`, "stderr");

            // Passed as `--env KEY=VALUE` args rather than `--env-file`: env-files split on
            // newlines and can't carry the multi-line PEM CA bundle without injecting an
            // extra variable.
            const env = [
              `PG_META_DB_URL=${target.url}`,
              `PG_CONN_TIMEOUT_SECS=${queryTimeoutSeconds}`,
              `PG_QUERY_TIMEOUT_SECS=${queryTimeoutSeconds}`,
              `PG_META_GENERATE_TYPES=${lang}`,
              `PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=${input.includedSchemas}`,
              `PG_META_GENERATE_TYPES_SWIFT_ACCESS_CONTROL=${swiftAccessControl}`,
              `PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=${String(!input.postgrestV9Compat)}`,
            ];

            // The SSL probe never verifies certificates on its own, so honor the same env var
            // here too when warning about disabled verification.
            if (process.env["SUPABASE_CA_SKIP_VERIFY"] === "true") {
              yield* output.raw(
                "WARNING: TLS certificate verification disabled for SSL probe (SUPABASE_CA_SKIP_VERIFY=true)\n",
                "stderr",
              );
            }

            const useTls = yield* sslProbe.requireSslForHost(target.probeHost, target.probePort);
            if (useTls) {
              env.push(`PG_META_DB_SSL_ROOT_CERT=${rootCaBundle()}`);
            }
            // After the TLS probe, so an unreachable database fails before any image pull.
            const pgmetaImage = yield* resolvedImage;

            // `--network-id` overrides any base network mode, including "host" for --db-url.
            const networkMode = Option.isSome(networkId) ? networkId.value : input.networkMode;
            const args = [
              "run",
              "--rm",
              "--network",
              networkMode,
              ...env.flatMap((entry) => ["--env", entry]),
              pgmetaImage,
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

        const runTarget = (conn: PgConnInput) =>
          buildRun({
            url: toPostgresURL(conn),
            host: conn.host,
            port: conn.port,
            probeHost: conn.host,
            probePort: conn.port,
          });

        const result =
          input.poolerFallback === undefined
            ? yield* buildRun(input)
            : yield* runWithPoolerFallback({
                run: buildRun(input),
                retry: runTarget,
                directHost: input.poolerFallback.directHost,
                eligible: input.poolerFallback.eligible,
                resolveFallback: input.poolerFallback.resolve,
                // A registry failure carries docker stderr that can read like an IPv6 error.
                classifyError: (error) =>
                  !Predicate.isTagged(error, "DockerRunError") &&
                  isIPv6ConnectivityErrorCause(error),
                classifyResult: (result) =>
                  result.exitCode !== 0 && isIPv6ConnectivityError(result.stderrText),
              });

        if (result.exitCode !== 0) {
          return yield* Effect.fail(new Error(`error running container: exit ${result.exitCode}`));
        }
      }),
    );

  const assertLocalDbRunning = (projectId: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Only the exit code and stderr matter; discard stdout so the inspect JSON can't
        // fill the pipe buffer and deadlock the unconsumed stream.
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
    // Validated before the command's own guard or flag-group validation; the query-timeout
    // parse failure above still precedes even this, since it happens at flag-parse time.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new GenTypesWorkdirError({ message: error.message })),
    );

    // This guard runs before flag-group validation, so its error wins when both apply. Both
    // run after the telemetry context is installed, so every return here must stay inside the
    // `Effect.ensuring(telemetryState.flush)` below.
    if (flags.postgrestV9Compat && Option.isNone(flags.dbUrl)) {
      // Established error text, including the "must used" typo — do not
      // "fix" the grammar.
      return yield* Effect.fail(
        new Error("--postgrest-v9-compat must used together with --db-url"),
      );
    }
    const positionalLang = findPositionalLanguage(rawArgs);
    if (
      Option.isSome(positionalLang) &&
      positionalLang.value !== "typescript" &&
      !occurrences.has("lang")
    ) {
      return yield* Effect.fail(new Error("use --lang flag to specify the typegen language"));
    }

    // A flag counts as set once passed explicitly, regardless of value (`--linked=false`
    // still trips its group). `project-id`/`db-url` are read straight off parsed flags since
    // they have no boolean-vs-default ambiguity.
    const changedMutexFlags: Record<GenTypesMutexFlag, boolean> = {
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
      const config = yield* readDbToml(fs, path, cliSettings.workdir);
      yield* applyProjectEnv(
        config.projectEnv,
        Object.keys(config.projectEnv).filter((key) => key !== "SUPABASE_DB_PASSWORD"),
      );
      const projectId = Option.getOrElse(config.projectId, () =>
        path.basename(cliSettings.workdir),
      );

      const paths = tempPaths(path, cliSettings.workdir);
      // Only forces v9 compat from the rest-version file's image tag when the database's
      // major version is > 14, so older databases aren't forced into v9 mode.
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
        probeHost: getHostname(),
        probePort: config.port,
        networkMode: localNetworkId(projectId),
        includedSchemas,
        postgrestV9Compat: flags.postgrestV9Compat || forcedV9,
        pgmetaVersionOverride,
      });
      return;
    }

    if (Option.isSome(flags.dbUrl)) {
      // Skips the config load entirely when `--schema` is explicit, since the load's only
      // output here is the schema fallback — a `--db-url --schema ...` invocation must not
      // fail just because the workdir has no project config.
      const loaded = schemas.length > 0 ? null : yield* loadConfig();
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
      const loaded = schemas.length > 0 ? null : yield* loadConfig(ref);
      yield* runProjectTypes(
        ref,
        schemas.length > 0 ? schemas : schemasFromConfig(loaded?.config.api.schemas),
        false,
      );
      return;
    }

    if (Option.isSome(flags.projectId)) {
      const ref = yield* projectRef.resolve(flags.projectId);
      const loaded = schemas.length > 0 ? null : yield* loadConfig(ref);
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
          cause instanceof ProjectRefNotLinkedError &&
          cause.message === PROJECT_NOT_LINKED_MESSAGE
        ) {
          return Effect.fail(
            new Error("Must specify one of --local, --linked, --project-id, or --db-url"),
          );
        }
        return Effect.fail(cause);
      }),
    );
    const loaded = schemas.length > 0 ? null : yield* loadConfig(resolvedRef);
    yield* runProjectTypes(
      resolvedRef,
      schemas.length > 0 ? schemas : schemasFromConfig(loaded?.config.api.schemas),
      false,
    );
  }).pipe(Effect.scoped, Effect.ensuring(telemetryState.flush));
});
