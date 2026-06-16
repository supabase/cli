import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyResolveDbImage } from "../../../shared/legacy-db-image.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import { legacyIsIPv6ConnectivityError } from "../../../shared/legacy-connect-errors.ts";
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

export const legacyDbDump = Effect.fn("legacy.db.dump")(function* (flags: LegacyDbDumpFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const docker = yield* LegacyDockerRun;
  const cliConfig = yield* LegacyCliConfig;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const networkIdFlag = yield* LegacyNetworkIdFlag;

  yield* Effect.gen(function* () {
    // 1. cobra `ValidateRequiredFlags` runs after the PreRun marks `data-only`
    //    required when `--use-copy`/`--exclude` are set (`cmd/db.go:134-137`).
    if ((flags.useCopy || flags.exclude.length > 0) && !flags.dataOnly) {
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
          return flags.linked;
        case "local":
          return flags.local;
        case "data-only":
          return flags.dataOnly;
        case "role-only":
          return flags.roleOnly;
        case "keep-comments":
          return flags.keepComments;
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
    const useLocal = Option.isNone(flags.dbUrl) && flags.local;
    const useLinked = Option.isNone(flags.dbUrl) && !flags.local;
    const {
      conn,
      isLocal,
      ref: resolvedRef,
    } = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      linked: useLinked,
      local: useLocal,
      dnsResolver,
      password: flags.password,
    });
    const db = isLocal ? "local" : "remote";
    // On the linked path, re-read config with the resolved ref so a matching
    // `[remotes.<ref>]` block overrides `db.major_version` for the pg_dump image,
    // mirroring Go's remote-merged `utils.Config` for `db dump --linked`.
    const linkedRef = Option.getOrUndefined(resolvedRef ?? Option.none());

    // Read config (with any `[remotes.<ref>]` override applied) BEFORE the dry-run
    // print. Go validates the merged config in the root `ParseDatabaseConfig`
    // (`cmd/root.go:118`) before `dump.Run`, even for `--dry-run`, so an invalid
    // merged config (e.g. an unsupported remote `db.major_version` or a malformed
    // remote `project_id`) fails rather than silently printing a script.
    const tomlValues = yield* legacyReadDbToml(fs, path, cliConfig.workdir, linkedRef);

    // 4. Pick the mode-specific script + env (pure builders, `dump.env.ts`).
    //    Go declares --schema/-s and --exclude/-x as cobra StringSlice
    //    (`apps/cli-go/cmd/db.go:432,444`), which comma-splits each value before it
    //    reaches the pg_dump env builder. The Effect CLI flags are repeatable but do
    //    not split on comma, so split here to match (e.g. `--schema public,auth`).
    const splitCsv = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
      values.flatMap((value) => value.split(","));
    const opt = {
      schema: splitCsv(flags.schema),
      keepComments: flags.keepComments,
      excludeTable: splitCsv(flags.exclude),
      columnInsert: !flags.useCopy,
    };
    // The script + diagnostic verb are connection-independent; the env is rebuilt
    // per connection so the pooler-fallback retry can target a different host.
    const mode = flags.dataOnly
      ? ({ verb: "data", script: legacyDumpDataScript, buildEnv: legacyBuildDataDumpEnv } as const)
      : flags.roleOnly
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
      return;
    }

    // Resolve the pg_dump image BEFORE opening `--file` (only needed for the real
    // container path; the dry-run script above is image-independent). Go skips the
    // file OpenFile on dry-run (`internal/db/dump/dump.go:23-32`), so the file is
    // created/truncated only here, after the dry-run early return.
    const image = yield* legacyResolveDbImage(fs, path, cliConfig.workdir, tomlValues.majorVersion);

    // Resolve a relative `--file` against the workdir: Go chdir's into the workdir
    // in PersistentPreRunE before opening the file (`cmd/root.go:104` →
    // `internal/utils/misc.go`), so `--workdir /repo db dump -f out.sql` writes
    // `/repo/out.sql`. `path.resolve` leaves absolute paths unchanged.
    const resolvedFile = Option.map(flags.file, (file) => path.resolve(cliConfig.workdir, file));

    // Open (create + truncate) the output file up front so an unwritable `--file`
    // path fails before the dump runs, matching Go's `OpenFile(O_WRONLY|O_CREATE|
    // O_TRUNC, 0644)` ordering (`internal/db/dump/dump.go:24-31`).
    if (Option.isSome(resolvedFile)) {
      yield* fs.writeFile(resolvedFile.value, new Uint8Array(0), { mode: DUMP_FILE_MODE }).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyDbDumpOpenFileError({
              message: `failed to open dump file: ${cause.message}`,
            }),
        ),
      );
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

    const runContainer = (env: Readonly<Record<string, string>>) =>
      docker.runCapture(
        {
          image: legacyGetRegistryImageUrl(image),
          cmd: ["bash", "-c", mode.script, "--"],
          env,
          binds: [],
          workingDir: Option.none(),
          securityOpt: [],
          extraHosts,
          network,
        },
        // Go's dump tees container stderr to os.Stderr live (`io.MultiWriter`),
        // so pg_dump progress/warnings reach the user as they happen.
        { teeStderr: true },
      );

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
      const pooler = yield* resolver.resolvePoolerFallback({
        dbUrl: flags.dbUrl,
        linked: true,
        local: false,
        dnsResolver,
        password: flags.password,
      });
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

    // 8. Persist the captured SQL — to `--file` (truncating) or stdout. Go streams
    //    this live; the captured bytes are written before classifying the exit code,
    //    and on a pooler retry only the retry's output is written (Go truncates the
    //    partial first-attempt output before retrying).
    if (Option.isSome(resolvedFile)) {
      yield* fs.writeFile(resolvedFile.value, result.stdout, { mode: DUMP_FILE_MODE }).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyDbDumpOpenFileError({
              message: `failed to open dump file: ${cause.message}`,
            }),
        ),
      );
    } else {
      // Write the captured bytes verbatim — Go streams pg_dump stdout byte-for-byte,
      // so a non-UTF-8 dump (SQL_ASCII/LATIN1) must not be decoded/re-encoded.
      yield* output.rawBytes(result.stdout);
    }

    // 9. Non-zero container exit → exit 1 (PostRun is skipped, matching cobra).
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new LegacyDbDumpRunError({ message: `error running container: exit ${result.exitCode}` }),
      );
    }

    // PostRun: report the absolute output path on stderr (`cmd/db.go:149-157`).
    if (Option.isSome(resolvedFile)) {
      yield* output.raw(`Dumped schema to ${legacyBold(resolvedFile.value)}.\n`, "stderr");
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
