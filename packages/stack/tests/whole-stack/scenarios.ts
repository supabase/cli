import { expect } from "@effect/vitest";
import { Cause, Effect, FileSystem, Ref, Schema } from "effect";
import { open } from "../../src/effect.ts";
import {
  allMembers,
  clearStackOwner,
  jsonRequest,
  requestWithHeaders,
  refreshLogTails,
  sql,
  serviceNames,
  setActivation,
  service,
  setStackOwner,
  statusByService,
  wholeStack,
  type Runtime,
  type WholeStack,
} from "./fixture.ts";
import {
  assertStoredImage,
  assertStoredMarker,
  exerciseMetadataAndPooler,
  exerciseStorageAndFunctions,
} from "./service-flows.ts";
import { exerciseAnalytics, queryAnalyticsMarker } from "./analytics.ts";
import { subscribeRealtime } from "./websocket.ts";
import { watchRecoveryMail } from "./realtime-mail.ts";
import { assertWorkloadsGone, captureWorkloads } from "./workloads.ts";

const withFixture = <A, E, R>(
  runtime: Runtime,
  use: (fixture: WholeStack) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* wholeStack(runtime);
      return yield* use(fixture);
    }),
  );

const assertDefaultPolicy = (fixture: WholeStack) =>
  Effect.gen(function* () {
    const members = yield* allMembers(fixture.stack);
    const byId = new Map(members.map((member) => [member.id, member]));
    for (const name of serviceNames) {
      const member = byId.get(service(fixture, name).id);
      expect(member).toBeDefined();
      if (member === undefined) continue;
      if (name === "database") {
        expect(member.activation).toBe("eager");
        expect(member.idleMillis).toBeUndefined();
      } else if (name === "functions") {
        expect(member.activation).toBe("lazy");
        expect(member.idleMillis).toBeUndefined();
      } else {
        expect(member.activation).toBe("lazy");
        expect(member.idleMillis).toBe(60_000);
      }
    }
  });

const assertPersistedPolicy = (fixture: WholeStack) =>
  Effect.gen(function* () {
    const members = yield* allMembers(fixture.stack);
    const byId = new Map(members.map((member) => [member.id, member]));
    for (const name of serviceNames) {
      const member = byId.get(service(fixture, name).id);
      expect(member).toBeDefined();
      if (member === undefined) continue;
      expect(member.idleMillis).toBeUndefined();
      expect(member.activation).toBe(name === "database" ? "eager" : "lazy");
    }
  });

const assertLifecycle = (fixture: WholeStack, lifecycle: "running" | "stopped") =>
  Effect.gen(function* () {
    const statuses = yield* statusByService(fixture);
    for (const name of serviceNames) {
      const status = statuses.find(([candidate]) => candidate === name)?.[1];
      expect(status?.lifecycle).toBe(lifecycle);
      if (lifecycle === "running") expect(status?.health).toBe("healthy");
    }
  });

const assertColdStart = (fixture: WholeStack) =>
  Effect.gen(function* () {
    const statuses = yield* statusByService(fixture);
    const database = statuses.find(([name]) => name === "database")?.[1];
    expect(database?.lifecycle).toBe("running");
    expect(database?.health).toBe("healthy");
    for (const name of serviceNames.filter((candidate) => candidate !== "database")) {
      const status = statuses.find(([candidate]) => candidate === name)?.[1];
      expect(status?.lifecycle).toBe("stopped");
      expect(status?.wakeEnabled).toBe(true);
    }
  });

const prepareSchema = Effect.fn("WholeStack.prepareSchema")((fixture: WholeStack) =>
  sql(
    fixture,
    "create table if not exists public.whole_stack_items (id text primary key, owner_id uuid not null, value text not null); alter table public.whole_stack_items enable row level security; grant select, insert, update on public.whole_stack_items to authenticated; drop policy if exists whole_stack_owner on public.whole_stack_items; create policy whole_stack_owner on public.whole_stack_items using (auth.uid() = owner_id) with check (auth.uid() = owner_id); do $$ begin alter publication supabase_realtime add table public.whole_stack_items; exception when duplicate_object then null; end $$;",
  ),
);

const clearIdleTimers = Effect.fn("WholeStack.clearIdleTimers")((fixture: WholeStack) =>
  Effect.gen(function* () {
    const configuration = yield* fixture.stack.composition.describe;
    yield* fixture.stack.composition.configure({
      ...configuration,
      members: configuration.members.map((member) => ({
        id: member.id,
        activation: member.activation,
      })),
    });
  }),
);

