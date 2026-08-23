import { Effect, Exit, Layer, Predicate, Scope } from "effect";
import { describe, expect, test } from "vitest";
import { ControlTransport } from "./managed/control.ts";
import { httpTransportClientLayer } from "./HttpTransportClient.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { Stack } from "./Stack.ts";
import {
  makeSupervisorControlApplication,
  makeSupervisorControlMiddleware,
} from "./SupervisorControlServer.ts";
import { SupervisorLifecycle } from "./SupervisorLifecycle.ts";
import { makeTestStack } from "./testing.ts";

const isBun = typeof Bun !== "undefined";
const ownerId = "c".repeat(64);

describe("Bun runtime RPC", () => {
  (isBun ? test : test.skip)("serves a same-build runtime RPC request over Bun TCP", async () => {
    const { controlTransportLayer } = await import("./platform-bun.ts");
    const scope = Scope.makeUnsafe();
    const lifecycle = await Effect.runPromise(
      SupervisorLifecycle.make({
        ownershipId: ownerId,
        ownerSessionId: "bun-rpc-session",
        daemonCliVersion: "test",
        daemonBuildId: "test-build",
      }).pipe(Effect.provide(Layer.succeed(Scope.Scope, scope))),
    );
    await Effect.runPromise(lifecycle.publishStack(makeTestStack()));
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
            ownershipId: ownerId,
            ownerSessionId: "bun-rpc-session",
            state: "running" as const,
            ready: true,
            daemonCliVersion: "test",
            daemonBuildId: "test-build",
          }),
          () => "accepted" as const,
          application,
        ),
      ).pipe(
        Effect.provide(Layer.mergeAll(Layer.succeed(Scope.Scope, scope), controlTransportLayer)),
      ),
    );
    try {
      const address = listener.server.address;
      expect(Predicate.isTagged(address, "TcpAddress")).toBe(true);
      if (!Predicate.isTagged(address, "TcpAddress")) return;
      const endpoint = {
        hostname: "127.0.0.1",
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
      };
      const layer = RemoteStack.layer(endpoint, {
        buildIdentity: { cliVersion: "test", buildId: "test-build" },
        owner: {
          ownershipId: ownerId,
          ownerSessionId: "bun-rpc-session",
          controlProtocolVersion: 1,
          daemonCliVersion: "test",
          daemonBuildId: "test-build",
        },
      }).pipe(Layer.provide(httpTransportClientLayer));
      const exit = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const remote = yield* Stack;
            return yield* remote.getInfo();
          }).pipe(Effect.provide(layer), Effect.exit),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) expect(exit.value.url).toContain("127.0.0.1");
    } finally {
      await Effect.runPromise(listener.close);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
