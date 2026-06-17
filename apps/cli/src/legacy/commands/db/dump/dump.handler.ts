import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type { LegacyDbConnType } from "../../../shared/legacy-db-target-flags.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyReadProjectRefFile } from "../../../shared/legacy-temp-paths.ts";
import { legacyResolveDbImage } from "../../../shared/legacy-db-image.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import {
  legacyIpv6Suggestion,
  legacyIsIPv6ConnectivityError,
} from "../../../shared/legacy-connect-errors.ts";
import { legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
import {
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
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
} from "./dump.env.ts";
import {
  legacyDumpDataScript,
  legacyDumpRoleScript,
  legacyDumpSchemaScript,
} from "./dump.scripts.ts";

/**
 * Mutually-exclusive flag groups, in cobra's check order (it sorts the joined
 * group keys alphabetically — `apps/cli-go/cmd/db.go:434,436,441,445`). The `key`
 * preserves the registration order used in the error's `[group]`, while the set
 * of violating flags is alphabetised in the message (cobra `sort.Strings(set)`).
 */
const LEGACY_DUMP_EXCLUSIVE_GROUPS = [
  { key: "db-url linked local", flags: ["db-url", "linked", "local"] },
  { key: "keep-comments data-only", flags: ["keep-comments", "data-only"] },
  { key: "role-only data-only", flags: ["role-only", "data-only"] },
  { key: "schema role-only", flags: ["schema", "role-only"] },
] as const;

const DUMP_FILE_MODE = 0o644;

/** Map a filesystem error to Go's `--file` open-failure error. */
const toOpenFileError = (cause: { readonly message: string }) =>
  new LegacyDbDumpOpenFileError({ message: `failed to open dump file: ${cause.message}` });

export const legacyDbDump = Effect.fn("legacy.db.dump")(function* (flags: LegacyDbDumpFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const docker = yield* LegacyDockerRun;
  const cliConfig = yield* LegacyCliConfig;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const networkIdFlag = yield* LegacyNetworkIdFlag;

  // Resolved linked ref, captured so the post-run finalizer can cache the project
  // (GET /v1/projects/{ref}) AFTER the command's own API calls — matching Go's
  // `ensureProjectGroupsCached` in `PersistentPostRun` (cmd/root.go:214-234).
  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
    // The grouped boolean flags are modelled as `Option` (presence = pflag `Changed`)
    // for the mutex/target checks; resolve their effective values here for the places
    // that consume the value (Go's `BoolVar` default is false).
    const dataOnly = Option.getOrElse(flags.dataOnly, () => false);
    const roleOnly = Option.getOrElse(flags.roleOnly, () => false);
    const keepComments = Option.getOrElse(flags.keepComments, () => false);

    // 1. cobra `ValidateRequiredFlags` runs after the PreRun marks `data-only`
    //    required when `--use-copy`/`--exclude` are set (`cmd/db.go:134-137`). The
    //    requirement is satisfied by flag PRESENCE (cobra checks `flag.Changed`), not
    //    the value — so `--use-copy --data-only=false` passes the check and Go runs the
    //    schema dump with dataOnly=false. Gate on absence, not the resolved value.
    if ((flags.useCopy || flags.exclude.length > 0) && Option.isNone(flags.dataOnly)) {
      return yield* Effect.fail(
        new LegacyDbDumpRequiresDataOnlyError({
          message: `required flag(s) "data-only" not set`,
        }),
      );
    }

    // 2. cobra `ValidateFlagGroups` (`MarkFlagsMutuallyExclusive`). "Set" follows
    //    cobra's `Changed`: an Option is set when `Some`, a boolean when explicitly
    //    `true`, a string-slice when non-empty.
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
      const set = group.flags.filter(isSet);
      if (set.length > 1) {
        return yield* Effect.fail(
          new LegacyDbDumpMutuallyExclusiveFlagsError({
            message: `if any flags in the group [${group.key}] are set none of the others can be; [${[...set].sort().join(" ")}] were all set`,
          }),
        );
      }
    }

    // 3. Resolve the connection. dump defaults `--linked` to true (unlike the
    //    other db subcommands), so translate the flag surface into the resolver's
    //    selection the way Go's `ParseDatabaseConfig` does: db-url > local >
    //    linked, defaulting to linked when neither local nor db-url is set
    //    (`internal/utils/flags/db_url.go:46-62`).
    const useLocal = Option.isNone(flags.dbUrl) && Option.isSome(flags.local);
    const useLinked = Option.isNone(flags.dbUrl) && Option.isNone(flags.local);
    // `connType` selects the resolver branch (Go's Changed-first precedence): a
    // `--db-url` wins, then explicit `--local`; otherwise dump defaults to linked
    // (unlike the other db commands, whose unset default is local).
    const connType: LegacyDbConnType = Option.isSome(flags.dbUrl)
      ? "db-url"
      : useLocal
        ? "local"
        : "linked";
    // Go's `LoadProjectRef` sets `flags.ProjectRef` BEFORE `NewDbConfigWithPassword`
    // (`flags/db_url.go:88` vs `:95`), and `ensureProjectGroupsCached` runs on failure
    // too (`cmd/root.go:176`), so a connection-resolution failure (IPv6 / pooler /
    // login-role) still refreshes the linked-project cache. The resolver only returns
    // the ref on success, so capture it up-front for the linked path. `db dump` has no
    // `--project-ref` flag, so the ref comes from config.toml `project_id` then the
    // `.temp/project-ref` file — the same chain `resolveOptional`/smart generate use.
    if (connType === "linked") {
      const refOpt = Option.isSome(cliConfig.projectId)
        ? cliConfig.projectId
        : yield* legacyReadProjectRefFile(fs, path, cliConfig.workdir);
      if (Option.isSome(refOpt)) {
        linkedRefForCache = refOpt.value;
      }
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
    });
    const db = isLocal ? "local" : "remote";
    // On the linked path, re-read config with the resolved ref so a matching
    // `[remotes.<ref>]` block overrides `db.major_version` for the pg_dump image,
    // mirroring Go's remote-merged `utils.Config` for `db dump --linked`.
    const linkedRef = Option.getOrUndefined(resolvedRef ?? Option.none());
    // On a successful linked resolve this is the canonical ref (it equals the
    // up-front capture); guard so a `None` from a non-linked path never clobbers it.
    if (linkedRef !== undefined) {
      linkedRefForCache = linkedRef;
    }

    // Read config (with any `[remotes.<ref>]` override applied) BEFORE the dry-run
    // print. Go validates the merged config in the root `ParseDatabaseConfig`
    // (`cmd/root.go:118`) before `dump.Run`, even for `--dry-run`, so an invalid
    // merged config (e.g. an unsupported remote `db.major_version` or a malformed
    // remote `project_id`) fails rather than silently printing a script.
    const tomlValues = yield* legacyReadDbToml(fs, path, cliConfig.workdir, linkedRef);

    // 4. Pick the mode-specific script + env (pure builders, `dump.env.ts`).
    //    Go declares --schema/-s and --exclude/-x as cobra StringSlice
    //    (`apps/cli-go/cmd/db.go:432,444`); both flags are CSV-parsed at the flag
    //    level via `legacyParseSchemaFlags` (pflag `readAsCSV` semantics, quoted
    //    commas preserved, malformed CSV rejected at parse time), so they arrive here
    //    already split — matching `gen types` / `db lint` / declarative.
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

    // 5. Dry-run: print the env-expanded script to stdout (no container).
    if (flags.dryRun) {
      yield* output.raw("DRY RUN: *only* printing the pg_dump script to console.\n", "stderr");
      yield* output.raw(`Dumping ${mode.verb} from ${db} database...\n`, "stderr");
      yield* output.raw(`${legacyExpandScript(mode.script, modeEnv)}\n`);
      // Go's `dump.Run` skips opening the file on dry-run but returns success, so the
      // cobra `PostRun` (not `PostRunE`) still prints `Dumped schema to <abs>.` when
      // `--file` is set (`cmd/db.go:148-156`), with no dry-run guard. Emit the same
      // stderr line here WITHOUT creating/truncating the file — Go never touches it on
      // a dry-run (`internal/db/dump/dump.go:23-32`). Resolve the path like the real
      // path (Go's `filepath.Abs` after the PreRun chdir into the workdir).
      if (Option.isSome(flags.file)) {
        const dryRunFile = path.resolve(cliConfig.workdir, flags.file.value);
        yield* output.raw(`Dumped schema to ${legacyBold(dryRunFile)}.\n`, "stderr");
      }
      return;
    }

    // Resolve the pg_dump image BEFORE opening `--file` (only needed for the real
    // container path; the dry-run script above is image-independent). Go skips the
    // file OpenFile on dry-run (`internal/db/dump/dump.go:23-32`), so the file is
    // created/truncated only here, after the dry-run early return.
    const image = yield* legacyResolveDbImage(
      fs,
      path,
      cliConfig.workdir,
      tomlValues.majorVersion,
      Option.getOrUndefined(tomlValues.orioledbVersion),
    );

    // Resolve a relative `--file` against the workdir: Go chdir's into the workdir
    // in PersistentPreRunE before opening the file (`cmd/root.go:104` →
    // `internal/utils/misc.go`), so `--workdir /repo db dump -f out.sql` writes
    // `/repo/out.sql`. `path.resolve` leaves absolute paths unchanged.
    const resolvedFile = Option.map(flags.file, (file) => path.resolve(cliConfig.workdir, file));

    // Open (create + truncate) the output file up front so an unwritable `--file`
    // path fails before the dump runs, matching Go's `OpenFile(O_WRONLY|O_CREATE|
    // O_TRUNC, 0644)` ordering (`internal/db/dump/dump.go:24-31`).
    if (Option.isSome(resolvedFile)) {
      yield* fs
        .writeFile(resolvedFile.value, new Uint8Array(0), { mode: DUMP_FILE_MODE })
        .pipe(Effect.mapError(toOpenFileError));
    }

    // 6. Diagnostic to stderr (Go writes this for both real and dry-run paths).
    yield* output.raw(`Dumping ${mode.verb} from ${db} database...\n`, "stderr");

    // 7. Run the pg_dump container, capturing stdout. dump always uses host
    //    networking (`dockerExec` sets `NetworkMode: NetworkHost`), overridden only
    //    by `--network-id` (Go's `DockerStart`). No `SecurityOpt` is set.
    const networkId = Option.getOrUndefined(networkIdFlag);
    const network =
      networkId !== undefined && networkId.length > 0
        ? { _tag: "named" as const, name: networkId }
        : { _tag: "host" as const };
    const extraHosts =
      runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];

    const dockerOpts = (env: Readonly<Record<string, string>>) => ({
      image: legacyGetRegistryImageUrl(image),
      cmd: ["bash", "-c", mode.script, "--"],
      env,
      binds: [],
      workingDir: Option.none(),
      securityOpt: [],
      extraHosts,
      network,
    });

    // Go streams pg_dump stdout straight to the destination sink (the `--file` handle
    // or `os.Stdout`) via `stdcopy.StdCopy` with `Follow:true`, at constant memory
    // (`apps/cli-go/internal/utils/docker.go:374,394`). Mirror that: write each chunk
    // to the destination as it arrives instead of buffering the whole dump. stderr is
    // teed live (Go's `io.MultiWriter(os.Stderr, errBuf)`).
    const runContainer = (env: Readonly<Record<string, string>>) =>
      Option.isSome(resolvedFile)
        ? // `--file`: (re)truncate then append-stream. Truncating per attempt
          // reproduces Go's `resetOutput` before a pooler retry, so the file ends
          // up holding only the successful attempt's output.
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
                    return yield* docker.runStream(dockerOpts(env), {
                      onStdout: (chunk) =>
                        file.writeAll(chunk).pipe(Effect.mapError(toOpenFileError)),
                      teeStderr: true,
                    });
                  }),
                ),
              ),
            )
        : // stdout: write each chunk straight to stdout (binary-safe, no decode).
          // On a pooler retry Go leaves the partial first-attempt bytes on stdout
          // (its `resetOutput` can't rewind a pipe); streaming matches that.
          docker.runStream(dockerOpts(env), {
            onStdout: (chunk) => output.rawBytes(chunk),
            teeStderr: true,
          });

    let result = yield* runContainer(modeEnv);

    // 7b. Container-level pooler fallback (Go's `RunWithPoolerFallback`,
    //     `internal/db/dump/pooler_fallback.go`). A linked dump can reach the direct
    //     host from the CLI process (so the resolver returned the direct conn) yet
    //     fail from inside the pg_dump container on an IPv6-only Docker network. When
    //     the captured container stderr classifies as an IPv6 connectivity error,
    //     retry once through the project's IPv4 transaction pooler. Gated to the
    //     `--linked` path with a direct `db.<ref>.<host>` connection (Go's
    //     `PoolerFallbackEligible` + `ProjectRefFromDirectDbHost`).
    if (
      result.exitCode !== 0 &&
      useLinked &&
      !isLocal &&
      conn.host.startsWith("db.") &&
      conn.host.endsWith(`.${cliConfig.projectHost}`) &&
      legacyIsIPv6ConnectivityError(result.stderr)
    ) {
      // Go's `PoolerFallbackConfig` returns `ok=false` on ANY fallback-resolution
      // error (e.g. temp-role creation/wait fails) and then reports the ORIGINAL
      // pg_dump failure with the IPv6 guidance — the optional retry must not replace
      // the actionable dump error. So a resolution failure is treated as "no
      // fallback" (the original `result` is surfaced at step 9).
      const pooler = yield* resolver
        .resolvePoolerFallback({
          dbUrl: flags.dbUrl,
          connType: "linked",
          dnsResolver,
          password: flags.password,
        })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(pooler)) {
        yield* output.raw(
          `${legacyYellow(
            `Warning: Direct connection to ${conn.host} is unavailable because this environment does not support IPv6.\nRetrying via the IPv4 connection pooler.`,
          )}\n`,
          "stderr",
        );
        yield* output.raw(`Dumping ${mode.verb} from ${db} database...\n`, "stderr");
        result = yield* runContainer(mode.buildEnv(pooler.value, opt));
      }
    }

    // 8. The dump has already been streamed to the destination by `runContainer`
    //    (to `--file` or stdout) as pg_dump produced it.

    // 9. Non-zero container exit → exit 1 (PostRun is skipped, matching cobra).
    //    Go classifies the captured container stderr into an actionable suggestion
    //    before returning (`RunWithPoolerFallback` → `SetConnectSuggestion`,
    //    `pooler_fallback.go:52-65`): on the no-fallback path and the failed-retry
    //    path alike, an IPv6 connectivity failure attaches the IPv4 transaction-pooler
    //    guidance. `result.stderr` is the relevant stderr in both cases (the original
    //    when no retry ran, the retry's when it did), so classify it here. (Go further
    //    enriches the no-fallback hint with the project's pooler URL via
    //    `SuggestIPv6Pooler`; that prefill needs the pooler connection string exposed
    //    through the resolver and is left as a follow-up — the generic hint is restored.)
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new LegacyDbDumpRunError({
          message: `error running container: exit ${result.exitCode}`,
          ...(legacyIsIPv6ConnectivityError(result.stderr)
            ? { suggestion: legacyIpv6Suggestion() }
            : {}),
        }),
      );
    }

    // PostRun: report the absolute output path on stderr (`cmd/db.go:149-157`).
    if (Option.isSome(resolvedFile)) {
      yield* output.raw(`Dumped schema to ${legacyBold(resolvedFile.value)}.\n`, "stderr");
    }
  }).pipe(
    // Cache the linked project (telemetry groups) in post-run, after the command's
    // own API calls, then flush telemetry — Go's PersistentPostRun ordering. The
    // cache layer no-ops when the file exists / no token / non-200.
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined ? linkedProjectCache.cache(linkedRefForCache) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