const assertOwnedPathsGone = Effect.fn("WholeStack.assertOwnedPathsGone")((fixture: WholeStack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataRoot = `${fixture.locations.stateRoot}/${fixture.stack.id}/data`;
    const databasePath = `${dataRoot}/${service(fixture, "database").id}`;
    const functionsPath = `${dataRoot}/${service(fixture, "functions").id}/runtime/functions`;
    const statePath = `${fixture.locations.stateRoot}/${fixture.stack.id}/state.json`;
    expect(yield* fs.exists(databasePath)).toBe(false);
    expect(yield* fs.exists(functionsPath)).toBe(false);
    expect(yield* fs.exists(statePath)).toBe(false);
    expect(yield* fs.exists(`${fixture.locations.stateRoot}/${fixture.stack.id}`)).toBe(false);
  }),
);

const assertOwnedPathsPresent = Effect.fn("WholeStack.assertOwnedPathsPresent")(
  (fixture: WholeStack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataRoot = `${fixture.locations.stateRoot}/${fixture.stack.id}/data`;
      const databasePath = `${dataRoot}/${service(fixture, "database").id}`;
      const functionsPath = `${dataRoot}/${service(fixture, "functions").id}/runtime/functions`;
      expect(yield* fs.exists(databasePath)).toBe(true);
      expect(yield* fs.exists(functionsPath)).toBe(true);
    }),
);

const stopWithDiagnostics = Effect.fn("WholeStack.stopWithDiagnostics")((fixture: WholeStack) =>
  fixture.stack.stop.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const statuses = yield* statusByService(fixture).pipe(
          Effect.catchCause(() => Effect.succeed([])),
        );
        const logs = yield* Ref.get(fixture.logTails);
        const serviceIds = serviceNames
          .map((name) => `${name}=${service(fixture, name).id}`)
          .join(",");
        yield* Effect.logError(
          `Whole-stack stop diagnostics: cause=${Cause.pretty(cause)} serviceIds=${serviceIds} statuses=${statuses
            .map(([name, status]) => `${name}=${status.lifecycle}`)
            .join(",")} logs=${logs.map(([name, value]) => `${name}: ${value}`).join("\n")}`,
        );
        return yield* Effect.failCause(cause);
      }),
    ),
  ),
);

