import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { Deferred, Effect, Fiber } from "effect";
import { HttpTransportClient, httpTransportClientLayer } from "./HttpTransportClient.ts";
import type { ControlEndpoint } from "./managed/control.ts";

const endpointFor = (server: Server): ControlEndpoint => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return {
    hostname: "127.0.0.1",
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
  };
};

const listen = (server: Server) =>
  Effect.callback<void, Error>((resume) => {
    server.once("error", (cause) => resume(Effect.fail(cause)));
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
    return Effect.sync(() => {
      if (server.listening) server.close();
    });
  });

const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return Effect.void;
    }
    server.close(() => resume(Effect.void));
    return Effect.void;
  });

describe("HttpTransportClient", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) await Effect.runPromise(close(server));
    server = undefined;
  });

  test("aborts an unanswered request when its fiber is interrupted", async () => {
    const requestArrived = Deferred.makeUnsafe<void>();
    const connectionClosed = Deferred.makeUnsafe<void>();
    server = createServer((_request, response) => {
      Deferred.doneUnsafe(requestArrived, Effect.void);
      response.socket?.once("close", () => Deferred.doneUnsafe(connectionClosed, Effect.void));
    });
    await Effect.runPromise(listen(server));

    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const client = yield* HttpTransportClient;
        yield* client.request(endpointFor(server!), "/never");
      }).pipe(Effect.provide(httpTransportClientLayer)),
    );
    await Effect.runPromise(Deferred.await(requestArrived).pipe(Effect.timeout("2 seconds")));
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(Deferred.await(connectionClosed).pipe(Effect.timeout("2 seconds")));
    expect(true).toBe(true);
  });
});
