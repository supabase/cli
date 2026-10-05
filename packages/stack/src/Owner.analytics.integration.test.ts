import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Crypto,
  DateTime,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { tmpdir } from "node:os";
import { logflareEvent, logflareSources } from "./host/LogflareEvents.ts";
import * as State from "./State.ts";
import type { SavedStack } from "./State.ts";
import type { ServiceCreationInput } from "./services/Catalog.ts";
import { makeDockerDatabaseRoot } from "../tests/docker-fixture.ts";
import { ownerFor } from "../tests/owner-rpc.ts";

const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;

const query = <A extends object>(url: string, statement: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const parsed = new URL(url);
      const services = yield* Layer.build(
        PgClient.layer({
          host: parsed.hostname,
          port: Number(parsed.port),
          database: parsed.pathname.slice(1),
          username: decodeURIComponent(parsed.username),
          password: Redacted.make(decodeURIComponent(parsed.password)),
        }),
      );
      return yield* Context.get(services, PgClient.PgClient).unsafe<A>(statement);
    }),
  );

const Confirmed = Schema.Struct({ generation: Schema.Int, byteOffset: Schema.Int });
const decodeConfirmed = Schema.decodeUnknownEffect(Schema.fromJsonString(Confirmed));

interface StoredEvent {
  readonly message: string;
  readonly severity: string | null;
  readonly host: string | null;
  readonly timestamp: string;
}

/** The table Logflare's Postgres backend stores a source's events in, once the source exists. */
const eventsTable = (internalDatabaseUrl: string, source: string) =>
  query<{ readonly token: string }>(
    internalDatabaseUrl,
    `SELECT replace(token::text, '-', '_') AS token FROM _analytics.sources WHERE name = '${source}'`,
  ).pipe(
    Effect.map(([row]) => (row === undefined ? undefined : `_analytics."log_events_${row.token}"`)),
  );

const database: ServiceCreationInput = {
  service: "database",
  config: {
    version: "17",
    databasePassword: Redacted.make("owner-logs-password"),
    jwtSecret: Redacted.make("owner-logs-jwt-secret-with-at-least-32-chars"),
    jwtExpiry: 3600,
  },
  endpoints: { sql: { port: "auto" } },
};
const analytics: ServiceCreationInput = {
  service: "analytics",
  config: { backend: "postgres", apiKey: "owner-logs-key" },
  endpoints: { http: { port: "auto" } },
};

/**
 * Starts an owner composing `services` in a fresh Docker stack. Its Analytics wakes on proxy
 * traffic, which `keepAwake` keeps sending while events must persist.
 */
const startStack = (
  name: string,
  services: ReadonlyArray<ServiceCreationInput>,
  analyticsIdleMillis?: number,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const client = yield* HttpClient.HttpClient;
    const stackId = `${name}-${(yield* crypto.randomUUIDv4).slice(0, 8)}`;
    const root = yield* makeDockerDatabaseRoot(`stack-${name}-`, stackId);
    const saved: SavedStack = {
      id: stackId,
      identity: { projectRoot: "/tmp/project", branchContext: name, stackName: stackId },
      runtime: "docker",
      instances: [],
      lifetime: "detached",
      composition: { members: [], dependencies: [] },
      ports: [],
    };
    const state = Context.get(
      yield* Layer.build(State.layer({ root: path.dirname(path.dirname(root)) })),
      State.Service,
    );
    yield* state.save(saved);
    const owner = yield* ownerFor({ saved, state, root, cacheRoot });
    yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));

    const composed = yield* owner.rpc.supabaseComposition({ services });
    const idOf = (service: string) => {
      const id = composed.find((entry) => entry.creation.service === service)?.id;
      return id === undefined ? Effect.die(`${service} was not composed`) : Effect.succeed(id);
    };
    const analyticsId = yield* idOf("analytics");
    if (analyticsIdleMillis !== undefined) {
      const composition = (yield* state.read(stackId))?.composition;
      if (composition === undefined) return yield* Effect.die("composition was not saved");
      yield* owner.rpc.configureComposition({
        ...composition,
        members: composition.members.map((member) =>
          member.id === analyticsId ? { ...member, idleMillis: analyticsIdleMillis } : member,
        ),
      });
    }
    yield* owner.rpc.startComposition();

    const analyticsUrl = (yield* owner.rpc.credentials({ id: analyticsId, from: "host" })).url;
    if (analyticsUrl === undefined) return yield* Effect.die("the Analytics URL is missing");
    const awaitAnalytics = (
      predicate: (observation: {
        lifecycle: string;
        health?: string;
        wakeEnabled: boolean;
      }) => boolean,
    ) =>
      owner.rpc
        .followStatus({ id: analyticsId })
        .pipe(Stream.filter(predicate), Stream.take(1), Stream.runDrain);
    return {
      owner,
      state,
      stackId,
      idOf,
      analyticsUrl,
      awaitAnalytics,
      wakeAnalytics: client
        .get(`${analyticsUrl}/health`)
        .pipe(
          Effect.andThen(
            awaitAnalytics(
              ({ lifecycle, health }) => lifecycle === "running" && health === "healthy",
            ),
          ),
        ),
      keepAwake: client
        .get(`${analyticsUrl}/health`)
        .pipe(Effect.ignore, Effect.repeat(Schedule.spaced("1 second"))),
    };
  });

