import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { PostgresClientError } from "../public/Errors.ts";
import { runPostgresClient } from "../public/PostgresClient.ts";
import { POSTGRES_CLIENT_BINS, POSTGRES_DUMP_BINS } from "./postgres-client-args.ts";
import { PostgresClientPreparer } from "./postgres-client.ts";

const capturingSpawner = (
  calls: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: Record<string, string | undefined>;
  }>,
) =>
  ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("unexpected piped command");
    calls.push({ command: command.command, args: command.args, env: command.options.env });
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable([new TextEncoder().encode("ok\n")]),
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

const writeFakeBins = (root: string, bins: ReadonlyArray<string> = POSTGRES_CLIENT_BINS) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(root, "bin");
    yield* fs.makeDirectory(binDir, { recursive: true });
    for (const bin of bins) {
      yield* fs.writeFileString(path.join(binDir, bin), "");
    }
    return binDir;
  });

const nativePreparer = (bins: ReadonlyArray<string> = POSTGRES_CLIENT_BINS) =>
  Layer.effect(
    PostgresClientPreparer,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({ prefix: "pg-client-" });
      yield* writeFakeBins(root, bins);
      return PostgresClientPreparer.of({
        prepare: (runtime) =>
          Effect.succeed({
            runtime,
            version: "17.6.1.168",
            artifactRoot: root,
          }),
      });
    }),
  );

const containerPreparer = Layer.succeed(
  PostgresClientPreparer,
  PostgresClientPreparer.of({
    prepare: (runtime) =>
      Effect.succeed({
        runtime,
        version: "17.6.1.168",
        image: "ghcr.io/supabase/cli/postgres:17.6.1.168",
      }),
  }),
);

const nativeClientLayer = (
  calls: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: Record<string, string | undefined>;
  }>,
  bins?: ReadonlyArray<string>,
) =>
  Layer.mergeAll(
    NodeServices.layer,
    nativePreparer(bins).pipe(Layer.provide(NodeServices.layer)),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, capturingSpawner(calls)),
  );

describe("runPostgresClient", () => {
  it.live("native prepends artifact bin to PATH and never starts postgres", () => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: Record<string, string | undefined>;
    }> = [];
    return Effect.gen(function* () {
      const chunks: Array<string> = [];
      const result = yield* runPostgresClient({
        version: "17.6.1.168",
        runtime: { kind: "native" },
        argv: ["bash", "-c", "pg_dump --version", "--"],
        env: { PGHOST: "127.0.0.1" },
        onStdout: (chunk) => Effect.sync(() => chunks.push(new TextDecoder().decode(chunk))),
      });
      expect(result.exitCode).toBe(0);
      expect(chunks.join("")).toBe("ok\n");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe("bash");
      expect(calls[0]?.args).toEqual(["-c", "pg_dump --version", "--"]);
      const firstPath = (calls[0]?.env?.["PATH"] ?? "").split(/[:;]/)[0] ?? "";
      expect(firstPath.endsWith("bin")).toBe(true);
      expect(calls[0]?.command).not.toBe("supabase-postgres-start");
      expect(calls[0]?.args).not.toContain("supabase-postgres-start");
    }).pipe(Effect.provide(nativeClientLayer(calls)));
  });

  it.live("native fails closed when a required client binary is missing", () =>
    Effect.gen(function* () {
      const exit = yield* runPostgresClient({
        version: "17.6.1.168",
        runtime: { kind: "native" },
        argv: ["pg_dump", "--version"],
        onStdout: () => Effect.void,
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(PostgresClientError);
      if (!(error instanceof PostgresClientError)) return;
      expect(error.reason).toBe("missing-bin");
      expect(error.bin).toBe("pg_dumpall");
    }).pipe(Effect.provide(nativeClientLayer([], ["pg_dump"]))),
  );

  it.live("native dump does not require pg_prove", () => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: Record<string, string | undefined>;
    }> = [];
    return Effect.gen(function* () {
      const result = yield* runPostgresClient({
        version: "17.6.1.168",
        runtime: { kind: "native" },
        argv: ["bash", "-c", "pg_dump --version", "--"],
        onStdout: () => Effect.void,
      });
      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
    }).pipe(Effect.provide(nativeClientLayer(calls, [...POSTGRES_DUMP_BINS])));
  });

  it.live("container spawns docker run --rm with the caller argv", () => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: Record<string, string | undefined>;
    }> = [];
    return Effect.gen(function* () {
      const result = yield* runPostgresClient({
        version: "17.6.1.168",
        runtime: { kind: "container", engine: "docker" },
        argv: ["pg_prove", "--ext", ".sql"],
        env: { PGPASSWORD: "secret" },
        network: "host",
        onStdout: () => Effect.void,
      });
      expect(result.exitCode).toBe(0);
      expect(calls[0]?.command).toBe("docker");
      expect(calls[0]?.args.slice(0, 2)).toEqual(["run", "--rm"]);
      expect(calls[0]?.args).toContain("-e");
      expect(calls[0]?.args).toContain("PGPASSWORD");
      expect(calls[0]?.args).not.toContain("secret");
      expect(calls[0]?.args).not.toContain("supabase-postgres-start");
      expect(calls[0]?.args.slice(-3)).toEqual(["pg_prove", "--ext", ".sql"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          containerPreparer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, capturingSpawner(calls)),
        ),
      ),
    );
  });
});
