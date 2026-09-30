import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Logger, Predicate, type LogLevel } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- NodeHttpServer.make requires a native server factory.
import * as Http from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- raw client fixture for a stalled wake.
import { Socket } from "node:net";
import { bindTcp, serveTcp } from "./Proxy.ts";

const captureLogs = (levels: ReadonlyArray<LogLevel.LogLevel>) => (lines: Array<string>) =>
  Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (levels.some((level) => level === logLevel))
        lines.push((Array.isArray(message) ? message : [message]).map(String).join(" "));
    }),
  ]);

const captureErrors = captureLogs(["Error"]);

it.live(
  "waits for target readiness and forwards a streamed response through its retained TCP listener",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* NodeHttpServer.make(() => Http.createServer(), {
          host: "127.0.0.1",
          port: 0,
        });
        yield* backend.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return HttpServerResponse.stream(request.stream, {
              contentType: "application/octet-stream",
            });
          }),
        );
        const listener = yield* bindTcp("127.0.0.1", 0);
        if (
          !Predicate.isTagged(backend.address, "TcpAddress") ||
          !Predicate.isTagged(listener.address, "TcpAddress")
        )
          return yield* Effect.die("Expected TCP listeners");
        const address = { host: "127.0.0.1", port: backend.address.port };
        const acquired = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const target = Effect.acquireRelease(Deferred.succeed(acquired, undefined), () =>
          Deferred.succeed(released, undefined),
        ).pipe(Effect.andThen(Deferred.await(ready)), Effect.as(address));
        yield* serveTcp(listener, target, "backend").pipe(Effect.forkScoped);
        const body = new Uint8Array(2 * 1024 * 1024).fill(71);
        const client = yield* HttpClient.HttpClient;
        const request = client
          .execute(
            HttpClientRequest.post(`http://127.0.0.1:${listener.address.port}/echo`).pipe(
              HttpClientRequest.bodyUint8Array(body),
              HttpClientRequest.setHeader("connection", "close"),
            ),
          )
          .pipe(Effect.flatMap((response) => response.arrayBuffer));
        const response = yield* request.pipe(Effect.forkScoped);
        yield* Deferred.await(acquired);
        expect(yield* Deferred.isDone(released)).toBe(false);
        yield* Deferred.succeed(ready, undefined);
        const bytes = Buffer.from(yield* Fiber.join(response));
        // An element-wise toEqual over 2 MiB blocks the event loop for seconds.
        expect(bytes.byteLength).toBe(body.byteLength);
        expect(bytes.equals(body)).toBe(true);
        yield* Deferred.await(released);
      }),
    ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
);

it.live("closes a connection and names the endpoint when its target never wakes", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const listener = yield* bindTcp("127.0.0.1", 0);
      if (!Predicate.isTagged(listener.address, "TcpAddress"))
        return yield* Effect.die("Expected TCP listener");
      const port = listener.address.port;
      // A target that never resolves stands in for a stalled wake.
      yield* serveTcp(listener, Effect.never, "db:sql", "200 millis").pipe(Effect.forkScoped);
      yield* Effect.callback<void, never>((resume) => {
        const socket = new Socket();
        socket.once("close", () => resume(Effect.void));
        socket.once("error", () => undefined);
        socket.connect(port, "127.0.0.1");
        return Effect.sync(() => socket.destroy());
      }).pipe(Effect.timeout("5 seconds"));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("Endpoint db:sql failed");
      expect(logs[0]).toContain("Wake for db:sql did not complete in time");
    }),
  ).pipe(Effect.provide(captureErrors(logs)));
});
