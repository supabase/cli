import {
  Cause,
  Data,
  Effect,
  Exit,
  FiberSet,
  Option,
  Redacted,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { Socket, createServer } from "node:net";
import { CapabilityNameSchema, type CapabilityName } from "../public/Capability.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import {
  GatewayActivationError,
  GatewayAuthenticationError,
  GatewayStaleGenerationError,
} from "../public/Errors.ts";
import {
  ACTIVATION_PROTOCOL,
  ActivationEndpointSchema,
  type ActivationEndpoint,
} from "./ActivationFile.ts";
import type { ActivationResult } from "./Gateway.ts";

export const ACTIVATION_MAX_FRAME_BYTES = 64 * 1024;
export const ACTIVATION_MAX_CONCURRENT_REQUESTS = 16;
export const ACTIVATION_REQUEST_DEADLINE_MS = 5_000;

const TokenSchema = Schema.String.pipe(
  Schema.refine(
    (value): value is string => value.length > 0 && value.length <= 256 && !/\s/.test(value),
    {
      identifier: "ActivationToken",
      message: "Expected a bounded activation token",
    },
  ),
);
const RedactedTokenSchema = Schema.RedactedFromValue(TokenSchema);

export const ActivationRequestSchema = Schema.Struct({
  protocol: Schema.Literal(ACTIVATION_PROTOCOL),
  operation: Schema.Literal("activate"),
  capability: RedactedTokenSchema,
  target: CapabilityNameSchema,
  stackId: StackIdSchema,
  desiredGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  gatewayInstanceId: RedactedTokenSchema,
  ownerSessionId: RedactedTokenSchema,
});
export type ActivationRequest = Schema.Schema.Type<typeof ActivationRequestSchema>;

export const ActivationResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    capability: CapabilityNameSchema,
    endpoint: ActivationEndpointSchema,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      tag: Schema.Literals([
        "authentication",
        "stale-generation",
        "activation",
        "invalid-request",
      ] as const),
      message: Schema.String,
    }),
  }),
]);
export type ActivationResponse = Schema.Schema.Type<typeof ActivationResponseSchema>;

export interface ActivationServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly capability: Redacted.Redacted<string>;
  readonly stackId: StackId;
  readonly desiredGeneration: number;
  readonly gatewayInstanceId: Redacted.Redacted<string>;
  readonly ownerSessionId: Redacted.Redacted<string>;
  readonly activate: (
    capability: CapabilityName,
  ) => Effect.Effect<ActivationResult, GatewayActivationError>;
}

export interface ActivationServer {
  readonly endpoint: ActivationEndpoint;
  readonly close: Effect.Effect<void>;
}

export interface ActivationClientOptions {
  readonly endpoint: ActivationEndpoint;
  readonly request: ActivationRequest;
}

class ActivationProtocolError extends Data.TaggedError("ActivationProtocolError")<{
  readonly message: string;
}> {}

const protocolError = (message: string) => new ActivationProtocolError({ message });
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const encodeFrame = (value: unknown): Uint8Array => {
  // The framing callback is a synchronous Node leaf; callers pass closed JSON records.
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json
  const body = textEncoder.encode(JSON.stringify(value));
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
};

const encodeFrameText = (text: string): Uint8Array => {
  const body = textEncoder.encode(text);
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
};

const encodeRequest = (
  request: ActivationRequest,
): Effect.Effect<Uint8Array, GatewayActivationError> =>
  Schema.encodeEffect(Schema.fromJsonString(ActivationRequestSchema))(request, {
    onExcessProperty: "error",
  }).pipe(
    Effect.map(encodeFrameText),
    Effect.mapError(() => new GatewayActivationError({ message: "Activation request is invalid" })),
  );

