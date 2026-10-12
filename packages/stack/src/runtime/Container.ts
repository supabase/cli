import { withAttemptCount } from "../internal/attempts.ts";
import {
  Cause,
  Config,
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
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { StackFailureKind } from "../FailureKind.ts";
import { testRunLabelArgs as readTestRunLabelArgs } from "../internal/test-run-label.ts";
import { CONTAINER_ENV_DIRNAME } from "../namespace/Paths.ts";
import { identifyContainer } from "./ContainerName.ts";

export class ContainerError extends Data.TaggedError("ContainerError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly kind?: StackFailureKind;
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
  /** `uid:gid` the container runs as, overriding the image's own user. */
  readonly user?: string;
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

/** The engine picks published host ports (`127.0.0.1::port`), so a refusal is its own allocation. */
const portAllocated = (message: string) =>
  /port is already allocated|address already in use|listen failed for host tcp port[^\n]*address in use/iu.test(
    message,
  );

/** Podman releases the host port it picks at create before pasta binds it at start, so another listener can take it. */
const PORT_COLLISION_ATTEMPTS = 3;

/** A refused registry connection also reads "connection refused", so a pull needs the daemon named. */
const pullEngineUnreachable = (cause: unknown, message: string) =>
  (cause instanceof Object &&
    "cause" in cause &&
    cause.cause instanceof PlatformError.PlatformError &&
    cause.cause.reason._tag === "NotFound" &&
    cause.cause.reason.method === "spawn") ||
  /cannot connect to the docker daemon|connect: no such file or directory|error during connect:[^\n]*(?:docker daemon is not running|the system cannot find the file specified|connection refused)|unable to connect to podman socket:[^\n]*(?:the system cannot find the file specified|connection refused)/iu.test(
    message,
  );

const engineKind = (
  operation: string,
  cause: unknown,
  message: string,
): StackFailureKind | undefined =>
  cause instanceof ContainerError
    ? cause.kind
    : Cause.isTimeoutError(cause)
      ? operation === "pull"
        ? "image-pull"
        : "engine-timeout"
      : (operation === "pull" ? pullEngineUnreachable(cause, message) : engineUnreachable(cause))
        ? "engine-unavailable"
        : portAllocated(message)
          ? "port-allocation"
          : undefined;

const errorFor = (operation: string, cause: unknown): ContainerError => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const kind = engineKind(operation, cause, message);
  return new ContainerError({ operation, message, cause, ...(kind === undefined ? {} : { kind }) });
};

/** Labels containers this run creates, when `SUPABASE_STACK_TEST_RUN` is set. */
const testRunLabelArgs = readTestRunLabelArgs.pipe(
  Effect.mapError((cause) => errorFor("config", cause)),
);

/**
 * Matches an engine CLI that is missing or reports a daemon that is not listening, never one
 * that rejects the caller (for example on permissions), so callers can leave work for a retry
 * instead of surfacing a hard failure.
 */
export const engineUnreachable = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    (cause instanceof Object &&
      "cause" in cause &&
      cause.cause instanceof PlatformError.PlatformError &&
      cause.cause.reason._tag === "NotFound" &&
      cause.cause.reason.method === "spawn") ||
    /cannot connect to the docker daemon|connection refused|connect: no such file or directory|error during connect:[^\n]*(?:docker daemon is not running|the system cannot find the file specified)|unable to connect to podman socket:[^\n]*the system cannot find the file specified/iu.test(
      message,
    )
  );
};

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

/** Runs one engine CLI invocation outside any pinned target, for resolving that target itself. */
const runRaw = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  engine: ContainerEngine,
  args: ReadonlyArray<string>,
): Effect.Effect<string, ContainerError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(engine, args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
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
        return yield* errorFor(args[0] ?? "command", stderr.trim() || `Engine exited with ${code}`);
      return stdout;
    }),
  ).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) =>
      cause instanceof ContainerError ? cause : errorFor(args[0] ?? "command", cause),
    ),
  );

/** The container engine CLI a stack's containers run through. */
export type ContainerEngine = "docker" | "podman";

/**
 * The engine endpoint and identity an owner resolves once, at startup, and pins for its entire
 * lifetime: the container runtime, the storage helpers, the host-gateway probes and the
 * namespace's reconcile loop all share this one target instead of each resolving (and so
 * potentially disagreeing on) their own. `argv` is the explicit prefix every invocation carries
 * (`--host <endpoint>` for Docker, `--url`/`--connection` for Podman), since the CLI gives it
 * priority over its environment and saved defaults, and since an argument, unlike an environment
 * variable, never leaks to subprocesses a launched workload spawns. `rootless` is whether the
 * Podman service runs without root, which decides how host uids map into containers.
 */
