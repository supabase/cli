import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type { LegacyDbConnType } from "../../../shared/legacy-db-target-flags.ts";
import {
  legacyApplyProjectEnv,
  legacyLoadProjectEnv,
  legacyReadDbToml,
} from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyResolveDbImage } from "../../../shared/legacy-db-image.ts";
import {
  legacyIpv6Suggestion,
  legacyIsIPv6ConnectivityError,
} from "../../../shared/legacy-connect-errors.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { cobraMutuallyExclusiveErrorMessage } from "../../../../shared/cli/cobra-flag-groups.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import type { LegacyDbDumpFlags } from "./dump.command.ts";
import {
  LegacyDbDumpMutuallyExclusiveFlagsError,
  LegacyDbDumpOpenFileError,
  LegacyDbDumpRequiresDataOnlyError,
  LegacyDbDumpRunError,
} from "./dump.errors.ts";
import {
  legacyBuildDataDumpEnv,
  legacyBuildRoleDumpEnv,
  legacyBuildSchemaDumpEnv,
  legacyExpandScript,
} from "../../../shared/legacy-pg-dump.env.ts";
import { legacyStreamPgDump } from "../../../shared/legacy-pg-dump.run.ts";
import { legacyRunWithPoolerFallback } from "../shared/legacy-pooler-fallback.ts";
import {
  legacyDumpDataScript,
  legacyDumpRoleScript,
  legacyDumpSchemaScript,
} from "../../../shared/legacy-pg-dump.scripts.ts";

/**
 * Mutually-exclusive flag groups, in the established check order (the group
 * keys are sorted alphabetically). Each group's flags are in registration
 * order, matching the `[group]` in the error text; the set of violating
 * flags is alphabetised separately by `cobraMutuallyExclusiveErrorMessage`.
 */
const LEGACY_DUMP_EXCLUSIVE_GROUPS = [
  ["db-url", "linked", "local"],
  ["keep-comments", "data-only"],
  ["role-only", "data-only"],
  ["schema", "role-only"],
] as const;

const DUMP_FILE_MODE = 0o644;

/** Map a filesystem error to the `--file` open-failure error. */
const toOpenFileError = (cause: { readonly message: string }) =>
  new LegacyDbDumpOpenFileError({ message: `failed to open dump file: ${cause.message}` });

