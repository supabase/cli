import * as nodePath from "node:path";
import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { LegacyDebugFlag, LegacyNetworkIdFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import type { LegacyTestDbFlags } from "./db.command.ts";
import {
  LegacyTestDbEnablePgtapError,
  LegacyTestDbMutuallyExclusiveFlagsError,
  LegacyTestDbRunError,
} from "./db.errors.ts";
import { buildLegacyPgProveArgs } from "./db.pg-prove-args.ts";

// Go: `apps/cli-go/internal/db/test/test.go:24-25`.
const ENABLE_PGTAP = "create extension if not exists pgtap with schema extensions";
const DISABLE_PGTAP = "drop extension if exists pgtap";
// Go bakes this default into the Dockerfile (`pkg/config/templates/Dockerfile:20`).
// The TS config schema does not model an `[images]` override, so it is fixed here.
const LEGACY_PG_PROVE_IMAGE = "supabase/pg_prove:3.36";
const MAX_PROJECT_ID_LENGTH = 40;

/** Port of Go's `sanitizeProjectId` (`pkg/config/config.go:1037`). */
function sanitizeProjectId(src: string): string {
  return src
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^[_.-]+/, "")
    .slice(0, MAX_PROJECT_ID_LENGTH);
}

export const legacyTestDb = Effect.fn("legacy.test.db")(function* (flags: LegacyTestDbFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;
  const docker = yield* LegacyDockerRun;
  const cliConfig = yield* LegacyCliConfig;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const debug = yield* LegacyDebugFlag;
  const networkIdFlag = yield* LegacyNetworkIdFlag;

  yield* Effect.gen(function* () {
    // Reproduce cobra's MarkFlagsMutuallyExclusive("db-url","linked","local")
    // (`apps/cli-go/cmd/db.go:485`). `--local` defaults to false in the TS flag
    // surface, so a `true` value means it was explicitly passed — matching
    // cobra's `Changed` semantics.
    const setFlags: Array<string> = [];
    if (Option.isSome(flags.dbUrl)) setFlags.push("db-url");
    if (flags.linked) setFlags.push("linked");
    if (flags.local) setFlags.push("local");
    if (setFlags.length > 1) {
      return yield* Effect.fail(
        new LegacyTestDbMutuallyExclusiveFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
        }),
      );
    }

    const { conn, isLocal } = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      linked: flags.linked,
      local: flags.local,
    });

    const args = buildLegacyPgProveArgs({
      paths: flags.paths,
      cwd: runtimeInfo.cwd,
      workdir: cliConfig.workdir,
      debug,
    });

    // For a local database the pg_prove container joins the supabase docker
    // network and reaches postgres via the internal `db:5432` alias; otherwise
    // it uses host networking (Go: test.go:79-87).
    const runEnv = {
      PGHOST: isLocal ? "db" : conn.host,
      PGPORT: isLocal ? "5432" : String(conn.port),
      PGUSER: conn.user,
      PGPASSWORD: conn.password,
      PGDATABASE: conn.database,
    };

    // Network selection mirrors Go's DockerRunOnceWithConfig: a non-empty
    // `--network-id` overrides everything (even host mode); otherwise local uses
    // the generated `supabase_network_<project_id>` network and remote uses host
    // networking (`apps/cli-go/internal/utils/docker.go:267-271`, `test.go:79-87`).
    const networkId = Option.getOrUndefined(networkIdFlag);
    const network =
      networkId !== undefined && networkId.length > 0
        ? { _tag: "named" as const, name: networkId }
        : isLocal
          ? yield* Effect.gen(function* () {
              const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
              const projectId = Option.getOrElse(toml.projectId, () =>
                sanitizeProjectId(nodePath.basename(cliConfig.workdir)),
              );
              return { _tag: "named" as const, name: `supabase_network_${projectId}` };
            })
          : { _tag: "host" as const };

    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const connecting = yield* output.task("Connecting to database...");
        const session = yield* dbConn.connect(conn).pipe(Effect.tapError(() => connecting.fail()));

        // Detect pre-existence before enabling so the drop is skipped when pgTAP
        // was already installed (Go keys this off an OnNotice 42710 callback,
        // which @effect/sql-pg does not expose — equivalent observable result).
        const alreadyExists = yield* session.extensionExists("extensions", "pgtap");
        yield* session.exec(ENABLE_PGTAP).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyTestDbEnablePgtapError({
                message: `failed to enable pgTAP: ${cause.message}`,
              }),
          ),
          Effect.tapError(() => connecting.fail()),
        );
        if (!alreadyExists) {
          yield* Effect.addFinalizer(() =>
            session
              .exec(DISABLE_PGTAP)
              .pipe(
                Effect.catch((cause) =>
                  output.raw(`failed to disable pgTAP: ${cause.message}\n`, "stderr"),
                ),
              ),
          );
        }
        yield* connecting.clear();

        const running = yield* output.task("Running pgTAP tests...");
        const code = yield* docker
          .run({
            image: LEGACY_PG_PROVE_IMAGE,
            cmd: args.cmd,
            env: runEnv,
            binds: args.binds,
            workingDir: args.workingDir,
            securityOpt: ["label:disable"],
            network,
          })
          .pipe(Effect.tapError(() => running.fail()));
        yield* running.clear();
        return code;
      }),
    );

    // No machine-format envelope: Go has no `--output-format` for `test db`; its
    // entire output is the streaming pg_prove TAP, which is emitted to stdout in
    // every mode (the docker subprocess inherits stdout). Appending a JSON object
    // here would corrupt that stream for `--output-format json` consumers.

    // Non-zero pg_prove exit → fail (exit 1), matching Go's cobra error return.
    // The TAP failure detail has already streamed to stdout.
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new LegacyTestDbRunError({ message: `error running container: exit ${exitCode}` }),
      );
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