export type EngineTarget =
  | {
      readonly engine: "docker";
      readonly argv: ReadonlyArray<string>;
      readonly daemonId: string;
    }
  | {
      readonly engine: "podman";
      readonly argv: ReadonlyArray<string>;
      readonly daemonId: string;
      readonly rootless: boolean;
    };

/**
 * The active context's own name, pinned by name rather than by its endpoint alone: `context show`
 * honours `DOCKER_CONTEXT` and the config file, and pinning by name keeps that context's own TLS
 * material (CA, client certificate and key, skip-verify) intact for every later invocation, which
 * extracting just its endpoint would otherwise drop.
 */
const resolveContextName = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Effect.gen(function* () {
    const name = (yield* runRaw(spawner, "docker", ["context", "show"])).trim();
    if (name.length === 0) return yield* errorFor("context", "Engine returned no active context");
    return name;
  });

const nonEmptyEnv = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.map(Option.filter((value) => value.length > 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

const PODMAN_INFO_FORMAT =
  "{{.Host.ServiceIsRemote}}|{{.Host.Security.Rootless}}|{{.Host.Hostname}}|{{.Store.GraphRoot}}";

/** Podman has no daemon `.ID`; its host name and graph root together identify the service. */
const podmanInfo = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  argv: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const output = yield* runRaw(spawner, "podman", [
      ...argv,
      "info",
      "--format",
      PODMAN_INFO_FORMAT,
    ]);
    const [remote, rootless, hostname, ...graphRoot] = output.trim().split("|");
    const root = graphRoot.join("|");
    if (hostname === undefined || hostname.length === 0 || root.length === 0)
      return yield* errorFor("identity", "Engine returned an empty id");
    return {
      remote: remote === "true",
      rootless: rootless === "true",
      daemonId: `${hostname}|${root}`,
    };
  });

/**
 * Pins the connection the Podman CLI would use: `CONTAINER_HOST` or `CONTAINER_CONNECTION` when
 * set, otherwise the default saved connection when the CLI talks to a remote service (a
 * `podman machine`), and nothing when it talks to a local one, which saved connections never
 * redirect.
 */
const resolvePodmanTarget = Effect.fn("Container.resolvePodmanTarget")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.fn.Return<EngineTarget, ContainerError> {
  const url = yield* nonEmptyEnv("CONTAINER_HOST");
  const connection = yield* nonEmptyEnv("CONTAINER_CONNECTION");
  const explicit: ReadonlyArray<string> | undefined = Option.isSome(url)
    ? ["--url", url.value]
    : Option.isSome(connection)
      ? ["--connection", connection.value]
      : undefined;
  const bare = explicit === undefined ? yield* podmanInfo(spawner, []) : undefined;
  let argv: ReadonlyArray<string> = explicit ?? [];
  if (bare?.remote === true) {
    const listing = yield* runRaw(spawner, "podman", [
      "system",
      "connection",
      "list",
      "--format",
      "{{.Name}}|{{.Default}}",
    ]);
    const name = listing
      .split("\n")
      .map((line) => line.trim().split("|"))
      .find(([, isDefault]) => isDefault === "true")?.[0];
    if (name === undefined || name.length === 0)
      return yield* errorFor("connection", "Podman has no default connection to pin");
    argv = ["--connection", name];
  }
  const info = bare !== undefined && argv.length === 0 ? bare : yield* podmanInfo(spawner, argv);
  return { engine: "podman", argv, daemonId: info.daemonId, rootless: info.rootless };
});

/**
 * Resolves and pins, once for an owner's whole lifetime, the single engine endpoint its commands
 * target and that endpoint's own identity.
 */
export const resolveEngineTarget = Effect.fn("Container.resolveEngineTarget")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  engine: ContainerEngine,
): Effect.fn.Return<EngineTarget, ContainerError> {
  yield* Effect.annotateCurrentSpan("container.engine", engine);
  if (engine === "podman") return yield* resolvePodmanTarget(spawner);
  const host = yield* nonEmptyEnv("DOCKER_HOST");
  const argv: ReadonlyArray<string> = Option.isSome(host)
    ? ["--host", host.value]
    : ["--context", yield* resolveContextName(spawner)];
  const daemonId = (yield* runRaw(spawner, "docker", [
    ...argv,
    "info",
    "--format",
    "{{.ID}}",
  ])).trim();
  if (daemonId.length === 0) return yield* errorFor("identity", "Engine returned an empty id");
  return { engine: "docker", argv, daemonId };
});

