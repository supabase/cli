import { Effect, FileSystem, Option, Path } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { renderGlamourTable } from "../../../output/glamour-table.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import {
  listRemoteMigrations,
  loadLocalVersions,
} from "../../../command-internal/migration-history.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { MigrationPasswordFlagsError, MigrationTargetFlagsError } from "../migration.errors.ts";
import type { MigrationListFlags } from "./list.command.ts";
import { makeMigrationListRows, migrationListTableCells } from "./list.format.ts";

const LIST_HEADERS = ["Local", "Remote", "Time (UTC)"] as const;

const runList = Effect.fnUntraced(function* (
  flags: MigrationListFlags,
  target: ReturnType<typeof resolveDbTargetFlags>,
) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;

  // Mutually-exclusive flag groups, in registration order: the target group
  // first, then {db-url, password}. `setFlags` is already
  // alphabetically sorted, matching the established group-error formatting.
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new MigrationTargetFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }
  if (Option.isSome(flags.dbUrl) && Option.isSome(flags.password)) {
    return yield* Effect.fail(
      new MigrationPasswordFlagsError({
        message:
          "if any flags in the group [db-url password] are set none of the others can be; [db-url password] were all set",
      }),
    );
  }

  // `--project-ref` never implies `--linked` and must not be silently
  // discarded on a non-linked target — see push.handler.ts's identical guard
  // (db push) for the full TS-only rationale.
  if (Option.isSome(flags.projectRef) && (target.connType ?? "linked") !== "linked") {
    return yield* Effect.fail(
      new MigrationTargetFlagsError({
        message:
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      }),
    );
  }

  const listBody = Effect.gen(function* () {
    // list defaults to `--linked`.
    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType: target.connType ?? "linked",
      dnsResolver,
      password: flags.password,
      linkedProjectRef: flags.projectRef,
    });

    const remote = yield* Effect.scoped(
      Effect.gen(function* () {
        // The connect diagnostic prints to stderr before dialing,
        // local/remote per the resolved connection.
        yield* output.raw(
          `Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`,
          "stderr",
        );
        const session = yield* connection.connect(cfg.conn, {
          isLocal: cfg.isLocal,
          dnsResolver,
        });
        return yield* listRemoteMigrations(session);
      }),
    );

    const local = yield* loadLocalVersions(
      fs,
      path,
      path.join(cliSettings.workdir, "supabase", "migrations"),
    );

    const rows = makeMigrationListRows(remote, local);
    if (output.format === "text") {
      yield* output.raw(renderGlamourTable([...LIST_HEADERS], migrationListTableCells(rows)));
    } else {
      yield* output.success("Migrations listed", { migrations: rows });
    }
  });

  // `--linked` resolves the project ref and writes the linked-project cache so
  // telemetry carries the org/project grouping. `--local` / `--db-url` leave the
  // ref empty.
  if ((target.connType ?? "linked") === "linked") {
    const projectRef = yield* ProjectRefResolver;
    const linkedProjectCache = yield* LinkedProjectCache;
    const ref = yield* projectRef.loadProjectRef(flags.projectRef);
    return yield* listBody.pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }
  return yield* listBody;
});

export const migrationList = Effect.fn("migration.list")(function* (flags: MigrationListFlags) {
  const telemetryState = yield* TelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveDbTargetFlags(cliArgs.args);
  yield* runList(flags, target).pipe(Effect.ensuring(telemetryState.flush));
});
