import { loadProjectConfig } from "@supabase/config";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, FileSystem, Option, Path, Stdio, Stream } from "effect";
import { LegacyDebugFlag, LegacyNetworkIdFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectNotLinkedError } from "../../../config/legacy-project-ref.errors.ts";
import { PROJECT_NOT_LINKED_MESSAGE } from "../../../config/legacy-project-ref.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import { legacyTempPaths } from "../../../shared/legacy-temp-paths.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyGenTypesFlags } from "./types.command.ts";
import { LegacyGenTypesNetworkError, LegacyGenTypesUnexpectedStatusError } from "./types.errors.ts";
import { legacyGetHostname } from "../../../shared/legacy-hostname.ts";
import {
  buildPostgresUrl,
  defaultSchemas,
  localDbContainerId,
  localDbPassword,
  localNetworkId,
  normalizeSchemaFlags,
  parseDatabaseUrl,
  parseQueryTimeoutSeconds,
  probeTlsSupport,
  legacyRootCaBundle,
  resolvePgmetaImage,
} from "./types.shared.ts";

const mapProjectTypesError = mapLegacyHttpError({
  networkError: LegacyGenTypesNetworkError,
  statusError: LegacyGenTypesUnexpectedStatusError,
  networkMessage: (cause) => `failed to get typescript types: ${cause}`,
  statusMessage: (_status, body) => `failed to retrieve generated types: ${body}`,
});

function ensureMutuallyExclusive(
  group: ReadonlyArray<string>,
  present: ReadonlyArray<string>,
): Effect.Effect<void, Error> {
  if (present.length <= 1) {
    return Effect.void;
  }
  return Effect.fail(
    new Error(
      `if any flags in the group [${group.join(" ")}] are set none of the others can be; [${present.join(" ")}] were all set`,
    ),
  );
}

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

function hasExplicitLongFlag(rawArgs: ReadonlyArray<string>, flagName: string): boolean {
  const commandIndex = rawArgs.findIndex(
    (value, index) => value === "types" && rawArgs[index - 1] === "gen",
  );
  if (commandIndex === -1) {
    return false;
  }

  for (let index = commandIndex + 1; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === undefined) {
      return false;
    }
    if (token === "--") {
      return false;
    }
    if (token === `--${flagName}` || token.startsWith(`--${flagName}=`)) {
      return true;
    }
  }
  return false;
}