/** A pull worth retrying: rate-limited or a dropped connection. */
const retryablePull = (error: ContainerError) => rateLimited(error) || transientPullFailure(error);

const PULL_MAX_RETRIES = 4;

/**
 * Host alias mapped in Docker containers' `/etc/hosts` to the engine's IPv4 host gateway, or to
 * `host-gateway` for runtimes that do not await the probe; Docker Desktop's `host.docker.internal`
 * and `host-gateway` also resolve to an IPv6 address. An engine that rejects `host-gateway` gets
 * the IPv4 address it maps to `host.docker.internal` instead.
 */
export const DOCKER_HOST_ALIAS = "host.supabase.internal";

/** Bounds the throwaway container that resolves the IPv4 host gateway. */
const HOST_GATEWAY_PROBE_TIMEOUT: Duration.Input = "15 seconds";

const IPV4_ADDRESS = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

/** The name the engine writes into `/etc/hosts` for its own host. */
const ENGINE_HOST_NAMES = ["host.docker.internal", "host.containers.internal"];

const firstIpv4For = (hosts: string, names: ReadonlyArray<string>) =>
  hosts
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find(
      ([address, ...mapped]) =>
        IPV4_ADDRESS.test(address ?? "") && mapped.some((name) => names.includes(name)),
    )?.[0];

/** Matches an engine that rejects the `host-gateway` keyword in `--add-host`. */
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

/** A started container's loopback publish can lag under concurrent engine load before landing. */
const PORT_PUBLISH_TIMEOUT: Duration.Input = "2 minutes";

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

