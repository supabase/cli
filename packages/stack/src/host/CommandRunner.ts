import {
  Context,
  Crypto,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Sink,
  Stream,
  Ref,
} from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem has no non-recursive directory removal operation.
import { rmdir } from "node:fs/promises";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import {
  slimImageMirrors,
  prepareNativeArtifact,
  postgresVersion,
  resolveArtifact,
} from "../Artifacts.ts";
import { makeContainerRuntime } from "../runtime/Container.ts";
import { spawnNativeProcess } from "../runtime/NativeProcess.ts";
import { awaitCommandOutput, type CommandOutputResult } from "../runtime/CommandOutput.ts";
import type { CommandInvocation as CommandInvocationType } from "../Commands.ts";
import type { StackCredentials } from "../State.ts";
import { resolveInitializationCommand } from "../services/Initialization.ts";

export class CommandError extends Data.TaggedError("CommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class StdinWriteError extends Data.TaggedError("StdinWriteError")<{
  readonly cause: CommandError;
}> {}

interface CommandInputCommon<E, R> {
  readonly stdout: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
  readonly stderr: (bytes: Uint8Array) => Effect.Effect<void, E, R>;
}
type CommandInput<E, R> =
  | (CommandInputCommon<E, R> & {
      readonly command: Extract<CommandInvocationType, { type: "postgres" }>;
      readonly stdin: Stream.Stream<Uint8Array, E, R> | undefined;
    })
  | (CommandInputCommon<E, R> & {
      readonly command: Exclude<CommandInvocationType, { type: "postgres" }>;
      readonly credentials: StackCredentials;
    });

export interface Interface {
  readonly run: <E, R>(
    input: CommandInput<E, R>,
  ) => Effect.Effect<{ readonly jobId: string; readonly exitCode: number }, E | CommandError, R>;
  readonly cleanup: Effect.Effect<void, CommandError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@supabase/stack/CommandRunner",
) {}

const failure = (cause: unknown) =>
  new CommandError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Creates an attached byte-stream runner whose invocation scope owns each finite process. */
