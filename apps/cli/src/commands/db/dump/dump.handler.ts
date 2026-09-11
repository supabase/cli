import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConnType } from "../../../command-internal/db-target-flags.ts";
import {
  applyProjectEnv,
  loadProjectEnv,
  readDbToml,
} from "../../../command-internal/db-config.toml-read.ts";
import { resolveDbImage } from "../../../command-internal/db-image.ts";
import {
  ipv6Suggestion,
  isIPv6ConnectivityError,
} from "../../../command-internal/connect-errors.ts";
import { bold, yellow } from "../../../command-internal/colors.ts";
import { DnsResolverFlag, NetworkIdFlag } from "../../../command-internal/global-flags.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { cobraMutuallyExclusiveErrorMessage } from "../../../shared/cli/cobra-flag-groups.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { DbDumpFlags } from "./dump.command.ts";
import {
  DbDumpMutuallyExclusiveFlagsError,
  DbDumpOpenFileError,
  DbDumpRequiresDataOnlyError,
  DbDumpRunError,
} from "./dump.errors.ts";
import {
  buildDataDumpEnv,
  buildRoleDumpEnv,
  buildSchemaDumpEnv,
  expandScript,
} from "../../../command-internal/pg-dump.env.ts";
import { streamPgDumpWithClient } from "../../../command-internal/pg-dump.run.ts";
import {
  dumpConnForHostClient,
  rewriteDumpHostForToolContainer,
} from "../../../command-internal/postgres-client.run.ts";
import { currentStackBackend } from "../../../command-internal/stack-backend.ts";
import { stackRequireProjectRuntime } from "../../../command-internal/stack-local-database.ts";
import { viperEnvStringWithProjectFallback } from "../../../command-internal/viper-env.ts";
import { runWithPoolerFallback } from "../shared/pooler-fallback.ts";
import {
  dumpDataScript,
  dumpRoleScript,
  dumpSchemaScript,
} from "../../../command-internal/pg-dump.scripts.ts";

/**
 * Mutually-exclusive flag groups, in the established check order (the group
 * keys are sorted alphabetically). Each group's flags are in registration
 * order, matching the `[group]` in the error text; the set of violating
 * flags is alphabetised separately by `cobraMutuallyExclusiveErrorMessage`.
 */
const DUMP_EXCLUSIVE_GROUPS = [
  ["db-url", "linked", "local"],
  ["keep-comments", "data-only"],
  ["role-only", "data-only"],
  ["schema", "role-only"],
] as const;

const DUMP_FILE_MODE = 0o644;

/** Map a filesystem error to the `--file` open-failure error. */
const toOpenFileError = (cause: { readonly message: string }) =>
  new DbDumpOpenFileError({ message: `failed to open dump file: ${cause.message}` });

