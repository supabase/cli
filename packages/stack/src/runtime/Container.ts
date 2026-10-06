import { withAttemptCount } from "../internal/attempts.ts";
import {
  Cause,
  Crypto,
  Data,
  Deferred,
  type Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  PlatformError,
  Ref,
  Schedule,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { testRunLabelArgs as readTestRunLabelArgs } from "../internal/test-run-label.ts";
import { identifyContainer } from "./ContainerName.ts";

export class ContainerError extends Data.TaggedError("ContainerError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly reason?: "engine-unavailable";
}> {}

interface ContainerSpec {
  readonly image: string;
  readonly stackId: string;
  readonly instanceId: string;
  /** Labels the container with its service kind so stack log collectors can route it. */
  readonly service?: string;
  /** Groups this stack's containers under one name in Docker Desktop/OrbStack. */
  readonly project?: string;
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
  /** Signal `docker stop` sends first; omitted uses the image's stop signal. */
  readonly stopSignal?: "SIGINT" | "SIGTERM";
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
  readonly launchCommand: (
    spec: Omit<ContainerSpec, "ports">,
  ) => Effect.Effect<ContainerProcess, ContainerError | ContainerLaunchError, Scope.Scope>;
}

const errorFor = (operation: string, cause: unknown) =>
  new ContainerError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Labels containers this run creates, when `SUPABASE_STACK_TEST_RUN` is set. */
const testRunLabelArgs = readTestRunLabelArgs.pipe(
  Effect.mapError((cause) => errorFor("config", cause)),
);

const rateLimited = (error: ContainerError) =>
  /toomanyrequests|too many requests|rate limit|rate exceeded/iu.test(error.message);

/**
 * Matches a dropped registry connection, not a permanent rejection or a failing engine socket
 * (`error during connect`, `%2F…` hosts). `EOF` only counts after a registry request URL.
 */
const transientPullFailure = (error: ContainerError) =>
  !/error during connect/iu.test(error.message) &&
  /(?:Get|Head|Post|Put) "https?:\/\/(?!%2F)[^"]+": (?:unexpected )?EOF|connection reset by peer|i\/o timeout|TLS handshake timeout|net\/http: request canceled|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|received unexpected HTTP status: 5\d\d/iu.test(
    error.message,
  );

/**
 * Matches an engine CLI that is missing or reports a daemon that is not listening, not one that
 * rejects the caller. Podman's connection wrappers and Windows' `error during connect` also wrap
 * authentication and TLS failures, so only their refused or missing-endpoint causes match.
 */
const engineUnreachable = (error: ContainerError) =>
  (error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.method === "spawn") ||
  /cannot connect to the docker daemon|connection refused|connect: no such file or directory|error during connect:[^\n]*(?:docker daemon is not running|the system cannot find the file specified)/iu.test(
    error.message,
  );

const markUnavailable = (error: ContainerError) =>
  engineUnreachable(error)
    ? new ContainerError({
        operation: error.operation,
        message: error.message,
        cause: error.cause,
        reason: "engine-unavailable",
      })
    : error;

/** A pull worth retrying: rate-limited or a dropped connection, never an unreachable engine. */
const retryablePull = (error: ContainerError) =>
  (rateLimited(error) || transientPullFailure(error)) && !engineUnreachable(error);

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const PULL_MAX_RETRIES = 4;

/**
 * Host alias mapped in Docker containers' `/etc/hosts` to the engine's IPv4 host gateway, or to
 * `host-gateway` for runtimes that do not await the probe; Docker Desktop's `host.docker.internal`
 * and `host-gateway` also resolve to an IPv6 address. Engines that reject `host-gateway` get the
 * IPv4 address they map to `host.docker.internal` or `host.containers.internal` instead.
 */
export const DOCKER_HOST_ALIAS = "host.supabase.internal";

/** Bounds the throwaway container that resolves the IPv4 host gateway. */
const HOST_GATEWAY_PROBE_TIMEOUT: Duration.Input = "15 seconds";

const IPV4_ADDRESS = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

/** Names an engine may write into `/etc/hosts` for its host, such as Podman's compat socket. */
const ENGINE_HOST_NAMES = ["host.docker.internal", "host.containers.internal"];

const firstIpv4For = (hosts: string, names: ReadonlyArray<string>) =>
  hosts
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find(
      ([address, ...mapped]) =>
        IPV4_ADDRESS.test(address ?? "") && mapped.some((name) => names.includes(name)),
    )?.[0];

/** Matches an engine that rejects the `host-gateway` keyword in `--add-host`, such as older Podman. */
const rejectsHostGateway = (error: ContainerError) =>
  /(?:invalid|unknown|unsupported|bad)[^\n]*add-host[^\n]*host-gateway/iu.test(error.message);