const makeCommandRunner = (options: {
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
        : yield* makeContainerRuntime({
            engine: options.runtime,
            root: options.root,
            imageMirrors: slimImageMirrors,
          });
    const jobsRoot = path.join(options.root, "jobs");
    yield* fs
      .makeDirectory(jobsRoot, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(failure));

    const nativeCleanup = yield* Ref.make(new Map<string, Effect.Effect<void, CommandError>>());
    const cleanupNative = (jobId: string) =>
      Ref.get(nativeCleanup).pipe(
        Effect.flatMap((entries) => {
          const cleanup = entries.get(jobId);
          if (cleanup === undefined) return Effect.void;
          return cleanup.pipe(
            Effect.tap(() =>
              Ref.update(nativeCleanup, (current) => {
                const next = new Map(current);
                next.delete(jobId);
                return next;
              }),
            ),
          );
        }),
      );

    const cleanup = Effect.gen(function* () {
      const entries = yield* Ref.get(nativeCleanup);
      const results = yield* Effect.forEach(
        entries.keys(),
        (jobId) => cleanupNative(jobId).pipe(Effect.exit),
        { concurrency: 1 },
      );
      const failureResult = results.find(Exit.isFailure);
      if (failureResult !== undefined) return yield* Effect.failCause(failureResult.cause);
      yield* Effect.tryPromise({ try: () => rmdir(jobsRoot), catch: failure }).pipe(
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
    });

    const run = Effect.fn("CommandRunner.run")(function* <E, R>(input: CommandInput<E, R>) {
      yield* fs
        .makeDirectory(jobsRoot, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(failure));
      const jobId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failure));
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const command = input.command;
          const directory = yield* fs
            .makeTempDirectoryScoped({ directory: jobsRoot, prefix: `${jobId}-` })
            .pipe(Effect.mapError(failure));
          const initialization =
            "credentials" in input
              ? yield* resolveInitializationCommand(input.command, {
                  runtime: options.runtime,
                  credentials: input.credentials,
                }).pipe(Effect.mapError(failure))
              : undefined;
          const postgresCommand = "stdin" in input ? input.command : undefined;
          const inputStream = "stdin" in input ? (input.stdin ?? Stream.empty) : Stream.empty;
          if (
            postgresCommand !== undefined &&
            postgresCommand.command.command !== "pg_prove" &&
            postgresCommand.pgProve !== undefined
          )
            return yield* failure("pgProve options require the pg_prove command");
          const version =
            initialization?.version ?? postgresVersion(String(postgresCommand?.command.major));
          const process = yield* Effect.gen(function* () {
            if (container === undefined) {
              const artifact = yield* prepareNativeArtifact(
                { service: initialization?.service ?? "database", version },
                options.cacheRoot,
              ).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.provideService(HttpClient.HttpClient, http),
              );
              const child = yield* spawnNativeProcess(
                {
                  executable: path.join(
                    artifact.root,
                    "bin",
                    postgresCommand?.command.command ?? initialization?.nativeExecutable ?? "",
                  ),
                  args: postgresCommand?.args ?? initialization?.args ?? [],
                  env: postgresCommand?.env ?? initialization?.env ?? {},
                  cwd:
                    postgresCommand?.pgProve?.cwd ??
                    initialization?.cwd ??
                    (initialization === undefined ? directory : artifact.root),
                  stdin: "pipe",
                },
                undefined,
                { stackId: options.stackId, workloadId: jobId },
              ).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.tap((child) =>
                  Ref.update(nativeCleanup, (entries) =>
                    new Map(entries).set(jobId, child.kill.pipe(Effect.mapError(failure))),
                  ),
                ),
                Effect.uninterruptible,
              );
              return {
                stdin: child.stdin.pipe(Sink.mapError(failure)),
                stdout: child.stdout.pipe(Stream.mapError(failure)),
                stderr: child.stderr.pipe(Stream.mapError(failure)),
                exitCode: child.exitCode.pipe(Effect.map(Number), Effect.mapError(failure)),
                cleanup: Effect.void,
              };
            }
            const artifact = yield* resolveArtifact({
              service: initialization?.service ?? "database",
              version,
            });
            yield* container.prepare(initialization?.image ?? artifact.image);
            const child = yield* container
              .launchCommand({
                image: initialization?.image ?? artifact.image,
                stackId: options.stackId,
                instanceId: jobId,
                env: postgresCommand?.env ?? initialization?.env ?? {},
                args: postgresCommand?.args ?? initialization?.args ?? [],
                entrypoint:
                  postgresCommand?.command.command ?? initialization?.containerEntrypoint ?? "",
                workingDir: postgresCommand?.pgProve?.workingDir ?? initialization?.workingDir,
                mounts:
                  postgresCommand?.pgProve?.mounts.map((mount) => ({
                    ...mount,
                    readOnly: true,
                  })) ?? initialization?.mounts,
              })
              .pipe(Effect.catchTag("ContainerLaunchError", (error) => Effect.fail(error.failure)));
            return {
              stdin: child.stdin.pipe(Sink.mapError(failure)),
              stdout: child.stdout.pipe(Stream.mapError(failure)),
              stderr: child.stderr.pipe(Stream.mapError(failure)),
              exitCode: child.exitCode.pipe(Effect.mapError(failure)),
              cleanup: child.stop.pipe(Effect.andThen(child.remove), Effect.mapError(failure)),
            };
          }).pipe(Effect.mapError(failure));
          const [, result] = yield* Effect.acquireUseRelease(
            Effect.succeed(process),
            (process) =>
              Effect.all(
                [
                  inputStream.pipe(
                    Stream.run(
                      process.stdin.pipe(Sink.mapError((cause) => new StdinWriteError({ cause }))),
                    ),
                    Effect.catchIf(
                      (error): error is StdinWriteError => error instanceof StdinWriteError,
                      () => process.exitCode.pipe(Effect.asVoid),
                    ),
                    Effect.raceFirst(process.exitCode.pipe(Effect.asVoid)),
                  ),
                  command.type === "postgres"
                    ? Effect.all(
                        [
                          process.stdout.pipe(Stream.runForEach(input.stdout)),
                          process.stderr.pipe(Stream.runForEach(input.stderr)),
                          process.exitCode,
                        ],
                        { concurrency: "unbounded" },
                      ).pipe(
                        Effect.map(([, , exitCode]): CommandOutputResult => ({
                          timedOut: false,
                          exitCode: Number(exitCode),
                          output: { stdout: [], stderr: [] },
                        })),
                      )
                    : awaitCommandOutput(process, {
                        timeout: "60 seconds",
                        onOutput: (stream, bytes) =>
                          stream === "stdout" ? input.stdout(bytes) : input.stderr(bytes),
                      }),
                ],
                { concurrency: "unbounded" },
              ),
            (process) => process.cleanup,
          );
          if (result.timedOut)
            return yield* failure(
              `${command.type} timed out after 60 seconds\nstdout:\n${result.output.stdout.join("\n")}\nstderr:\n${result.output.stderr.join("\n")}`,
            );
          if (command.type !== "postgres" && result.exitCode !== 0)
            return yield* failure(
              `${command.type} exited with code ${result.exitCode}\nstdout:\n${result.output.stdout.join("\n")}\nstderr:\n${result.output.stderr.join("\n")}`,
            );
          return { jobId, exitCode: result.exitCode };
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? cleanupNative(jobId) : cleanupNative(jobId).pipe(Effect.ignore),
        ),
      );
    });
    return { run, cleanup } satisfies Interface;
  });

export const layer = (options: {
  readonly stackId: string;
  readonly root: string;
  readonly cacheRoot: string;
  readonly runtime: "native" | "docker" | "podman";
}) => Layer.effect(Service, makeCommandRunner(options).pipe(Effect.map(Service.of)));
