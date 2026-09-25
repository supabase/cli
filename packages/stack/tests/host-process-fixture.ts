import { NodeHttpClient, NodeServices, NodeStream } from "@effect/platform-node";
import {
  Context,
  Data,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  Stream,
} from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test fixture owns inherited readiness and release descriptors.
import { closeSync, createReadStream, writeSync } from "node:fs";
import { currentRelease, launchHost, authorizes, type HostEndpoint } from "../src/HostProcess.ts";
import { bindControl } from "../src/StackHost.ts";
import * as State from "../src/State.ts";

class FixtureError extends Data.TaggedError("FixtureError")<{ readonly message: string }> {}

const makeState = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );

const awaitBarrier = NodeStream.fromReadable({
  evaluate: () => createReadStream("", { fd: 4 }),
  onError: (cause) => new FixtureError({ message: String(cause) }),
}).pipe(Stream.take(1), Stream.runDrain);

let reported = false;
const report = (value: unknown) => {
  if (reported) return;
  reported = true;
  try {
    writeSync(
      3,
      Buffer.from(`${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value)}\n`),
    );
  } finally {
    closeSync(3);
  }
};

const [stateRoot, cacheRoot, stackId, mode = "owner", ownerEntrypoint] = process.argv.slice(2);
if (stateRoot === undefined || stackId === undefined)
  throw new FixtureError({ message: "fixture arguments missing" });

/** Follows the owner protocol without services; `held` acknowledges shutdown but stays alive. */
const owner = Effect.scoped(
  Effect.gen(function* () {
    const state = yield* makeState(stateRoot);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stack = yield* state.read(stackId);
    if (stack === undefined) return yield* new FixtureError({ message: "stack is not registered" });
    if (!(yield* state.lease(stackId))) {
      report({ type: "error", message: "lease held", reason: "lease-held" });
      return;
    }
    yield* state.retractHolder(stackId);
    if (stack.identity.stackName === "slow-handshake") {
      const marker = path.join(stateRoot, "slow-handshake.pid");
      yield* fs.writeFileString(`${marker}.tmp`, String(process.pid));
      yield* fs.rename(`${marker}.tmp`, marker);
      return yield* Effect.never;
    }
    const control = yield* bindControl();
    const shutdown = yield* Deferred.make<void>();
    const endpoint: HostEndpoint = {
      stackId,
      identity: stack.identity,
      pid: process.pid,
      port: control.port,
      release: yield* currentRelease,
    };
    const secret = `fixture-${process.pid}`;
    yield* control.server
      .serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!authorizes(request.headers.authorization, secret))
            return HttpServerResponse.empty({ status: 401 });
          if (request.method === "GET" && request.url === "/identity")
            return yield* HttpServerResponse.json(endpoint).pipe(
              Effect.map(HttpServerResponse.setHeader("connection", "close")),
            );
          if (request.method === "POST" && request.url === "/shutdown") {
            yield* Deferred.succeed(shutdown, undefined);
            return HttpServerResponse.empty({ status: 204 }).pipe(
              HttpServerResponse.setHeader("connection", "close"),
            );
          }
          return HttpServerResponse.empty({ status: 404 });
        }),
      )
      .pipe(Effect.forkScoped);
    yield* state.publishHolder(stackId, {
      role: "owner",
      secret,
      port: endpoint.port,
      pid: endpoint.pid,
      release: endpoint.release,
      lifetime: stack.lifetime,
      startedAt: DateTime.formatIso(yield* DateTime.now),
    });
    report({ type: "ready", endpoint, secret });
    if (mode === "held") yield* awaitBarrier;
    else yield* Deferred.await(shutdown);
    yield* state.retractHolder(stackId);
  }),
);

const launcher = Effect.scoped(
  Effect.gen(function* () {
    const state = yield* makeState(stateRoot);
    const { endpoint } = yield* launchHost(state, {
      stateRoot,
      cacheRoot: cacheRoot ?? stateRoot,
      stackId,
      entrypoint: ownerEntrypoint ?? new URL(import.meta.url).pathname,
    });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(endpoint);
    process.stdout.write(`${encoded}\n`);
  }),
);

try {
  const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
  if (mode === "launcher") await Effect.runPromise(launcher.pipe(Effect.provide(layer)));
  else await Effect.runPromise(owner.pipe(Effect.provide(layer)));
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (mode === "launcher") process.stderr.write(`${message}\n`);
  else report({ type: "error", message });
  process.exitCode = 1;
}
