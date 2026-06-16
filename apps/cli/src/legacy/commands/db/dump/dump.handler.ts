import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyResolveDbImage } from "../../../shared/legacy-db-image.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
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
    const { conn, isLocal } = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      linked: useLinked,
      local: useLocal,
      dnsResolver,
      password: flags.password,
    });
    const db = isLocal ? "local" : "remote";

    // 4. Pick the mode-specific script + env (pure builders, `dump.env.ts`).
    const opt = {
      schema: flags.schema,
      keepComments: flags.keepComments,
      excludeTable: flags.exclude,
      columnInsert: !flags.useCopy,
    };
    const mode = flags.dataOnly
      ? ({
          verb: "data",
          script: legacyDumpDataScript,
          env: legacyBuildDataDumpEnv(conn, opt),
        } as const)
      : flags.roleOnly
        ? ({
            verb: "roles",
            script: legacyDumpRoleScript,
            env: legacyBuildRoleDumpEnv(conn, opt),
          } as const)
        : ({
            verb: "schemas",
            script: legacyDumpSchemaScript,
            env: legacyBuildSchemaDumpEnv(conn, opt),
          } as const);

    // 5. Dry-run: print the env-expanded script to stdout (no container).
    if (flags.dryRun) {
      yield* output.raw("DRY RUN: *only* printing the pg_dump script to console.\n", "stderr");
      yield* output.raw(`Dumping ${mode.verb} from ${db} database...\n`, "stderr");
      yield* output.raw(`${legacyExpandScript(mode.script, mode.env)}\n`);
      return;
    }

    // Open (create + truncate) the output file up front so an unwritable `--file`
    // path fails before the dump runs, matching Go's `OpenFile(O_WRONLY|O_CREATE|
    // O_TRUNC, 0644)` ordering (`internal/db/dump/dump.go:24-31`).
    if (Option.isSome(flags.file)) {
      yield* fs.writeFile(flags.file.value, new Uint8Array(0), { mode: DUMP_FILE_MODE }).pipe(
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
    const tomlValues = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
    const image = yield* legacyResolveDbImage(fs, path, cliConfig.workdir, tomlValues.majorVersion);

    const result = yield* docker.runCapture({
      image: legacyGetRegistryImageUrl(image),
      cmd: ["bash", "-c", mode.script, "--"],
      env: mode.env,
      binds: [],
      workingDir: Option.none(),
      securityOpt: [],
      extraHosts,
      network,
    });

    // 8. Persist the captured SQL — to `--file` (truncating) or stdout. Go streams
    //    this live, so partial output on a failed run is also written; do the same
    //    by writing the captured bytes before classifying the exit code.
    if (Option.isSome(flags.file)) {
      yield* fs.writeFile(flags.file.value, result.stdout, { mode: DUMP_FILE_MODE }).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyDbDumpOpenFileError({
              message: `failed to open dump file: ${cause.message}`,
            }),
        ),
      );
    } else {
      yield* output.raw(new TextDecoder().decode(result.stdout));
    }

    // 9. Non-zero container exit → exit 1 (PostRun is skipped, matching cobra).
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new LegacyDbDumpRunError({ message: `error running container: exit ${result.exitCode}` }),
      );
    }

    // PostRun: report the absolute output path on stderr (`cmd/db.go:149-157`).
    if (Option.isSome(flags.file)) {
      const abs = path.resolve(flags.file.value);
      yield* output.raw(`Dumped schema to ${legacyBold(abs)}.\n`, "stderr");
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
