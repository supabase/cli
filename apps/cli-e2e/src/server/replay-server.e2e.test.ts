import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "vitest";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { fixtureKey } from "./placeholder.ts";
import { startReplayServer } from "./replay-server.ts";

const RecordedResponseSchema = Schema.Struct({
  body: Schema.Struct({ value: Schema.String }),
});

describe("replay server recording", () => {
  it("keeps concurrent recordings for one normalized fixture key", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixturesDir = yield* fs.makeTempDirectory({ prefix: "supabase-replay-recording-" });
        const firstRef = "aaaaaaaaaaaaaaaaaaaa";
        const secondRef = "bbbbbbbbbbbbbbbbbbbb";
        const bothRequests = yield* Deferred.make<void>();
        const serverContext = yield* Effect.context();
        let upstreamRequestCount = 0;
        const upstream = Bun.serve({
          port: 0,
          fetch: (request) =>
            Effect.runPromiseWith(serverContext)(
              Effect.gen(function* () {
                const pathname = new URL(request.url).pathname;
                if (!pathname.startsWith("/v1/projects/")) {
                  return new Response(null, { status: 404 });
                }

                upstreamRequestCount += 1;
                if (upstreamRequestCount === 2) {
                  yield* Deferred.succeed(bothRequests, undefined);
                }
                yield* Deferred.await(bothRequests);

                return Response.json({
                  value: pathname.endsWith(firstRef) ? "first" : "second",
                });
              }),
            ),
        });

        const replay = yield* Effect.tryPromise(() =>
          startReplayServer({
            fixturesDir,
            mode: "record",
            stagingUrl: `http://127.0.0.1:${upstream.port}`,
          }),
        );

        yield* Effect.gen(function* () {
          const [firstResponse, secondResponse] = yield* Effect.all(
            [
              HttpClient.execute(HttpClientRequest.get(`${replay.url}/v1/projects/${firstRef}`)),
              HttpClient.execute(HttpClientRequest.get(`${replay.url}/v1/projects/${secondRef}`)),
            ],
            { concurrency: "unbounded" },
          );
          expect(firstResponse.status).toBe(200);
          expect(secondResponse.status).toBe(200);
          expect(yield* Effect.all([firstResponse.json, secondResponse.json])).toEqual([
            { value: "first" },
            { value: "second" },
          ]);

          const keyDir = path.join(
            fixturesDir,
            "recorded",
            fixtureKey("GET", `/v1/projects/${firstRef}`),
          );
          expect(new Set(yield* fs.readDirectory(keyDir))).toEqual(
            new Set([
              "default.request.json",
              "default.response.json",
              "2.request.json",
              "2.response.json",
            ]),
          );
          const responseBodies = yield* Effect.all(
            ["default", "2"].map((index) =>
              Effect.gen(function* () {
                return yield* Schema.decodeEffect(Schema.fromJsonString(RecordedResponseSchema))(
                  yield* fs.readFileString(path.join(keyDir, `${index}.response.json`)),
                );
              }),
            ),
          );
          expect(
            responseBodies.map((body) => body.body.value).sort((a, b) => a.localeCompare(b)),
          ).toEqual(["first", "second"]);
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => replay.stop()).pipe(
              Effect.andThen(Effect.promise(() => Promise.resolve(upstream.stop()))),
              Effect.andThen(fs.remove(fixturesDir, { recursive: true, force: true })),
              Effect.ignore,
            ),
          ),
        );
      }).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
        Effect.orDie,
      ),
    ));

  it("waits for detached Docker recordings before stopping", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixturesDir = yield* fs.makeTempDirectory({ prefix: "supabase-replay-drain-" });
        const socketPath = path.join(fixturesDir, "docker.sock");
        const bodyStarted = yield* Deferred.make<void>();
        const releaseBody = yield* Deferred.make<void>();
        const serverContext = yield* Effect.context();
        const docker = Bun.serve({
          unix: socketPath,
          fetch: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"ok":true}'));
                  void Effect.runPromiseWith(serverContext)(
                    Effect.gen(function* () {
                      yield* Deferred.succeed(bodyStarted, undefined);
                      yield* Deferred.await(releaseBody);
                      controller.close();
                    }),
                  );
                },
              }),
            ),
        });
        const replay = yield* Effect.tryPromise(() =>
          startReplayServer({
            fixturesDir,
            mode: "record",
            stagingUrl: "http://127.0.0.1:1",
          }),
        );
        replay.setDockerProxyUrl(socketPath);

        yield* Effect.gen(function* () {
          const response = yield* HttpClient.execute(
            HttpClientRequest.get(`${replay.url}/v1.47/info`),
          );
          expect(response.status).toBe(200);
          yield* Stream.runHead(response.stream);
          yield* Deferred.await(bodyStarted);

          const stopFiber = yield* Effect.tryPromise(() => replay.stop()).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          const stoppedBeforeBody = yield* Fiber.await(stopFiber).pipe(
            Effect.timeoutOption(Duration.millis(100)),
          );
          expect(Option.isNone(stoppedBeforeBody)).toBe(true);

          yield* Deferred.succeed(releaseBody, undefined);
          yield* Fiber.await(stopFiber);
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(releaseBody, undefined).pipe(
              Effect.andThen(Effect.promise(() => Promise.resolve(docker.stop()))),
              Effect.andThen(fs.remove(fixturesDir, { recursive: true, force: true })),
              Effect.ignore,
            ),
          ),
        );
      }).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
        Effect.orDie,
      ),
    ));
});
