import { NodeServices, NodeSocket } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Redacted,
  Ref,
  Scope,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { deriveStackId, type StackIdentity } from "../identity/Identity.ts";
import { CAPABILITY_NAMES } from "../public/Capability.ts";
import type { StackStatus } from "../public/Status.ts";
import type { ControlEndpoint } from "../state/Ownership.ts";
import {
  makeControlClient,
  startControlServer,
  type MaintenanceHandlers,
  type ControlServerOptions,
} from "./ControlServer.ts";
import {
  CONTROL_PREFACE_MAX_BYTES,
  decodeFrame,
  decodePreface,
  encodeFrame,
  encodePreface,
  encodeRawFrame,
  FrameDecoder,
  MaintenanceProtocolError,
  MAINTENANCE_MAX_FRAME_BYTES,
  type JsonValue,
} from "./MaintenanceProtocol.ts";
import type { StackRpcError, StackRpcHandlers } from "./StackRpc.ts";

interface ServerOverrides {
  readonly rpcHandlers?: Partial<StackRpcHandlers>;
  readonly maintenanceHandlers?: Partial<MaintenanceHandlers>;
  readonly onShutdownReady?: Effect.Effect<void>;
}

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const testIdentity: StackIdentity = {
  projectRoot: "/tmp/project",
  checkoutRoot: "/tmp/project",
  workspaceId: "/tmp/project",
  checkoutId: "/tmp/project",
  branchContext: "ordinary-workspace",
  localProjectKey: ".",
  stackName: "default",
};

const withServer = <A, E, R>(
  f: (context: {
    readonly endpoint: ControlEndpoint;
    readonly stackId: string;
    readonly ownerSessionId: string;
    readonly completion: Deferred.Deferred<void>;
    readonly abandoned: Deferred.Deferred<void>;
    readonly completionStarted: Deferred.Deferred<void>;
    readonly completionRelease: Deferred.Deferred<void>;
    readonly stopCalls: Ref.Ref<number>;
    readonly prepareCalls: Ref.Ref<number>;
    readonly maintenanceStarted: Deferred.Deferred<void>;
    readonly maintenanceRelease: Deferred.Deferred<void>;
  }) => Effect.Effect<A, E, R>,
  overrides?: (context: {
    readonly stackId: string;
    readonly ownerSessionId: string;
    readonly status: StackStatus;
    readonly completion: Deferred.Deferred<void>;
    readonly abandoned: Deferred.Deferred<void>;
    readonly completionStarted: Deferred.Deferred<void>;
    readonly completionRelease: Deferred.Deferred<void>;
    readonly stopCalls: Ref.Ref<number>;
    readonly prepareCalls: Ref.Ref<number>;
    readonly maintenanceStarted: Deferred.Deferred<void>;
    readonly maintenanceRelease: Deferred.Deferred<void>;
  }) => ServerOverrides,
) =>
  withPlatform(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-control-" });
      const stackId = yield* deriveStackId(testIdentity);
      const ownerSessionId = yield* crypto.randomUUIDv4;
      const completion = yield* Deferred.make<void>();
      const abandoned = yield* Deferred.make<void>();
      const completionStarted = yield* Deferred.make<void>();
      const completionRelease = yield* Deferred.make<void>();
      const stopCalls = yield* Ref.make(0);
      const prepareCalls = yield* Ref.make(0);
      const maintenanceStarted = yield* Deferred.make<void>();
      const maintenanceRelease = yield* Deferred.make<void>();
      const endpoint: ControlEndpoint = { kind: "unix", path: path.join(root, "control.sock") };
      const status: StackStatus = {
        id: stackId,
        lifecycle: "stopped",
        desiredLifecycle: "stopped",
        runtime: { kind: "native" },
        endpoints: {},
        versions: {},
        capabilities: CAPABILITY_NAMES.map((name) => ({
          name,
          activation: "eager",
          state: "stopped",
        })),
      };
      const defaultRpcHandlers: StackRpcHandlers = {
        status: () => Effect.succeed(status),
        credentials: () =>
          Effect.succeed({
            database: {
              url: Redacted.make("postgres://localhost"),
              password: Redacted.make("secret"),
            },
            api: {
              publishableKey: "publishable",
              secretKey: Redacted.make("secret"),
              anonJwt: "anon",
              serviceRoleJwt: Redacted.make("service"),
            },
          }),
        prepare: () =>
          Ref.update(prepareCalls, (count) => count + 1).pipe(Effect.as({ capabilities: [] })),
        start: () => Effect.succeed(status),
        restart: () => Effect.succeed(status),
        destroy: () => Effect.void,
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: false }),
      };
      const defaultMaintenanceHandlers: MaintenanceHandlers = {
        probe: Effect.succeed({
          ok: true,
          op: "probe",
          stackId,
          ownerSessionId,
          rpcRelease: "stack-rpc-v1@0.1.0",
        }),
        stop: Effect.succeed({ ok: true, op: "stop" }),
      };
      const custom =
        overrides?.({
          stackId,
          ownerSessionId,
          status,
          completion,
          abandoned,
          completionStarted,
          completionRelease,
          stopCalls,
          prepareCalls,
          maintenanceStarted,
          maintenanceRelease,
        }) ?? {};
      const options: ControlServerOptions = {
        endpoint,
        stackId,
        ownerSessionId,
        maintenanceHandlers: { ...defaultMaintenanceHandlers, ...custom.maintenanceHandlers },
        rpcHandlers: { ...defaultRpcHandlers, ...custom.rpcHandlers },
        onShutdownReady: custom.onShutdownReady,
      };
      yield* startControlServer(options);
      const info = yield* fs.stat(endpoint.path);
      expect(info.mode & 0o777).toBe(0o600);
      return yield* f({
        endpoint,
        stackId,
        ownerSessionId,
        completion,
        abandoned,
        completionStarted,
        completionRelease,
        stopCalls,
        prepareCalls,
        maintenanceStarted,
        maintenanceRelease,
      });
    }),
  );