/**
 * One stack host's `--add-host` target for `DOCKER_HOST_ALIAS`, shared by its Docker runtimes.
 * At most one probe runs at a time, in the gateway's scope; a probe yielding `undefined` leaves
 * the target unresolved so a later caller probes again, and a probe failure is cached.
 */
export interface HostGateway {
  /** Awaits the cached or in-flight target, starting `probe` when there is neither. */
  readonly resolve: (
    probe: Effect.Effect<string | undefined, ContainerError>,
  ) => Effect.Effect<string, ContainerError>;
  /** Starts `probe` in the background unless a target is cached or in flight. */
  readonly prefetch: (
    probe: Effect.Effect<string | undefined, ContainerError>,
  ) => Effect.Effect<void>;
}

/** Probes on every platform: engines with IPv6 on the bridge map `host-gateway` to both families. */
export const makeHostGateway: Effect.Effect<HostGateway, never, Scope.Scope> = Effect.gen(
  function* () {
    const scope = yield* Scope.Scope;
    const target = yield* Ref.make<
      Deferred.Deferred<string | undefined, ContainerError> | undefined
    >(undefined);
    const start = (probe: Effect.Effect<string | undefined, ContainerError>) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const fresh = yield* Deferred.make<string | undefined, ContainerError>();
          const current = yield* Ref.modify(target, (state) =>
            state === undefined ? [undefined, fresh] : [state, state],
          );
          if (current !== undefined) return current;
          // Starting immediately installs `onExit` before a closed scope can interrupt the fiber.
          yield* probe.pipe(
            Effect.onExit((exit) => {
              const failure = Exit.isFailure(exit)
                ? Cause.findErrorOption(exit.cause)
                : Option.none();
              if (Option.isSome(failure)) return Deferred.fail(fresh, failure.value);
              const probed = Exit.isSuccess(exit) ? exit.value : undefined;
              return (probed === undefined ? Ref.set(target, undefined) : Effect.void).pipe(
                Effect.andThen(Deferred.succeed(fresh, probed)),
              );
            }),
            Effect.forkIn(scope, { startImmediately: true }),
          );
          return fresh;
        }),
      );
    return {
      // A waiter whose shared probe failed retries once before falling back.
      resolve: (probe) =>
        start(probe).pipe(
          Effect.flatMap(Deferred.await),
          Effect.flatMap((probed) =>
            probed === undefined
              ? start(probe).pipe(Effect.flatMap(Deferred.await))
              : Effect.succeed(probed),
          ),
          Effect.map((probed) => probed ?? "host-gateway"),
        ),
      prefetch: (probe) => Effect.asVoid(start(probe)),
    };
  },
);

const pullBackoff = Schedule.exponential("2 seconds").pipe(Schedule.jittered);

/** `docker create` only writes metadata; a healthy daemon answers well within this bound. */
const CREATE_TIMEOUT: Duration.Input = "2 minutes";

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
 * that mirror reference. When every mirror fails, the primary pull error is reported; a primary
 * that is rate-limited or hits a transient registry transport failure retries the whole chain
 * with backoff.
 */
