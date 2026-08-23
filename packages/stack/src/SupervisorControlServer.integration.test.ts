import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Predicate } from "effect";
import { HttpServer } from "effect/unstable/http";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { SupervisorControlServer } from "./SupervisorControlServer.ts";
import { SupervisorLifecycle } from "./SupervisorLifecycle.ts";
import { makeTestStack } from "./testing.ts";

describe("SupervisorControlServer", () => {
  it("publishes owner status from the lifecycle application", async () => {
    const serverLayer = NodeHttpServer.layer(() => createServer(), { port: 0 }).pipe(Layer.orDie);
    const runtime = ManagedRuntime.make(serverLayer);
    try {
      const server = await runtime.runPromise(HttpServer.HttpServer);
      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* SupervisorLifecycle.make({
              ownershipId: "stack",
              ownerSessionId: "session",
              daemonCliVersion: "test",
              daemonBuildId: "build",
              close: Effect.void,
            });
            const application = yield* SupervisorControlServer.make(lifecycle);
            yield* server.serve(application);
            const address = server.address;
            if (!Predicate.isTagged(address, "TcpAddress")) throw new Error("expected tcp address");
            const response = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${address.port}/owner`),
            );
            return { status: response.status, body: yield* Effect.promise(() => response.json()) };
          }),
        ),
      );
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ownershipId: "stack",
        ownerSessionId: "session",
        daemonBuildId: "build",
        state: "starting",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("flushes the fenced stop response before gated shutdown completes", async () => {
    const serverLayer = NodeHttpServer.layer(() => createServer(), { port: 0 }).pipe(Layer.orDie);
    const runtime = ManagedRuntime.make(serverLayer);
    try {
      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* SupervisorLifecycle.make({
              ownershipId: "stack",
              ownerSessionId: "session",
              daemonCliVersion: "test",
              daemonBuildId: "build",
              close: Effect.void,
            });
            const started = Deferred.makeUnsafe<void>();
            const release = Deferred.makeUnsafe<void>();
            yield* lifecycle.publishStack(
              makeTestStack({
                stop: () =>
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
              }),
            );
            const server = yield* HttpServer.HttpServer;
            const application = yield* SupervisorControlServer.make(lifecycle);
            yield* server.serve(application, SupervisorControlServer.middleware(lifecycle));
            const address = server.address;
            if (!Predicate.isTagged(address, "TcpAddress")) throw new Error("expected tcp address");
            const response = yield* Effect.promise(() =>
              fetch(`http://127.0.0.1:${address.port}/stop`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ownershipId: "stack", ownerSessionId: "session" }),
              }),
            );
            const body = yield* Effect.promise(() => response.text());
            yield* Deferred.await(started);
            const stopping = yield* lifecycle.currentStatus;
            yield* Deferred.succeed(release, undefined);
            yield* lifecycle.awaitShutdown;
            return { status: response.status, body, stopping: stopping.state };
          }),
        ),
      );
      expect(result).toEqual({
        status: 202,
        body: JSON.stringify({ ok: true }),
        stopping: "stopping",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("projects deleting on /owner while destructive cleanup is gated", async () => {
    const serverLayer = NodeHttpServer.layer(() => createServer(), { port: 0 }).pipe(Layer.orDie);
    const runtime = ManagedRuntime.make(serverLayer);
    try {
      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* SupervisorLifecycle.make({
              ownershipId: "stack",
              ownerSessionId: "session",
              daemonCliVersion: "test",
              daemonBuildId: "build",
              close: Effect.void,
            });
            const entered = Deferred.makeUnsafe<void>();
            const release = Deferred.makeUnsafe<void>();
            const server = yield* HttpServer.HttpServer;
            const application = yield* SupervisorControlServer.make(lifecycle);
            yield* server.serve(application, SupervisorControlServer.middleware(lifecycle));
            const address = server.address;
            if (!Predicate.isTagged(address, "TcpAddress")) throw new Error("expected tcp address");
            const deleting = yield* Effect.forkScoped(
              lifecycle.beginDeleting.pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(lifecycle.requestShutdown("dispose")),
              ),
            );
            yield* Deferred.await(entered);
            const response = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${address.port}/owner`, { headers: { connection: "close" } }),
            );
            const body = yield* Effect.promise(() => response.json());
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(deleting);
            return { status: response.status, body };
          }),
        ),
      );
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ state: "deleting", ready: false });
    } finally {
      await runtime.dispose();
    }
  });
});
