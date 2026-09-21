import { NodeHttpClient, NodeServices, NodeStream } from "@effect/platform-node";
import { Context, Data, Deferred, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test fixture owns inherited readiness and release descriptors.
import { closeSync, createReadStream, writeSync } from "node:fs";
import { acquireHost, HostEndpoint, launchHost } from "../src/HostProcess.ts";
import * as State from "../src/State.ts";

class FixtureError extends Data.TaggedError("FixtureError")<{ readonly message: string }> {}

const FixtureRpc = RpcGroup.make(
  Rpc.make("shutdown", {
    payload: { destroy: Schema.Boolean },
    error: Schema.Never,
  }),
);

const causeCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return causeCode(cause.cause);
  return undefined;
};

const makeState = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );

const awaitBarrier = NodeStream.fromReadable({
  evaluate: () => createReadStream("", { fd: 4 }),
  onError: (cause) => new FixtureError({ message: String(cause) }),
}).pipe(Stream.take(1), Stream.runDrain);

const [stateRoot, cacheRoot, stackId, mode = "owner", ownerEntrypoint] = process.argv.slice(2);
if (stateRoot === undefined || stackId === undefined)
  throw new FixtureError({ message: "fixture arguments missing" });

const owner = Effect.scoped(
  Effect.gen(function* () {
    const state = yield* makeState(stateRoot);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stack = yield* state.read(stackId);
    if (stack === undefined) return yield* new FixtureError({ message: "stack is not registered" });
    const host = yield* acquireHost(state, stackId);
    if (stack.identity.stackName === "slow-handshake") {
      const marker = path.join(stateRoot, "slow-handshake.pid");
      yield* fs.writeFileString(`${marker}.tmp`, String(process.pid));
      yield* fs.rename(`${marker}.tmp`, marker);
      return yield* Effect.never;
    }
    const shutdown = yield* Deferred.make<void>();
    const endpoint: HostEndpoint = {
      stackId,
      identity: stack.identity,
      pid: process.pid,
      port: host.port,
    };
    const rpc = yield* RpcServer.toHttpEffect(FixtureRpc, { streamBufferSize: 4 }).pipe(
      Effect.provide(
        Layer.merge(
          FixtureRpc.toLayer({
            shutdown: () => Deferred.succeed(shutdown, undefined).pipe(Effect.asVoid),
          }),
          RpcSerialization.layerNdjson,
        ),
      ),
    );
    const serving = host.server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method === "GET" && request.url === "/identity")
          return yield* HttpServerResponse.json(endpoint).pipe(
            Effect.map(HttpServerResponse.setHeader("connection", "close")),
          );
        if (request.method === "POST" && request.url === "/shutdown") {
          yield* Deferred.succeed(shutdown, undefined);
          return HttpServerResponse.empty({ status: 202 }).pipe(
            HttpServerResponse.setHeader("connection", "close"),
          );
        }
        if (mode === "rpc-held" && request.method === "POST" && request.url.startsWith("/rpc"))
          return yield* rpc;
        return HttpServerResponse.empty({ status: 404 });
      }),
    );
    yield* serving.pipe(Effect.forkScoped);
    try {
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        type: "ready",
        endpoint,
      });
      writeSync(3, Buffer.from(`${encoded}\n`));
    } finally {
      closeSync(3);
    }
    yield* Deferred.await(shutdown);
    if (mode === "rpc-held") yield* awaitBarrier;
  }),
);

const launcher = Effect.gen(function* () {
  const state = yield* makeState(stateRoot);
  const endpoint = yield* launchHost(state, {
    stateRoot,
    cacheRoot: cacheRoot ?? stateRoot,
    stackId,
    entrypoint: ownerEntrypoint ?? new URL(import.meta.url).pathname,
  });
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(endpoint);
  process.stdout.write(`${encoded}\n`);
});

const program = mode === "launcher" ? launcher : owner;
try {
  await Effect.runPromise(
    Effect.scoped(program).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    ),
  );
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const reason = causeCode(cause) === "EADDRINUSE" ? "bind-conflict" : undefined;
  const error = `${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
    type: "error",
    message,
    ...(reason === undefined ? {} : { reason }),
  })}\n`;
  if (mode === "owner") {
    try {
      writeSync(3, Buffer.from(error));
    } finally {
      closeSync(3);
    }
  } else process.stderr.write(error);
  process.exitCode = 1;
}