const concatBytes = (...chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const sendRawAndReadFrame = (
  endpoint: ControlEndpoint,
  bytes: Uint8Array,
): Effect.Effect<JsonValue, MaintenanceProtocolError, Scope.Scope> =>
  sendRawSequenceAndReadFrame(endpoint, [bytes]);

const sendRawSequenceAndReadFrame = (
  endpoint: ControlEndpoint,
  chunks: ReadonlyArray<Uint8Array>,
): Effect.Effect<JsonValue, MaintenanceProtocolError, Scope.Scope> =>
  Effect.gen(function* () {
    const socket = yield* NodeSocket.makeNet({
      path: endpoint.kind === "unix" ? endpoint.path : endpoint.name,
    });
    const write = yield* socket.writer;
    const decoder = new FrameDecoder();
    const response = yield* Deferred.make<Uint8Array>();
    const read = socket
      .runRaw((chunk) =>
        decoder.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk).pipe(
          Effect.flatMap((frames) =>
            Effect.forEach(frames, (frame) =>
              Deferred.succeed(response, frame).pipe(Effect.asVoid),
            ),
          ),
          Effect.asVoid,
        ),
      )
      .pipe(Effect.catchTag("SocketError", () => Effect.void));
    const fiber = yield* Effect.forkChild(read);
    for (const chunk of chunks) {
      yield* write(chunk).pipe(
        Effect.mapError((error) => new MaintenanceProtocolError({ message: error.message })),
      );
    }
    const frame = yield* Deferred.await(response).pipe(
      Effect.timeoutOrElse({
        duration: 5_500,
        orElse: () =>
          Effect.fail(new MaintenanceProtocolError({ message: "Timed out waiting for response" })),
      }),
      Effect.ensuring(Fiber.interrupt(fiber)),
    );
    return yield* decodeFrame(frame);
  });

const makePrepareRequestFrame = (
  capabilities: ReadonlyArray<string>,
): Effect.Effect<Uint8Array, MaintenanceProtocolError> =>
  Effect.gen(function* () {
    const parser = RpcSerialization.json.makeUnsafe();
    const encoded = parser.encode({
      _tag: "Request",
      id: "1",
      tag: "prepare",
      payload: { capabilities },
      headers: [],
    });
    if (encoded === undefined) {
      return yield* new MaintenanceProtocolError({ message: "RPC request could not be encoded" });
    }
    return yield* encodeRawFrame(encoded);
  });

const makeDestroyRequestFrame = (): Effect.Effect<Uint8Array, MaintenanceProtocolError> =>
  Effect.gen(function* () {
    const parser = RpcSerialization.json.makeUnsafe();
    const encoded = parser.encode({
      _tag: "Request",
      id: "1",
      tag: "destroy",
      payload: null,
      headers: [],
    });
    if (encoded === undefined) {
      return yield* new MaintenanceProtocolError({ message: "RPC request could not be encoded" });
    }
    return yield* encodeRawFrame(encoded);
  });

