import { Effect, FileSystem, Path } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { renderGlamourTable } from "../../../output/glamour-table.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { hostedMutationPreapproval } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import {
  listRemoteMigrations,
  loadLocalVersions,
} from "../../../command-internal/migration-history.ts";
import {
  resolveTarget,
  type ResolvedTarget,
} from "../../../command-internal/target/resolve-target.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { MigrationListFlags } from "./list.command.ts";
import { makeMigrationListRows, migrationListTableCells } from "./list.format.ts";

const listHeaders = (target: ResolvedTarget) =>
  ["Local", target.kind === "local" ? "Local DB" : "Remote", "Time (UTC)"] as const;

const runList = Effect.fnUntraced(function* (flags: MigrationListFlags) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;

  const target = yield* resolveTarget(flags);

  const listBody = Effect.gen(function* () {
    const cfg = yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: flags.password,
      hasPasswordFlag: true,
      networkBanRemoval: yield* hostedMutationPreapproval,
    });

    const remote = yield* Effect.scoped(
      Effect.gen(function* () {
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
    yield* Effect.annotateCurrentSpan({
      "db.is_local": cfg.isLocal,
      "migration.count": rows.length,
    });
    if (output.format === "text") {
      yield* output.raw(
        renderGlamourTable([...listHeaders(target)], migrationListTableCells(rows)),
      );
    } else {
      yield* output.success("Migrations listed", { migrations: rows });
    }
  });

  if (target.kind === "linked") {
    const linkedProjectCache = yield* LinkedProjectCache;
    return yield* listBody.pipe(Effect.ensuring(linkedProjectCache.cache(target.ref)));
  }
  return yield* listBody;
});

export const migrationList = Effect.fn("migration.list")(function* (flags: MigrationListFlags) {
  const telemetryState = yield* TelemetryState;
  yield* runList(flags).pipe(Effect.ensuring(telemetryState.flush));
});
