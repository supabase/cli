import { describe, expect, it } from "@effect/vitest";
import { Cause, Data, Deferred, Duration, Effect, Exit, Fiber, Option } from "effect";
import * as TestClock from "effect/testing/TestClock";
/* oxlint-disable effecttsgo/node-builtin-import -- integration test owns real listeners. */
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { StackPreparationError } from "../public/Errors.ts";
import { parseGoDuration } from "../model/capabilities/database.ts";
import { probeReadiness } from "./ReadinessProbe.ts";

class ListenerError extends Data.TaggedError("ListenerError")<{ readonly message: string }> {}

const listenHttp = (
  server: HttpServer,
  handler: () => void,
): Effect.Effect<number, ListenerError> =>
  Effect.callback<number, ListenerError>((resume) => {
    const onError = (cause: Error) =>
      resume(Effect.fail(new ListenerError({ message: cause.message })));
    server.once("error", onError);
    server.once("request", handler);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address !== "object" || address === null)
        return resume(Effect.fail(new ListenerError({ message: "missing HTTP address" })));
      resume(Effect.succeed(address.port));
    });
    return Effect.sync(() => {
      server.off("error", onError);
      server.close();
    });
  });

const listenTcp = (server: TcpServer): Effect.Effect<number, ListenerError> =>
  Effect.callback<number, ListenerError>((resume) => {
    const onError = (cause: Error) =>
      resume(Effect.fail(new ListenerError({ message: cause.message })));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address !== "object" || address === null)
        return resume(Effect.fail(new ListenerError({ message: "missing TCP address" })));
      resume(Effect.succeed(address.port));
    });
    return Effect.sync(() => {
      server.off("error", onError);
      server.close();
    });
  });

