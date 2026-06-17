import * as nodePath from "node:path";
import { Effect, FileSystem, Option, Path } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
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
// Go resolves it through `GetRegistryImageUrl` (`DockerStart`), honoring
// `SUPABASE_INTERNAL_IMAGE_REGISTRY` / the default ECR mirror, so do the same
// before passing it to `docker run`.
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
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const cliArgs = yield* CliArgs;

  yield* Effect.gen(function* () {
    // Reproduce cobra's MarkFlagsMutuallyExclusive("db-url","linked","local")
    // (`apps/cli-go/cmd/db.go:485`). Selection is keyed off flag PRESENCE (cobra's
    // `Changed`), not boolean value — `--linked=false` and `--no-linked` both count
    // as explicitly setting the `linked` flag (`db_url.go:46-63`).
    const target = resolveLegacyDbTargetFlags(cliArgs.args);
    const { setFlags } = target;
    if (setFlags.length > 1) {
      return yield* Effect.fail(
        new LegacyTestDbMutuallyExclusiveFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
        }),
      );
    }

    const { conn, isLocal } = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType: target.connType ?? "local",
      dnsResolver,
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
              // Go sanitizes `c.ProjectId` unconditionally (`config.go:471`) —
              // whether it came from `config.toml` or the cwd-basename fallback —
              // before deriving the network name `supabase_network_<id>`
              // (`config.go:57-58`, `GetId`). A configured `project_id` like
              // "my project" must join the same sanitized network the local stack
              // created, not the literal raw value.
              const projectId = sanitizeProjectId(
                Option.getOrElse(toml.projectId, () => nodePath.basename(cliConfig.workdir)),
              );
              return { _tag: "named" as const, name: `supabase_network_${projectId}` };
            })
          : { _tag: "host" as const };

    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        // stdout is reserved for the pg_prove TAP stream (the docker subprocess
        // writes it there directly), so connection diagnostics must go to stderr —
        // exactly as Go does (`ConnectByConfigStream` writes "Connecting to …
        // database…" to `os.Stderr`, `connect.go:205-228`). A `Output.task`
        // spinner would corrupt the TAP stream: clack writes spinner ANSI to
        // stdout in text mode, and the stream-json layer emits task JSON log
        // events to stdout. Go has no "Running pgTAP tests…" line at all.
        yield* output.raw(`Connecting to ${isLocal ? "local" : "remote"} database...\n`, "stderr");
        const session = yield* dbConn.connect(conn, { isLocal, dnsResolver });

        // Detect pre-existence before enabling so the drop is skipped when pgTAP
        // was already installed (Go keys this off an OnNotice 42710 callback,
        // which @effect/sql-pg does not expose — equivalent observable result).
        // Checked by extension name only, regardless of schema: Go's duplicate-object
        // notice fires for any pre-existing pgTAP, so a pgTAP the user installed in
        // e.g. `public` must also be detected and left untouched.
        const alreadyExists = yield* session.extensionExists("pgtap");
        yield* session.exec(ENABLE_PGTAP).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyTestDbEnablePgtapError({
                message: `failed to enable pgTAP: ${cause.message}`,
              }),
          ),
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

        // Bitbucket Pipelines rejects `--security-opt`, so Go clears
        // `hostConfig.SecurityOpt` when `BITBUCKET_CLONE_DIR` is set
        // (`apps/cli-go/internal/utils/docker.go:288-293`). Match that exactly:
        // omit the option in Bitbucket CI, where it would abort container creation.
        const inBitbucket = (process.env["BITBUCKET_CLONE_DIR"] ?? "") !== "";
        // Go adds `host.docker.internal:host-gateway` to every container's
        // ExtraHosts on Linux (`apps/cli-go/internal/utils/docker_linux.go`); macOS/
        // Windows Docker Desktop provide the mapping natively (empty there).
        const extraHosts =
          runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
        return yield* docker.run({
          image: legacyGetRegistryImageUrl(LEGACY_PG_PROVE_IMAGE),
          cmd: args.cmd,
          env: runEnv,
          binds: args.binds,
          workingDir: args.workingDir,
          securityOpt: inBitbucket ? [] : ["label:disable"],
          extraHosts,
          network,
        });
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
