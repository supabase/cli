import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import {
  legacyListRemoteMigrations,
  legacyLoadLocalVersions,
} from "../../../shared/legacy-migration-history.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  LegacyMigrationPasswordFlagsError,
  LegacyMigrationTargetFlagsError,
} from "../migration.errors.ts";
import type { LegacyMigrationListFlags } from "./list.command.ts";
import { legacyMakeMigrationListRows, legacyMigrationListTableCells } from "./list.format.ts";

const LIST_HEADERS = ["Local", "Remote", "Time (UTC)"] as const;

const runList = Effect.fnUntraced(function* (
  flags: LegacyMigrationListFlags,
  target: ReturnType<typeof resolveLegacyDbTargetFlags>,
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const connection = yield* LegacyDbConnection;
  const cliConfig = yield* LegacyCliConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;

  // cobra `MarkFlagsMutuallyExclusive`, in registration order: the target group
  // first, then {db-url, password} (`cmd/migration.go`). `setFlags` is already
  // alphabetically sorted, matching cobra's group-error formatting.
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyMigrationTargetFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }
  if (Option.isSome(flags.dbUrl) && Option.isSome(flags.password)) {
    return yield* Effect.fail(
      new LegacyMigrationPasswordFlagsError({
        message:
          "if any flags in the group [db-url password] are set none of the others can be; [db-url password] were all set",
      }),
    );
  }

  const listBody = Effect.gen(function* () {
    // list defaults to `--linked` (Go: `Bool("linked", true)`).
    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType: target.connType ?? "linked",
      dnsResolver,
      password: flags.password,
    });

    const remote = yield* Effect.scoped(
      Effect.gen(function* () {
        // Go's `utils.ConnectByConfig` prints this to stderr before dialing
        // (`internal/utils/connect.go:343-348`), local/remote per `IsLocalDatabase`.
        yield* output.raw(
          `Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`,
          "stderr",
        );
        const session = yield* connection.connect(cfg.conn, {
          isLocal: cfg.isLocal,
          dnsResolver,
        });
        return yield* legacyListRemoteMigrations(session);
      }),
    );

    const local = yield* legacyLoadLocalVersions(
      fs,
      path,
      path.join(cliConfig.workdir, "supabase", "migrations"),
    );

    const rows = legacyMakeMigrationListRows(remote, local);
    if (output.format === "text") {
      yield* output.raw(renderGlamourTable([...LIST_HEADERS], legacyMigrationListTableCells(rows)));
    } else {
      yield* output.success("Migrations listed", { migrations: rows });
    }
  });

  // `--linked` resolves the project ref and writes the linked-project cache so
  // telemetry carries the org/project grouping (Go's PersistentPostRun
  // `ensureProjectGroupsCached`). `--local` / `--db-url` leave the ref empty.
  if ((target.connType ?? "linked") === "linked") {
    const projectRef = yield* LegacyProjectRefResolver;
    const linkedProjectCache = yield* LegacyLinkedProjectCache;
    const ref = yield* projectRef.loadProjectRef(Option.none());
    return yield* listBody.pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }
  return yield* listBody;
});

export const legacyMigrationList = Effect.fn("legacy.migration.list")(function* (
  flags: LegacyMigrationListFlags,
) {
  const telemetryState = yield* LegacyTelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  yield* runList(flags, target).pipe(Effect.ensuring(telemetryState.flush));
});
