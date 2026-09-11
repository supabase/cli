import { Data, Effect, Option, Result, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { ProcessControl } from "../shared/runtime/process-control.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { collectText } from "./container-cli.ts";
import type { PgConnInput } from "./db-connection.service.ts";

const POSTGRES_CLIENT_MAJOR = /\(PostgreSQL\)\s+(\d+)/;
const HOST_CLIENT_SUGGESTION =
  "Install matching PostgreSQL client tools on PATH, or start the stack with --runtime docker.";

export const parsePostgresClientMajor = (text: string): number | undefined => {
  const match = POSTGRES_CLIENT_MAJOR.exec(text);
  if (match?.[1] === undefined) return undefined;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : undefined;
};

/** `pg_prove` has no Postgres major; any matching `psql` or `pg_dump` on PATH is enough. */
export const matchingHostPostgresClient = (
  dumpMajor: number | undefined,
  psqlMajor: number | undefined,
  expected: number,
):
  | { readonly kind: "match" }
  | {
      readonly kind: "mismatch";
      readonly command: "pg_dump" | "psql";
      readonly actual: number | undefined;
    } => {
  if (dumpMajor === expected || psqlMajor === expected) return { kind: "match" };
  if (psqlMajor !== undefined) return { kind: "mismatch", command: "psql", actual: psqlMajor };
  return { kind: "mismatch", command: "pg_dump", actual: dumpMajor };
};

export class HostPostgresClientError extends Data.TaggedError("HostPostgresClientError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

const missingClient = (command: string) =>
  new HostPostgresClientError({
    message: `${command} was not found on PATH.`,
    suggestion: HOST_CLIENT_SUGGESTION,
  });

const majorMismatch = (command: string, actual: number | undefined, expected: number) =>
  new HostPostgresClientError({
    message:
      actual === undefined
        ? `${command} did not report a PostgreSQL major version.`
        : `${command} major version ${actual} does not match stack Postgres ${expected}.`,
    suggestion: HOST_CLIENT_SUGGESTION,
  });

const hostClientVersion = (command: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, ["--version"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          handle.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError(() => missingClient(command)),
          ),
          collectText(handle.stdout.pipe(Stream.mapError(() => missingClient(command)))),
          collectText(handle.stderr.pipe(Stream.mapError(() => missingClient(command)))),
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode, output: `${stdout}\n${stderr}` };
    }),
  ).pipe(
    Effect.mapError(() => missingClient(command)),
    Effect.flatMap((result) =>
      result.exitCode === 0 ? Effect.succeed(result.output) : Effect.fail(missingClient(command)),
    ),
  );

/** Require a PATH client whose `--version` major matches the stack Postgres. */
export const requireHostPostgresClient = (
  command: string,
  expectedMajor: number,
): Effect.Effect<void, HostPostgresClientError, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const output = yield* hostClientVersion(command);
    const major = parsePostgresClientMajor(output);
    if (major !== expectedMajor) return yield* majorMismatch(command, major, expectedMajor);
  });

/**
 * `pg_prove --version` has no Postgres major. Require `pg_prove` on PATH and a
 * matching `pg_dump` or `psql` major.
 */
export const requireHostPgProve = (
  expectedMajor: number,
): Effect.Effect<void, HostPostgresClientError, ChildProcessSpawner> =>
  Effect.gen(function* () {
    yield* hostClientVersion("pg_prove");
    const dump = yield* hostClientVersion("pg_dump").pipe(Effect.result);
    const psql = yield* hostClientVersion("psql").pipe(Effect.result);
    const dumpMajor = Result.isSuccess(dump) ? parsePostgresClientMajor(dump.success) : undefined;
    const psqlMajor = Result.isSuccess(psql) ? parsePostgresClientMajor(psql.success) : undefined;
    const matched = matchingHostPostgresClient(dumpMajor, psqlMajor, expectedMajor);
    if (matched.kind === "match") return;
    return yield* majorMismatch(matched.command, matched.actual, expectedMajor);
  });

/** Stream a host process stdout like `streamPgDump`, teeing stderr when requested. */
export const streamHostCommand = Effect.fnUntraced(function* <E>(params: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
  readonly teeStderr?: boolean;
  readonly captureStderr?: boolean;
}) {
  const spawner = yield* ChildProcessSpawner;
  const processControl = yield* Effect.serviceOption(ProcessControl);
  const teeStderr = params.teeStderr ?? false;
  const captureStderr = params.captureStderr ?? true;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      if (Option.isSome(processControl)) {
        yield* processControl.value.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
      }
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(params.command, [...params.args], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            cwd: params.cwd,
            env: params.env,
            extendEnv: true,
          }),
        )
        .pipe(Effect.mapError(() => missingClient(params.command)));
      const stderrChunks: Array<Uint8Array> = [];
      yield* Effect.all(
        [
          Stream.runForEach(handle.stdout, params.onStdout),
          Stream.runForEach(handle.stderr, (chunk) =>
            Effect.sync(() => {
              if (captureStderr) stderrChunks.push(chunk);
              if (teeStderr) globalThis.process.stderr.write(chunk);
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = yield* handle.exitCode.pipe(Effect.map(Number));
      return { exitCode, stderr: new TextDecoder().decode(Buffer.concat(stderrChunks)) };
    }),
  );
});

/** Native-engine dumps talk to loopback; container tools may need Docker Desktop's host alias. */
export const rewriteDumpHostForToolContainer = (
  host: string,
  opts: { readonly platform: string; readonly usesHostNetwork: boolean },
): string => {
  if (host !== "127.0.0.1" && host !== "localhost") return host;
  if (opts.platform !== "linux" || !opts.usesHostNetwork) return "host.docker.internal";
  return host;
};

export const dumpConnForHostClient = (conn: PgConnInput): PgConnInput => ({
  ...conn,
  host: "127.0.0.1",
});