it.live(
  "ships persisted service logs to Analytics, catching up after it wakes from idle",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const client = yield* HttpClient.HttpClient;
        // A short idle timer lets the test observe Analytics sleeping while services keep logging.
        const { owner, state, stackId, idOf, awaitAnalytics, wakeAnalytics, keepAwake } =
          yield* startStack(
            "owner-logs",
            [
              database,
              { service: "rest", config: {}, endpoints: { http: { port: "auto" } } },
              analytics,
            ],
            3_000,
          );
        const [databaseId, restId] = yield* Effect.all([idOf("database"), idOf("rest")]);
        const { databaseUrl, internalDatabaseUrl } = yield* owner.rpc.credentials({
          id: databaseId,
          from: "host",
        });
        const rest = yield* owner.rpc.credentials({ id: restId, from: "host" });
        if (databaseUrl === undefined || internalDatabaseUrl === undefined)
          return yield* Effect.die("database credentials are missing");
        if (rest.url === undefined) return yield* Effect.die("the REST URL is missing");

        const raise = (marker: string) =>
          query(databaseUrl, `DO $$ BEGIN RAISE LOG '${marker}'; END $$`);
        const stored = (source: string, filter: string) =>
          Effect.gen(function* () {
            const table = yield* eventsTable(internalDatabaseUrl, source);
            if (table === undefined) return [];
            return yield* query<StoredEvent>(
              internalDatabaseUrl,
              `SELECT body->>'event_message' AS message, body->'metadata'->'parsed'->>'error_severity' AS severity, body->'metadata'->>'host' AS host, to_char(timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp FROM ${table} WHERE ${filter}`,
            );
          });
        // Logflare ingests asynchronously and exposes no completion signal; polling is the guard.
        const awaitStored = (source: string, filter: string) =>
          stored(source, filter).pipe(
            Effect.filterOrFail((rows) => rows.length > 0),
            Effect.retry(Schedule.spaced("500 millis")),
            Effect.timeout("120 seconds"),
          );

        yield* wakeAnalytics;
        const keeper = yield* Effect.forkScoped(keepAwake);
        const awakeMarker = `${stackId}-awake`;
        yield* raise(awakeMarker);
        expect(
          yield* awaitStored(
            "postgres.logs",
            `body->>'event_message' LIKE '%LOG:  ${awakeMarker}'`,
          ),
        ).toEqual([
          {
            message: expect.stringContaining(`LOG:  ${awakeMarker}`),
            severity: "LOG",
            host: "db-default",
            timestamp: expect.any(String),
          },
        ]);
        // The cursor passes a body only once shipping read its events back from Analytics' tables.
        const awakeRecord = Option.getOrUndefined(
          yield* owner.rpc.readLogs({ id: databaseId, follow: false }).pipe(
            Stream.filter((record) => record.text?.includes(`LOG:  ${awakeMarker}`) === true),
            Stream.runHead,
          ),
        );
        const passedAwake = ({ generation, byteOffset }: typeof Confirmed.Type) =>
          awakeRecord?.position !== undefined &&
          (generation > awakeRecord.position.generation ||
            (generation === awakeRecord.position.generation &&
              byteOffset >= awakeRecord.position.byteOffset));
        const confirmed = yield* fs
          .readFileString(path.join(state.logsRoot(stackId), "database", databaseId, "cursor.json"))
          .pipe(
            Effect.flatMap(decodeConfirmed),
            Effect.filterOrFail(passedAwake),
            Effect.retry(Schedule.spaced("250 millis")),
            Effect.timeout("60 seconds"),
          );
        expect(passedAwake(confirmed)).toBe(true);
        const restPath = `/${stackId}-probe`;
        yield* client.get(`${rest.url}${restPath}`);
        expect(
          yield* awaitStored("postgREST.logs.prod", `body->'metadata'->>'path' = '${restPath}'`),
        ).toEqual([
          {
            message: expect.stringContaining(`"GET ${restPath} HTTP/1.1" 404`),
            severity: null,
            host: "default",
            timestamp: expect.any(String),
          },
        ]);

        yield* Fiber.interrupt(keeper);
        const noise = yield* Effect.forkScoped(
          raise(`${stackId}-noise`).pipe(Effect.repeat(Schedule.spaced("250 millis"))),
        );
        yield* awaitAnalytics(
          ({ lifecycle, wakeEnabled }) => lifecycle === "stopped" && wakeEnabled,
        ).pipe(Effect.timeout("90 seconds"));
        yield* Fiber.interrupt(noise);
        const asleepMarker = `${stackId}-asleep`;
        const persistedAsleep = yield* owner.rpc.readLogs({ id: databaseId, follow: true }).pipe(
          Stream.filter((record) => record.text?.includes(`LOG:  ${asleepMarker}`) === true),
          Stream.runHead,
          Effect.forkScoped,
        );
        const raisedAt = DateTime.toEpochMillis(yield* DateTime.now);
        yield* raise(asleepMarker);
        const asleepRecord = Option.getOrUndefined(yield* Fiber.join(persistedAsleep));
        const wakeRequestedAt = DateTime.toEpochMillis(yield* DateTime.now);

        yield* wakeAnalytics;
        yield* Effect.forkScoped(keepAwake);
        const [shippedAsleep] = yield* awaitStored(
          "postgres.logs",
          `body->>'event_message' LIKE '%LOG:  ${asleepMarker}'`,
        );
        expect(shippedAsleep?.timestamp).toBe(asleepRecord?.timestamp);
        // The owner stamps a line with host time on arrival, possibly in the millisecond it is read.
        const shippedAt = Date.parse(shippedAsleep?.timestamp ?? "");
        expect(shippedAt).toBeGreaterThanOrEqual(raisedAt);
        expect(shippedAt).toBeLessThanOrEqual(wakeRequestedAt);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 600_000 },
);

