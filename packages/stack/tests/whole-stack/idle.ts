import { expect } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SignJWT } from "jose";
import {
  jsonRequest,
  requestWithHeaders,
  service,
  sql,
  waitForLifecycle,
  wholeStack,
  type Runtime,
} from "./fixture.ts";
import { subscribeRealtime } from "./websocket.ts";

class IdleProbeError extends Schema.TaggedError<IdleProbeError>()("IdleProbeError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

const signServiceToken = Effect.fn("WholeStack.signServiceToken")((secret: string) =>
  Effect.tryPromise({
    try: () =>
      new SignJWT({ role: "service_role" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode(secret)),
    catch: (cause) => new IdleProbeError({ message: String(cause), cause }),
  }),
);

export const idleWake = (runtime: Runtime) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* wholeStack(runtime);
      const configuration = yield* fixture.stack.composition.describe;
      const database = service(fixture, "database");
      const timedServices = new Set([
        service(fixture, "rest").id,
        service(fixture, "realtime").id,
        service(fixture, "pooler").id,
      ]);
      yield* fixture.stack.composition.configure({
        ...configuration,
        members: configuration.members.map((member) =>
          member.id === database.id
            ? { id: member.id, activation: "eager" as const }
            : timedServices.has(member.id)
              ? { id: member.id, activation: "lazy" as const, idleMillis: 15_000 }
              : { id: member.id, activation: "lazy" as const },
        ),
      });
      yield* fixture.stack.composition.start;
      yield* sql(
        fixture,
        "create table if not exists public.idle_items (id text primary key, value text not null); alter table public.idle_items enable row level security; grant select, insert on public.idle_items to anon, authenticated, service_role; alter publication supabase_realtime add table public.idle_items;",
      );

      const token = yield* signServiceToken(fixture.secret);
      const restUrl = (yield* service(fixture, "rest").credentials()).url;
      const authUrl = (yield* service(fixture, "auth").credentials()).url;
      const realtimeUrl = (yield* service(fixture, "realtime").credentials()).url;
      const poolerCredentials = yield* service(fixture, "pooler").credentials();
      const poolerUrl = poolerCredentials.sqlUrl;
      if (
        restUrl === undefined ||
        authUrl === undefined ||
        realtimeUrl === undefined ||
        poolerUrl === undefined
      )
        return yield* Effect.die("Idle scenario credentials are incomplete");
      const headers = { authorization: `Bearer ${token}`, apikey: token };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const realtime = yield* subscribeRealtime(realtimeUrl, token, "idle_items", "INSERT");
          const poolerAddress = new URL(poolerUrl);
          const poolerLayer = yield* Layer.build(
            PgClient.layer({
              host: poolerAddress.hostname,
              port: Number(poolerAddress.port),
              database: "postgres",
              username: "supabase_admin.whole",
              password: Redacted.make("postgres"),
              connectTimeout: "60 seconds",
            }),
          );
          const pooler = Context.get(poolerLayer, PgClient.PgClient);
          const poolerConnection = yield* pooler.reserve;
          yield* poolerConnection.executeRaw("SELECT 1", []);

          const client = yield* HttpClient.HttpClient;
          const keepAlive = yield* client.execute(
            HttpClientRequest.get(restUrl).pipe(
              HttpClientRequest.setHeader("connection", "keep-alive"),
            ),
          );
          yield* keepAlive.text;
          const firstChange = yield* realtime.nextChange.pipe(Effect.forkScoped);
          const insert = yield* jsonRequest(
            "POST",
            `${restUrl}/idle_items`,
            { id: fixture.stack.id, value: "awake" },
            { ...headers, "content-type": "application/json", prefer: "return=minimal" },
          );
          expect(insert.status).toBe(201);
          yield* Fiber.join(firstChange);
          const rest = service(fixture, "rest");
          yield* waitForLifecycle(rest, "stopped");
          expect((yield* rest.status).wakeEnabled).toBe(true);
          const authHealth = yield* requestWithHeaders(`${authUrl}/health`, {});
          expect(authHealth.status).toBe(200);
          expect((yield* rest.status).lifecycle).toBe("stopped");
          expect((yield* database.status).lifecycle).toBe("running");
          expect((yield* service(fixture, "realtime").status).lifecycle).toBe("running");
          expect((yield* service(fixture, "pooler").status).lifecycle).toBe("running");
          yield* poolerConnection.executeRaw("SELECT 1", []);

          const nextChange = yield* realtime.nextChange.pipe(Effect.forkScoped);
          const wake = yield* requestWithHeaders(
            `${restUrl}/idle_items?id=eq.${fixture.stack.id}`,
            headers,
          );
          expect(wake.status).toBe(200);
          expect((yield* rest.status).lifecycle).toBe("running");
          const marker = `${fixture.stack.id}-change`;
          const changed = yield* jsonRequest(
            "POST",
            `${restUrl}/idle_items`,
            { id: marker, value: "wake" },
            { ...headers, "content-type": "application/json", prefer: "return=minimal" },
          );
          expect(changed.status).toBe(201);
          const change = yield* Fiber.join(nextChange);
          const changeRow = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ record: Schema.Struct({ id: Schema.String, value: Schema.String }) }),
          )(change.payload.data);
          expect(changeRow.record).toEqual({ id: marker, value: "wake" });
          yield* waitForLifecycle(rest, "stopped");
          expect((yield* rest.status).wakeEnabled).toBe(true);
        }),
      );
      yield* waitForLifecycle(service(fixture, "realtime"), "stopped");
      yield* waitForLifecycle(service(fixture, "pooler"), "stopped");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const realtime = yield* subscribeRealtime(realtimeUrl, token, "idle_items", "INSERT");
          const poolerAddress = new URL(poolerUrl);
          const poolerLayer = yield* Layer.build(
            PgClient.layer({
              host: poolerAddress.hostname,
              port: Number(poolerAddress.port),
              database: "postgres",
              username: "supabase_admin.whole",
              password: Redacted.make("postgres"),
              connectTimeout: "60 seconds",
            }),
          );
          const pooler = Context.get(poolerLayer, PgClient.PgClient);
          const poolerConnection = yield* pooler.reserve;
          yield* poolerConnection.executeRaw("SELECT 1", []);
          const nextChange = yield* realtime.nextChange.pipe(Effect.forkScoped);
          const wake = yield* requestWithHeaders(
            `${restUrl}/idle_items?id=eq.${fixture.stack.id}`,
            headers,
          );
          expect(wake.status).toBe(200);
          const marker = `${fixture.stack.id}-reconnect`;
          const changed = yield* jsonRequest(
            "POST",
            `${restUrl}/idle_items`,
            { id: marker, value: "reconnect" },
            { ...headers, "content-type": "application/json", prefer: "return=minimal" },
          );
          expect(changed.status).toBe(201);
          const change = yield* Fiber.join(nextChange);
          const changeRow = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ record: Schema.Struct({ id: Schema.String, value: Schema.String }) }),
          )(change.payload.data);
          expect(changeRow.record).toEqual({ id: marker, value: "reconnect" });
        }),
      );
      yield* waitForLifecycle(service(fixture, "realtime"), "stopped");
      yield* waitForLifecycle(service(fixture, "pooler"), "stopped");
    }),
  );
