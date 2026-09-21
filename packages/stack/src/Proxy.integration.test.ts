import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Predicate } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- NodeHttpServer.make requires a native server factory.
import * as Http from "node:http";
import { bindTcp, serveTcp } from "./Proxy.ts";

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
        yield* serveTcp(listener, target).pipe(Effect.forkScoped);
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
        const bytes = new Uint8Array(yield* Fiber.join(response));
        expect(bytes).toEqual(body);
        yield* Deferred.await(released);
      }),
    ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
);