it.live(
  "Logflare accepts a batch holding an already stored id and then stores none of its events",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const client = yield* HttpClient.HttpClient;
        const { owner, idOf, analyticsUrl, wakeAnalytics, keepAwake } = yield* startStack(
          "owner-logflare",
          [database, analytics],
        );
        const { internalDatabaseUrl } = yield* owner.rpc.credentials({
          id: yield* idOf("database"),
          from: "host",
        });
        if (internalDatabaseUrl === undefined)
          return yield* Effect.die("database credentials are missing");
        // No composed service ships to this source, so only this test's posts reach its batches.
        const source = logflareSources.realtime;
        const event = Effect.fnUntraced(function* (message: string) {
          const id = yield* crypto.randomUUIDv4;
          const timestamp = DateTime.formatIso(yield* DateTime.now);
          return { id, ...logflareEvent("realtime", timestamp, message) };
        });
        const post = (events: ReadonlyArray<{ readonly id: string }>) =>
          client
            .execute(
              HttpClientRequest.post(`${analyticsUrl}/api/logs`).pipe(
                HttpClientRequest.setUrlParam("source_name", source),
                HttpClientRequest.setHeader("x-api-key", "owner-logs-key"),
                HttpClientRequest.bodyText(JSON.stringify({ batch: events }), "application/json"),
              ),
            )
            .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        const storedIds = (ids: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const table = yield* eventsTable(internalDatabaseUrl, source);
            if (table === undefined) return [];
            const rows = yield* query<{ readonly id: string }>(
              internalDatabaseUrl,
              `SELECT id::text AS id FROM ${table} WHERE id IN (${ids.map((id) => `'${id}'`).join(", ")})`,
            );
            return rows.map(({ id }) => id);
          });
        // Logflare ingests asynchronously and exposes no completion signal; polling is the guard.
        const awaitStored = (id: string, attempts: number) =>
          storedIds([id]).pipe(
            Effect.filterOrFail((rows) => rows.length > 0),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: attempts }),
          );

        yield* wakeAnalytics;
        yield* Effect.forkScoped(keepAwake);
        const first = yield* event("stored first");
        yield* post([first]);
        yield* awaitStored(first.id, 240);
        const added = [yield* event("added 1"), yield* event("added 2")];
        yield* post([{ ...first, event_message: "stored again" }, ...added]);
        // A stored sentinel shows Logflare processed the batch before it; a sentinel inserted with
        // that batch is dropped too, so fresh ones follow until one is stored.
        yield* event("sentinel").pipe(
          Effect.tap((sentinel) => post([sentinel])),
          Effect.flatMap(({ id }) => awaitStored(id, 10)),
          Effect.retry({ times: 24 }),
        );

        expect(yield* storedIds([first.id, ...added.map(({ id }) => id)])).toEqual([first.id]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 600_000 },
);
