import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Redacted, Ref, Scope, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "../Orchestrator.ts";
import { makeService, ServiceError } from "../Service.ts";
import type { SavedStack } from "../StackNamespace.ts";
import type { ServiceCreation } from "../services/Catalog.ts";
import {
  makeSupabaseComposition,
  planEndpointReplan,
  type SupabaseCompositionOperations,
} from "./Supabase.ts";

/** A registered instance with no runtime behavior beyond an immediate healthy start and stop. */
const makeInstance = (
  orchestrator: Orchestrator.Interface,
  id: string,
  options: {
    readonly inputs?: ReadonlyArray<string>;
    readonly outputs?: Readonly<Record<string, Effect.Effect<string, ServiceError>>>;
    readonly hasEndpoint?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const core = yield* makeService<Record<string, string>>(
      {
        launch: () =>
          Effect.gen(function* () {
            const exited = yield* Deferred.make<Exit.Exit<void, ServiceError>>();
            return {
              health: Effect.void,
              exit: Deferred.await(exited),
              stop: Deferred.succeed(exited, Exit.void).pipe(Effect.asVoid),
              remove: Effect.void,
            };
          }),
        removeData: () => Effect.void,
      },
      { id, config: {}, report: orchestrator.report },
    );
    yield* orchestrator.register({
      id,
      service: id,
      core,
      launch: (generation, inputs) => core.launch(generation, inputs),
      prepare: () => Effect.void,
      bind: Effect.void,
      close: Effect.void,
      confirmRemoved: Effect.void,
      release: Effect.void,
      releasePorts: Effect.void,
      hasEndpoint: options.hasEndpoint ?? true,
      inputs: options.inputs ?? [],
      outputs: options.outputs ?? {},
    });
    return { status: orchestrator.status(id), observation: orchestrator.changes(id) };
  });

/** Merges optional config bindings onto a creation; the config union can't express this generically. */
const withValues = <C extends ServiceCreation>(
  creation: C,
  values: Record<string, string | undefined>,
): C => ({ ...creation, config: { ...creation.config, ...values } }) as C;

const stopped = (instance: Effect.Success<ReturnType<typeof makeInstance>>) =>
  instance.observation.pipe(
    Stream.filter((state) => state.lifecycle === "stopped" && state.currentOperation === undefined),
    Stream.take(1),
    Stream.runDrain,
  );

