import {
  Context,
  Crypto,
  Data,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  Sink,
  Stream,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no non-recursive directory removal operation.
import { rmdir } from "node:fs/promises";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { prepareNativeArtifact, postgresVersion, resolveArtifact } from "../Artifacts.ts";
import { makeContainerRuntime } from "../runtime/Container.ts";
import { PostgresTool } from "../Tools.ts";

class ToolError extends Data.TaggedError("ToolError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class StdinWriteError extends Data.TaggedError("StdinWriteError")<{ readonly cause: ToolError }> {}

export interface ToolInput<E, R> {
  readonly tool: PostgresTool;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Stream.Stream<Uint8Array, E, R>;
  readonly stdout: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
  readonly stderr: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
}

export interface Interface {
  readonly run: <E, R>(
    input: ToolInput<E, R>,
  ) => Effect.Effect<{ readonly jobId: string; readonly exitCode: number }, E | ToolError, R>;
  readonly cleanup: Effect.Effect<void, ToolError>;
}

export class Service extends Context.Service<Service, Interface>()("@supabase/stack/ToolRunner") {}

const failure = (cause: unknown) =>
  new ToolError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Creates an attached byte-stream runner whose invocation scope owns each finite process. */
const makeToolRunner = (options: {
  readonly stackId: string;
  readonly root: string;
  readonly cacheRoot: string;
  readonly runtime: "native" | "docker" | "podman";
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const http = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    if (!/^[a-zA-Z0-9_-]+$/u.test(options.stackId)) return yield* failure("Invalid stack identity");
    const container =
      options.runtime === "native"
        ? undefined
        : yield* makeContainerRuntime({ engine: options.runtime });
    const jobsRoot = path.join(options.root, "jobs");
    yield* fs
      .makeDirectory(jobsRoot, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(failure));

    const cleanup = Effect.tryPromise({ try: () => rmdir(jobsRoot), catch: failure }).pipe(
      Effect.catch((cause) => {
        const code =
          typeof cause.cause === "object" && cause.cause !== null && "code" in cause.cause
            ? cause.cause.code
            : undefined;
        return code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST"
          ? Effect.void
          : Effect.fail(cause);
      }),
    );

    const run = Effect.fn("ToolRunner.run")(function* <E, R>(input: ToolInput<E, R>) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const tool = yield* Schema.decodeEffect(PostgresTool)(input.tool).pipe(
            Effect.mapError(failure),
          );
          const version = postgresVersion(String(tool.major));
          const jobId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failure));
          const directory = yield* fs
            .makeTempDirectoryScoped({ directory: jobsRoot, prefix: `${jobId}-` })
            .pipe(Effect.mapError(failure));
          const process = yield* Effect.gen(function* () {
            if (container === undefined) {
              const artifact = yield* prepareNativeArtifact(
                { service: "database", version },
                options.cacheRoot,
              ).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.provideService(HttpClient.HttpClient, http),
              );
              const child = yield* spawner.spawn(
                ChildProcess.make(path.join(artifact.root, "bin", tool.command), input.args, {
                  env: input.env,
                  cwd: directory,
                  stdin: "pipe",
                  forceKillAfter: "5 seconds",
                }),
              );
              return {
                stdin: child.stdin.pipe(Sink.mapError(failure)),
                stdout: child.stdout.pipe(Stream.mapError(failure)),
                stderr: child.stderr.pipe(Stream.mapError(failure)),
                exitCode: child.exitCode.pipe(Effect.map(Number), Effect.mapError(failure)),
                cleanup: Effect.void,
              };
            }
            const artifact = yield* resolveArtifact({ service: "database", version });
            yield* container.prepare(artifact.image);
            const child = yield* container
              .launchTool({
                image: artifact.image,
                stackId: options.stackId,
                instanceId: jobId,
                env: input.env,
                args: input.args,
                entrypoint: tool.command,
              })
              .pipe(
                Effect.catchTag("ContainerLaunchError", (error) =>
                  error.process.stop.pipe(
                    Effect.andThen(error.process.remove),
                    Effect.andThen(Effect.fail(error.failure)),
                  ),
                ),
              );
            return {
              stdin: child.stdin.pipe(Sink.mapError(failure)),
              stdout: child.stdout.pipe(Stream.mapError(failure)),
              stderr: child.stderr.pipe(Stream.mapError(failure)),
              exitCode: child.exitCode.pipe(Effect.mapError(failure)),
              cleanup: child.stop.pipe(Effect.andThen(child.remove), Effect.mapError(failure)),
            };
          }).pipe(Effect.mapError(failure));
          const [, , , exitCode] = yield* Effect.acquireUseRelease(
            Effect.succeed(process),
            (process) =>
              Effect.all(
                [
                  (input.stdin ?? Stream.empty).pipe(
                    Stream.run(
                      process.stdin.pipe(Sink.mapError((cause) => new StdinWriteError({ cause }))),
                    ),
                    Effect.catchIf(
                      (error): error is StdinWriteError => error instanceof StdinWriteError,
                      () => process.exitCode.pipe(Effect.asVoid),
                    ),
                    Effect.raceFirst(process.exitCode.pipe(Effect.asVoid)),
                  ),
                  process.stdout.pipe(Stream.runForEach(input.stdout)),
                  process.stderr.pipe(Stream.runForEach(input.stderr)),
                  process.exitCode,
                ],
                { concurrency: "unbounded" },
              ),
            (process) => process.cleanup,
          );
          return { jobId, exitCode };
        }),
      );
    });
    return { run, cleanup } satisfies Interface;
  });

export const layer = (options: {
  readonly stackId: string;
  readonly root: string;
  readonly cacheRoot: string;
  readonly runtime: "native" | "docker" | "podman";
}) => Layer.effect(Service, makeToolRunner(options).pipe(Effect.map(Service.of)));
