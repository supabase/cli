import { expect } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Option, Redacted, Schema, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import { HttpClient, HttpClientRequest } from "effect/http";
import { SignJWT } from "jose";
import {
  jsonRequest,
  requestWithHeaders,
  service,
  sql,
  waitForLifecycle,
  wholeStack,
  type Runtime,
  type WholeStack,
} from "./fixture.ts";
import { subscribeRealtime } from "./websocket.ts";
import { killWorkload } from "./workloads.ts";

class IdleProbeError extends Schema.TaggedError<IdleProbeError>()("IdleProbeError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

// At least 5s, so a service can't idle out between back-to-back requests on a slow runner.
const idleMillis = 5_000;

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
              ? { id: member.id, activation: "lazy" as const, idleMillis }
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
          expect(insert.status, insert.body).toBe(201);
          yield* Fiber.join(firstChange);
          const rest = service(fixture, "rest");
          yield* waitForLifecycle(rest, "stopped");
          expect((yield* rest.status).wakeEnabled).toBe(true);
          const authHealth = yield* requestWithHeaders(`${authUrl}/health`, {});
          expect(authHealth.status, authHealth.body).toBe(200);
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
          expect(wake.status, wake.body).toBe(200);
          expect((yield* rest.status).lifecycle).toBe("running");
          const marker = `${fixture.stack.id}-change`;
          const changed = yield* jsonRequest(
            "POST",
            `${restUrl}/idle_items`,
            { id: marker, value: "wake" },
            { ...headers, "content-type": "application/json", prefer: "return=minimal" },
          );
          expect(changed.status, changed.body).toBe(201);
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
          expect(wake.status, wake.body).toBe(200);
          const marker = `${fixture.stack.id}-reconnect`;
          const changed = yield* jsonRequest(
            "POST",
            `${restUrl}/idle_items`,
            { id: marker, value: "reconnect" },
            { ...headers, "content-type": "application/json", prefer: "return=minimal" },
          );
          expect(changed.status, changed.body).toBe(201);
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

/** Only the given member carries a short idle timeout; the rest of the composition stays lazy but untimed. */
const configureSoleTimedMember = (fixture: WholeStack, timedId: string) =>
  Effect.gen(function* () {
    const database = service(fixture, "database");
    const configuration = yield* fixture.stack.composition.describe;
    yield* fixture.stack.composition.configure({
      ...configuration,
      members: configuration.members.map((member) =>
        member.id === database.id
          ? { id: member.id, activation: "eager" as const }
          : member.id === timedId
            ? { id: member.id, activation: "lazy" as const, idleMillis }
            : { id: member.id, activation: "lazy" as const },
      ),
    });
  });

/** A restart through the public API must preserve activation intent: the member still idle-sleeps
 * afterwards and wakes again on the next request (regression for Service.restart disarming wake). */
export const restartIdleWake = (runtime: Runtime) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* wholeStack(runtime);
      const rest = service(fixture, "rest");
      yield* configureSoleTimedMember(fixture, rest.id);
      yield* fixture.stack.composition.start;

      const token = yield* signServiceToken(fixture.secret);
      const restUrl = (yield* rest.credentials()).url;
      if (restUrl === undefined) return yield* Effect.die("Rest URL missing");
      const headers = { authorization: `Bearer ${token}`, apikey: token };

      const warm = yield* requestWithHeaders(restUrl, headers);
      expect(warm.status, warm.body).toBe(200);
      expect((yield* rest.status).lifecycle).toBe("running");

      yield* rest.restart();
      expect((yield* rest.status).wakeEnabled).toBe(true);

      yield* waitForLifecycle(rest, "stopped");
      expect((yield* rest.status).wakeEnabled).toBe(true);

      const rewarm = yield* requestWithHeaders(restUrl, headers);
      expect(rewarm.status, rewarm.body).toBe(200);
      expect((yield* rest.status).lifecycle).toBe("running");

      yield* killWorkload(runtime, fixture, rest.id);
      const crashed = yield* rest.followStatus.pipe(
        Stream.filter((status) => status.lifecycle === "stopped"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(crashed.exit !== undefined && Exit.isFailure(crashed.exit)).toBe(true);
      expect(crashed.wakeEnabled).toBe(true);

      const rewake = yield* requestWithHeaders(restUrl, headers);
      expect(rewake.status, rewake.body).toBe(200);
      expect((yield* rest.status).lifecycle).toBe("running");
    }),
  );

/** Functions must idle-sleep and wake like every other lazy service (no exemption). */
export const functionsIdleWake = (runtime: Runtime) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* wholeStack(runtime);
      const functionsInstance = service(fixture, "functions");
      // The default composition policy (not a test override) must give functions the same idle
      // timeout as its peers instead of exempting it.
      const defaultConfiguration = yield* fixture.stack.composition.describe;
      const defaultMember = defaultConfiguration.members.find(
        (member) => member.id === functionsInstance.id,
      );
      expect(defaultMember?.activation).toBe("lazy");
      expect(defaultMember?.idleMillis).toBe(60_000);
      yield* configureSoleTimedMember(fixture, functionsInstance.id);
      yield* fixture.stack.composition.start;
      yield* sql(
        fixture,
        "create table if not exists public.whole_stack_items (id text primary key, value text); grant select, insert on public.whole_stack_items to anon, authenticated, service_role;",
      );

      const token = yield* signServiceToken(fixture.secret);
      const functionsUrl = (yield* functionsInstance.credentials()).url;
      if (functionsUrl === undefined) return yield* Effect.die("Functions URL missing");
      const headers = {
        authorization: `Bearer ${token}`,
        apikey: token,
        "content-type": "application/json",
      };

      const invoke = yield* jsonRequest(
        "POST",
        `${functionsUrl}/hello`,
        { id: "functions-idle-probe" },
        headers,
      );
      expect(invoke.status, invoke.body).toBe(200);
      expect((yield* functionsInstance.status).lifecycle).toBe("running");

      yield* waitForLifecycle(functionsInstance, "stopped");
      expect((yield* functionsInstance.status).wakeEnabled).toBe(true);

      const rewake = yield* jsonRequest(
        "POST",
        `${functionsUrl}/hello`,
        { id: "functions-idle-probe" },
        headers,
      );
      expect(rewake.status, rewake.body).toBe(200);
      expect((yield* functionsInstance.status).lifecycle).toBe("running");
    }),
  );
