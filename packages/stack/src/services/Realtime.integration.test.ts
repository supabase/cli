import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Fiber, Layer, Redacted, Ref, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import type { CatalogLogs } from "./Recipe.ts";
import { makeDockerHttpRelay, makeDockerTcpRelay } from "../../tests/docker-relay.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";
import { engineTarget, testEngine } from "../../tests/engine-target.ts";
import { httpHost } from "../../tests/helpers/endpoint.ts";
import { selection } from "../../tests/pins.ts";

const options = (root: string) => ({
  stackId: "catalog-realtime",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
  claimNativePort: () => Effect.succeed(true),
});

const dockerOptions = (root: string) => ({
  ...options(root),
  runtime: testEngine,
  engineTarget,
});

class CatalogStallError extends Data.TaggedError("CatalogStallError")<{
  readonly message: string;
}> {}

/** Tracks the current launch phase and each service's output so a stall names both. */
const makeLaunchTrace = Effect.gen(function* () {
  const phase = yield* Ref.make({ service: "database", step: "setup" });
  const outputs = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const capture = Effect.fnUntraced(function* (service: string, logs: CatalogLogs) {
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    yield* Stream.fromSubscription(yield* logs).pipe(
      Stream.runForEach(({ stream, bytes }) =>
        Ref.update(outputs, (current) =>
          new Map(current).set(
            service,
            ((current.get(service) ?? "") + decoders[stream].decode(bytes, { stream: true })).slice(
              -4_000,
            ),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  });
  const enter = (service: string, step: string) => Ref.set(phase, { service, step });
  /** Reports a stall without waiting for the stalled scope's finalizers, which may hang too. */
  const guard =
    (duration: `${number} seconds`) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(Effect.forkDetach(effect), (fiber) =>
        Fiber.join(fiber).pipe(
          Effect.onInterrupt(() => Effect.forkDetach(Fiber.interrupt(fiber))),
          Effect.timeoutOrElse({
            duration,
            orElse: () =>
              Effect.all([Ref.get(phase), Ref.get(outputs)]).pipe(
                Effect.flatMap(([{ service, step }, output]) =>
                  Effect.fail(
                    new CatalogStallError({
                      message: `${service} ${step} did not finish within ${duration}; ${service} output:\n${output.get(service) || "(none)"}`,
                    }),
                  ),
                ),
              ),
          }),
        ),
      );
  return { capture, enter, guard };
});

describe("service catalog", () => {
  it.live(
    "serves Realtime, pg-meta, and Studio against the owned database",
    () =>
      Effect.gen(function* () {
        const trace = yield* makeLaunchTrace;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            const root = yield* makeDockerDatabaseRoot("catalog-optional-api-");
            const secret = "catalog-optional-api-secret-with-at-least-32-chars";
            const databaseRecipe = yield* makeServiceRecipe(
              {
                service: "database",
                pin: selection.database,
                config: {
                  databasePassword: Redacted.make("postgres"),
                  jwtSecret: Redacted.make(secret),
                  jwtExpiry: 3600,
                },
              },
              dockerOptions(root),
            );
            yield* trace.capture("database", databaseRecipe.logs);
            const database = yield* makeStandaloneService(databaseRecipe.definition, {
              id: "database",
              config: databaseRecipe.creation,
            });
            yield* trace.enter("database", "start");
            yield* database.start;
            yield* trace.enter("database", "readiness");
            yield* database.ready;
            yield* trace.enter("database", "relay");
            const databaseRelay = yield* makeDockerTcpRelay(databaseRecipe.endpoint("sql"));
            const databaseUrl = `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/postgres`;

            yield* trace.enter("realtime", "recipe");
            const realtimeRecipe = yield* makeServiceRecipe(
              {
                service: "realtime",
                pin: selection.realtime,
                config: { databaseUrl, jwtSecret: secret },
              },
              dockerOptions(root),
            );
            yield* trace.capture("realtime", realtimeRecipe.logs);
            const realtime = yield* makeStandaloneService(realtimeRecipe.definition, {
              id: "realtime",
              config: realtimeRecipe.creation,
            });
            yield* trace.enter("realtime", "start");
            yield* realtime.start;
            yield* trace.enter("realtime", "readiness");
            yield* realtime.ready;
            yield* trace.enter("realtime", "/healthcheck request");
            const realtimeEndpoint = yield* realtimeRecipe.endpoint("http");
            const realtimeResponse = yield* client.execute(
              HttpClientRequest.get(
                `http://${httpHost(realtimeEndpoint)}:${realtimeEndpoint.port}/healthcheck`,
              ),
            );
            expect(realtimeResponse.status).toBe(200);
            yield* trace.enter("pgmeta", "recipe");

            const pgmetaRecipe = yield* makeServiceRecipe(
              { service: "pgmeta", pin: selection.pgmeta, config: { databaseUrl } },
              dockerOptions(root),
            );
            yield* trace.capture("pgmeta", pgmetaRecipe.logs);
            const pgmeta = yield* makeStandaloneService(pgmetaRecipe.definition, {
              id: "pgmeta",
              config: pgmetaRecipe.creation,
            });
            yield* trace.enter("pgmeta", "start");
            yield* pgmeta.start;
            yield* trace.enter("pgmeta", "readiness");
            yield* pgmeta.ready;
            yield* trace.enter("pgmeta", "relay");
            const pgmetaEndpoint = yield* pgmetaRecipe.endpoint("http");
            const pgmetaRelay = yield* makeDockerHttpRelay(pgmetaRecipe.endpoint("http"));
            yield* trace.enter("pgmeta", "/schemas request");
            const schemasResponse = yield* client.execute(
              HttpClientRequest.get(
                `http://${httpHost(pgmetaEndpoint)}:${pgmetaEndpoint.port}/schemas`,
              ),
            );
            expect(schemasResponse.status).toBe(200);
            expect(yield* schemasResponse.text).toContain("public");
            yield* trace.enter("studio", "recipe");

            const studioRecipe = yield* makeServiceRecipe(
              {
                service: "studio",
                pin: selection.studio,
                config: {
                  databaseUrl,
                  pgmetaUrl: `http://${pgmetaRelay.host}:${pgmetaRelay.port}`,
                  analyticsApiKey: "catalog-analytics-key",
                  apiUrl: "http://localhost:8000",
                  publicApiUrl: "http://localhost:8000",
                  jwtSecret: secret,
                },
              },
              dockerOptions(root),
            );
            yield* trace.capture("studio", studioRecipe.logs);
            const studio = yield* makeStandaloneService(studioRecipe.definition, {
              id: "studio",
              config: studioRecipe.creation,
            });
            yield* trace.enter("studio", "start");
            yield* studio.start;
            yield* trace.enter("studio", "readiness");
            yield* studio.ready;
            yield* trace.enter("studio", "API requests");
            const studioEndpoint = yield* studioRecipe.endpoint("http");
            const profileResponse = yield* client.execute(
              HttpClientRequest.get(
                `http://${httpHost(studioEndpoint)}:${studioEndpoint.port}/api/platform/profile`,
              ),
            );
            expect(profileResponse.status).toBe(200);
            const queryResponse = yield* client.execute(
              HttpClientRequest.post(
                `http://${httpHost(studioEndpoint)}:${studioEndpoint.port}/api/platform/pg-meta/default/query`,
              ).pipe(HttpClientRequest.bodyJsonUnsafe({ query: "select current_user" })),
            );
            expect(queryResponse.status).toBe(200);
            expect(yield* queryResponse.text).toContain('"current_user":"postgres"');

            yield* trace.enter("studio", "stop");
            yield* studio.stop;
            yield* trace.enter("pgmeta", "stop");
            yield* pgmeta.stop;
            yield* trace.enter("realtime", "stop");
            yield* realtime.stop;
            yield* trace.enter("database", "stop");
            yield* database.stop;
            yield* trace.enter("database", "scope teardown");
          }),
        ).pipe(trace.guard("110 seconds"));
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
});