describe("private endpoint readiness probe", () => {
  it("parses supported Go duration strings without accepting negative budgets", () => {
    expect(Duration.toMillis(parseGoDuration("1h30m2.5s"))).toBe(5_402_500);
    expect(Duration.toMillis(parseGoDuration("250ms"))).toBe(250);
    expect(Duration.toNanosUnsafe(parseGoDuration("1µs"))).toEqual(1_000n);
    expect(Duration.toNanosUnsafe(parseGoDuration("1μs"))).toEqual(1_000n);
    expect(Duration.toMillis(parseGoDuration("0s"))).toBe(0);
    expect(() => parseGoDuration("-1s")).not.toThrow();
    expect(Duration.isNegative(parseGoDuration("-1s"))).toBe(true);
    for (const invalid of ["", "1", "9223372036854775808ns", "Infinity"])
      expect(() => parseGoDuration(invalid)).toThrow();
  });

  it.live("rejects negative and non-finite readiness deadlines as typed preparation failures", () =>
    Effect.gen(function* () {
      for (const deadline of [Duration.seconds(-1), Duration.infinity]) {
        const result = yield* probeReadiness(
          { mode: "tcp", host: "127.0.0.1", port: 1 },
          { deadline },
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const cause = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(cause).toBeInstanceOf(StackPreparationError);
        }
      }
    }),
  );

  it.live("passes validated request headers to HTTP readiness endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const received = yield* Deferred.make<string>();
        const server = createHttpServer((request, response) => {
          // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- bridge event callback to test signal.
          Effect.runSync(Deferred.succeed(received, request.headers.host ?? ""));
          response.statusCode = request.headers.host === "realtime-dev" ? 200 : 400;
          response.end();
        });
        const port = yield* listenHttp(server, () => undefined);
        yield* probeReadiness({
          mode: "http",
          host: "127.0.0.1",
          port,
          path: "/api/ping",
          headers: { Host: "realtime-dev" },
        });
        expect(yield* Deferred.await(received)).toBe("realtime-dev");
      }),
    ),
  );

  it.live("rejects invalid readiness header names and values", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<Readonly<Record<string, string>>> = [
        { "bad name": "ok" },
        { Host: "bad\nvalue" },
      ];
      for (const headers of cases) {
        const result = yield* probeReadiness({
          mode: "http",
          host: "127.0.0.1",
          port: 1,
          headers,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const cause = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(cause).toBeInstanceOf(StackPreparationError);
        }
      }
    }),
  );

  it.live("rejects control characters in HTTP paths as typed preparation failures", () =>
    Effect.gen(function* () {
      for (const path of ["/ready\nX", "/ready\rX", "/ready\u0000X"]) {
        const result = yield* probeReadiness({
          mode: "http",
          host: "127.0.0.1",
          port: 1,
          path,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const cause = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(cause).toBeInstanceOf(StackPreparationError);
        }
      }
    }),
  );

  it.live("probes HTTP and TCP endpoints with a Schedule retry policy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const http = createHttpServer((_request, response) => {
          response.statusCode = 200;
          response.end("ok");
        });
        const httpPort = yield* listenHttp(http, () => undefined);
        yield* probeReadiness(
          { mode: "http", host: "127.0.0.1", port: httpPort, path: "/health" },
          { retries: 1, retryDelay: 0 },
        );

        const tcp = createTcpServer((socket) => socket.end());
        const tcpPort = yield* listenTcp(tcp);
        yield* probeReadiness(
          { mode: "tcp", host: "127.0.0.1", port: tcpPort },
          { retries: 1, retryDelay: 0 },
        );
      }),
    ),
  );

  it.live("reports a failed endpoint after bounded retries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = createHttpServer((_request, response) => {
          response.statusCode = 503;
          response.end("not ready");
        });
        const port = yield* listenHttp(server, () => undefined);
        const result = yield* probeReadiness(
          { mode: "http", host: "127.0.0.1", port },
          { retries: 1, retryDelay: 0 },
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
      }),
    ),
  );

  it.live("performs exactly one immediate probe for a zero readiness budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let count = 0;
        const server = createHttpServer((_request, response) => {
          count += 1;
          response.statusCode = 503;
          response.end("not ready");
        });
        const port = yield* listenHttp(server, () => undefined);
        const result = yield* probeReadiness(
          { mode: "http", host: "127.0.0.1", port },
          { deadline: Duration.zero },
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const cause = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(cause).toMatchObject({ message: "Readiness HTTP status was not successful" });
          expect(cause).toMatchObject({
            target: { mode: "http", host: "127.0.0.1", port },
          });
        }
        expect(count).toBe(1);
      }),
    ),
  );

  it.live("interrupts an in-flight HTTP request and closes its owned socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const received = yield* Deferred.make<void>();
        const server = createHttpServer((request) => {
          // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- bridge event callback to test signal.
          Effect.runSync(Deferred.succeed(received, undefined));
          request.once("error", () => undefined);
        });
        const port = yield* listenHttp(server, () => undefined);
        const fiber = yield* Effect.forkChild(
          probeReadiness({ mode: "http", host: "127.0.0.1", port, path: "/hang" }, { retries: 0 }),
        );
        yield* Deferred.await(received);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.effect("interrupts an in-flight HTTP request at its total deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const received = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const server = createHttpServer((request) => {
          // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- bridge event callback to test signal.
          Effect.runSync(Deferred.succeed(received, undefined));
          request.once("close", () => {
            // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- bridge event callback to test signal.
            Effect.runSync(Deferred.succeed(closed, undefined));
          });
        });
        const port = yield* listenHttp(server, () => undefined);
        const fiber = yield* Effect.forkChild(
          probeReadiness(
            { mode: "http", host: "127.0.0.1", port, path: "/deadline" },
            { deadline: Duration.millis(10) },
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(received);
        yield* TestClock.adjust(Duration.millis(10));
        const result = yield* Fiber.join(fiber).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const cause = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(cause).toMatchObject({ message: "Readiness deadline exceeded" });
        }
        yield* Deferred.await(closed);
      }),
    ),
  );
});