export const dbDump = Effect.fn("db.dump")(function* (flags: DbDumpFlags) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;
  const networkIdFlag = yield* NetworkIdFlag;
  const tty = yield* Tty;
  const runtimeInfo = yield* RuntimeInfo;

  // Captured so the post-run finalizer can cache the project after the command's
  // own API calls.
  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
    // Makes an allowlisted `supabase/.env` registry override visible to the synchronous
    // `process.env` reader in `getRegistryImageUrl`; reverted when this scope closes.
    const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
    yield* applyProjectEnv(projectEnv);

    // Resolves grouped boolean flags' effective values (default false) for code paths
    // that need the value, not just presence.
    const dataOnly = Option.getOrElse(flags.dataOnly, () => false);
    const roleOnly = Option.getOrElse(flags.roleOnly, () => false);
    const keepComments = Option.getOrElse(flags.keepComments, () => false);

    // 1. `data-only` is required when `--use-copy`/`--exclude` are set, keyed on
    //    presence not value — `--use-copy --data-only=false` still passes.
    if ((flags.useCopy || flags.exclude.length > 0) && Option.isNone(flags.dataOnly)) {
      return yield* Effect.fail(
        new DbDumpRequiresDataOnlyError({
          message: `required flag(s) "data-only" not set`,
        }),
      );
    }

    // 2. Mutually-exclusive flag groups. "Set" means explicitly set: an
    //    Option is set when `Some`, a boolean when explicitly `true`, a
    //    string-slice when non-empty.
    const isSet = (name: string): boolean => {
      switch (name) {
        case "db-url":
          return Option.isSome(flags.dbUrl);
        case "linked":
          return Option.isSome(flags.linked);
        case "local":
          return Option.isSome(flags.local);
        case "data-only":
          return Option.isSome(flags.dataOnly);
        case "role-only":
          return Option.isSome(flags.roleOnly);
        case "keep-comments":
          return Option.isSome(flags.keepComments);
        case "schema":
          return flags.schema.length > 0;
        default:
          return false;
      }
    };
    for (const group of DUMP_EXCLUSIVE_GROUPS) {
      const set = group.filter(isSet);
      if (set.length > 1) {
        return yield* Effect.fail(
          new DbDumpMutuallyExclusiveFlagsError({
            message: cobraMutuallyExclusiveErrorMessage(group, set),
          }),
        );
      }
    }

    // 3. Resolve the connection: db-url > local > linked, defaulting to linked when
    //    neither is set (unlike other db subcommands, which default to local).
    const useLocal = Option.isNone(flags.dbUrl) && Option.isSome(flags.local);
    const connType: DbConnType = Option.isSome(flags.dbUrl)
      ? "db-url"
      : useLocal
        ? "local"
        : "linked";
    // `--project-ref` never implies `--linked`; see push.handler.ts's identical guard.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* Effect.fail(
        new DbDumpMutuallyExclusiveFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
    }
    // The project ref is resolved before the connection is built, and the
    // linked-project cache is refreshed unconditionally afterward, even on a
    // connection-resolution failure. `loadProjectRef` validates the ref up front so an
    // unvalidated raw `--project-ref` is never stored for the cache finalizer.
    if (connType === "linked") {
      const refResolver = yield* ProjectRefResolver;
      linkedRefForCache = yield* refResolver.loadProjectRef(flags.projectRef);
    }
    const {
      conn,
      isLocal,
      ref: resolvedRef,
    } = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      password: flags.password,
      linkedProjectRef: flags.projectRef,
    });
    const db = isLocal ? "local" : "remote";
    // On the linked path, re-read config with the resolved ref so a matching
    // `[remotes.<ref>]` block overrides `db.major_version` for the pg_dump image.
    const linkedRef = Option.getOrUndefined(resolvedRef ?? Option.none());
    // Guards a `None` from a non-linked path from clobbering the up-front capture.
    if (linkedRef !== undefined) {
      linkedRefForCache = linkedRef;
    }

    // Read before the dry-run print so an invalid merged config fails rather than
    // silently printing a script.
    const tomlValues = yield* readDbToml(fs, path, cliSettings.workdir, linkedRef);

    const backend = yield* currentStackBackend;
    const stackRuntime =
      backend.kind === "stack" && isLocal ? yield* stackRequireProjectRuntime : undefined;
    const useHostClient = stackRuntime?.kind === "native";
    const networkId = Option.getOrUndefined(networkIdFlag);
    const envNetworkId = viperEnvStringWithProjectFallback("SUPABASE_NETWORK_ID", projectEnv);
    const dumpUsesHostNetwork =
      backend.kind === "stack"
        ? networkId === undefined || networkId.length === 0
        : (networkId === undefined || networkId.length === 0) && envNetworkId.length === 0;
    const dumpConn = useHostClient
      ? dumpConnForHostClient(conn)
      : backend.kind === "stack" && isLocal
        ? {
            ...conn,
            host: rewriteDumpHostForToolContainer(conn.host, {
              platform: runtimeInfo.platform,
              usesHostNetwork: dumpUsesHostNetwork,
            }),
          }
        : conn;
    const dumpClient = useHostClient
      ? {
          kind: "host" as const,
          command: roleOnly ? ("pg_dumpall" as const) : ("pg_dump" as const),
          expectedMajor: tomlValues.majorVersion,
        }
      : { kind: "container" as const };

    // 4. Pick the mode-specific script + env. --schema/-s and --exclude/-x arrive here
    //    already CSV-parsed by `parseSchemaFlags`.
    const opt = {
      schema: flags.schema,
      keepComments,
      excludeTable: flags.exclude,
      columnInsert: !flags.useCopy,
    };
    // The script + diagnostic verb are connection-independent; the env is rebuilt
    // per connection so the pooler-fallback retry can target a different host.
    const mode = dataOnly
      ? ({ verb: "data", script: dumpDataScript, buildEnv: buildDataDumpEnv } as const)
      : roleOnly
        ? ({
            verb: "roles",
            script: dumpRoleScript,
            buildEnv: buildRoleDumpEnv,
          } as const)
        : ({
            verb: "schemas",
            script: dumpSchemaScript,
            buildEnv: buildSchemaDumpEnv,
          } as const);
    const modeEnv = mode.buildEnv(dumpConn, opt);

    // Keys off `path.length > 0`, not flag presence: `--file ""` means stdout, no
    // file opened.
    const fileFlag = Option.filter(flags.file, (file) => file.length > 0);

    // 5. Dry-run: print the env-expanded script to stdout (no container).
    if (flags.dryRun) {
      yield* output.raw("DRY RUN: *only* printing the pg_dump script to console.\n", "stderr");
      yield* output.raw(`Dumping ${mode.verb} from ${db} database...\n`, "stderr");
      yield* output.raw(`${expandScript(mode.script, modeEnv)}\n`);
      // Still prints "Dumped schema to <abs>." on dry-run, without creating/truncating
      // the file.
      if (Option.isSome(fileFlag)) {
        const dryRunFile = path.resolve(cliSettings.workdir, fileFlag.value);
        yield* output.raw(`Dumped schema to ${bold(dryRunFile)}.\n`, "stderr");
      }
      return;
    }

    // Resolved before opening `--file`; the dry-run path above never reaches here.
    const { image } = yield* resolveDbImage(
      fs,
      path,
      cliSettings.workdir,
      tomlValues.majorVersion,
      Option.getOrUndefined(tomlValues.orioledbVersion),
    );

    // Resolves a relative `--file` against the workdir (e.g. --workdir /repo -f
    // out.sql → /repo/out.sql).
    const resolvedFile = Option.map(fileFlag, (file) => path.resolve(cliSettings.workdir, file));

    // PowerShell interposes a pipe for `>`/`|` and re-encodes what it reads with the
    // legacy console code page, mangling multi-byte UTF-8; TTYs, disk-file handles, and
    // MSYS/mintty pipes are byte-faithful and never warn.
    const trackNonAscii =
      runtimeInfo.platform === "win32" &&
      tty.stdoutIsPipe &&
      Option.isNone(resolvedFile) &&
      (process.env["MSYSTEM"] ?? "") === "" &&
      process.env["TERM_PROGRAM"] !== "mintty";
    let sawNonAscii = false;

    // Open (create + truncate) the output file up front so an unwritable
    // `--file` path fails before the dump runs.
    if (Option.isSome(resolvedFile)) {
      yield* fs
        .writeFile(resolvedFile.value, new Uint8Array(0), { mode: DUMP_FILE_MODE })
        .pipe(Effect.mapError(toOpenFileError));
    }

    // 6. Diagnostic to stderr (printed for both real and dry-run paths).
    yield* output.raw(`Dumping ${mode.verb} from ${db} database...\n`, "stderr");

    // 7. Streams pg_dump's stdout straight to the destination (file or stdout) at
    //    constant memory, chunk by chunk, via `streamPgDump`.
    const runContainer = (env: Readonly<Record<string, string>>) =>
      Option.isSome(resolvedFile)
        ? // `--file`: (re)truncate then append-stream. Truncating per attempt
          // ensures the file ends up holding only the successful attempt's
          // output when a pooler retry runs.
          fs
            .writeFile(resolvedFile.value, new Uint8Array(0), { mode: DUMP_FILE_MODE })
            .pipe(Effect.mapError(toOpenFileError))
            .pipe(
              Effect.andThen(
                Effect.scoped(
                  Effect.gen(function* () {
                    const file = yield* fs
                      .open(resolvedFile.value, { flag: "a" })
                      .pipe(Effect.mapError(toOpenFileError));
                    return yield* streamPgDumpWithClient({
                      image,
                      script: mode.script,
                      env,
                      onStdout: (chunk) =>
                        file.writeAll(chunk).pipe(Effect.mapError(toOpenFileError)),
                      projectEnvValues: projectEnv,
                      client: dumpClient,
                    });
                  }),
                ),
              ),
            )
        : // stdout: write each chunk straight to stdout (binary-safe, no decode).
          // On a pooler retry the partial first-attempt bytes are left on
          // stdout (a pipe can't be rewound); streaming matches that.
          streamPgDumpWithClient({
            image,
            script: mode.script,
            env,
            onStdout: trackNonAscii
              ? (chunk) =>
                  Effect.suspend(() => {
                    for (let i = 0; !sawNonAscii && i < chunk.length; i += 1) {
                      if (chunk[i]! > 0x7f) sawNonAscii = true;
                    }
                    return output.rawBytes(chunk);
                  })
              : (chunk) => output.rawBytes(chunk),
            projectEnvValues: projectEnv,
            client: dumpClient,
          });

    // 7b. IPv6 → IPv4-pooler retry, shared with `db pull`: a linked dump can reach the
    //     direct host from the CLI process yet fail inside the container on an
    //     IPv6-only Docker network. Falls back to `None` on any resolution error so the
    //     original pg_dump failure surfaces instead of a fallback-setup error.
    const result = yield* runWithPoolerFallback({
      result: yield* runContainer(modeEnv),
      connType,
      host: conn.host,
      isLocal,
      projectHost: cliSettings.projectHost,
      resolvePooler: () =>
        resolver
          .resolvePoolerFallback({
            dbUrl: flags.dbUrl,
            connType: "linked",
            dnsResolver,
            password: flags.password,
            linkedProjectRef: flags.projectRef,
          })
          .pipe(Effect.orElseSucceed(() => Option.none())),
      runWithConn: (c) => runContainer(mode.buildEnv(c, opt)),
      reprintOnRetry: output.raw(`Dumping ${mode.verb} from ${db} database...\n`, "stderr"),
    });

    // 8. The dump has already been streamed to the destination by `runContainer`
    //    (to `--file` or stdout) as pg_dump produced it.

    // 9. A nonzero exit classifies `result.stderr` (the retry's stderr when a retry
    //    ran, otherwise the original) into an actionable suggestion, e.g. IPv6
    //    connectivity.
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new DbDumpRunError({
          message: `error running container: exit ${result.exitCode}`,
          ...(isIPv6ConnectivityError(result.stderr) ? { suggestion: ipv6Suggestion() } : {}),
        }),
      );
    }

    // Report the absolute output path on stderr.
    if (Option.isSome(resolvedFile)) {
      yield* output.raw(`Dumped schema to ${bold(resolvedFile.value)}.\n`, "stderr");
    }

    if (sawNonAscii) {
      yield* output.raw(
        `${yellow("WARNING:")} The dump contains non-ASCII characters. ` +
          "Some Windows shells (notably Windows PowerShell 5.1) corrupt them when redirecting " +
          "or piping output. If the result looks garbled, re-run with --file (e.g. -f dump.sql) " +
          "to write the dump directly to disk.\n",
        "stderr",
      );
    }
  }).pipe(
    // Cache the linked project (telemetry groups) in post-run, after the
    // command's own API calls, then flush telemetry. The cache layer no-ops
    // when the file exists / no token / non-200.
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined ? linkedProjectCache.cache(linkedRefForCache) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
    // Scope the `SUPABASE_INTERNAL_IMAGE_REGISTRY`-from-`.env` apply above to this
    // command run: `applyProjectEnv` registers a finalizer that reverts it.
    Effect.scoped,
  );
});
