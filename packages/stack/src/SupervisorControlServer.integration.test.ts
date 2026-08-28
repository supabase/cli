// oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch-in-effect, effecttsgo/node-builtin-import -- Control-server tests call the native HTTP client from Vitest callbacks to exercise the wire boundary.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, ManagedRuntime, Predicate } from "effect";
import { HttpServer } from "effect/unstable/http";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { makeSupervisorControlApplication } from "./SupervisorControlServer.ts";
import { makeSupervisorSessionFixture } from "../tests/helpers/SupervisorSessionFixture.ts";

describe("SupervisorControlServer", () => {
  it("returns 404 for an unknown control route", async () => {
    const serverLayer = NodeHttpServer.layer(() => createServer(), { port: 0 }).pipe(Layer.orDie);
    const runtime = ManagedRuntime.make(serverLayer);
    try {
      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* makeSupervisorSessionFixture({
              ownershipId: "stack",
              ownerSessionId: "session",
              daemonCliVersion: "test",
              close: Effect.void,
            });
            const application = yield* makeSupervisorControlApplication(lifecycle);
            const server = yield* HttpServer.HttpServer;
            yield* server.serve(application);
            const address = server.address;
            if (!Predicate.isTagged(address, "TcpAddress")) throw new Error("expected tcp address");
            const response = yield* Effect.tryPromise(() =>
              fetch(`http://127.0.0.1:${address.port}/unknown`),
            );
            return response.status;
          }),
        ),
      );
      expect(result).toBe(404);
    } finally {
      await runtime.dispose();
    }
  });
});