/** The published ports together with the run state they were observed in. */
const PublicationState = Schema.Struct({
  Ports: Schema.NullOr(PublishedPorts),
  Status: Schema.String,
  ExitCode: Schema.Finite,
});

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
  readonly target: EngineTarget;
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
    // An owned directory for per-launch environment files, never the real system temp directory.
    const containerEnvRoot = path.join(stackRoot, CONTAINER_ENV_DIRNAME);
    const engine = options.target.engine;

    const command = (
      args: ReadonlyArray<string>,
      commandOptions: {
        readonly stdin?: "ignore" | "pipe";
        readonly forceKillAfter?: Duration.Input;
      } = {},
    ) =>
      ChildProcess.make(engine, [...options.target.argv, ...args], {
        stdin: "ignore",
        ...commandOptions,
      });

    const run = Effect.fn("Container.command")(function* (
      args: ReadonlyArray<string>,
      commandOptions: { readonly timeout?: Duration.Input } = { timeout: "30 seconds" },
    ) {
      yield* Effect.annotateCurrentSpan({
        "process.executable.name": engine,
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
    /** Polls until the engine confirms a `--rm` container's own asynchronous removal finished. */
    const awaitRemoved = (name: string) =>
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
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          while: (output) => output !== "",
        }),
        Effect.timeout("10 seconds"),
        Effect.asVoid,
      );
    /** Reads `/etc/hosts` from a throwaway, claimed container of an already present image. */
    const readProbeHosts = (image: string, spec: ContainerSpec, addHost: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const testRunLabel = yield* testRunLabelArgs;
        const token = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => errorFor("identity", cause)),
        );
        // Not an instance container: no instance label, so it is never mistaken for one.
        const { name } = identifyContainer(spec, token, true);
        const hosts = yield* run(
          [
            "run",
            "--rm",
            "--pull",
            "never",
            "--name",
            name,
            ...addHost,
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
        );
        yield* awaitRemoved(name);
        return hosts;
      }).pipe(Effect.timeout(HOST_GATEWAY_PROBE_TIMEOUT));
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
                    message: `The container engine rejects host-gateway in --add-host and maps no IPv4 address to ${ENGINE_HOST_NAMES.join(" or ")}`,
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

    const launchOnce = Effect.fnUntraced(function* (
      spec: ContainerSpec,
      interactive: boolean,
      oneOff: boolean,
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
      yield* fs
        .makeDirectory(containerEnvRoot, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError((cause) => errorFor("environment", cause)));
      // Not `makeTempDirectoryScoped`: its scoped cleanup removes without `force`, then dies on
      // any failure, including a confirmed ENOENT when this stack's whole root (this directory's
      // owned ancestor) is already gone — turning an ordinary stop into an unrecoverable defect.
      // `acquireRelease` keeps the plain `makeTempDirectory` and installing its tolerant,
      // `force: true` finalizer uninterruptible together, so an interruption between the two
      // can never leave the directory created but unregistered for cleanup.
      const directory = yield* Effect.acquireRelease(
        fs
          .makeTempDirectory({ directory: containerEnvRoot, prefix: "container-" })
          .pipe(Effect.mapError((cause) => errorFor("environment", cause))),
        (value) => fs.remove(value, { recursive: true, force: true }).pipe(Effect.ignore),
      );
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
      const hostAlias = yield* hostAliasTarget(image, spec);
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
        ...(spec.user === undefined ? [] : ["--user", spec.user]),
        // A rootless Podman maps the host uid elsewhere inside the container; keep-id maps it to
        // itself so files written through a borrowed bind mount stay owned by the caller.
        ...(spec.user !== undefined && options.target.engine === "podman" && options.target.rootless
          ? ["--userns=keep-id"]
          : []),
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
                    return yield* new ContainerError({
                      operation: "create",
                      message: `Engine did not respond to container creation within ${CREATE_TIMEOUT} (container name ${name})`,
                      kind: "engine-timeout",
                    });
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
              const requestedPorts = spec.ports ?? [];
              const inspectPublished = Effect.gen(function* () {
                const text = yield* run([
                  "inspect",
                  "--format",
                  '{"Ports":{{json .NetworkSettings.Ports}},"Status":{{json .State.Status}},"ExitCode":{{.State.ExitCode}}}',
                  name,
                ]);
                const state = yield* Schema.decodeEffect(Schema.fromJsonString(PublicationState))(
                  text,
                ).pipe(Effect.mapError((cause) => errorFor("inspect", cause)));
                const bindings = state.Ports ?? {};
                const published: Record<number, number> = {};
                const pending: Array<number> = [];
                for (const port of requestedPorts) {
                  const value = bindings[`${port}/tcp`]?.find(
                    (binding) => binding.HostIp === "127.0.0.1",
                  )?.HostPort;
                  const actual = Number(value);
                  if (Number.isInteger(actual) && actual >= 1 && actual <= 65535)
                    published[port] = actual;
                  else pending.push(port);
                }
                if (pending.length > 0 && state.Status !== "running")
                  return yield* errorFor(
                    "inspect",
                    `Container ${state.Status} (exit code ${state.ExitCode}) before publishing ${pending.join(", ")}`,
                  );
                return { published, pending };
              });
              // The engine can report a container started before its loopback publish lands,
              // so poll for it instead of trusting a single inspect under load.
              const awaitPublishedPorts = Effect.fn("Container.awaitPublishedPorts")(function* () {
                const observed = yield* Ref.make<{
                  readonly published: Record<number, number>;
                  readonly pending: ReadonlyArray<number>;
                }>({ published: {}, pending: requestedPorts });
                yield* withAttemptCount(
                  inspectPublished.pipe(Effect.tap((result) => Ref.set(observed, result))),
                  (counted) =>
                    counted.pipe(
                      Effect.repeat({
                        schedule: Schedule.spaced("250 millis"),
                        while: (result) => result.pending.length > 0,
                      }),
                    ),
                ).pipe(
                  Effect.timeout(PORT_PUBLISH_TIMEOUT),
                  Effect.catchTag("TimeoutError", () =>
                    Ref.get(observed).pipe(
                      Effect.flatMap(({ pending }) =>
                        errorFor(
                          "inspect",
                          `No loopback publication for ${pending.join(", ")} after ${PORT_PUBLISH_TIMEOUT}`,
                        ),
                      ),
                    ),
                  ),
                );
                return (yield* Ref.get(observed)).published;
              });
              const ports = yield* awaitPublishedPorts();
              const logProcess =
                attached ??
                (yield* Effect.gen(function* () {
                  // Released on exit, since a release left for service stop can hit a reused pid.
                  const followerScope = yield* Scope.fork(owner);
                  const follower = yield* spawner.spawn(command(["logs", "--follow", name])).pipe(
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
    const launchWithRetry = (
      spec: ContainerSpec,
      interactive: boolean,
      oneOff: boolean,
      owner: Scope.Scope,
      attempt: number,
    ): ReturnType<ContainerRuntime["launch"]> =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({ "retry.attempt_count": attempt });
        const attemptScope = yield* Scope.fork(owner);
        return yield* launchOnce(spec, interactive, oneOff).pipe(
          Effect.provideService(Scope.Scope, attemptScope),
          Effect.catchTag("ContainerLaunchError", (error) =>
            attempt >= PORT_COLLISION_ATTEMPTS || error.failure.kind !== "port-allocation"
              ? Effect.fail(error)
              : Effect.logDebug(`Retrying container launch: ${error.failure.message}`).pipe(
                  Effect.andThen(
                    error.process.remove.pipe(
                      Effect.tapError((cause) =>
                        Effect.logWarning(
                          `Failed to remove collided container ${error.process.id}: ${cause.message}`,
                        ),
                      ),
                      Effect.mapError(() => error),
                    ),
                  ),
                  Effect.andThen(Scope.close(attemptScope, Exit.void)),
                  Effect.andThen(launchWithRetry(spec, interactive, oneOff, owner, attempt + 1)),
                ),
          ),
        );
      });
    const launch = Effect.fn("Container.launch")(function* (
      spec: ContainerSpec,
      interactive = false,
      oneOff = false,
    ) {
      return yield* launchWithRetry(spec, interactive, oneOff, yield* Scope.Scope, 1);
    });
    return {
      prepare,
      prepareImage,
      launch,
      launchCommand: (spec) => launch(spec, true, true),
    };
  });

/**
 * Removes a container by its exact id, succeeding when it is already absent, through the same
 * pinned {@link EngineTarget} it was discovered through, so a context switch in between can never
 * split the two.
 */
const removeContainerById = Effect.fn("Container.removeContainerById")(
  (options: { readonly target: EngineTarget; readonly id: string }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(
              options.target.engine,
              [...options.target.argv, "rm", "--force", options.id],
              { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
            ),
          );
          const [stderr, code] = yield* Effect.all(
            [child.stderr.pipe(Stream.decodeText, Stream.mkString), child.exitCode],
            { concurrency: "unbounded" },
          );
          // Docker reports this exact phrasing for an id that no longer exists.
          if (Number(code) !== 0 && !/no such container/iu.test(stderr))
            return yield* errorFor("cleanup", stderr.trim() || `Engine exited with ${code}`);
        }),
      ).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) =>
          cause instanceof ContainerError ? cause : errorFor("cleanup", cause),
        ),
      );
    }),
);