export const makeContainerRuntime = (options: {
  readonly engine: "docker" | "podman";
  readonly root: string;
  readonly imageMirrors?: (image: string) => ReadonlyArray<string>;
  /** Omitted gives this runtime its own host-gateway probe. */
  readonly hostGateway?: HostGateway;
  /**
   * `false` launches with `host-gateway` at once and resolves the IPv4 target in the background,
   * for containers that do not rely on reaching the host over IPv4.
   */
  readonly awaitHostGateway?: boolean;
}): Effect.Effect<
  ContainerRuntime,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const stackRoot = path.resolve(options.root);

    const command = (
      args: ReadonlyArray<string>,
      commandOptions: {
        readonly stdin?: "ignore" | "pipe";
        readonly forceKillAfter?: Duration.Input;
      } = {},
    ) => ChildProcess.make(options.engine, args, { stdin: "ignore", ...commandOptions });

    const run = Effect.fn("Container.command")(function* (
      args: ReadonlyArray<string>,
      commandOptions: { readonly timeout?: Duration.Input } = { timeout: "30 seconds" },
    ) {
      yield* Effect.annotateCurrentSpan({
        "process.executable.name": options.engine,
        "process.arg_count": args.length,
        "container.command": args[0] ?? "",
      });
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(command(args));
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
          yield* Effect.annotateCurrentSpan("process.exit_code", Number(code));
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
          !retryablePull(error)
            ? Effect.void
            : rateLimited(error)
              ? Effect.logWarning(`Registry rate-limited the pull of ${image}`)
              : Effect.logWarning(`Registry pull of ${image} failed transiently`),
        ),
        Effect.retry({ schedule: pullBackoff, times: PULL_MAX_RETRIES, while: retryablePull }),
      );
    });
    const prepare = Effect.fn("Container.prepare")((image: string) =>
      prepareImage(image).pipe(Effect.asVoid),
    );

    const hostGateway = options.hostGateway ?? (yield* makeHostGateway);
    /** Reads `/etc/hosts` from a throwaway container of an already present image. */
    const readProbeHosts = (image: string, spec: ContainerSpec, addHost: ReadonlyArray<string>) =>
      testRunLabelArgs.pipe(
        Effect.flatMap((testRunLabel) =>
          run(
            [
              "run",
              "--rm",
              "--pull",
              "never",
              ...addHost,
              // No instance label: `--rm` removal is asynchronous and must not count as an
              // instance container; the stack labels keep it sweepable.
              "--label",
              `com.supabase.stack=${spec.stackId}`,
              "--label",
              `com.supabase.stack-root=${stackRoot}`,
              ...testRunLabel,
              "--entrypoint",
              "cat",
              image,
              "/etc/hosts",
            ],
            { timeout: undefined },
          ),
        ),
        Effect.timeout(HOST_GATEWAY_PROBE_TIMEOUT),
      );
    /** Resolves the IPv4 host address the engine writes itself, since it rejects `host-gateway`. */
    const engineHostProbe = (image: string, spec: ContainerSpec, rejection: ContainerError) =>
      readProbeHosts(image, spec, []).pipe(
        Effect.matchEffect({
          // A failed or slow read says nothing about the engine, so the next launch retries.
          onFailure: (error) =>
            Effect.logDebug(`Engine host probe failed: ${error.message}`).pipe(
              Effect.as(undefined),
            ),
          onSuccess: (hosts) => {
            const address = firstIpv4For(hosts, ENGINE_HOST_NAMES);
            return address === undefined
              ? Effect.fail(
                  new ContainerError({
                    operation: "host-gateway",
                    message: `The container engine rejects host-gateway in --add-host and maps no IPv4 address to ${ENGINE_HOST_NAMES.join(" or ")}; upgrade Podman or use --runtime podman`,
                    cause: rejection,
                  }),
                )
              : Effect.succeed(address);
          },
        }),
      );
    /** Probes the engine's first IPv4 `host-gateway` address with an already present image. */
    const hostGatewayProbe = (image: string, spec: ContainerSpec) =>
      readProbeHosts(image, spec, ["--add-host", `${DOCKER_HOST_ALIAS}:host-gateway`]).pipe(
        // No IPv4 entry is a stable engine answer, so `host-gateway` is cached rather than re-probed.
        Effect.map((hosts) => firstIpv4For(hosts, [DOCKER_HOST_ALIAS]) ?? "host-gateway"),
        // A failed or slow probe (e.g. an image without `cat`) is retried by the next launch.
        Effect.catch((error) =>
          error instanceof ContainerError && rejectsHostGateway(error)
            ? engineHostProbe(image, spec, error)
            : Effect.logDebug(`Host gateway probe failed: ${error.message}`).pipe(
                Effect.as(undefined),
              ),
        ),
      );
    const hostAliasTarget = (image: string, spec: ContainerSpec) =>
      options.awaitHostGateway === false
        ? hostGateway.prefetch(hostGatewayProbe(image, spec)).pipe(Effect.as("host-gateway"))
        : hostGateway.resolve(hostGatewayProbe(image, spec));

    const launch = Effect.fn("Container.launch")(function* (
      spec: ContainerSpec,
      interactive = false,
      oneOff = false,
    ) {
      const owner = yield* Scope.Scope;
      const image = (yield* Ref.get(mirrored)).get(spec.image) ?? spec.image;
      yield* Effect.annotateCurrentSpan({
        "image.name": image,
        ...(spec.service === undefined ? {} : { "container.service": spec.service }),
        "container.ports": spec.ports ?? [],
      });
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
      const { name, composeProject, composeService } = identifyContainer(spec, token, oneOff);
      const hostAlias =
        options.engine === "docker" ? yield* hostAliasTarget(image, spec) : undefined;
      const testRunLabel = yield* testRunLabelArgs;
      const createArgs = (target: string | undefined) => [
        "create",
        "--pull",
        "never",
        ...(interactive ? ["--interactive", "--init"] : []),
        ...(target !== undefined
          ? [
              "--add-host",
              `${DOCKER_HOST_ALIAS}:${target}`,
              ...(process.platform === "linux"
                ? ["--add-host", `host.docker.internal:${target}`]
                : []),
            ]
          : []),
        "--name",
        name,
        "--label",
        `com.supabase.stack=${spec.stackId}`,
        "--label",
        `com.supabase.instance=${spec.instanceId}`,
        "--label",
        `com.supabase.stack-root=${stackRoot}`,
        ...(spec.service === undefined ? [] : ["--label", `com.supabase.service=${spec.service}`]),
        ...testRunLabel,
        "--label",
        `com.docker.compose.project=${composeProject}`,
        "--label",
        `com.docker.compose.service=${composeService}`,
        ...(oneOff ? ["--label", "com.docker.compose.oneoff=True"] : []),
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
        ...(spec.stopSignal === undefined ? [] : ["--stop-signal", spec.stopSignal]),
        ...(spec.ports ?? []).flatMap((port) => ["--publish", `127.0.0.1::${port}`]),
        ...(spec.entrypoint === undefined ? [] : ["--entrypoint", spec.entrypoint]),
        image,
        ...(spec.args ?? []),
      ];
      const create = run(createArgs(hostAlias), { timeout: undefined }).pipe(
        // An unawaited `host-gateway` can reach an engine that rejects it before the probe answers.
        Effect.catchTag("ContainerError", (error) =>
          hostAlias === "host-gateway" && rejectsHostGateway(error)
            ? hostGateway
                .resolve(hostGatewayProbe(image, spec))
                .pipe(Effect.flatMap((target) => run(createArgs(target), { timeout: undefined })))
            : Effect.fail(error),
        ),
      );

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Creation must settle before cleanup can safely run. The timeout below needs genuine
          // interruptibility to bound a hung daemon, so this restores it just for the create
          // call; either that timeout or an external interrupt reaching this window may still
          // leave a container needing best-effort removal, handled in both branches below.
          const creation = yield* restore(
            create.pipe(
              Effect.timeout(CREATE_TIMEOUT),
              Effect.mapError((error) =>
                error._tag === "TimeoutError"
                  ? error
                  : new ContainerError({
                      operation: error.operation,
                      message: `${error.message} (container name ${name})`,
                      cause: error,
                    }),
              ),
              Effect.catchTag("TimeoutError", () =>
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* run(["rm", "--force", name], { timeout: "10 seconds" }).pipe(
                      Effect.ignore,
                    );
                    return yield* errorFor(
                      "create",
                      `Engine did not respond to container creation within ${CREATE_TIMEOUT} (container name ${name})`,
                    );
                  }),
                ),
              ),
              Effect.onInterrupt(() =>
                run(["rm", "--force", name], { timeout: "10 seconds" }).pipe(Effect.ignore),
              ),
            ),
          ).pipe(Effect.exit);
          const stopped = yield* Ref.make(false);
          const removed = yield* Ref.make(false);
          const reconcileAbsent = Effect.fn("Container.reconcileAbsent")(function* (
            failure: ContainerError,
          ) {
            const probe = withAttemptCount(
              run(
                [
                  "ps",
                  "--all",
                  "--no-trunc",
                  "--filter",
                  // Docker matches this as a regex; `.` is the only metacharacter a name can hold.
                  `name=^/?${name.replaceAll(".", "\\.")}$`,
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
              ),
              (counted) =>
                counted.pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("250 millis"),
                    while: (state) => state === "removing",
                  }),
                ),
            ).pipe(
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
            const grace =
              spec.stopGraceSeconds !== undefined &&
              Number.isInteger(spec.stopGraceSeconds) &&
              spec.stopGraceSeconds > 0 &&
              spec.stopGraceSeconds <= 60
                ? String(spec.stopGraceSeconds)
                : "10";
            yield* run(["stop", "--time", grace, name]).pipe(
              Effect.catchTag("ContainerError", reconcileAbsent),
            );
            yield* Ref.set(stopped, true);
          });
          const discard = Effect.gen(function* () {
            if ((yield* Ref.get(removed)) || (yield* Ref.get(stopped))) return;
            yield* run(["stop", "--time", "0", name]).pipe(
              Effect.catchTag("ContainerError", reconcileAbsent),
            );
            yield* Ref.set(stopped, true);
          });
          const kill = Effect.gen(function* () {
            if ((yield* Ref.get(removed)) || (yield* Ref.get(stopped))) return;
            yield* run(["kill", name]).pipe(Effect.catchTag("ContainerError", reconcileAbsent));
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
              const attached = interactive
                ? yield* spawner
                    .spawn(
                      command(["start", "--attach", "--interactive", name], {
                        stdin: "pipe",
                        forceKillAfter: "5 seconds",
                      }),
                    )
                    .pipe(Effect.mapError((cause) => errorFor("start", cause)))
                : undefined;
              if (!interactive) yield* run(["start", name]);
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
                (yield* Effect.gen(function* () {
                  // Released on exit, since a release left for service stop can hit a reused pid.
                  const followerScope = yield* Scope.fork(owner);
                  const follower = yield* spawner
                    .spawn(
                      ChildProcess.make(options.engine, ["logs", "--follow", name], {
                        stdin: "ignore",
                      }),
                    )
                    .pipe(
                      Scope.provide(followerScope),
                      Effect.mapError((cause) => errorFor("logs", cause)),
                    );
                  yield* Effect.forkIn(
                    Effect.exit(follower.exitCode).pipe(
                      Effect.andThen(Scope.close(followerScope, Exit.void)),
                    ),
                    owner,
                  );
                  return follower;
                }));
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
    return {
      prepare,
      prepareImage,
      launch,
      launchCommand: (spec) => launch(spec, true, true),
    };
  });

