import * as nodePath from "node:path";
import { Effect, FileSystem, Option, Path } from "effect";

import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import { readDbToml } from "./db-config.toml-read.ts";
import { DbConnection } from "./db-connection.service.ts";
import { DockerRun } from "./docker-run.service.ts";
import { getRegistryImageUrl } from "./docker-registry.ts";
import { resolveDbTargetFlags } from "./db-target-flags.ts";
import { DebugFlag, DnsResolverFlag, NetworkIdFlag } from "./global-flags.ts";
import { Output } from "../shared/output/output.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import type { TestDbFlags } from "./test-db.command-handler.ts";
import {
  TestDbEnablePgtapError,
  TestDbMutuallyExclusiveFlagsError,
  TestDbNoTestsError,
  TestDbRunError,
} from "./test-db.errors.ts";
import { buildPgProveArgs } from "./test-db.pg-prove-args.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { stackRequireProjectRuntime } from "./stack-local-database.ts";
import {
  rewriteDumpHostForToolContainer,
  requireHostPgProve,
  streamHostCommand,
} from "./postgres-client.run.ts";

const ENABLE_PGTAP = "create extension if not exists pgtap with schema extensions";
const DISABLE_PGTAP = "drop extension if exists pgtap";
// Fixed here: the config schema has no `[images]` override for this. Re-verify
// `NO_TESTS_VERDICT` still matches pg_prove's summary format when bumping this tag.
const PG_PROVE_IMAGE = "supabase/pg_prove:3.36";
const MAX_PROJECT_ID_LENGTH = 40;
/**
 * `pg_prove` exits 0 even when it finds nothing to run, so a typo'd path or a
 * misresolved bind can silently report success on zero tests. Detecting
 * "nothing ran" needs both the harness's final `Result: NOTESTS` line (not an
 * earlier per-test line under `--debug`) and a `Files=0` summary — a
 * self-skipping suite also prints `NOTESTS` but reports `Files=1`.
 */
const VERDICT_PREFIX = "Result: ";
const NO_TESTS_VERDICT = "Result: NOTESTS";
const FILES_SUMMARY = /^Files=(\d+),/;

function sanitizeProjectId(src: string): string {
  return src
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^[_.-]+/, "")
    .slice(0, MAX_PROJECT_ID_LENGTH);
}