const decodeRequest = (
  frame: Uint8Array,
): Effect.Effect<ActivationRequest, ActivationProtocolError> =>
  Effect.gen(function* () {
    if (frame.byteLength < 4) return yield* protocolError("Activation frame is truncated");
    const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
    if (length > ACTIVATION_MAX_FRAME_BYTES || frame.byteLength !== length + 4)
      return yield* protocolError("Activation frame exceeds the size limit");
    const text = yield* Effect.try({
      try: () => textDecoder.decode(frame.slice(4)),
      catch: () => protocolError("Activation frame is invalid"),
    });
    return yield* Schema.decodeEffect(Schema.fromJsonString(ActivationRequestSchema))(text, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => protocolError("Activation request is invalid")));
  });

const responseFor = (
  result: Exit.Exit<
    ActivationResult,
    GatewayActivationError | GatewayAuthenticationError | GatewayStaleGenerationError
  >,
): Record<string, unknown> => {
  if (Exit.isSuccess(result))
    return { ok: true, capability: result.value.capability, endpoint: result.value.endpoint };
  const value = Cause.findErrorOption(result.cause);
  if (Option.isSome(value) && value.value instanceof GatewayAuthenticationError)
    return { ok: false, error: { tag: "authentication", message: "Activation request rejected" } };
  if (Option.isSome(value) && value.value instanceof GatewayStaleGenerationError)
    return {
      ok: false,
      error: { tag: "stale-generation", message: "Activation request rejected" },
    };
  return { ok: false, error: { tag: "activation", message: "Activation failed" } };
};

const writeAndClose = (socket: Socket, value: unknown): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      socket.off("error", done);
      socket.off("close", done);
      resume(Effect.void);
    };
    socket.once("error", done);
    socket.once("close", done);
    socket.end(encodeFrame(value), done);
    return Effect.sync(() => {
      socket.off("error", done);
      socket.off("close", done);
      socket.destroy();
    });
  });

/** One-shot client used by a container gateway; it never exposes maintenance authority. */
export const requestActivation = (
  options: ActivationClientOptions,
): Effect.Effect<
  ActivationResult,
  GatewayActivationError | GatewayAuthenticationError | GatewayStaleGenerationError