const runCleanupCommand = Effect.fn("Container.runCleanupCommand")(function* (
  engine: "docker" | "podman",
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(engine, args, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText, Stream.mkString),
          child.stderr.pipe(Stream.decodeText, Stream.mkString),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* errorFor(args[0] ?? "cleanup", stderr.trim() || `Engine exited with ${code}`);
      return stdout.trim();
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          errorFor(
            args[0] ?? "cleanup",
            `${engine} ${args[0] ?? "command"} did not respond within 30 seconds`,
          ),
        ),
    }),
    Effect.mapError((cause) =>
      cause instanceof ContainerError ? cause : errorFor(args[0] ?? "cleanup", cause),
    ),
  );
});

export const listStackContainers = Effect.fn("Container.listStackContainers")(function* (
  engine: "docker" | "podman",
) {
  const output = yield* runCleanupCommand(engine, [
    "ps",
    "--all",
    "--filter",
    "label=com.supabase.stack",
    "--format",
    '{{.Label "com.supabase.stack"}}\t{{.Label "com.supabase.stack-root"}}',
  ]).pipe(Effect.mapError(markUnavailable));
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [stackId = "", root = ""] = line.split(/\t(.*)/);
      return { stackId, root };
    });
});

export const removeStackContainers = Effect.fn("Container.removeStackContainers")(
  (options: {
    readonly engine: "docker" | "podman";
    readonly stackId: string;
    readonly root: string;
  }) =>
    Effect.gen(function* () {
      const stackRoot = options.root;
      const run = (args: ReadonlyArray<string>) => runCleanupCommand(options.engine, args);
      const filters = [
        "--filter",
        `label=com.supabase.stack=${options.stackId}`,
        "--filter",
        `label=com.supabase.stack-root=${stackRoot}`,
      ];
      const list = () => run(["ps", "--all", "--quiet", "--no-trunc", ...filters]);
      // Only the initial listing can show the engine itself is unreachable; a later `rm` or
      // leftover check failing is a per-container cleanup problem instead.
      const ids = (yield* list().pipe(Effect.mapError(markUnavailable)))
        .split("\n")
        .filter((id) => id.length > 0);
      yield* Effect.forEach(
        ids,
        (id) =>
          run(["rm", "--force", id]).pipe(
            Effect.catchTag("ContainerError", (failure) =>
              run(["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${id}`]).pipe(
                Effect.flatMap((present) =>
                  present.length === 0 ? Effect.void : Effect.fail(failure),
                ),
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      );
      const remaining = yield* list();
      if (remaining.length > 0)
        return yield* errorFor("cleanup", `Stack containers remain: ${remaining}`);
    }),
);

/** Shell command that removes the same containers as `removeStackContainers`, succeeding when none remain. */
export const removeStackContainersCommand = (options: {
  readonly engine: "docker" | "podman";
  readonly stackId: string;
  readonly root: string;
}): string => {
  const filters = [
    `label=com.supabase.stack=${options.stackId}`,
    `label=com.supabase.stack-root=${options.root}`,
  ]
    .map((filter) => `--filter ${shellQuote(filter)}`)
    .join(" ");
  // `sh -c` keeps POSIX word splitting of `$ids` when pasted into shells like zsh that skip it.
  return `sh -c ${shellQuote(`ids=$(${options.engine} ps --all --quiet --no-trunc ${filters}) && { [ -z "$ids" ] || ${options.engine} rm --force $ids; }`)}`;
};