export const legacyDbDump = Effect.fn("legacy.db.dump")(function* (flags: LegacyDbDumpFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;

  // Resolved linked ref, captured so the post-run finalizer can cache the project
  // (GET /v1/projects/{ref}) AFTER the command's own API calls.
  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
    // Make an allowlisted `supabase/.env` registry override visible to the
    // synchronous `process.env` reader in `legacyGetRegistryImageUrl` (the pg_dump
    // image), reverted when this scope closes. The pure `legacyLoadProjectEnv` does
    // not apply the env as a side effect of `resolveDbPassword`, so `db dump` opts
    // in explicitly here.
    const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
    const effectiveProjectEnv = {
      ...projectEnv,
      ...(yield* legacyApplyProjectEnv(projectEnv)),
    };

    // The grouped boolean flags are modelled as `Option` (presence = explicitly
    // set) for the mutex/target checks; resolve their effective values here for
    // the places that consume the value (default is false).
    const dataOnly = Option.getOrElse(flags.dataOnly, () => false);
    const roleOnly = Option.getOrElse(flags.roleOnly, () => false);
    const keepComments = Option.getOrElse(flags.keepComments, () => false);

    // 1. `data-only` is required when `--use-copy`/`--exclude` are set. The
    //    requirement is satisfied by flag PRESENCE, not the value — so
    //    `--use-copy --data-only=false` passes the check and runs the schema
    //    dump with dataOnly=false. Gate on absence, not the resolved value.
    if ((flags.useCopy || flags.exclude.length > 0) && Option.isNone(flags.dataOnly)) {
      return yield* new LegacyDbDumpRequiresDataOnlyError({
        message: `required flag(s) "data-only" not set`,
      });
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
    for (const group of LEGACY_DUMP_EXCLUSIVE_GROUPS) {
      const set = group.filter(isSet);
      if (set.length > 1) {
        return yield* new LegacyDbDumpMutuallyExclusiveFlagsError({
          message: cobraMutuallyExclusiveErrorMessage(group, set),
        });
      }
    }

    // 3. Resolve the connection. dump defaults `--linked` to true (unlike the
    //    other db subcommands), so translate the flag surface into the
    //    resolver's selection: db-url > local > linked, defaulting to linked
    //    when neither local nor db-url is set.
    const useLocal = Option.isNone(flags.dbUrl) && Option.isSome(flags.local);
    // `connType` selects the resolver branch (explicitly-set-first precedence):
    // a `--db-url` wins, then explicit `--local`; otherwise dump defaults to
    // linked (unlike the other db commands, whose unset default is local).
    const connType: LegacyDbConnType = Option.isSome(flags.dbUrl)
      ? "db-url"
      : useLocal
        ? "local"
        : "linked";
    // `--project-ref` never implies `--linked` and must not be silently discarded
    // on a non-linked target — one-liner: see push.handler.ts's identical guard
    // for the full TS-only rationale.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* new LegacyDbDumpMutuallyExclusiveFlagsError({
        message:
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      });
    }
    // The project ref is resolved before the connection is built, and the
    // linked-project cache is refreshed unconditionally afterward — including on a
    // connection-resolution failure (IPv6 / pooler / login-role). Capture the ref
    // up-front for the linked path via `loadProjectRef`, which implements the same
    // flag > SUPABASE_PROJECT_ID/project_id > `.temp/project-ref` file precedence as
    // the resolver, now validated — it raises the same invalid-ref/not-linked errors
    // `resolver.resolve()` would raise right after, so the user-visible error surface
    // is unchanged, and an unvalidated raw `--project-ref` value is never stored for
    // the cache finalizer to send to the Management API.
    if (connType === "linked") {
      const refResolver = yield* LegacyProjectRefResolver;
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
    // On a successful linked resolve this is the canonical ref (it equals the
    // up-front capture); guard so a `None` from a non-linked path never clobbers it.
    if (linkedRef !== undefined) {
      linkedRefForCache = linkedRef;
    }

    // Read config (with any `[remotes.<ref>]` override applied) BEFORE the
    // dry-run print. The merged config is validated even for `--dry-run`, so an
    // invalid merged config (e.g. an unsupported remote `db.major_version` or a
    // malformed remote `project_id`) fails rather than silently printing a script.
    const tomlValues = yield* legacyReadDbToml(fs, path, cliConfig.workdir, linkedRef);

    // 4. Pick the mode-specific script + env (pure builders, `legacy-pg-dump.env.ts`).
    //    --schema/-s and --exclude/-x are CSV string-slice values, CSV-parsed at
    //    the flag level via `legacyParseSchemaFlags` (quoted commas preserved,
    //    malformed CSV rejected at parse time), so they arrive here already
    //    split — matching `gen types` / `db lint` / declarative.
    const opt = {
      schema: flags.schema,
      keepComments,
      excludeTable: flags.exclude,
      columnInsert: !flags.useCopy,
    };
    // The script + diagnostic verb are connection-independent; the env is rebuilt
    // per connection so the pooler-fallback retry can target a different host.
    const mode = dataOnly
      ? ({ verb: "data", script: legacyDumpDataScript, buildEnv: legacyBuildDataDumpEnv } as const)
      : roleOnly
        ? ({
            verb: "roles",
            script: legacyDumpRoleScript,
            buildEnv: legacyBuildRoleDumpEnv,
          } as const)
        : ({
            verb: "schemas",
            script: legacyDumpSchemaScript,
            buildEnv: legacyBuildSchemaDumpEnv,
          } as const);
    const modeEnv = mode.buildEnv(conn, opt);

    // Every `--file` branch keys off `len(path) > 0`, not flag presence: an
    // explicit `--file ""` means stdout, with no file open and no `Dumped
    // schema to …` line.
    const fileFlag = Option.filter(flags.file, (file) => file.length > 0);

    // 5. Dry-run: print the env-expanded script to stdout (no container).
    if (flags.dryRun) {
      yield* output.raw("DRY RUN: *only* printing the pg_dump script to console.\n", "stderr");
      yield* output.raw(`Dumping ${mode.verb} from ${db} database...\n`, "stderr");
      yield* output.raw(`${legacyExpandScript(mode.script, modeEnv)}\n`);
      // The file is never opened on dry-run, but `Dumped schema to <abs>.` is
      // still printed when `--file` is set, with no dry-run guard. Emit the
      // same stderr line here WITHOUT creating/truncating the file. Resolve
      // the path like the real path (absolute, relative to the workdir).
      if (Option.isSome(fileFlag)) {
        const dryRunFile = path.resolve(cliConfig.workdir, fileFlag.value);
        yield* output.raw(`Dumped schema to ${legacyBold(dryRunFile)}.\n`, "stderr");
      }
      return;
    }

    // Resolve the pg_dump image BEFORE opening `--file` (only needed for the
    // real container path; the dry-run script above is image-independent). The
    // file is never opened on dry-run, so it is created/truncated only here,
    // after the dry-run early return.
    const image = yield* legacyResolveDbImage(
      fs,
      path,
      cliConfig.workdir,
      tomlValues.majorVersion,
      Option.getOrUndefined(tomlValues.orioledbVersion),
    );

    // Resolve a relative `--file` against the workdir, so `--workdir /repo db
    // dump -f out.sql` writes `/repo/out.sql`. `path.resolve` leaves absolute
    // paths unchanged.
    const resolvedFile = Option.map(fileFlag, (file) => path.resolve(cliConfig.workdir, file));

    // Open (create + truncate) the output file up front so an unwritable
    // `--file` path fails before the dump runs.
    if (Option.isSome(resolvedFile)) {
      yield* fs
        .writeFile(resolvedFile.value, new Uint8Array(0), { mode: DUMP_FILE_MODE })
        .pipe(Effect.mapError(toOpenFileError));
    }

    // 6. Diagnostic to stderr (printed for both real and dry-run paths).
    yield* output.raw(`Dumping ${mode.verb} from ${db} database...\n`, "stderr");

    // 7. Run the pg_dump container, streaming stdout. `legacyStreamPgDump` applies
    //    the registry mirror + host networking (overridden by `--network-id`) and
    //    tees stderr.
    //
    // pg_dump stdout streams straight to the destination sink (the `--file`
    // handle or stdout) at constant memory: write each chunk to the
    // destination as it arrives instead of buffering the whole dump.
    const runContainer = (env: Readonly<Record<string, string>>) =>
      Option.isSome(resolvedFile)
        ? // `--file`: (re)truncate then append-stream. Truncating per attempt
          // ensures the file ends up holding only the successful attempt's
          // output when a pooler retry runs.
          fs.writeFile(resolvedFile.value, new Uint8Array(0), { mode: DUMP_FILE_MODE }).pipe(
            Effect.mapError(toOpenFileError),
            Effect.andThen(
              Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* fs
                    .open(resolvedFile.value, { flag: "a" })
                    .pipe(Effect.mapError(toOpenFileError));
                  return yield* legacyStreamPgDump({
                    image,
                    script: mode.script,
                    env,
                    onStdout: (chunk) =>
                      file.writeAll(chunk).pipe(Effect.mapError(toOpenFileError)),
                    projectEnvValues: effectiveProjectEnv,
                  });
                }),
              ),
            ),
          )
        : // stdout: write each chunk straight to stdout (binary-safe, no decode).
          // On a pooler retry the partial first-attempt bytes are left on
          // stdout (a pipe can't be rewound); streaming matches that.
          legacyStreamPgDump({
            image,
            script: mode.script,
            env,
            onStdout: (chunk) => output.rawBytes(chunk),
            projectEnvValues: effectiveProjectEnv,
          });

    // 7b. Container-level IPv6 → IPv4-pooler retry, shared with `db pull`. A
    //     linked dump can reach the direct host from the CLI process (so the
    //     resolver returned the direct conn) yet fail from inside the pg_dump
    //     container on an IPv6-only Docker network. `resolvePoolerFallback` is
    //     neutralised to `None` on any resolution error so the original,
    //     actionable pg_dump failure is surfaced at step 9 rather than a
    //     fallback-setup error. `db dump` re-prints the "Dumping …" line on
    //     the retry.
    const result = yield* legacyRunWithPoolerFallback({
      result: yield* runContainer(modeEnv),
      connType,
      host: conn.host,
      isLocal,
      projectHost: cliConfig.projectHost,
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

    // 9. Non-zero container exit → exit 1 (the success-only PostRun step is
    //    skipped). The captured container stderr is classified into an
    //    actionable suggestion before returning: on the no-fallback path and
    //    the failed-retry path alike, an IPv6 connectivity failure attaches
    //    the IPv4 transaction-pooler guidance. `result.stderr` is the relevant
    //    stderr in both cases (the original when no retry ran, the retry's
    //    when it did), so classify it here. (Enriching the no-fallback hint
    //    with the project's pooler URL needs the pooler connection string
    //    exposed through the resolver and is left as a follow-up — the
    //    generic hint is restored.)
    if (result.exitCode !== 0) {
      return yield* new LegacyDbDumpRunError({
        message: `error running container: exit ${result.exitCode}`,
        ...(legacyIsIPv6ConnectivityError(result.stderr)
          ? { suggestion: legacyIpv6Suggestion() }
          : {}),
      });
    }

    // Report the absolute output path on stderr.
    if (Option.isSome(resolvedFile)) {
      yield* output.raw(`Dumped schema to ${legacyBold(resolvedFile.value)}.\n`, "stderr");
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
    // command run: `legacyApplyProjectEnv` registers a finalizer that reverts it.
    Effect.scoped,
  );
});