export const legacyGenTypes = Effect.fn("legacy.gen.types")(function* (flags: LegacyGenTypesFlags) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stdio = yield* Stdio.Stdio;
  const networkId = yield* LegacyNetworkIdFlag;
  const debug = yield* LegacyDebugFlag;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const rawArgs = yield* stdio.args;

  yield* ensureMutuallyExclusive(
    ["local", "linked", "project-id", "db-url"],
    [
      ...(flags.local ? ["local"] : []),
      ...(flags.linked ? ["linked"] : []),
      ...(Option.isSome(flags.projectId) ? ["project-id"] : []),
      ...(Option.isSome(flags.dbUrl) ? ["db-url"] : []),
    ],
  );
  yield* ensureMutuallyExclusive(
    ["linked", "project-id", "swift-access-control"],
    [
      ...(flags.linked ? ["linked"] : []),
      ...(Option.isSome(flags.projectId) ? ["project-id"] : []),
      ...(hasExplicitLongFlag(rawArgs, "swift-access-control") ? ["swift-access-control"] : []),
    ],
  );
  yield* ensureMutuallyExclusive(
    ["linked", "project-id", "postgrest-v9-compat"],
    [
      ...(flags.linked ? ["linked"] : []),
      ...(Option.isSome(flags.projectId) ? ["project-id"] : []),
      ...(flags.postgrestV9Compat ? ["postgrest-v9-compat"] : []),
    ],
  );
  yield* ensureMutuallyExclusive(
    ["linked", "project-id", "query-timeout"],
    [
      ...(flags.linked ? ["linked"] : []),
      ...(Option.isSome(flags.projectId) ? ["project-id"] : []),
      ...(hasExplicitLongFlag(rawArgs, "query-timeout") ? ["query-timeout"] : []),
    ],
  );

  if (flags.postgrestV9Compat && Option.isNone(flags.dbUrl)) {
    return yield* Effect.fail(new Error("--postgrest-v9-compat must used together with --db-url"));
  }
  const legacyLang = findLegacyPositionalLanguage(rawArgs);
  if (
    Option.isSome(legacyLang) &&
    legacyLang.value !== "typescript" &&
    !hasExplicitLongFlag(rawArgs, "lang")
  ) {
    return yield* Effect.fail(new Error("use --lang flag to specify the typegen language"));
  }

  const schemas = normalizeSchemaFlags(flags.schema);
  const queryTimeoutSeconds = yield* parseQueryTimeoutSeconds(flags.queryTimeout);
  const lang = flags.lang;
  const swiftAccessControl = flags.swiftAccessControl;

  const loadConfig = () => loadProjectConfig(cliConfig.workdir);

  const runProjectTypes = (projectRef: string, includedSchemas: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (lang !== "typescript") {
        return yield* Effect.fail(
          new Error(
            `Unable to generate ${lang} types for selected project. Try using --db-url flag instead.`,
          ),
        );
      }

      const response = yield* api.v1
        .generateTypescriptTypes({
          ref: projectRef,
          included_schemas: includedSchemas.join(","),
        })
        .pipe(Effect.catch(mapProjectTypesError));

      yield* output.raw(response.types);
    }).pipe(Effect.ensuring(linkedProjectCache.cache(projectRef)));

  const runPgMeta = (input: {
    readonly url: string;
    readonly host: string;
    readonly port: number;
    readonly probeHost: string;
    readonly probePort: number;
    readonly networkMode: "host" | string;
    readonly includedSchemas: string;
    readonly postgrestV9Compat: boolean;
    readonly pgmetaVersionOverride?: string;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* output.raw(`Connecting to ${input.host} ${input.port}\n`, "stderr");

        // Mirrors Go's container.Config.Env ([]string of "KEY=VALUE"). We pass each
        // entry as a `--env KEY=VALUE` argument rather than a `--env-file`: env-files
        // split on newlines, so they cannot carry the multi-line PEM CA bundle, and a
        // value containing a newline could inject an extra variable. Passing argv
        // elements keeps each entry as exactly one variable regardless of its contents.
        const env = [
          `PG_META_DB_URL=${input.url}`,
          `PG_CONN_TIMEOUT_SECS=${queryTimeoutSeconds}`,
          `PG_QUERY_TIMEOUT_SECS=${queryTimeoutSeconds}`,
          `PG_META_GENERATE_TYPES=${lang}`,
          `PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=${input.includedSchemas}`,
          `PG_META_GENERATE_TYPES_SWIFT_ACCESS_CONTROL=${swiftAccessControl}`,
          `PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=${String(!input.postgrestV9Compat)}`,
        ];

        // Go's isRequireSSL emits this warning to stderr when the probe runs with
        // certificate verification disabled. Our wire-level SSLRequest probe never
        // verifies certificates, so honour the same env var for stderr parity.
        if (process.env["SUPABASE_CA_SKIP_VERIFY"] === "true") {
          yield* output.raw(
            "WARNING: TLS certificate verification disabled for SSL probe (SUPABASE_CA_SKIP_VERIFY=true)\n",
            "stderr",
          );
        }

        const useTls = yield* probeTlsSupport(input.probeHost, input.probePort);
        if (useTls && !debug) {
          env.push(`PG_META_DB_SSL_ROOT_CERT=${legacyRootCaBundle()}`);
        }

        // Go's DockerStart applies `--network-id` over any base network mode (even the
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
        const child = yield* spawner.spawn(
          ChildProcess.make("docker", args, {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        );

        const [exitCode] = yield* Effect.all(
          [
            child.exitCode.pipe(Effect.map(Number)),
            forwardByteStream(child.stdout, (text) => output.raw(text, "stdout")),
            forwardByteStream(child.stderr, (text) => output.raw(text, "stderr")),
          ],
          { concurrency: "unbounded" },
        );

        if (exitCode !== 0) {
          return yield* Effect.fail(new Error(`error running container: exit ${exitCode}`));
        }
      }),
    );

  const assertLocalDbRunning = (projectId: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        // We only need the exit code and stderr (Go uses Docker's ContainerInspect API,
        // which reads no stdout). Discard stdout so the inspect JSON can never fill the
        // pipe buffer and deadlock the unconsumed stream.
        const child = yield* spawner.spawn(
          ChildProcess.make("docker", ["container", "inspect", localDbContainerId(projectId)], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          }),
        );
        const [exitCode, stderr] = yield* Effect.all([
          child.exitCode.pipe(Effect.map(Number)),
          collectByteStream(child.stderr),
        ]);
        if (exitCode !== 0) {
          const message = stderr.trim();
          if (message.includes("No such container")) {
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
    if (flags.local) {
      const loaded = yield* loadConfig();
      if (loaded === null) {
        return yield* Effect.fail(
          new Error("failed to load config: supabase/config.toml not found"),
        );
      }

      const paths = legacyTempPaths(path, cliConfig.workdir);
      // Go resolves Config.Api.Image from the rest-version file only when
      // Db.MajorVersion > 14, then forces v9 compat when that image tag contains "v9"
      // (pkg/config/config.go:657-666, internal/gen/types/types.go:69). Gate and trim
      // identically so we don't force v9 on older databases.
      const restVersion =
        loaded.config.db.major_version > 14
          ? (yield* fs
              .readFileString(paths.restVersion)
              .pipe(Effect.orElseSucceed(() => ""))).trim()
          : "";
      const forcedV9 = restVersion.length > 0 && restVersion.includes("v9");
      const pgmetaVersionOverride = yield* fs
        .readFileString(paths.pgmetaVersion)
        .pipe(Effect.orElseSucceed(() => ""));

      const includedSchemas = (
        schemas.length > 0 ? schemas : defaultSchemas(loaded.config.api.schemas)
      ).join(",");
      const projectId = loaded.config.project_id ?? path.basename(cliConfig.workdir);
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
        probePort: loaded.config.db.port,
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
      const loaded = yield* loadConfig();
      const ref = yield* resolver.resolve(Option.none());
      yield* runProjectTypes(
        ref,
        schemas.length > 0 ? schemas : defaultSchemas(loaded?.config.api.schemas),
      );
      return;
    }

    if (Option.isSome(flags.projectId)) {
      const loaded = yield* loadConfig();
      const ref = yield* resolver.resolve(flags.projectId);
      yield* runProjectTypes(
        ref,
        schemas.length > 0 ? schemas : defaultSchemas(loaded?.config.api.schemas),
      );
      return;
    }

    const resolvedRef = yield* resolver.resolve(Option.none()).pipe(
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
    const loaded = yield* loadConfig();
    yield* runProjectTypes(
      resolvedRef,
      schemas.length > 0 ? schemas : defaultSchemas(loaded?.config.api.schemas),
    );
  }).pipe(Effect.ensuring(telemetryState.flush));
});
