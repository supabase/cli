import { Cause, Deferred, Effect, Exit, Layer, Predicate, Scope } from "effect";
import { describe, expect, test } from "vitest";
import { ControlTransport, ControlTransportError } from "./managed/control.ts";
import {
  makeSupervisorControlApplication,
  makeSupervisorControlMiddleware,
} from "./SupervisorControlServer.ts";
import { SupervisorLifecycle } from "./SupervisorLifecycle.ts";
import { makeTestStack } from "./testing.ts";

const isBun = typeof Bun !== "undefined";

describe("Bun control transport", () => {
  (isBun ? test : test.skip)("classifies an owner status timeout as transport", async () => {
    const { controlTransportLayer } = await import("./platform-bun.ts");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    try {
      const port = server.port;
      expect(port).toBeTypeOf("number");
      if (port === undefined) return;
      const endpoint = {
        hostname: "127.0.0.1",
        port,
        url: `http://127.0.0.1:${port}`,
      };
      const exit = await Effect.runPromise(
        Effect.flatMap(ControlTransport, (transport) => transport.read(endpoint)).pipe(
          Effect.provide(controlTransportLayer),
          Effect.exit,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause);
        expect(failure).toBeInstanceOf(ControlTransportError);
        if (failure instanceof ControlTransportError) expect(failure.reason).toBe("transport");
      }
    } finally {
      await server.stop(true);
    }
  });

  (isBun ? test : test.skip)("installs the complete owner app before bind returns", async () => {
    const scope = Scope.makeUnsafe();
    const lifecycle = await Effect.runPromise(
      SupervisorLifecycle.make({
        ownershipId: "a".repeat(64),
        ownerSessionId: "session",
        daemonCliVersion: "test",
        daemonBuildId: "test-build",
        close: Effect.void,
      }).pipe(Effect.provide(Layer.succeed(Scope.Scope, scope))),
    );
    const application = {
      app: await Effect.runPromise(
        makeSupervisorControlApplication(lifecycle).pipe(
          Effect.provide(Layer.succeed(Scope.Scope, scope)),
        ),
      ),
      middleware: makeSupervisorControlMiddleware(lifecycle),
    };
    const listener = await Effect.runPromise(
      Effect.flatMap(ControlTransport, (transport) =>
        transport.bind(
          { hostname: "127.0.0.1", port: 0, url: "http://127.0.0.1:0" },
          () => ({
            controlProtocol: "supabase-stack-control" as const,
            controlProtocolVersion: 1 as const,
            ownershipId: "a".repeat(64),
            ownerSessionId: "session",
            state: "starting" as const,
            ready: false,
            daemonCliVersion: "test",
            daemonBuildId: "test-build",
          }),
          () => "accepted" as const,
          application,
        ),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Scope.Scope, scope),
            (await import("./platform-bun.ts")).controlTransportLayer,
          ),
        ),
      ),
    );
    try {
      const address = listener.server.address;
      expect(Predicate.isTagged(address, "TcpAddress")).toBe(true);
      if (!Predicate.isTagged(address, "TcpAddress")) return;
      const response = await fetch(`http://127.0.0.1:${address.port}/owner`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ daemonBuildId: "test-build" });
    } finally {
      await Effect.runPromise(listener.close);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  (isBun ? test : test.skip)("returns a JSON error for malformed /stop requests", async () => {
    const scope = Scope.makeUnsafe();
    const endpoint = { hostname: "127.0.0.1", port: 0, url: "http://127.0.0.1:0" };
    const listener = await Effect.runPromise(
      Effect.flatMap(ControlTransport, (transport) =>
        transport.bind(
          endpoint,
          () => ({
            controlProtocol: "supabase-stack-control" as const,
            controlProtocolVersion: 1 as const,
            ownershipId: "b".repeat(64),
            ownerSessionId: "session",
            state: "running" as const,
            ready: true,
            daemonCliVersion: "test",
            daemonBuildId: "test-build",
          }),
          () => "accepted" as const,
        ),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Scope.Scope, scope),
            (await import("./platform-bun.ts")).controlTransportLayer,
          ),
        ),
      ),
    );
    try {
      const address = listener.server.address;
      expect(Predicate.isTagged(address, "TcpAddress")).toBe(true);
      if (!Predicate.isTagged(address, "TcpAddress")) return;
      const response = await fetch(`http://127.0.0.1:${address.port}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid stop request" });
    } finally {
      await Effect.runPromise(listener.close);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  (isBun ? test : test.skip)("flushes /stop before graceful Bun close", async () => {
    const scope = Scope.makeUnsafe();
    const lifecycle = await Effect.runPromise(
      SupervisorLifecycle.make({
        ownershipId: "c".repeat(64),
        ownerSessionId: "session",
        daemonCliVersion: "test",
        daemonBuildId: "test-build",
        close: Effect.void,
      }).pipe(Effect.provide(Layer.succeed(Scope.Scope, scope))),
    );
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    await Effect.runPromise(
      lifecycle.publishStack(
        makeTestStack({
          stop: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        }),
      ),
    );
    const application = {
      app: await Effect.runPromise(
        makeSupervisorControlApplication(lifecycle).pipe(
          Effect.provide(Layer.succeed(Scope.Scope, scope)),
        ),
      ),
      middleware: makeSupervisorControlMiddleware(lifecycle),
    };
    const listener = await Effect.runPromise(
      Effect.flatMap(ControlTransport, (transport) =>
        transport.bind(
          { hostname: "127.0.0.1", port: 0, url: "http://127.0.0.1:0" },
          () => ({
            controlProtocol: "supabase-stack-control" as const,
            controlProtocolVersion: 1 as const,
            ownershipId: "c".repeat(64),
            ownerSessionId: "session",
            state: "running" as const,
            ready: true,
            daemonCliVersion: "test",
            daemonBuildId: "test-build",
          }),
          () => "accepted" as const,
          application,
        ),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Scope.Scope, scope),
            (await import("./platform-bun.ts")).controlTransportLayer,
          ),
        ),
      ),
    );
    try {
      await Effect.runPromise(lifecycle.setClose(listener.close));
      const address = listener.server.address;
      expect(Predicate.isTagged(address, "TcpAddress")).toBe(true);
      if (!Predicate.isTagged(address, "TcpAddress")) return;
      const response = await fetch(`http://127.0.0.1:${address.port}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownershipId: "c".repeat(64), ownerSessionId: "session" }),
      });
      const body = await response.text();
      await Effect.runPromise(Deferred.await(started));
      expect(response.status).toBe(202);
      expect(body).toBe(JSON.stringify({ ok: true }));
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(lifecycle.awaitShutdown);
      await expect(fetch(`http://127.0.0.1:${address.port}/owner`)).rejects.toThrow();
    } finally {
      await Effect.runPromise(listener.close);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