const exerciseStack = Effect.fn("WholeStack.exerciseStack")(
  (fixture: WholeStack, phase: string, resourceKey?: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* prepareSchema(fixture);
        const authUrl = (yield* service(fixture, "auth").credentials()).url;
        const restUrl = (yield* service(fixture, "rest").credentials()).url;
        if (authUrl === undefined || restUrl === undefined)
          return yield* Effect.die("Auth/REST URL missing");
        const email = `whole-${phase}-${fixture.stack.id}@example.test`;
        const password = "whole-stack-password";
        const signup = yield* jsonRequest("POST", `${authUrl}/signup`, { email, password });
        expect(signup.status).toBe(200);
        const signupBody = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            access_token: Schema.String,
            user: Schema.Struct({ id: Schema.String }),
          }),
        )(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(signup.body));
        const login = yield* jsonRequest("POST", `${authUrl}/token?grant_type=password`, {
          email,
          password,
        });
        const loginBody = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String }),
        )(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(login.body));
        const headers = {
          authorization: `Bearer ${loginBody.access_token}`,
          apikey: loginBody.access_token,
          "content-type": "application/json",
        };
        const rowId = resourceKey ?? `${fixture.stack.id}-${phase}`;
        const insert = yield* jsonRequest(
          "POST",
          `${restUrl}/whole_stack_items`,
          { id: rowId, owner_id: signupBody.user.id, value: phase },
          { ...headers, prefer: "return=representation" },
        );
        expect(insert.status).toBe(201);
        const read = yield* requestWithHeaders(
          `${restUrl}/whole_stack_items?id=eq.${rowId}`,
          headers,
        );
        expect(read.status).toBe(200);
        const rows = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.String })),
          ),
        )(read.body);
        expect(rows).toEqual([{ id: rowId, value: phase }]);
        const secondEmail = `whole-other-${phase}-${fixture.stack.id}@example.test`;
        const secondSignup = yield* jsonRequest("POST", `${authUrl}/signup`, {
          email: secondEmail,
          password,
        });
        expect(secondSignup.status).toBe(200);
        const secondSignupBody = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String }),
        )(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(secondSignup.body));
        const otherRead = yield* requestWithHeaders(`${restUrl}/whole_stack_items?id=eq.${rowId}`, {
          authorization: `Bearer ${secondSignupBody.access_token}`,
          apikey: secondSignupBody.access_token,
        });
        expect(otherRead.status).toBe(200);
        expect(
          yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String }))),
          )(otherRead.body),
        ).toEqual([]);
        yield* exerciseStorageAndFunctions(
          fixture,
          signupBody.access_token,
          rowId,
          phase,
          resourceKey ?? phase,
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const mailUrl = (yield* service(fixture, "mail").credentials()).url;
            const realtimeUrl = (yield* service(fixture, "realtime").credentials()).url;
            if (mailUrl === undefined || realtimeUrl === undefined)
              return yield* Effect.die("Mail or Realtime URL missing");
            const watcher = yield* watchRecoveryMail(mailUrl, email);
            const recovery = yield* jsonRequest("POST", `${authUrl}/recover`, { email });
            expect(recovery.status).toBe(200);
            const mail = yield* watcher.awaitFullMail;
            expect(mail.To.map((recipient) => recipient.Address)).toContain(email);
            const authOrigin = new URL(authUrl).origin;
            const mailBody = `${mail.Text ?? ""}\n${mail.HTML ?? ""}`;
            expect(mailBody).toContain(authOrigin);
            expect(mailBody).toContain("/verify?token=");
            const realtime = yield* subscribeRealtime(
              realtimeUrl,
              loginBody.access_token,
              "whole_stack_items",
              "UPDATE",
            );
            yield* exerciseMetadataAndPooler(fixture, loginBody.access_token, rowId, phase);
            const poolerChange = yield* realtime.nextChange;
            const poolerEvent = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ record: Schema.Struct({ id: Schema.String, value: Schema.String }) }),
            )(poolerChange.payload.data);
            expect(poolerEvent.record).toEqual({ id: rowId, value: `${phase}-pooler` });
            const update = yield* jsonRequest(
              "PATCH",
              `${restUrl}/whole_stack_items?id=eq.${rowId}`,
              { value: `${phase}-realtime` },
              { ...headers, prefer: "return=representation" },
            );
            expect(update.status).toBe(200);
            const change = yield* realtime.nextChange;
            const event = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ record: Schema.Struct({ id: Schema.String, value: Schema.String }) }),
            )(change.payload.data);
            expect(event.record).toEqual({ id: rowId, value: `${phase}-realtime` });
          }),
        );
        const analyticsUrl = (yield* service(fixture, "analytics").credentials()).url;
        const vectorUrl = (yield* service(fixture, "vector").credentials()).url;
        if (analyticsUrl === undefined || vectorUrl === undefined)
          return yield* Effect.die("Analytics or Vector URL missing");
        yield* exerciseAnalytics(analyticsUrl, vectorUrl, fixture.secret, fixture.stack.id, phase);
        yield* assertLifecycle(fixture, "running");
        return {
          accessToken: loginBody.access_token,
          rowId,
          value: `${phase}-realtime`,
          credentials: yield* Effect.forEach(serviceNames, (name) =>
            service(fixture, name).credentials(),
          ),
        };
      }),
    ),
);