> =>
  Effect.gen(function* () {
    const requestFrame = yield* encodeRequest(options.request);
    return yield* Effect.callback<
      ActivationResult,
      GatewayActivationError | GatewayAuthenticationError | GatewayStaleGenerationError
    >((resume) => {
      const socket = new Socket();
      let done = false;
      let bytes = new Uint8Array(0);
      let onData: ((chunk: Buffer) => void) | undefined;
      let onError: ((cause: Error) => void) | undefined;
      let onClose: (() => void) | undefined;
      let onTimeout: (() => void) | undefined;
      let onConnect: (() => void) | undefined;
      const cleanup = () => {
        if (onData !== undefined) socket.off("data", onData);
        if (onError !== undefined) socket.off("error", onError);
        if (onClose !== undefined) socket.off("close", onClose);
        if (onTimeout !== undefined) socket.off("timeout", onTimeout);
        if (onConnect !== undefined) socket.off("connect", onConnect);
        socket.setTimeout(0);
      };
      const finish = (
        effect: Effect.Effect<
          ActivationResult,
          GatewayActivationError | GatewayAuthenticationError | GatewayStaleGenerationError
        >,
      ) => {
        if (done) return;
        done = true;
        cleanup();
        resume(effect);
        socket.destroy();
      };
      onError = (cause: Error) =>
        finish(
          Effect.fail(
            new GatewayActivationError({ message: "Activation server unavailable", cause }),
          ),
        );
      onClose = () =>
        finish(
          Effect.fail(new GatewayActivationError({ message: "Activation server unavailable" })),
        );
      onTimeout = () =>
        finish(
          Effect.fail(new GatewayActivationError({ message: "Activation request timed out" })),
        );
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("timeout", onTimeout);
      socket.setTimeout(ACTIVATION_REQUEST_DEADLINE_MS);
      onData = (chunk: Buffer) => {
        if (done) return;
        const next = new Uint8Array(bytes.byteLength + chunk.byteLength);
        next.set(bytes);
        next.set(chunk, bytes.byteLength);
        bytes = next;
        if (bytes.byteLength < 4) return;
        const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
        if (length > ACTIVATION_MAX_FRAME_BYTES || bytes.byteLength < length + 4) {
          if (length > ACTIVATION_MAX_FRAME_BYTES)
            finish(
              Effect.fail(
                new GatewayActivationError({ message: "Activation response is invalid" }),
              ),
            );
          return;
        }
        if (bytes.byteLength !== length + 4) {
          finish(
            Effect.fail(new GatewayActivationError({ message: "Activation response is invalid" })),
          );
          return;
        }
        const frame = bytes.slice(4, length + 4);
        const parsed: Effect.Effect<
          ActivationResult,
          GatewayActivationError | GatewayAuthenticationError | GatewayStaleGenerationError
        > = Effect.try({
          try: () => textDecoder.decode(frame),
          catch: () => new GatewayActivationError({ message: "Activation response is invalid" }),
        }).pipe(
          Effect.flatMap((text) =>
            Schema.decodeEffect(Schema.fromJsonString(ActivationResponseSchema))(text, {
              onExcessProperty: "error",
            }),
          ),
          Effect.mapError((error): GatewayActivationError =>
            error instanceof GatewayActivationError
              ? error
              : new GatewayActivationError({
                  message: "Activation response is invalid",
                  cause: error,
                }),
          ),
          Effect.flatMap(
            (
              value,
            ): Effect.Effect<
              ActivationResult,
              GatewayActivationError | GatewayAuthenticationError | GatewayStaleGenerationError
            > =>
              value.ok
                ? Effect.succeed({ capability: value.capability, endpoint: value.endpoint })
                : value.error.tag === "authentication"
                  ? Effect.fail(
                      new GatewayAuthenticationError({ message: "Activation request rejected" }),
                    )
                  : value.error.tag === "stale-generation"
                    ? Effect.fail(
                        new GatewayStaleGenerationError({ message: "Activation request rejected" }),
                      )
                    : Effect.fail(new GatewayActivationError({ message: "Activation failed" })),
          ),
        );
        finish(parsed);
      };
      socket.on("data", onData);
      onConnect = () => socket.write(requestFrame);
      socket.once("connect", onConnect);
      socket.connect(options.endpoint.port, options.endpoint.host);
      return Effect.sync(() => {
        cleanup();
        done = true;
        socket.destroy();
      });
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: ACTIVATION_REQUEST_DEADLINE_MS,
      orElse: () =>
        Effect.fail(new GatewayActivationError({ message: "Activation request timed out" })),
    }),
  );

const serveSocket = (
  socket: Socket,
  options: ActivationServerOptions,
  semaphore: Semaphore.Semaphore,
  runFork: <A, E>(effect: Effect.Effect<A, E>) => import("effect/Fiber").Fiber<A, E>,
  active: Set<Socket>,
): void => {
  active.add(socket);
  let finished = false;
  let processing = false;
  let bytes = new Uint8Array(0);
  let fiber: import("effect/Fiber").Fiber<unknown, unknown> | undefined;
  const finish = () => {
    if (finished) {
      active.delete(socket);
      return;
    }
    finished = true;
    if (fiber !== undefined) fiber.interruptUnsafe();
    socket.destroy();
    active.delete(socket);
  };
  const send = (value: unknown) => {
    if (finished) return;
    finished = true;
    // Socket callbacks are a foreign boundary; all response work runs on the
    // Supervisor context captured when this server was acquired.
    runFork(writeAndClose(socket, value));
  };
  socket.once("error", finish);
  socket.once("close", finish);
  socket.setTimeout(ACTIVATION_REQUEST_DEADLINE_MS, finish);
  const onData = (chunk: Buffer) => {
    if (finished || processing) return;
    const next = new Uint8Array(bytes.byteLength + chunk.byteLength);
    next.set(bytes);
    next.set(chunk, bytes.byteLength);
    bytes = next;
    if (bytes.byteLength > ACTIVATION_MAX_FRAME_BYTES + 4) {
      send({
        ok: false,
        error: { tag: "invalid-request", message: "Activation request rejected" },
      });
      return;
    }
    if (bytes.byteLength < 4) return;
    const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    if (length > ACTIVATION_MAX_FRAME_BYTES) {
      send({
        ok: false,
        error: { tag: "invalid-request", message: "Activation request rejected" },
      });
      return;
    }
    if (bytes.byteLength < length + 4) return;
    if (bytes.byteLength !== length + 4) {
      send({
        ok: false,
        error: { tag: "invalid-request", message: "Activation request rejected" },
      });
      return;
    }
    const frame = bytes.slice(0, length + 4);
    processing = true;
    socket.setTimeout(0);
    fiber = runFork(
      semaphore.withPermit(
        Effect.gen(function* () {
          const request = yield* decodeRequest(frame).pipe(Effect.exit);
          if (Exit.isFailure(request)) {
            send({
              ok: false,
              error: { tag: "invalid-request", message: "Activation request rejected" },
            });
            return;
          }
          if (
            request.value.protocol !== ACTIVATION_PROTOCOL ||
            Redacted.value(request.value.capability) !== Redacted.value(options.capability) ||
            request.value.stackId !== options.stackId ||
            Redacted.value(request.value.gatewayInstanceId) !==
              Redacted.value(options.gatewayInstanceId) ||
            Redacted.value(request.value.ownerSessionId) !== Redacted.value(options.ownerSessionId)
          ) {
            send({
              ok: false,
              error: { tag: "authentication", message: "Activation request rejected" },
            });
            return;
          }
          if (request.value.desiredGeneration !== options.desiredGeneration) {
            send({
              ok: false,
              error: { tag: "stale-generation", message: "Activation request rejected" },
            });
            return;
          }
          const result = yield* options.activate(request.value.target).pipe(
            Effect.timeoutOrElse({
              duration: ACTIVATION_REQUEST_DEADLINE_MS,
              orElse: () =>
                Effect.fail(
                  new GatewayActivationError({ message: "Activation deadline exceeded" }),
                ),
            }),
            Effect.exit,
          );
          send(responseFor(result));
        }),
      ),
    );
  };
  socket.on("data", onData);
};

/** Bind an ephemeral exact-release activation server owned by the Supervisor. */
export const startActivationServer = (
  options: ActivationServerOptions,
): Effect.Effect<ActivationServer, GatewayActivationError, Scope.Scope> =>
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(ACTIVATION_MAX_CONCURRENT_REQUESTS);
    const fibers = yield* FiberSet.make<unknown, unknown>();
    const runFork = yield* FiberSet.runtime(fibers)<never>();
    const active = new Set<Socket>();
    const server = createServer((socket) =>
      serveSocket(socket, options, semaphore, runFork, active),
    );
    server.maxConnections = ACTIVATION_MAX_CONCURRENT_REQUESTS;
    const host = options.host ?? "127.0.0.1";
    yield* Effect.callback<void, GatewayActivationError>((resume) => {
      let settled = false;
      const cleanup = () => {
        server.off("error", onError);
        if (!server.listening) {
          server.close(() => undefined);
          return;
        }
        server.close(() => undefined);
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(
          Effect.fail(
            new GatewayActivationError({ message: "Activation server unavailable", cause: error }),
          ),
        );
      };
      server.once("error", onError);
      server.listen({ host, port: options.port ?? 0 }, () => {
        if (settled) return;
        settled = true;
        server.off("error", onError);
        resume(Effect.void);
      });
      return Effect.sync(() => {
        if (settled) return;
        settled = true;
        cleanup();
      });
    });
    const address = server.address();
    if (typeof address !== "object" || address === null)
      return yield* new GatewayActivationError({
        message: "Activation server did not expose an endpoint",
      });
    const closeOperation = Effect.gen(function* () {
      yield* FiberSet.clear(fibers);
      yield* Effect.callback<void>((resume) => {
        for (const socket of active) socket.destroy();
        if (!server.listening) return resume(Effect.void);
        server.close(() => resume(Effect.void));
      });
    });
    const close = yield* Effect.cached(closeOperation);
    yield* Effect.addFinalizer(() => close);
    return {
      endpoint: { host: address.address, port: address.port },
      close,
    } satisfies ActivationServer;
  });