/**
 * Lists every container carrying this stack's identity and data-root labels, through the pinned
 * engine: service containers and every storage helper alike (per-instance and shared),
 * independent of any in-memory registry's own bookkeeping. The data-root label is required
 * alongside the stack id label because a stack id alone does not identify a stack: two owners can
 * share one id while rooted at different data directories.
 */
const listStackContainers = Effect.fn("Container.listStackContainers")(function* (options: {
  readonly target: EngineTarget;
  readonly stackId: string;
  readonly stackRoot: string;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* runRaw(spawner, options.target.engine, [
    ...options.target.argv,
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `label=com.supabase.stack=${options.stackId}`,
    "--filter",
    `label=com.supabase.stack-root=${options.stackRoot}`,
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
});

/**
 * Removes every container carrying this stack's identity and data-root labels and reports how
 * many remain (normally 0): the registration-independent confirming sweep destroy and stop use
 * instead of depending on any helper registry's own bookkeeping. A container that disappears
 * between listing and removal is not an error, matching {@link removeContainerById}.
 */
export const removeStackContainers = Effect.fn("Container.removeStackContainers")(
  function* (options: {
    readonly target: EngineTarget;
    readonly stackId: string;
    readonly stackRoot: string;
  }) {
    const ids = yield* listStackContainers(options);
    yield* Effect.forEach(ids, (id) => removeContainerById({ target: options.target, id }), {
      concurrency: "unbounded",
      discard: true,
    });
    const remaining = yield* listStackContainers(options);
    return remaining;
  },
);

const decodeStackLabels = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

/**
 * Lists the stack id and data-root labels of every stack-labelled container on the pinned
 * engine, for finding stacks that no registration accounts for. A line that is not a label pair
 * is skipped.
 */
export const listStackLabels = Effect.fn("Container.listStackLabels")(function* (
  target: EngineTarget,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* runRaw(spawner, target.engine, [
    ...target.argv,
    "ps",
    "--all",
    "--filter",
    "label=com.supabase.stack",
    "--format",
    '[{{json (.Label "com.supabase.stack")}},{{json (.Label "com.supabase.stack-root")}}]',
  ]);
  const labels = yield* Effect.forEach(
    output.split("\n").filter((line) => line.length > 0),
    (line) => decodeStackLabels(line).pipe(Effect.option),
  );
  const containers = labels.flatMap(Option.toArray).map(([stackId, root]) => ({ stackId, root }));
  yield* Effect.annotateCurrentSpan("container.count", containers.length);
  return containers;
});