export const defaultLifecycle = (runtime: Runtime) =>
  withFixture(runtime, (fixture) =>
    Effect.gen(function* () {
      yield* assertDefaultPolicy(fixture);
      yield* clearIdleTimers(fixture);
      yield* fixture.stack.composition.start;
      yield* assertColdStart(fixture);
      yield* prepareSchema(fixture);
      const coldWorkloads = yield* captureWorkloads(runtime, fixture);
      expect(coldWorkloads.identities.length).toBeGreaterThan(0);
      const databaseMarker = service(fixture, "database").id;
      for (const identity of coldWorkloads.identities)
        expect(
          runtime === "native"
            ? identity.includes(`supabase-workload-id=${databaseMarker}`)
            : identity.endsWith(databaseMarker),
        ).toBe(true);
      const before = yield* exerciseStack(fixture, "default");
      const workloads = yield* captureWorkloads(runtime, fixture);
      yield* stopWithDiagnostics(fixture);
      yield* assertWorkloadsGone(runtime, fixture, workloads);
      const reopenedStack = yield* open({ ...fixture.locations, id: fixture.stack.id });
      yield* setStackOwner(fixture, reopenedStack);
      const reopened = {
        ...fixture,
        stack: reopenedStack,
        services: yield* reopenedStack.services.list,
      };
      yield* refreshLogTails(reopened);
      yield* assertPersistedPolicy(reopened);
      yield* clearIdleTimers(reopened);
      yield* reopened.stack.composition.start;
      yield* assertColdStart(reopened);
      const reopenedColdWorkloads = yield* captureWorkloads(runtime, reopened);
      expect(reopenedColdWorkloads.identities.length).toBeGreaterThan(0);
      for (const identity of reopenedColdWorkloads.identities)
        expect(
          runtime === "native"
            ? identity.includes(`supabase-workload-id=${databaseMarker}`)
            : identity.endsWith(databaseMarker),
        ).toBe(true);
      expect(
        yield* sql(
          reopened,
          `select id from public.whole_stack_items where id = '${fixture.stack.id}-default'`,
        ),
      ).toBe(`${fixture.stack.id}-default`);
      yield* assertStoredImage(reopened, "default");
      const after = yield* exerciseStack(reopened, "reopened");
      expect(after.credentials).toEqual(before.credentials);
      yield* assertOwnedPathsPresent(reopened);
      yield* reopened.stack.destroy;
      yield* clearStackOwner(reopened);
      yield* assertOwnedPathsGone(reopened);
    }),
  );

export const allEager = (runtime: Runtime) =>
  withFixture(runtime, (fixture) =>
    Effect.gen(function* () {
      const preStartWorkloads = yield* captureWorkloads(runtime, fixture);
      expect(preStartWorkloads.identities).toEqual([]);
      yield* fixture.stack.composition.start;
      yield* prepareSchema(fixture);
      const stoppedWorkloads = yield* captureWorkloads(runtime, fixture);
      yield* fixture.stack.composition.stop;
      yield* assertWorkloadsGone(runtime, fixture, stoppedWorkloads);
      yield* setActivation(fixture.stack, "eager");
      yield* fixture.stack.composition.start;
      yield* assertLifecycle(fixture, "running");
      const eagerWorkloads = yield* captureWorkloads(runtime, fixture);
      expect(eagerWorkloads.identities.length).toBeGreaterThanOrEqual(serviceNames.length);
      yield* exerciseStack(fixture, "eager");
      const finalWorkloads = yield* captureWorkloads(runtime, fixture);
      yield* fixture.stack.composition.stop;
      yield* assertLifecycle(fixture, "stopped");
      yield* assertWorkloadsGone(runtime, fixture, finalWorkloads);
      yield* assertOwnedPathsPresent(fixture);
      yield* fixture.stack.destroy;
      yield* clearStackOwner(fixture);
      yield* assertOwnedPathsGone(fixture);
    }),
  );

