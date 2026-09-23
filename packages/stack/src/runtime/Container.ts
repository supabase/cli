import {
  Cause,
  Crypto,
  Data,
  type Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Ref,
  Schema,
  Schedule,
  Scope,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class ContainerError extends Data.TaggedError("ContainerError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface ContainerSpec {
  readonly image: string;
  readonly stackId: string;
  readonly instanceId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly args?: ReadonlyArray<string>;
  readonly entrypoint?: string;
  readonly mounts?: ReadonlyArray<{
    readonly source: string;
    readonly target: string;
    readonly readOnly: boolean;
  }>;
  readonly workingDir?: string;
  readonly ports?: ReadonlyArray<number>;
}

export interface ContainerProcess {
  /** The unique managed launch name used for the container's entire lifetime. */
  readonly id: string;
  readonly ports: Readonly<Record<number, number>>;
  /** A single-consumer stream; callers that need fanout should publish observations. */
  readonly stdout: Stream.Stream<Uint8Array, ContainerError>;
  /** A single-consumer stream; callers that need fanout should publish observations. */
  readonly stderr: Stream.Stream<Uint8Array, ContainerError>;
  readonly exitCode: Effect.Effect<number, ContainerError>;
  readonly stdin: Sink.Sink<void, Uint8Array, never, ContainerError>;
  readonly stop: Effect.Effect<void, ContainerError>;
  readonly remove: Effect.Effect<void, ContainerError>;
}

export class ContainerLaunchError extends Data.TaggedError("ContainerLaunchError")<{
  readonly failure: ContainerError;
  readonly process: ContainerProcess;
}> {}

export interface ContainerRuntime {
  readonly prepare: (image: string) => Effect.Effect<void, ContainerError>;
  readonly launch: (
    spec: ContainerSpec,
  ) => Effect.Effect<ContainerProcess, ContainerError | ContainerLaunchError, Scope.Scope>;
  readonly launchTool: (
    spec: Omit<ContainerSpec, "ports">,
  ) => Effect.Effect<ContainerProcess, ContainerError | ContainerLaunchError, Scope.Scope>;
}

const errorFor = (operation: string, cause: unknown) =>
  new ContainerError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const PublishedPorts = Schema.Record(
  Schema.String,
  Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        HostIp: Schema.String,
        HostPort: Schema.String,
      }),
    ),
  ),
);