describe("control transport", () => {
  it.live("reevaluates owner shutdown after a failed start response", () =>
    withServer(
      ({ endpoint, stackId, ownerSessionId, completion }) =>
        Effect.gen(function* () {
          const client = makeControlClient(endpoint, { stackId, ownerSessionId });
          const rpc = yield* client.rpc;
          const result = yield* rpc.start({}).pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          yield* Deferred.await(completion).pipe(
            Effect.timeoutOrElse({
              duration: 5_500,
              orElse: () =>
                Effect.fail(
                  new MaintenanceProtocolError({
                    message: "failed start did not trigger shutdown reevaluation",
                  }),
                ),
            }),
          );
        }),
      ({ completion }) => ({
        rpcHandlers: {
          start: () =>
            Effect.fail({
              tag: "StackPreparationError",
              message: "injected start failure",
            } satisfies StackRpcError),
        },
        onShutdownReady: Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
      }),
    ),
  );

  it.live("reevaluates owner shutdown after a failed restart response", () =>
    withServer(
      ({ endpoint, stackId, ownerSessionId, completion }) =>
        Effect.gen(function* () {
          const client = makeControlClient(endpoint, { stackId, ownerSessionId });
          const rpc = yield* client.rpc;
          expect(Exit.isFailure(yield* rpc.restart({}).pipe(Effect.exit))).toBe(true);
          yield* Deferred.await(completion);
        }),
      ({ completion }) => ({
        rpcHandlers: {
          restart: () =>
            Effect.fail({
              tag: "StackReconciliationError",
              message: "injected restart failure",
            } satisfies StackRpcError),
        },
        onShutdownReady: Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
      }),
    ),
  );

  it.live("reevaluates owner shutdown after a prepare response", () =>
    withServer(
      ({ endpoint, stackId, ownerSessionId, completion }) =>
        Effect.gen(function* () {
          const client = makeControlClient(endpoint, { stackId, ownerSessionId });
          const rpc = yield* client.rpc;
          yield* rpc.prepare({});
          yield* Deferred.await(completion);
        }),
      ({ completion }) => ({
        onShutdownReady: Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
      }),
    ),
  );

  it.live("signals destroy shutdown only after writing the typed response", () =>
    withServer(
      ({ endpoint, stackId, ownerSessionId, completion }) =>
        Effect.gen(function* () {
          const client = makeControlClient(endpoint, { stackId, ownerSessionId });
          const rpc = yield* client.rpc;
          yield* rpc.destroy(undefined);
          yield* Deferred.await(completion).pipe(
            Effect.timeoutOrElse({
              duration: 5_500,
              orElse: () =>
                Effect.fail(
                  new MaintenanceProtocolError({ message: "destroy completion was not signaled" }),
                ),
            }),
          );
        }),
      ({ completion }) => ({
        onShutdownReady: Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
      }),
    ),
  );

  it.live("counts a successful destroy send before an immediate disconnect", () =>
    withServer(
      ({ endpoint, stackId, ownerSessionId, completionStarted, completionRelease, completion }) =>
        Effect.gen(function* () {
          const preface = encodePreface({
            kind: "rpc",
            release: "stack-rpc-v1@0.1.0",
            stackId,
            ownerSessionId,
          });
          const frame = yield* makeDestroyRequestFrame();
          const response = yield* sendRawSequenceAndReadFrame(endpoint, [
            concatBytes(preface, frame),
          ]);
          expect(response).toMatchObject({ _tag: "Exit", requestId: "1" });
          yield* Deferred.await(completionStarted).pipe(
            Effect.timeoutOrElse({
              duration: 1_000,
              orElse: () =>
                Effect.fail(
                  new MaintenanceProtocolError({
                    message: "destroy completion did not survive the response disconnect",
                  }),
                ),
            }),
          );
          yield* Deferred.succeed(completionRelease, undefined);
          yield* Deferred.await(completion).pipe(
            Effect.timeoutOrElse({
              duration: 1_000,
              orElse: () =>
                Effect.fail(
                  new MaintenanceProtocolError({ message: "destroy completion was not signaled" }),
                ),
            }),
          );
        }),
      ({ completionStarted, completionRelease, completion }) => ({
        onShutdownReady: Deferred.succeed(completionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(completionRelease)),
          Effect.andThen(Deferred.succeed(completion, undefined)),
          Effect.asVoid,
        ),
      }),
    ),
  );

  it.live("reevaluates shutdown after a request-scoped defect and keeps the endpoint usable", () =>
    withServer(
      ({ endpoint, stackId, ownerSessionId, completion }) =>
        Effect.gen(function* () {
          const preface = encodePreface({
            kind: "rpc",
            release: "stack-rpc-v1@0.1.0",
            stackId,
            ownerSessionId,
          });
          const frame = yield* makeDestroyRequestFrame();
          const response = yield* sendRawSequenceAndReadFrame(endpoint, [
            concatBytes(preface, frame),
          ]);
          expect(response).toMatchObject({
            _tag: "Exit",
            requestId: "1",
            exit: { _tag: "Failure" },
          });
          yield* Deferred.await(completion);

          const client = makeControlClient(endpoint, { stackId, ownerSessionId });
          const rpc = yield* client.rpc;
          const status = yield* rpc.status(undefined);
          expect(status.id).toBe(stackId);
        }),
      ({ completion }) => ({
        rpcHandlers: {
          destroy: () => Effect.die(new Error("injected destroy defect")),
        },
        onShutdownReady: Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
      }),
    ),
  );

  it.live("round-trips typed RPC and stable maintenance on one endpoint", () =>
    withServer(({ endpoint, stackId, ownerSessionId }) =>
      Effect.gen(function* () {
        const client = makeControlClient(endpoint, { stackId, ownerSessionId });
        const probe = yield* client.probe();
        expect(probe).toMatchObject({ ok: true, op: "probe", stackId, ownerSessionId });
        const rpc = yield* client.rpc;
        const observed = yield* rpc.status(undefined);
        expect(observed.id).toBe(stackId);
        expect(yield* client.stop()).toEqual({ ok: true, op: "stop" });
      }),
    ),
  );

  it.live("holds a fragmented preface until the newline and reports the consumed boundary", () =>
    withPlatform(
      Effect.gen(function* () {
        const stackId = "a".repeat(64);
        const ownerSessionId = "session";
        const preface = encodePreface({
          kind: "rpc",
          release: "stack-rpc-v1@0.1.0",
          stackId,
          ownerSessionId,
        });
        const incomplete = yield* decodePreface(preface.slice(0, 3)).pipe(Effect.exit);
        expect(Exit.isFailure(incomplete)).toBe(true);
        const complete = yield* decodePreface(preface);
        expect(complete.consumed).toBe(preface.byteLength);
      }),
    ),
  );

  it.live("forwards a fragmented preface and same-write large typed RPC payload", () =>
    withServer(({ endpoint, stackId, ownerSessionId, prepareCalls }) =>
      Effect.gen(function* () {
        const preface = encodePreface({
          kind: "rpc",
          release: "stack-rpc-v1@0.1.0",
          stackId,
          ownerSessionId,
        });
        const frame = yield* makePrepareRequestFrame(Array.from({ length: 100 }, () => "database"));
        const response = yield* sendRawSequenceAndReadFrame(endpoint, [
          preface.slice(0, 3),
          concatBytes(preface.slice(3), frame),
        ]);
        expect(response).toMatchObject({ _tag: "Exit", requestId: "1" });
        expect(yield* Ref.get(prepareCalls)).toBe(1);
      }),
    ),
  );

  it.live("rejects a mismatched stack identity before decoding an oversized RPC frame", () =>
    withServer(({ endpoint, ownerSessionId }) =>
      Effect.gen(function* () {
        const preface = encodePreface({
          kind: "rpc",
          release: "stack-rpc-v1@0.1.0",
          stackId: "b".repeat(64),
          ownerSessionId,
        });
        const oversized = new Uint8Array(4);
        new DataView(oversized.buffer).setUint32(0, MAINTENANCE_MAX_FRAME_BYTES + 1, false);
        const response = yield* sendRawAndReadFrame(endpoint, concatBytes(preface, oversized));
        expect(response).toMatchObject({ ok: false, error: { tag: "invalid-request" } });
      }),
    ),
  );

  it.live("rejects a stale owner session before decoding an invalid RPC frame", () =>
    withServer(({ endpoint, stackId }) =>
      Effect.gen(function* () {
        const preface = encodePreface({
          kind: "rpc",
          release: "stack-rpc-v1@0.1.0",
          stackId,
          ownerSessionId: "stale-session",
        });
        const invalid = concatBytes(new Uint8Array([0, 0, 0, 3]), new Uint8Array([123, 125, 0]));
        const response = yield* sendRawAndReadFrame(endpoint, concatBytes(preface, invalid));
        expect(response).toMatchObject({ ok: false, error: { tag: "stale-session" } });
      }),
    ),
  );

  it.live("rejects an unsupported RPC release before payload parsing", () =>
    withServer(({ endpoint, stackId, ownerSessionId }) =>
      Effect.gen(function* () {
        const preface = encodePreface({
          kind: "rpc",
          release: "stack-rpc-v9@0.0.0",
          stackId,
          ownerSessionId,
        });
        const invalid = concatBytes(new Uint8Array([0, 0, 0, 1]), new Uint8Array([0xff]));
        const response = yield* sendRawAndReadFrame(endpoint, concatBytes(preface, invalid));
        expect(response).toMatchObject({ ok: false, error: { tag: "unsupported-release" } });
      }),
    ),
  );

  it.live("dispatches exactly one maintenance request on a connection", () => {
    return withServer(
      ({ endpoint, stackId, ownerSessionId, stopCalls }) =>
        Effect.gen(function* () {
          const preface = encodePreface({
            kind: "maintenance",
            release: "maintenance-v1",
            stackId,
            ownerSessionId,
          });
          const first = yield* encodeFrame({ op: "stop", stackId, ownerSessionId });
          const second = yield* encodeFrame({ op: "stop", stackId, ownerSessionId });
          const response = yield* sendRawAndReadFrame(
            endpoint,
            concatBytes(preface, first, second),
          );
          expect(response).toMatchObject({ ok: true, op: "stop" });
          expect(yield* Ref.get(stopCalls)).toBe(1);
        }),
      ({ stopCalls }) => ({
        maintenanceHandlers: {
          stop: Ref.update(stopCalls, (count) => count + 1).pipe(
            Effect.as({ ok: true, op: "stop" }),
          ),
        },
      }),
    );
  });

  it.effect("allows validated stop to outlive the admission deadline", () => {
    return withServer(
      ({ endpoint, stackId, ownerSessionId, maintenanceStarted, maintenanceRelease }) =>
        Effect.gen(function* () {
          const client = makeControlClient(endpoint, {
            stackId,
            ownerSessionId,
          });
          const stopCompleted = yield* Deferred.make<void>();
          const stopFiber = yield* Effect.forkChild(
            client.stop().pipe(Effect.ensuring(Deferred.succeed(stopCompleted, undefined))),
          );
          yield* Deferred.await(maintenanceStarted);
          yield* TestClock.adjust("6 seconds");
          yield* Effect.yieldNow;
          const pending = yield* Deferred.poll(stopCompleted);
          expect(Option.isNone(pending)).toBe(true);
          yield* Deferred.succeed(maintenanceRelease, undefined);
          expect(yield* Fiber.join(stopFiber)).toMatchObject({ ok: true, op: "stop" });
        }),
      ({ maintenanceStarted, maintenanceRelease }) => {
        return {
          maintenanceHandlers: {
            stop: Effect.gen(function* () {
              yield* Deferred.succeed(maintenanceStarted, undefined);
              yield* Deferred.await(maintenanceRelease);
              return { ok: true, op: "stop" };
            }),
          },
        };
      },
    );
  });

  it.live("runs maintenance completion only after the response is flushed", () => {
    return withServer(
      ({ endpoint, stackId, ownerSessionId, completionStarted, completionRelease, completion }) =>
        Effect.gen(function* () {
          const client = makeControlClient(endpoint, {
            stackId,
            ownerSessionId,
          });
          const stopFiber = yield* Effect.forkChild(client.stop(), { startImmediately: true });
          yield* Deferred.await(completionStarted);
          const response = yield* Fiber.join(stopFiber);
          expect(response).toMatchObject({ ok: true, op: "stop" });
          yield* Deferred.succeed(completionRelease, undefined);
          yield* Deferred.await(completion);
        }),
      ({ completionStarted, completionRelease, completion }) => ({
        onShutdownReady: Deferred.succeed(completionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(completionRelease)),
          Effect.andThen(Deferred.succeed(completion, undefined)),
          Effect.asVoid,
        ),
      }),
    );
  });

  it.live("fails closed on bounded frame and preface violations", () =>
    withPlatform(
      Effect.gen(function* () {
        const decoder = new FrameDecoder();
        const oversized = new Uint8Array(4);
        new DataView(oversized.buffer).setUint32(0, MAINTENANCE_MAX_FRAME_BYTES + 1, false);
        const frameResult = yield* decoder.push(oversized).pipe(Effect.exit);
        expect(Exit.isFailure(frameResult)).toBe(true);
        const preface = new Uint8Array(CONTROL_PREFACE_MAX_BYTES + 1);
        preface.fill(120);
        const prefaceResult = yield* decodePreface(preface).pipe(Effect.exit);
        expect(Exit.isFailure(prefaceResult)).toBe(true);
      }),
    ),
  );

  it.live(
    "closes a connection that never sends a preface by the maintenance deadline",
    () =>
      withServer(({ endpoint }) =>
        Effect.gen(function* () {
          const response = yield* sendRawSequenceAndReadFrame(endpoint, []);
          expect(response).toMatchObject({ ok: false, error: { tag: "timeout" } });
        }),
      ),
    7_000,
  );
});