export const parallel = (runtime: Runtime) =>
  Effect.scoped(
    Effect.gen(function* () {
      const left = yield* wholeStack(runtime);
      const right = yield* wholeStack(runtime);
      yield* Effect.all([assertDefaultPolicy(left), assertDefaultPolicy(right)], {
        concurrency: "unbounded",
      });
      yield* Effect.all([clearIdleTimers(left), clearIdleTimers(right)], {
        concurrency: "unbounded",
      });
      yield* Effect.all([left.stack.composition.start, right.stack.composition.start], {
        concurrency: "unbounded",
      });
      expect(left.stack.id).not.toBe(right.stack.id);
      const [leftLedger, rightLedger] = yield* Effect.all(
        [
          exerciseStack(left, "parallel-left", "parallel-shared"),
          exerciseStack(right, "parallel-right", "parallel-shared"),
        ],
        { concurrency: "unbounded" },
      );
      expect(leftLedger.rowId).toBe("parallel-shared");
      expect(rightLedger.rowId).toBe(leftLedger.rowId);
      expect(leftLedger.value).not.toBe(rightLedger.value);
      expect(
        yield* sql(left, "select value from public.whole_stack_items where id = 'parallel-shared'"),
      ).toBe(leftLedger.value);
      expect(
        yield* sql(
          right,
          "select value from public.whole_stack_items where id = 'parallel-shared'",
        ),
      ).toBe(rightLedger.value);
      const leftEndpoints = leftLedger.credentials.flatMap((credentials) =>
        credentials.url === undefined ? [] : [credentials.url],
      );
      const rightEndpoints = rightLedger.credentials.flatMap((credentials) =>
        credentials.url === undefined ? [] : [credentials.url],
      );
      expect(new Set(leftEndpoints).size).toBe(leftEndpoints.length);
      expect(new Set(rightEndpoints).size).toBe(rightEndpoints.length);
      expect(new Set([...leftEndpoints, ...rightEndpoints]).size).toBe(
        leftEndpoints.length + rightEndpoints.length,
      );
      const leftAnalyticsUrl = (yield* service(left, "analytics").credentials()).url;
      const rightAnalyticsUrl = (yield* service(right, "analytics").credentials()).url;
      if (leftAnalyticsUrl === undefined || rightAnalyticsUrl === undefined)
        return yield* Effect.die("Parallel Analytics URL missing");
      expect(
        (yield* queryAnalyticsMarker(leftAnalyticsUrl, left.secret, `vector-${right.stack.id}`, 0))
          .length,
      ).toBe(0);
      expect(
        (yield* queryAnalyticsMarker(rightAnalyticsUrl, right.secret, `vector-${left.stack.id}`, 0))
          .length,
      ).toBe(0);
      const rightRest = service(right, "rest");
      const rightRestUrl = (yield* rightRest.credentials()).url;
      const rightRealtimeUrl = (yield* service(right, "realtime").credentials()).url;
      if (rightRestUrl === undefined || rightRealtimeUrl === undefined)
        return yield* Effect.die("Parallel REST or Realtime URL missing");
      const crossStack = yield* requestWithHeaders(`${rightRestUrl}/whole_stack_items`, {
        authorization: `Bearer ${leftLedger.accessToken}`,
        apikey: leftLedger.accessToken,
      });
      expect(crossStack.status).toBe(401);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const rightRealtime = yield* subscribeRealtime(
            rightRealtimeUrl,
            rightLedger.accessToken,
            "whole_stack_items",
            "UPDATE",
          );
          yield* stopWithDiagnostics(left);
          const reopenedLeft = yield* open({ ...left.locations, id: left.stack.id });
          yield* setStackOwner(left, reopenedLeft);
          const reopenedLeftFixture = {
            ...left,
            stack: reopenedLeft,
            services: yield* reopenedLeft.services.list,
          };
          yield* refreshLogTails(reopenedLeftFixture);
          yield* clearIdleTimers(reopenedLeftFixture);
          yield* reopenedLeft.composition.start;
          expect(
            yield* sql(
              reopenedLeftFixture,
              `select id from public.whole_stack_items where id = 'parallel-shared'`,
            ),
          ).toBe("parallel-shared");
          yield* assertStoredImage(reopenedLeftFixture, "parallel-shared");
          const reopenedLedger = yield* exerciseStack(
            reopenedLeftFixture,
            "parallel-left-reopened",
          );
          expect(reopenedLedger.credentials).toEqual(leftLedger.credentials);
          const reopenedWorkloads = yield* captureWorkloads(runtime, reopenedLeftFixture);
          yield* assertOwnedPathsPresent(reopenedLeftFixture);
          yield* reopenedLeft.destroy;
          yield* clearStackOwner(left);
          yield* assertWorkloadsGone(runtime, reopenedLeftFixture, reopenedWorkloads, true);
          yield* assertOwnedPathsGone(reopenedLeftFixture);
          expect((yield* rightRest.status).lifecycle).toBe("running");
          yield* assertStoredMarker(right, "parallel-shared");
          const update = yield* jsonRequest(
            "PATCH",
            `${rightRestUrl}/whole_stack_items?id=eq.${rightLedger.rowId}`,
            { value: "parallel-right-survived" },
            {
              authorization: `Bearer ${rightLedger.accessToken}`,
              apikey: rightLedger.accessToken,
              prefer: "return=representation",
            },
          );
          expect(update.status).toBe(200);
          const change = yield* rightRealtime.nextChange;
          const event = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ record: Schema.Struct({ id: Schema.String, value: Schema.String }) }),
          )(change.payload.data);
          expect(event.record).toEqual({
            id: rightLedger.rowId,
            value: "parallel-right-survived",
          });
        }),
      );
      yield* exerciseStack(right, "parallel-right-after");
    }),
  );