it.live(
  "keeps Studio's pgmeta prerequisite awake without coupling its lifecycle to Functions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const idFor = (service: ServiceCreation["service"]) => `${service}-id`;
        const inputs: ReadonlyArray<ServiceCreation> = [
          {
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("studio-idle-password"),
              jwtSecret: Redacted.make("studio-idle-jwt-secret-with-32-chars"),
              jwtExpiry: 3600,
            },
            endpoints: { sql: { port: "auto" } },
          },
          {
            service: "auth",
            config: { jwtSecret: "studio-idle-jwt-secret-with-32-chars", jwtExpiry: 3600 },
            endpoints: { http: { port: "auto" } },
          },
          {
            service: "functions",
            config: { functionsRoot: "/project/supabase/functions" },
            endpoints: { http: { port: "auto" } },
          },
          { service: "studio", config: {}, endpoints: { http: { port: "auto" } } },
          { service: "pgmeta", config: {}, endpoints: { http: { port: "auto" } } },
        ];
        const baseById = new Map(inputs.map((creation) => [idFor(creation.service), creation]));
        const captured = yield* Ref.make<Orchestrator.CompositionConfig | undefined>(undefined);
        const operations: SupabaseCompositionOperations = {
          currentComposition: Effect.succeed({ members: [], dependencies: [] }),
          get: () => Effect.die("get is unused"),
          status: () => Effect.die("status is unused"),
          create: (creation) => Effect.succeed({ id: idFor(creation.service), creation }),
          destroy: () => Effect.die("destroy is unused"),
          bind: () => Effect.void,
          address: (id, endpoint, from) => Effect.succeed(`${from}://${id}/${endpoint}`),
          output: (id, name) => Effect.succeed(`${name}::${id}`),
          updateCreation: (id, values) => {
            const base = baseById.get(id);
            return base === undefined
              ? Effect.die(`Unknown instance ${id}`)
              : Effect.succeed({ id, creation: withValues(base, values) });
          },
          replaceCreation: () => Effect.die("replaceCreation is unused"),
          configure: (configuration) => Ref.set(captured, configuration),
        };
        const configured = yield* makeSupabaseComposition(operations, inputs);
        const configuration = yield* Ref.get(captured);
        if (configuration === undefined) return yield* Effect.die("Composition was not configured");

        const studioId = idFor("studio");
        const functionsId = idFor("functions");
        const pgmetaId = idFor("pgmeta");
        // pgmeta must be a declared prerequisite of studio for the dependent-blocks-sleep rule below to apply.
        expect(
          configuration.dependencies.some(
            (dependency) => dependency.from === pgmetaId && dependency.to === studioId,
          ),
        ).toBe(true);
        const configuredStudio = configured.find(({ creation }) => creation.service === "studio");
        if (configuredStudio?.creation.service !== "studio")
          return yield* Effect.die("Studio was not configured");
        expect(configuredStudio.creation.config.functionsUrl).toBe(`url::${functionsId}`);

        const orchestrator = yield* Orchestrator.make<Orchestrator.RegisteredInstance>();
        const database = yield* makeInstance(orchestrator, idFor("database"), {
          outputs: {
            authDatabaseUrl: Effect.succeed("postgres://auth"),
            databaseUrl: Effect.succeed("postgres://pgmeta"),
          },
        });
        yield* makeInstance(orchestrator, idFor("auth"), { inputs: ["databaseUrl"] });
        const pgmeta = yield* makeInstance(orchestrator, pgmetaId, {
          inputs: ["databaseUrl"],
          outputs: { url: Effect.succeed("http://pgmeta") },
        });
        yield* makeInstance(orchestrator, functionsId, {
          outputs: { url: Effect.succeed(`url::${functionsId}`) },
        });
        const studio = yield* makeInstance(orchestrator, studioId, {
          inputs: ["databaseUrl", "pgmetaUrl", "analyticsUrl", "functionsUrl"],
        });
        yield* orchestrator.configure(configuration);
        yield* orchestrator.startComposition;
        yield* orchestrator.restart(functionsId);
        yield* orchestrator.ready(functionsId);
        expect(yield* studio.status).toMatchObject({ lifecycle: "stopped", wakeEnabled: true });

        const requestScope = yield* Scope.make();
        yield* orchestrator.acquire(studioId).pipe(Scope.provide(requestScope));
        yield* TestClock.adjust("1 second");
        expect((yield* database.status).lifecycle).toBe("running");
        expect((yield* pgmeta.status).lifecycle).toBe("running");
        expect((yield* studio.status).lifecycle).toBe("running");
        yield* orchestrator.restart(functionsId);
        yield* orchestrator.ready(functionsId);
        expect((yield* studio.status).lifecycle).toBe("running");

        // The request finished; studio itself now idles on its own 5-minute timer.
        yield* Scope.close(requestScope, Exit.void);

        // Well past pgmeta's own 60s idle mark but within studio's 5-minute window: studio
        // isn't idle yet, so the dependent-blocks-sleep rule keeps pgmeta running too.
        yield* TestClock.adjust("90 seconds");
        expect((yield* studio.status).lifecycle).toBe("running");
        expect((yield* pgmeta.status).lifecycle).toBe("running");

        // One second before studio's 5-minute idle deadline, measured from the request.
        yield* TestClock.adjust("208 seconds");
        expect((yield* studio.status).lifecycle).toBe("running");
        expect((yield* pgmeta.status).lifecycle).toBe("running");

        const studioStopped = yield* stopped(studio).pipe(Effect.forkChild);
        const pgmetaStopped = yield* stopped(pgmeta).pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(studioStopped);
        expect((yield* pgmeta.status).lifecycle).toBe("running");

        // Once studio's stop is confirmed, pgmeta idles on its own timer.
        yield* TestClock.adjust("60 seconds");
        yield* Fiber.join(pgmetaStopped);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);

it("does not let an excluded sibling's stale fixed port mask a shared endpoint's own change", () => {
  const fixedPort = 54_321;
  const saved: Pick<SavedStack, "instances" | "composition"> = {
    instances: [
      {
        id: "rest-1",
        creation: { service: "rest", config: {}, endpoints: { http: { port: fixedPort } } },
      },
      {
        id: "auth-1",
        creation: { service: "auth", config: {}, endpoints: { http: { port: fixedPort } } },
      },
    ],
    composition: {
      members: [
        { id: "rest-1", activation: "eager" },
        { id: "auth-1", activation: "eager" },
      ],
      dependencies: [],
    },
  };
  // The config dropped [api] port and the start excludes auth, so only REST is requested.
  const requested: ReadonlyArray<ServiceCreation> = [
    { service: "rest", config: {}, endpoints: { http: { port: "auto" } } },
  ];
  const plan = planEndpointReplan(saved, requested);
  expect(plan?.changes).toEqual([
    {
      id: "rest-1",
      service: "rest",
      endpoint: "http",
      key: "api",
      previous: fixedPort,
    },
  ]);
});
