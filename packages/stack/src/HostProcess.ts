import { NodeHttpServer } from "@effect/platform-node";
import { Data, Effect, Duration, Option, Schema, Scope, Stream } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- NodeHttpServer.make requires a native server factory.
import * as Http from "node:http";
import { HOST_PROCESS_DISPATCH_SENTINEL, isBunVirtualPath } from "./internal/dispatch-markers.ts";
import { makePorts, PortError } from "./Ports.ts";
import type * as State from "./State.ts";

export class HostProcessError extends Data.TaggedError("HostProcessError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly reason?: HostFailureReason;
}> {}
type HostFailureReason = "missing-control-listener" | "connection-failure" | "bind-conflict";
const HostIdentity = Schema.Struct({
  projectRoot: Schema.String,
  branchContext: Schema.String,
  stackName: Schema.String,
});
interface HostIdentity extends Schema.Schema.Type<typeof HostIdentity> {}
export const HostEndpoint = Schema.Struct({
  stackId: Schema.String,
  identity: HostIdentity,
  pid: Schema.Int,
  port: Schema.Int,
});
export interface HostEndpoint extends Schema.Schema.Type<typeof HostEndpoint> {}
const error = (operation: string, cause: unknown, reason?: HostFailureReason) =>
  new HostProcessError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
    ...(reason === undefined ? {} : { reason }),
  });

export const acquireHost = Effect.fn("HostProcess.acquireHost")(function* (
  state: State.Interface,
  stackId: string,
): Effect.fn.Return<
  {
    readonly port: number;
    readonly server: HttpServer.HttpServer["Service"];
    readonly closeConnections: Effect.Effect<void>;
  },
  HostProcessError | PortError | State.StateError,
  Scope.Scope | import("effect").Crypto.Crypto
> {
  if ((yield* state.read(stackId)) === undefined)
    return yield* error("acquire", "Stack is not registered");
  const ports = yield* makePorts(state);
  let rawServer: Http.Server | undefined;
  const acquired = yield* ports.acquire(
    { stackId, key: "control", host: "127.0.0.1", port: "auto" },
    (host, port) => {
      const server = Http.createServer();
      rawServer = server;
      return NodeHttpServer.make(() => server, { host, port }).pipe(
        Effect.mapError(
          (cause) =>
            new PortError({ key: "control", message: "Cannot bind control listener", cause }),
        ),
      );
    },
  );
  return {
    port: acquired.port,
    server: acquired.listener,
    closeConnections: Effect.sync(() => {
      rawServer?.closeAllConnections();
      rawServer?.closeIdleConnections();
    }),
  };
});

const endpointFromResponse = Effect.fn("HostProcess.endpointFromResponse")(function* (
  state: State.Interface,
  stackId: string,
  port: number,
) {
  const stack = yield* state.read(stackId);
  if (stack === undefined) return yield* error("connect", "Stack is not registered");
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(HttpClientRequest.get(`http://127.0.0.1:${port}/identity`))
    .pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(2),
        orElse: () =>
          Effect.fail(
            error(
              "connect",
              "Timed out connecting to the host control listener",
              "connection-failure",
            ),
          ),
      }),
      Effect.mapError((cause) =>
        cause instanceof HostProcessError ? cause : error("connect", cause),
      ),
    );
  yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.mapError((cause) => error("connect", cause)),
  );
  const remote = yield* HttpClientResponse.schemaBodyJson(HostEndpoint)(response).pipe(
    Effect.mapError((cause) => error("connect", cause)),
  );
  if (
    remote.port !== port ||
    remote.stackId !== stackId ||
    remote.identity.projectRoot !== stack.identity.projectRoot ||
    remote.identity.branchContext !== stack.identity.branchContext ||
    remote.identity.stackName !== stack.identity.stackName
  )
    return yield* error("connect", "Control listener belongs to another stack");
  return remote;
});

