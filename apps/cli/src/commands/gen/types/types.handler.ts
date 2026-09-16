import type { LoadedCliConfig } from "@supabase/config/effect";
import { loadCliConfig } from "@supabase/config/internal";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Effect, FileSystem, Option, Path, Stdio, Stream } from "effect";
import { getDomain } from "tldts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
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
import { isIPv6ConnectivityErrorCause } from "../../../command-internal/connect-errors.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags } from "../../../command-internal/db-config.types.ts";
import { poolerConfigFromConnectionString } from "../../../command-internal/db-config.parse.ts";
import { readDbToml } from "../../../command-internal/db-config.toml-read.ts";
import { getHostname } from "../../../command-internal/hostname.ts";
import type { PgConnInput } from "../../../command-internal/db-connection.service.ts";
import { tempPaths } from "../../../command-internal/temp-paths.ts";
import {
  missingProjectConfigMessageEffect,
  relativeConfigPath,
} from "../../../command-internal/workdir-project.ts";
import { shouldSearchAncestors } from "../../../command-internal/workdir-search.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  isDirectDbHost,
  runWithPoolerFallback,
} from "../../../command-internal/pooler-fallback.ts";
import type { GenTypesFlags } from "./types.command.ts";
import {
  GenTypesMissingProjectConfigError,
  GenTypesNetworkError,
  GenTypesNetworkIdUnsupportedError,
  GenTypesParseConfigError,
  GenTypesUnexpectedStatusError,
  GenTypesWorkdirError,
} from "./types.errors.ts";
import { GenTypesGenerator } from "./types.generator.service.ts";
import { currentStackBackend } from "../../../command-internal/stack-backend.ts";
import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import {
  defaultSchemas,
  localDbContainerId,
  localDbPassword,
  parseQueryTimeoutMillis,
  rootCaBundle,
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

/** Pins the Supabase CA on a known-Supabase target, promoting `require` to `verify-ca`. */
function pinSupabaseTls(conn: PgConnInput): PgConnInput {
  return { ...conn, sslmode: "require", sslrootcertInline: rootCaBundle() };
}

/** Whether `host`'s registrable domain matches the active profile's pooler domain. */
function isPoolerHost(host: string, poolerHost: string): boolean {
  if (poolerHost.length === 0) return false;
  const domain = getDomain(host);
  return domain !== null && domain.toLowerCase() === poolerHost.toLowerCase();
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
  const dnsResolver = yield* DnsResolverFlag;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const rawArgs = yield* stdio.args;
  const platformApi = yield* CommandPlatformApiFactory;
  const projectRef = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const dbConfig = yield* DbConfigResolver;
  const generator = yield* GenTypesGenerator;
  const backend = yield* currentStackBackend;

  // "Set" means the flag appeared in argv at all (pflag's `Changed` semantics), not its parsed
  // value — `--linked=false` still counts. Argv is scanned directly since a token like
  // `-s --linked` consumes `--linked` as `-s`'s value, not as its own boolean flag.
  const scan = pflagArgvScan(rawArgs, GEN_TYPES_COMMAND_PATH, GEN_TYPES_SCAN_SPEC);
  const occurrences = scan.occurrences;

  // Parsed before the telemetry context is installed, so an invalid `--query-timeout` wins
  // over every guard below and, unlike them, is never followed by a telemetry flush.
  const queryTimeoutMillis = yield* parseQueryTimeoutMillis(flags.queryTimeout);

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

  /**
   * Sets a session-level `statement_timeout` and connect timeout from `--query-timeout` on
   * every generate attempt — the server-side `statement_timeout` is the real guard, unlike the
   * pg-meta container's own env-var timeouts it replaces.
   */
  const withQueryTimeout = (conn: PgConnInput): PgConnInput => ({
    ...conn,
    runtimeParams: {
      ...conn.runtimeParams,
      statement_timeout:
        queryTimeoutMillis === 0 ? "0" : String(Math.max(1, Math.round(queryTimeoutMillis))),
    },
    ...(queryTimeoutMillis === 0
      ? {}
      : { connectTimeoutSeconds: Math.max(1, Math.ceil(queryTimeoutMillis / 1000)) }),
  });

  const runGenerate = (input: {
    readonly conn: PgConnInput;
    readonly isLocal: boolean;
    readonly includedSchemas: ReadonlyArray<string>;
    readonly detectOneToOneRelationships: boolean;
    readonly poolerFallback?: {
      readonly directHost: string;
      readonly eligible: boolean;
      readonly resolve: Effect.Effect<Option.Option<PgConnInput>, unknown>;
    };
  }) =>
    Effect.gen(function* () {
      const attempt = (conn: PgConnInput) =>
        Effect.scoped(
          Effect.gen(function* () {
            const target = withQueryTimeout(conn);
            yield* output.raw(`Connecting to ${target.host} ${target.port}\n`, "stderr");
            return yield* generator.generate({
              conn: target,
              isLocal: input.isLocal,
              dnsResolver,
              lang,
              includedSchemas: input.includedSchemas,
              detectOneToOneRelationships: input.detectOneToOneRelationships,
              swiftAccessControl,
            });
          }),
        );

      const types =
        input.poolerFallback === undefined
          ? yield* attempt(input.conn)
          : yield* runWithPoolerFallback({
              run: attempt(input.conn),
              retry: attempt,
              directHost: input.poolerFallback.directHost,
              eligible: input.poolerFallback.eligible,
              resolveFallback: input.poolerFallback.resolve,
              classifyError: isIPv6ConnectivityErrorCause,
            });

      yield* output.raw(types);
    });

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
        const conn = pinSupabaseTls(resolved.conn);
        yield* runGenerate({
          conn,
          isLocal: resolved.isLocal,
          includedSchemas,
          detectOneToOneRelationships: !flags.postgrestV9Compat,
          poolerFallback: {
            directHost: conn.host,
            eligible: !resolved.isLocal && isDirectDbHost(conn.host, cliSettings.projectHost),
            resolve: dbConfig
              .resolvePoolerFallback(resolveFlags)
              .pipe(Effect.map(Option.map(pinSupabaseTls))),
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
            ? Option.some(pinSupabaseTls({ ...parsed.conn, password: branchPassword }))
            : Option.none<PgConnInput>();
        }),
        Effect.orElseSucceed(() => Option.none<PgConnInput>()),
      );

      yield* runGenerate({
        conn: pinSupabaseTls({
          host: branch.db_host,
          port: branch.db_port,
          user: branchUser,
          password: branchPassword,
          database: "postgres",
        }),
        isLocal: false,
        includedSchemas,
        detectOneToOneRelationships: !flags.postgrestV9Compat,
        poolerFallback: {
          directHost: branch.db_host,
          eligible: isDirectDbHost(branch.db_host, cliSettings.projectHost),
          resolve: poolerFallback,
        },
      });
    });

  const assertLocalDbRunning = (
    projectId: string,
    projectEnvValues?: Readonly<Record<string, string>>,
  ) =>
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
            env: projectEnvValues === undefined ? undefined : { ...projectEnvValues },
            extendEnv: true,
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

    // `--network-id` can no longer be honored: generation runs in-process, not in a Docker
    // container. It is a persistent flag, so a pre-command occurrence (`supabase --network-id
    // net gen types ...`) lands in `prePathOccurrences`, not `occurrences` — check both.
    if (occurrences.has("network-id") || scan.prePathOccurrences.has("network-id")) {
      return yield* Effect.fail(
        new GenTypesNetworkIdUnsupportedError({
          message:
            "gen types now generates types in-process and cannot join a Docker network via " +
            "--network-id; use a host-reachable --db-url instead.",
        }),
      );
    }

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
      const projectEnvValues = Object.fromEntries(
        Object.entries(config.projectEnv).filter(([key]) => key !== "SUPABASE_DB_PASSWORD"),
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

      const includedSchemas = schemas.length > 0 ? schemas : defaultSchemas(config.apiSchemas);
      if (backend.kind === "stack") {
        const resolved = yield* dbConfig.resolve({
          dbUrl: Option.none(),
          connType: "local",
          dnsResolver,
        });
        yield* runGenerate({
          conn: resolved.conn,
          isLocal: true,
          includedSchemas,
          detectOneToOneRelationships: !(flags.postgrestV9Compat || forcedV9),
        });
        return;
      }

      yield* assertLocalDbRunning(projectId, projectEnvValues);
      yield* runGenerate({
        conn: {
          host: yield* getHostname(projectEnvValues),
          port: config.port,
          user: "postgres",
          password: yield* localDbPassword(),
          database: "postgres",
        },
        isLocal: true,
        includedSchemas,
        detectOneToOneRelationships: !(flags.postgrestV9Compat || forcedV9),
      });
      return;
    }

    if (Option.isSome(flags.dbUrl)) {
      // Skips the config load entirely when `--schema` is explicit, since the load's only
      // output here is the schema fallback — a `--db-url --schema ...` invocation must not
      // fail just because the workdir has no project config.
      const loaded = schemas.length > 0 ? null : yield* loadConfig();
      const resolved = yield* dbConfig.resolve({
        dbUrl: flags.dbUrl,
        connType: "db-url",
        dnsResolver,
      });
      const includedSchemas =
        schemas.length > 0 ? schemas : defaultSchemas(loaded?.config.api.schemas ?? []);

      // A DSN's own `sslmode`/`sslrootcert` is honored as-is; only a known Supabase host with
      // neither set gets the CA pinned, matching the project-ref/branch paths.
      const conn =
        !resolved.isLocal &&
        resolved.conn.sslmode === undefined &&
        resolved.conn.sslrootcert === undefined &&
        (isDirectDbHost(resolved.conn.host, cliSettings.projectHost) ||
          isPoolerHost(resolved.conn.host, cliSettings.poolerHost))
          ? pinSupabaseTls(resolved.conn)
          : resolved.conn;

      yield* runGenerate({
        conn,
        isLocal: resolved.isLocal,
        includedSchemas,
        detectOneToOneRelationships: !flags.postgrestV9Compat,
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
