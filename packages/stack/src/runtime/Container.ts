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
  Schedule,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { startupTrace } from "./StartupTrace.ts";

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
    readonly type?: "bind" | "volume";
    readonly volumeSubpath?: string;
  }>;
  readonly workingDir?: string;
  readonly ports?: ReadonlyArray<number>;
  /** Seconds `docker stop` waits before SIGKILL. Omitted means 10. */
  readonly stopGraceSeconds?: number;
}

export interface ContainerProcess {
  readonly id: string;
  readonly ports: Readonly<Record<number, number>>;
  /** A single-consumer stream; callers that need fanout should publish observations. */
  readonly stdout: Stream.Stream<Uint8Array, ContainerError>;
  /** A single-consumer stream; callers that need fanout should publish observations. */
  readonly stderr: Stream.Stream<Uint8Array, ContainerError>;
  readonly exitCode: Effect.Effect<number, ContainerError>;
  readonly stdin: Sink.Sink<void, Uint8Array, never, ContainerError>;
  readonly stop: Effect.Effect<void, ContainerError>;
  readonly discard: Effect.Effect<void, ContainerError>;
  readonly kill: Effect.Effect<void, ContainerError>;
  readonly remove: Effect.Effect<void, ContainerError>;
}

export class ContainerLaunchError extends Data.TaggedError("ContainerLaunchError")<{
  readonly failure: ContainerError;
  readonly process: ContainerProcess;
}> {}