export const testDb = Effect.fn("test.db")(function* (flags: TestDbFlags) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const dbConn = yield* DbConnection;
  const docker = yield* DockerRun;
  const cliSettings = yield* CommandSettings;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryState = yield* TelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const debug = yield* DebugFlag;
  const networkIdFlag = yield* NetworkIdFlag;
  const dnsResolver = yield* DnsResolverFlag;
  const cliArgs = yield* CliArgs;

  yield* Effect.gen(function* () {
    // Selection is keyed off flag presence, not its boolean value: `--linked=false`
    // and `--no-linked` both count as explicitly setting `linked`.
    const target = resolveDbTargetFlags(cliArgs.args);
    const { setFlags } = target;
    if (setFlags.length > 1) {
      return yield* Effect.fail(
        new TestDbMutuallyExclusiveFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
        }),
      );
    }

    const connType = target.connType ?? "local";

    // `--project-ref` never implies `--linked`; see push.handler.ts's
    // identical guard (db push) for the rationale.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* Effect.fail(
        new TestDbMutuallyExclusiveFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
    }

    const { conn, isLocal } = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      linkedProjectRef: flags.projectRef,
    });

    const args = buildPgProveArgs({
      paths: flags.paths,
      cwd: runtimeInfo.cwd,
      workdir: cliSettings.workdir,
      debug,
    });

    const backend = yield* currentStackBackend;
    const stackRuntime =
      backend.kind === "stack" && isLocal ? yield* stackRequireProjectRuntime : undefined;
    const useHostProve = stackRuntime?.kind === "native";
    const stackContainerProve = backend.kind === "stack" && isLocal && !useHostProve;

    const networkId = Option.getOrUndefined(networkIdFlag);
    const dumpUsesHostNetwork = networkId === undefined || networkId.length === 0;
    const runEnv = {
      PGHOST: useHostProve
        ? "127.0.0.1"
        : stackContainerProve
          ? rewriteDumpHostForToolContainer(conn.host, {
              platform: runtimeInfo.platform,
              usesHostNetwork: dumpUsesHostNetwork,
            })
          : isLocal
            ? "db"
            : conn.host,
      PGPORT: isLocal && backend.kind !== "stack" ? "5432" : String(conn.port),
      PGUSER: conn.user,
      PGPASSWORD: conn.password,
      PGDATABASE: conn.database,
    };

    // A non-empty `--network-id` overrides everything (even host mode);
    // otherwise local Compose uses `supabase_network_<project_id>` and remote / stack uses host networking.
    const network =
      networkId !== undefined && networkId.length > 0
        ? { _tag: "named" as const, name: networkId }
        : isLocal && backend.kind !== "stack"
          ? yield* Effect.gen(function* () {
              const toml = yield* readDbToml(fs, path, cliSettings.workdir);
              // The project id is sanitized unconditionally before deriving the
              // network name, so a configured `project_id` like "my project" joins
              // the same sanitized network the local stack created.
              const projectId = sanitizeProjectId(
                Option.getOrElse(toml.projectId, () => nodePath.basename(cliSettings.workdir)),
              );
              return { _tag: "named" as const, name: `supabase_network_${projectId}` };
            })
          : { _tag: "host" as const };

    const decoder = new TextDecoder();
    // The trailing partial line, plus the last complete summary/verdict lines so far.
    let pendingLine = "";
    let lastVerdict = "";
    let lastSummary = "";

    const { exitCode } = yield* Effect.scoped(
      Effect.gen(function* () {
        // stdout is reserved for the pg_prove TAP stream (forwarded byte-exact
        // below), so connection diagnostics go to stderr. An `Output.task`
        // spinner would also corrupt the stream: it writes ANSI to stdout in
        // text mode, and JSON log events to stdout in stream-json mode.
        yield* output.raw(`Connecting to ${isLocal ? "local" : "remote"} database...\n`, "stderr");
        const session = yield* dbConn.connect(conn, { isLocal, dnsResolver });

        // Detect pre-existence before enabling so the drop is skipped when pgTAP
        // was already installed. Checked by extension name only, regardless of
        // schema, so a pgTAP the user installed elsewhere (e.g. `public`) is
        // also detected and left untouched.
        const alreadyExists = yield* session.extensionExists("pgtap");
        yield* session.exec(ENABLE_PGTAP).pipe(
          Effect.mapError(
            (cause) =>
              new TestDbEnablePgtapError({
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

        // Bitbucket Pipelines rejects `--security-opt`, so it's omitted when
        // `BITBUCKET_CLONE_DIR` is set, where it would abort container creation.
        const inBitbucket = (process.env["BITBUCKET_CLONE_DIR"] ?? "") !== "";
        // `host.docker.internal:host-gateway` is added on Linux; macOS/Windows
        // Docker Desktop provide the mapping natively.
        const extraHosts =
          runtimeInfo.platform === "linux" ? ["host.docker.internal:host-gateway"] : [];
        const onStdout = (chunk: Uint8Array) =>
          Effect.suspend(() => {
            // Split on newlines, carrying the incomplete trailing line into the
            // next chunk so a verdict straddling a chunk boundary is still seen.
            const lines = (pendingLine + decoder.decode(chunk, { stream: true })).split("\n");
            pendingLine = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith(VERDICT_PREFIX)) lastVerdict = line;
              else if (FILES_SUMMARY.test(line)) lastSummary = line;
            }
            return output.rawBytes(chunk, "stdout");
          });
        if (useHostProve) {
          const toml = yield* readDbToml(fs, path, cliSettings.workdir);
          yield* requireHostPgProve(toml.majorVersion);
          const hostPath = args.hostPaths[0];
          const hostWorkingDir =
            hostPath === undefined
              ? undefined
              : nodePath.extname(hostPath) !== ""
                ? nodePath.dirname(hostPath)
                : hostPath;
          const hostArgs = ["--ext", ".pg", "--ext", ".sql", "-r", ...args.hostPaths];
          if (debug) hostArgs.push("--verbose");
          return yield* streamHostCommand({
            command: "pg_prove",
            args: hostArgs,
            env: runEnv,
            cwd: hostWorkingDir,
            onStdout,
            teeStderr: true,
            captureStderr: false,
          });
        }
        return yield* docker.runStream(
          {
            image: getRegistryImageUrl(PG_PROVE_IMAGE),
            cmd: args.cmd,
            env: runEnv,
            binds: args.binds,
            workingDir: args.workingDir,
            securityOpt: inBitbucket ? [] : ["label:disable"],
            extraHosts,
            network,
          },
          {
            onStdout,
            teeStderr: true,
            captureStderr: false,
          },
        );
      }),
    );

    // No machine-format envelope: the entire output is the streaming pg_prove
    // TAP on stdout in every mode. Appending a JSON object here would corrupt
    // that stream for `--output-format json` consumers.

    // Non-zero pg_prove exit fails the command; the TAP failure detail has
    // already streamed to stdout.
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new TestDbRunError({ message: `error running container: exit ${exitCode}` }),
      );
    }

    // A stream that ends without a trailing newline leaves the verdict unterminated.
    const finalVerdict = pendingLine.startsWith(VERDICT_PREFIX) ? pendingLine : lastVerdict;
    const aggregatedFiles = FILES_SUMMARY.exec(lastSummary)?.[1];
    if (finalVerdict.trimEnd() === NO_TESTS_VERDICT && aggregatedFiles === "0") {
      return yield* Effect.fail(
        new TestDbNoTestsError({
          message: `no pgTAP tests found in ${args.hostPaths.join(", ")}`,
        }),
      );
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
