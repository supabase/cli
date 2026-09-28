import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Redacted, Ref, Scope, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "../Orchestrator.ts";
import { makeService, ServiceError } from "../Service.ts";
import type { ServiceCreation } from "../services/Catalog.ts";
import { makeSupabaseComposition, type SupabaseCompositionOperations } from "./Supabase.ts";

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
      { id, config: {}, coordinate: orchestrator.admissionFor(id) },
    );
    const instance: Orchestrator.RegisteredInstance = {
      id,
      core,
      startAt: (revision, inputs, wake, guard) => core.startAt(revision, inputs, wake, guard),
      restart: (revision, inputs, config, guard) => core.restart(inputs, revision, guard),
      bind: Effect.void,
      close: Effect.void,
      hasEndpoint: options.hasEndpoint ?? true,
      inputs: options.inputs ?? [],
      outputs: options.outputs ?? {},
    };
    yield* orchestrator.register(instance);
    return instance;
  });

/** Merges optional config bindings onto a creation; the config union can't express this generically. */
const withValues = <C extends ServiceCreation>(
  creation: C,
  values: Record<string, string | undefined>,
): C => ({ ...creation, config: { ...creation.config, ...values } }) as C;

const stopped = (instance: Orchestrator.RegisteredInstance) =>
  instance.core.observation.pipe(
    Stream.filter((state) => state.lifecycle === "stopped" && state.currentOperation === undefined),
    Stream.take(1),
    Stream.runDrain,
  );

it.live(
  "keeps a studio member's pgmeta prerequisite awake past 60s, and sleeps both after studio idles",
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
        yield* makeSupabaseComposition(operations, inputs);
        const configuration = yield* Ref.get(captured);
        if (configuration === undefined) return yield* Effect.die("Composition was not configured");

        const studioId = idFor("studio");
        const pgmetaId = idFor("pgmeta");
        // pgmeta must be a declared prerequisite of studio for the dependent-blocks-sleep rule below to apply.
        expect(
          configuration.dependencies.some(
            (dependency) => dependency.from === pgmetaId && dependency.to === studioId,
          ),
        ).toBe(true);

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
        const studio = yield* makeInstance(orchestrator, studioId, {
          inputs: ["databaseUrl", "pgmetaUrl", "analyticsUrl", "functionsUrl"],
        });
        yield* orchestrator.configure(configuration);
        yield* orchestrator.startComposition;

        const requestScope = yield* Scope.make();
        yield* orchestrator.acquire(studioId).pipe(Scope.provide(requestScope));
        yield* TestClock.adjust("1 second");
        expect((yield* database.core.get).lifecycle).toBe("running");
        expect((yield* pgmeta.core.get).lifecycle).toBe("running");
        expect((yield* studio.core.get).lifecycle).toBe("running");

        // The request finished; studio itself now idles on its own 5-minute timer.
        yield* Scope.close(requestScope, Exit.void);

        // Well past pgmeta's own 60s idle mark but within studio's 5-minute window: studio
        // isn't idle yet, so the dependent-blocks-sleep rule keeps pgmeta running too.
        yield* TestClock.adjust("90 seconds");
        expect((yield* studio.core.get).lifecycle).toBe("running");
        expect((yield* pgmeta.core.get).lifecycle).toBe("running");

        const studioStopped = yield* stopped(studio).pipe(Effect.forkChild);
        const pgmetaStopped = yield* stopped(pgmeta).pipe(Effect.forkChild);
        yield* TestClock.adjust("5 minutes");
        yield* Fiber.join(studioStopped);
        yield* Fiber.join(pgmetaStopped);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);