export interface ContainerRuntime {
  readonly prepare: (image: string) => Effect.Effect<void, ContainerError>;
  readonly prepareImage: (image: string) => Effect.Effect<string, ContainerError>;
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

const rateLimited = (error: ContainerError) =>
  /toomanyrequests|too many requests|rate limit|rate exceeded/iu.test(error.message);

const PULL_MAX_RETRIES = 4;

const pullBackoff = Schedule.exponential("2 seconds").pipe(Schedule.jittered);

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

/**
 * Captures the selected local engine; each launch owns one exact container. An image whose pull
 * fails is pulled from the first of its `imageMirrors` that succeeds, and launches of it then use
 * that mirror reference. When every mirror fails, the primary pull error is reported; a
 * rate-limited primary retries the whole chain with backoff.
 */
export const makeContainerRuntime = (options: {
  readonly engine: "docker" | "podman";
  readonly imageMirrors?: (image: string) => ReadonlyArray<string>;
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
    let commandSequence = 0;
    const nextTraceId = () =>
      // oxlint-disable-next-line effecttsgo/process-env -- Benchmark command IDs are disabled when tracing is off.
      process.env.SUPABASE_STARTUP_TRACE_FILE === undefined
        ? undefined
        : `${process.pid}:${++commandSequence}`;

    const run = Effect.fn("Container.command")(function* (
      args: ReadonlyArray<string>,
      commandOptions: { readonly timeout?: Duration.Input } = { timeout: "30 seconds" },
      identity?: { readonly stackId: string; readonly instanceId: string; readonly image?: string },
    ) {
      const traceId = nextTraceId();
      const fields = {
        ...(traceId === undefined ? {} : { trace_id: traceId }),
        engine: options.engine,
        operation: args[0] ?? "command",
        suboperation: args[1],
        ...(identity === undefined
          ? {}
          : {
              stack_id: identity.stackId,
              member_id: identity.instanceId,
              ...(identity.image === undefined ? {} : { image: identity.image }),
            }),
      };
      yield* startupTrace("docker.command.begin", fields);
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
        Effect.ensuring(startupTrace("docker.command.end", fields)),
      );
    });

    const mirrored = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
    const present = (image: string) =>
      run(["image", "inspect", "--format", "{{.Id}}", image]).pipe(
        Effect.catchTag("ContainerError", (error) =>
          /no such image|image .*not known/iu.test(error.message)
            ? Effect.succeed("")
            : Effect.fail(error),
        ),
        Effect.map((id) => id.length > 0),
      );
    const pull = (image: string) => run(["pull", image], { timeout: "5 minutes" });

    const fromMirror = (
      image: string,
      mirrors: ReadonlyArray<string>,
      primaryError: ContainerError,
    ): Effect.Effect<string, ContainerError> => {
      const [mirror, ...rest] = mirrors;
      if (mirror === undefined) return Effect.fail(primaryError);
      return Effect.gen(function* () {
        if (!(yield* present(mirror))) yield* pull(mirror);
        yield* Ref.update(mirrored, (map) => new Map(map).set(image, mirror));
        return mirror;
      }).pipe(
        Effect.tap(() => Effect.logInfo(`Pulled image from mirror ${mirror}`)),
        Effect.tapError((cause) => Effect.logWarning(`Image mirror ${mirror} failed`, cause)),
        Effect.catch(() => fromMirror(image, rest, primaryError)),
      );
    };

    const prepareImage = Effect.fn("Container.prepareImage")(function* (image: string) {
      // A mirror chosen earlier may have been pruned since; launches follow the primary again.
      const usePrimary = Ref.update(mirrored, (map) => {
        if (!map.has(image)) return map;
        const next = new Map(map);
        next.delete(image);
        return next;
      });
      const mirrors = options.imageMirrors?.(image) ?? [];
      // Presence is rechecked per attempt: a concurrent prepare may land the image during backoff.
      const attempt = Effect.gen(function* () {
        if (yield* present(image)) {
          yield* usePrimary;
          return image;
        }
        return yield* pull(image).pipe(
          Effect.as(image),
          Effect.tap(() => usePrimary),
          Effect.catch((primaryError) => fromMirror(image, mirrors, primaryError)),
        );
      });
      return yield* attempt.pipe(
        Effect.tapError((error) =>
          rateLimited(error)
            ? Effect.logWarning(`Registry rate-limited the pull of ${image}`)
            : Effect.void,
        ),
        Effect.retry({ schedule: pullBackoff, times: PULL_MAX_RETRIES, while: rateLimited }),
      );
    });
    const prepare = Effect.fn("Container.prepare")((image: string) =>
      prepareImage(image).pipe(Effect.asVoid),
    );

    const launch = Effect.fn("Container.launch")(function* (
      spec: ContainerSpec,
      interactive = false,
    ) {
      const owner = yield* Scope.Scope;
      const image = (yield* Ref.get(mirrored)).get(spec.image) ?? spec.image;
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
      const cidPath = path.join(directory, "container-id");
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
      const args = [
        "create",
        "--pull",
        "never",
        "--cidfile",
        cidPath,
        ...(interactive ? ["--interactive", "--init"] : []),
        ...(options.engine === "docker" && process.platform === "linux"
          ? ["--add-host", "host.docker.internal:host-gateway"]
          : []),
        "--name",
        `supabase-${token}`,
        "--label",
        `com.supabase.stack=${spec.stackId}`,
        "--label",
        `com.supabase.instance=${spec.instanceId}`,
        "--env-file",
        envPath,
        ...(spec.mounts ?? []).flatMap((mount) => [
          "--mount",
          [
            `type=${mount.type ?? "bind"}`,
            mountField("src", mount.source),
            mountField("dst", mount.target),
            ...(mount.volumeSubpath === undefined
              ? []
              : [mountField("volume-subpath", mount.volumeSubpath)]),
            ...(mount.readOnly ? ["ro"] : []),
          ].join(","),
        ]),
        ...(spec.workingDir === undefined ? [] : ["--workdir", spec.workingDir]),
        ...(spec.ports ?? []).flatMap((port) => ["--publish", `127.0.0.1::${port}`]),
        ...(spec.entrypoint === undefined ? [] : ["--entrypoint", spec.entrypoint]),
        image,
        ...(spec.args ?? []),
      ];
      const identity = {
        stackId: spec.stackId,
        instanceId: spec.instanceId,
        image: spec.image,
      };

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const creation = yield* restore(
            run(args, undefined, {
              stackId: spec.stackId,
              instanceId: spec.instanceId,
              image: spec.image,
            }),
          ).pipe(Effect.exit);
          const recorded = yield* fs.readFileString(cidPath).pipe(Effect.option);
          const fromFile =
            Option.isSome(recorded) && recorded.value.trim().length > 0
              ? Option.some(recorded.value.trim())
              : Option.none<string>();
          const id = Option.isSome(fromFile)
            ? fromFile.value
            : Exit.isSuccess(creation)
              ? creation.value
              : undefined;
          if (id === undefined)
            return yield* creation.pipe(
              Effect.andThen(
                Effect.fail(errorFor("create", "Engine returned no container identity")),
              ),
            );
          if (!/^[a-f0-9]{12,64}$/u.test(id))
            return yield* errorFor("create", "Engine returned an invalid container identity");
          const stopped = yield* Ref.make(false);
          const removed = yield* Ref.make(false);
          const stop = Effect.gen(function* () {
            if ((yield* Ref.get(removed)) || (yield* Ref.get(stopped))) return;
            const grace =
              spec.stopGraceSeconds !== undefined &&
              Number.isInteger(spec.stopGraceSeconds) &&
              spec.stopGraceSeconds > 0 &&
              spec.stopGraceSeconds <= 60
                ? String(spec.stopGraceSeconds)
                : "10";
            yield* run(["stop", "--time", grace, id], undefined, identity);
            yield* Ref.set(stopped, true);
          });
          const discard = Effect.gen(function* () {
            if ((yield* Ref.get(removed)) || (yield* Ref.get(stopped))) return;
            yield* run(["stop", "--time", "0", id], undefined, identity);
            yield* Ref.set(stopped, true);
          });
          const kill = Effect.gen(function* () {
            if ((yield* Ref.get(removed)) || (yield* Ref.get(stopped))) return;
            yield* run(["kill", id], undefined, identity);
            yield* Ref.set(stopped, true);
          });
          const remove = Effect.gen(function* () {
            if (yield* Ref.get(removed)) return;
            yield* run(["rm", id], undefined, identity);
            yield* Ref.set(removed, true);
          });
          yield* Scope.addFinalizer(
            owner,
            stop.pipe(
              Effect.andThen(remove),
              Effect.catch((error) => Effect.logError(error)),
            ),
          );
          const partial: ContainerProcess = {
            id,
            ports: {},
            stdout: Stream.empty,
            stderr: Stream.empty,
            exitCode: Effect.fail(errorFor("wait", "Container did not start")),
            stdin: Sink.fail(errorFor("stdin", "Container did not start")),
            stop,
            discard,
            kill,
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
              const attachedTraceId = nextTraceId();
              const attached = interactive
                ? yield* startupTrace("docker.command.begin", {
                    ...(attachedTraceId === undefined ? {} : { trace_id: attachedTraceId }),
                    engine: options.engine,
                    operation: "start",
                    suboperation: "attach",
                    stack_id: spec.stackId,
                    member_id: spec.instanceId,
                    image: spec.image,
                  }).pipe(
                    Effect.andThen(
                      spawner
                        .spawn(
                          ChildProcess.make(
                            options.engine,
                            ["start", "--attach", "--interactive", id],
                            { stdin: "pipe", forceKillAfter: "5 seconds" },
                          ),
                        )
                        .pipe(
                          Effect.mapError((cause) => errorFor("start", cause)),
                          Effect.ensuring(
                            startupTrace("docker.command.end", {
                              ...(attachedTraceId === undefined
                                ? {}
                                : { trace_id: attachedTraceId }),
                              engine: options.engine,
                              operation: "start",
                              suboperation: "attach",
                              stack_id: spec.stackId,
                              member_id: spec.instanceId,
                              image: spec.image,
                            }),
                          ),
                        ),
                    ),
                  )
                : undefined;
              if (attached === undefined) yield* run(["start", id], undefined, identity);
              const wait: Effect.Effect<number, ContainerError> =
                attached === undefined
                  ? run(["wait", id], {}).pipe(
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
              const text = yield* run(
                ["inspect", "--format", "{{json .NetworkSettings.Ports}}", id],
                undefined,
                identity,
              );
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
                    ChildProcess.make(options.engine, ["logs", "--follow", id], {
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
    return { prepare, prepareImage, launch, launchTool: (spec) => launch(spec, true) };
  });