const mountField = (key: string, value: string) => {
  const field = `${key}=${value}`;
  return /[,"\n\r]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
};

/** Captures the selected local engine; each launch owns one exact container. */
export const makeContainerRuntime = (options: {
  readonly engine: "docker" | "podman";
}): Effect.Effect<
  ContainerRuntime,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;

    const run = Effect.fn("Container.command")(function* (
      args: ReadonlyArray<string>,
      commandOptions: { readonly timeout?: Duration.Input } = { timeout: "30 seconds" },
    ) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(options.engine, args, { stdin: "ignore" }),
          );
          const tail = (stream: typeof child.stdout) =>
            stream.pipe(
              Stream.decodeText,
              Stream.runFold(
                () => "",
                (text, chunk) => (text + chunk).slice(-65536),
              ),
            );
          const [stdout, stderr, code] = yield* Effect.all(
            [tail(child.stdout), tail(child.stderr), child.exitCode],
            { concurrency: "unbounded" },
          );
          if (Number(code) !== 0)
            return yield* errorFor(
              args[0] ?? "command",
              stderr.trim() || `Engine exited with ${code}`,
            );
          return stdout.trim();
        }),
      ).pipe(
        (effect) =>
          commandOptions.timeout === undefined
            ? effect
            : effect.pipe(Effect.timeout(commandOptions.timeout)),
        Effect.mapError((cause) => errorFor(args[0] ?? "command", cause)),
      );
    });

    const prepare = Effect.fn("Container.prepare")(function* (image: string) {
      const inspected = yield* run(["image", "inspect", "--format", "{{.Id}}", image]).pipe(
        Effect.option,
      );
      if (Option.isNone(inspected) || inspected.value.length === 0)
        yield* run(["pull", image], { timeout: "5 minutes" });
    });

    const launch = Effect.fn("Container.launch")(function* (
      spec: ContainerSpec,
      interactive = false,
    ) {
      const owner = yield* Scope.Scope;
      for (const [key, value] of Object.entries(spec.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || /[\0\r\n]/u.test(value)) {
          return yield* errorFor(
            "environment",
            "Container environment contains an invalid key or value",
          );
        }
      }
      for (const port of spec.ports ?? []) {
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          return yield* errorFor("ports", "Invalid container port");
      }
      const directory = yield* fs
        .makeTempDirectoryScoped({ prefix: "supabase-container-" })
        .pipe(Effect.mapError((cause) => errorFor("environment", cause)));
      const envPath = path.join(directory, "environment");
      yield* fs
        .writeFileString(
          envPath,
          Object.entries(spec.env)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n"),
          { mode: 0o600 },
        )
        .pipe(Effect.mapError((cause) => errorFor("environment", cause)));
      const token = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => errorFor("identity", cause)),
      );
      const name = `supabase-${token}`;
      const args = [
        "create",
        "--pull",
        "never",
        ...(interactive ? ["--interactive", "--init"] : []),
        ...(options.engine === "docker" && process.platform === "linux"
          ? ["--add-host", "host.docker.internal:host-gateway"]
          : []),
        "--name",
        name,
        "--label",
        `com.supabase.stack=${spec.stackId}`,
        "--label",
        `com.supabase.instance=${spec.instanceId}`,
        "--env-file",
        envPath,
        ...(spec.mounts ?? []).flatMap((mount) => [
          "--mount",
          `type=bind,${mountField("src", mount.source)},${mountField("dst", mount.target)}${mount.readOnly ? ",ro" : ""}`,
        ]),
        ...(spec.workingDir === undefined ? [] : ["--workdir", spec.workingDir]),
        ...(spec.ports ?? []).flatMap((port) => ["--publish", `127.0.0.1::${port}`]),
        ...(spec.entrypoint === undefined ? [] : ["--entrypoint", spec.entrypoint]),
        spec.image,
        ...(spec.args ?? []),
      ];

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Creation must settle before cleanup can safely run.
          const creation = yield* run(args, { timeout: undefined }).pipe(
            Effect.mapError(
              (error) =>
                new ContainerError({
                  operation: error.operation,
                  message: `${error.message} (container name ${name})`,
                  cause: error,
                }),
            ),
            Effect.exit,
          );
          const stopped = yield* Ref.make(false);
          const removed = yield* Ref.make(false);
          const reconcileAbsent = Effect.fn("Container.reconcileAbsent")(function* (
            failure: ContainerError,
          ) {
            const probe = run(
              [
                "ps",
                "--all",
                "--no-trunc",
                "--filter",
                `name=^/?${name}$`,
                "--format",
                "{{.State}}",
              ],
              { timeout: "5 seconds" },
            ).pipe(
              Effect.map((output) =>
                output === ""
                  ? ("absent" as const)
                  : output === "removing"
                    ? "removing"
                    : "present",
              ),
              Effect.repeat({
                schedule: Schedule.spaced("250 millis"),
                while: (state) => state === "removing",
              }),
              Effect.timeout("10 seconds"),
              Effect.mapError((error) =>
                error instanceof ContainerError ? error : errorFor("cleanup", error),
              ),
            );
            const observed = yield* probe.pipe(Effect.exit);
            if (Exit.isFailure(observed)) {
              if (Cause.hasInterrupts(observed.cause))
                return yield* Effect.failCause(observed.cause);
              return yield* Effect.failCause(Cause.combine(Cause.fail(failure), observed.cause));
            }
            if (observed.value === "absent") {
              yield* Ref.set(stopped, true);
              yield* Ref.set(removed, true);
              return;
            }
            return yield* failure;
          });
          const stop = Effect.gen(function* () {
            if ((yield* Ref.get(removed)) || (yield* Ref.get(stopped))) return;
            yield* run(["stop", "--time", "10", name]).pipe(
              Effect.catchTag("ContainerError", reconcileAbsent),
            );
            yield* Ref.set(stopped, true);
          });
          const remove = Effect.gen(function* () {
            if (yield* Ref.get(removed)) return;
            yield* run(["rm", name]).pipe(Effect.catchTag("ContainerError", reconcileAbsent));
            yield* Ref.set(stopped, true);
            yield* Ref.set(removed, true);
          });
          yield* Scope.addFinalizer(
            owner,
            stop.pipe(
              Effect.andThen(remove),
              Effect.tapError((error) =>
                Effect.logError(`Failed to clean up container ${name}: ${error.message}`),
              ),
              Effect.orDie,
            ),
          );
          const partial: ContainerProcess = {
            id: name,
            ports: {},
            stdout: Stream.empty,
            stderr: Stream.empty,
            exitCode: Effect.fail(errorFor("wait", "Container did not start")),
            stdin: Sink.fail(errorFor("stdin", "Container did not start")),
            stop,
            remove,
          };
          let owned = partial;
          const wrapFailure = (failure: ContainerError) =>
            new ContainerLaunchError({ failure, process: owned });
          if (Exit.isFailure(creation)) {
            const failure = Cause.findErrorOption(creation.cause);
            return yield* Option.isSome(failure)
              ? Effect.fail(wrapFailure(failure.value))
              : Effect.failCause(creation.cause);
          }
          return yield* restore(
            Effect.gen(function* () {
              const attached = interactive
                ? yield* spawner
                    .spawn(
                      ChildProcess.make(
                        options.engine,
                        ["start", "--attach", "--interactive", name],
                        { stdin: "pipe", forceKillAfter: "5 seconds" },
                      ),
                    )
                    .pipe(Effect.mapError((cause) => errorFor("start", cause)))
                : undefined;
              if (attached === undefined) yield* run(["start", name]);
              const wait: Effect.Effect<number, ContainerError> =
                attached === undefined
                  ? run(["wait", name], {}).pipe(
                      Effect.flatMap((output) => {
                        const code = Number(output);
                        return /^\d+$/u.test(output) && Number.isSafeInteger(code)
                          ? Effect.succeed(code)
                          : Effect.fail(errorFor("wait", "Invalid container exit code"));
                      }),
                    )
                  : attached.exitCode.pipe(
                      Effect.map(Number),
                      Effect.mapError((cause) => errorFor("wait", cause)),
                    );
              const getWaiter = yield* Effect.cached(Effect.forkIn(wait, owner));
              const exitCode: Effect.Effect<number, ContainerError> = Effect.uninterruptible(
                getWaiter,
              ).pipe(Effect.flatMap((fiber) => Fiber.join(fiber)));
              owned = { ...partial, exitCode };
              const text = yield* run([
                "inspect",
                "--format",
                "{{json .NetworkSettings.Ports}}",
                name,
              ]);
              const bindings = yield* Schema.decodeEffect(Schema.fromJsonString(PublishedPorts))(
                text,
              ).pipe(Effect.mapError((cause) => errorFor("inspect", cause)));
              const ports: Record<number, number> = {};
              for (const port of spec.ports ?? []) {
                const value = bindings[`${port}/tcp`]?.find(
                  (binding) => binding.HostIp === "127.0.0.1",
                )?.HostPort;
                const actual = Number(value);
                if (!Number.isInteger(actual) || actual < 1 || actual > 65535)
                  return yield* errorFor("inspect", `No loopback publication for ${port}`);
                ports[port] = actual;
              }
              const logProcess =
                attached ??
                (yield* spawner
                  .spawn(
                    ChildProcess.make(options.engine, ["logs", "--follow", name], {
                      stdin: "ignore",
                    }),
                  )
                  .pipe(Effect.mapError((cause) => errorFor("logs", cause))));
              return {
                ...partial,
                ports,
                exitCode,
                stdin: logProcess.stdin.pipe(Sink.mapError((cause) => errorFor("stdin", cause))),
                stdout: logProcess.stdout.pipe(Stream.mapError((cause) => errorFor("logs", cause))),
                stderr: logProcess.stderr.pipe(Stream.mapError((cause) => errorFor("logs", cause))),
              };
            }),
          ).pipe(Effect.mapError(wrapFailure));
        }),
      );
    });
    return { prepare, launch, launchTool: (spec) => launch(spec, true) };
  });