export const connectHost = Effect.fn("HostProcess.connectHost")(function* (
  state: State.Interface,
  stackId: string,
): Effect.fn.Return<HostEndpoint, HostProcessError | State.StateError, HttpClient.HttpClient> {
  const stack = yield* state.read(stackId);
  if (stack === undefined) return yield* error("connect", "Stack is not registered");
  const claim = stack.ports.find((entry) => entry.key === "control");
  if (claim === undefined)
    return yield* error("connect", "Stack has no control listener", "missing-control-listener");
  return yield* endpointFromResponse(state, stackId, claim.port);
});

export interface LaunchOptions {
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly stackId: string;
  readonly entrypoint?: string;
}
const readyLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), endpoint: HostEndpoint }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
    reason: Schema.optionalKey(Schema.Literal("bind-conflict")),
  }),
]);
const spawnDetached = Effect.fn("HostProcess.spawnDetached")(function* (
  options: LaunchOptions,
  entrypoint: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            process.execPath,
            [entrypoint, options.stateRoot, options.cacheRoot, options.stackId],
            {
              cwd: process.cwd(),
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              additionalFds: { fd3: { type: "output" } },
              forceKillAfter: "2 seconds",
            },
          ),
        )
        .pipe(Effect.mapError((cause) => error("startup", cause)));
      const readiness = child.getOutputFd(3).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(error("startup", "Host readiness stream closed")),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) => error("startup", cause)),
      );
      return yield* readiness.pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError((cause) => error("startup", cause)),
        Effect.flatMap((line) =>
          Schema.decodeEffect(Schema.fromJsonString(readyLine))(line).pipe(
            Effect.mapError((cause) => error("startup", cause)),
            Effect.flatMap((decoded) => {
              if (decoded.type === "error")
                return Effect.fail(error("startup", decoded.message, decoded.reason));
              if (decoded.endpoint.stackId !== options.stackId)
                return Effect.fail(
                  error("startup", "Host readiness identity does not match the requested stack"),
                );
              return child.unref.pipe(
                Effect.mapError((cause) => error("startup", cause)),
                Effect.as(decoded.endpoint),
              );
            }),
          ),
        ),
      );
    }),
  );
});

const causeCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return causeCode(cause.cause);
  return undefined;
};
const isConnectionFailure = (failure: HostProcessError) => {
  const code = causeCode(failure.cause);
  return (
    failure.reason === "connection-failure" ||
    code === "ECONNREFUSED" ||
    code === "ConnectionRefused" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
};
const isBindConflict = (failure: HostProcessError) => {
  const code = causeCode(failure.cause);
  return failure.reason === "bind-conflict" || code === "EADDRINUSE";
};

export const launchHost = Effect.fn("HostProcess.launchHost")(function* (
  state: State.Interface,
  options: LaunchOptions,
): Effect.fn.Return<
  HostEndpoint,
  HostProcessError | State.StateError,
  | Scope.Scope
  | HttpClient.HttpClient
  | import("effect").Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
> {
  const existing = yield* connectHost(state, options.stackId).pipe(
    Effect.map(Option.some),
    Effect.catchTag("HostProcessError", (failure) =>
      failure.reason === "missing-control-listener" || isConnectionFailure(failure)
        ? Effect.succeed(Option.none())
        : Effect.fail(failure),
    ),
  );
  if (Option.isSome(existing)) return existing.value;
  return yield* spawnDetached(
    options,
    options.entrypoint ?? hostEntrypointFor(import.meta.url),
  ).pipe(
    Effect.catchTag("HostProcessError", (failure) =>
      isBindConflict(failure)
        ? connectHost(state, options.stackId).pipe(Effect.mapError(() => failure))
        : Effect.fail(failure),
    ),
  );
});

const hostEntrypointFor = (moduleUrl: string): string => {
  if (isBunVirtualPath(moduleUrl)) return HOST_PROCESS_DISPATCH_SENTINEL;
  const sourceEntrypoint = fileURLToPath(new URL("./internal/host-process.ts", moduleUrl));
  return isBunVirtualPath(sourceEntrypoint) ? HOST_PROCESS_DISPATCH_SENTINEL : sourceEntrypoint;
};
