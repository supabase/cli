import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Path, Redacted } from "effect";
import {
  compileServiceInstance,
  compileServiceRestart,
  compileStack,
  seedServiceRegistry,
} from "./Compiler.ts";
import { createExecutionPlan } from "./ExecutionPlan.ts";
import { emptyServiceRegistry, registerServiceInstance } from "./ServiceRegistry.ts";
import { AUTH_JWT_SECRET_SLOT, resolveSecrets } from "../state/SecretStore.ts";

const layer = NodeServices.layer;
const context = (
  runtime:
    | { readonly kind: "native" }
    | { readonly kind: "container"; readonly engine: "docker" | "podman" },
) =>
  Effect.gen(function* () {
    return { projectRoot: "/tmp/supabase-project", path: yield* Path.Path, runtime };
  });

describe("service instance compiler", () => {
  it.live("allocates independent IDs and instance-scoped secret slots", () =>
    Effect.gen(function* () {
      const runtime = { kind: "native" } as const;
      const first = yield* compileServiceInstance(
        {
          service: "database",
          name: "first",
          config: { password: Redacted.make("first-password"), settings: {} },
        },
        yield* context(runtime),
      );
      const second = yield* compileServiceInstance(
        {
          service: "database",
          name: "second",
          config: { password: Redacted.make("second-password"), settings: {} },
        },
        yield* context(runtime),
      );

      expect(first.id).not.toBe(second.id);
      expect(first.secretSlots.map(({ slot }) => slot)).toEqual([`secret:${first.id}:password`]);
      expect(second.secretSlots.map(({ slot }) => slot)).toEqual([`secret:${second.id}:password`]);
    }).pipe(Effect.provide(layer)),
  );

  it.live("resolves equal creation profiles independently of instance identity", () =>
    Effect.gen(function* () {
      const runtime = { kind: "native" } as const;
      const initialization = {
        catalog: { auth: { settings: { jwt_secret: Redacted.make("same-secret") } } },
      };
      const first = yield* compileServiceInstance(
        { service: "database", config: { settings: {} }, initialization },
        yield* context(runtime),
      );
      const second = yield* compileServiceInstance(
        { service: "database", config: { settings: {} }, initialization },
        yield* context(runtime),
      );
      const changed = yield* compileServiceInstance(
        {
          service: "database",
          config: {
            settings: {},
          },
          initialization: {
            catalog: { auth: { settings: { jwt_secret: Redacted.make("changed-secret") } } },
          },
        },
        yield* context(runtime),
      );

      expect(first.initializationInputs?.profileId).toBe(second.initializationInputs?.profileId);
      expect(first.initializationInputs?.profileId).not.toBe(
        changed.initializationInputs?.profileId,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.live("retains omitted restart inputs and applies explicit replacements", () =>
    Effect.gen(function* () {
      const runtime = { kind: "native" } as const;
      const first = yield* compileServiceInstance(
        {
          service: "database",
          config: {
            password: Redacted.make("old-password"),
            endpoints: { sql: { port: 5432 } },
            settings: {},
          },
        },
        yield* context(runtime),
      );
      const retained = yield* compileServiceRestart(
        first,
        { settings: {} },
        yield* context(runtime),
      );
      const replaced = yield* compileServiceRestart(
        first,
        {
          password: Redacted.make("new-password"),
          endpoints: { sql: { port: 6543 } },
          settings: {},
        },
        yield* context(runtime),
      );

      expect(retained.id).toBe(first.id);
      if (retained.instance.service !== "database") throw new Error("restart changed service kind");
      if (retained.instance.config.endpoints.sql?.enabled === false)
        throw new Error("retained endpoint became disabled");
      expect(retained.instance.config.endpoints.sql?.port).toBe(5432);
      expect(retained.passwordSecretRef).toBe(first.passwordSecretRef);
      if (replaced.instance.service !== "database") throw new Error("restart changed service kind");
      if (replaced.instance.config.endpoints.sql?.enabled === false)
        throw new Error("replaced endpoint became disabled");
      expect(replaced.instance.config.endpoints.sql?.port).toBe(6543);
      expect(replaced.passwordSecretRef).toBe(`secret:${first.id}:password`);
      expect(replaced.secretSlots[0]?.slot).toBe(`secret:${first.id}:password`);
    }).pipe(Effect.provide(layer)),
  );

  it.live("generates one database password for seeded and dynamic instances", () =>
    Effect.gen(function* () {
      const runtime = { kind: "native" } as const;
      const contextValue = yield* context(runtime);
      const dynamic = yield* compileServiceInstance(
        { service: "database", config: { settings: {} } },
        contextValue,
      );
      const dynamicSlot = `secret:${dynamic.id}:password`;
      expect(dynamic.passwordSecretRef).toBe(dynamicSlot);
      expect(dynamic.secretSlots).toEqual([
        {
          slot: dynamicSlot,
          policy: "managed",
          generator: { kind: "random-base64url", bytes: 32 },
        },
      ]);
      const resolvedDynamic = yield* resolveSecrets(
        { declarations: dynamic.secretSlots },
        undefined,
        "unconfigured",
      );
      const restarted = yield* compileServiceRestart(dynamic, { settings: {} }, contextValue);
      const resolvedRestart = yield* resolveSecrets(
        { declarations: restarted.secretSlots },
        resolvedDynamic.persisted,
        "stopped",
      );
      expect(resolvedRestart.persisted[dynamicSlot]?.value).toBe(
        resolvedDynamic.persisted[dynamicSlot]?.value,
      );

      const compiled = yield* compileStack({
        projectRoot: "/tmp/supabase-project",
        runtime,
        config: {},
      });
      const path = yield* Path.Path;
      const seeded = yield* seedServiceRegistry(
        compiled.definition,
        { projectRoot: "/tmp/supabase-project", path, runtime },
        compiled.sourceConfig,
        compiled.secrets,
      );
      const database = seeded.registry.instances.find((entry) => entry.service === "database");
      if (database === undefined) throw new Error("missing seeded database");
      const seededSlot = `secret:${database.id}:password`;
      expect(database.config.passwordSecretRef).toBe(seededSlot);
      expect(seeded.secretSlots.some(({ slot }) => slot === seededSlot)).toBe(true);
      const resolvedSeed = yield* resolveSecrets(
        { declarations: seeded.secretSlots },
        undefined,
        "unconfigured",
      );
      expect(resolvedSeed.persisted[seededSlot]?.value).toBeTypeOf("string");
      const seededRestart = yield* compileServiceRestart(database, { settings: {} }, contextValue);
      const resolvedSeedRestart = yield* resolveSecrets(
        { declarations: seededRestart.secretSlots },
        resolvedSeed.persisted,
        "stopped",
      );
      expect(resolvedSeedRestart.persisted[seededSlot]?.value).toBe(
        resolvedSeed.persisted[seededSlot]?.value,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.live("declares generated Realtime catalog secrets when the service itself is disabled", () =>
    Effect.gen(function* () {
      const compiled = yield* compileServiceInstance(
        {
          service: "database",
          config: { settings: {} },
          initialization: { catalog: { realtime: {} } },
        },
        yield* context({ kind: "native" }),
      );
      const realtimeSlots = compiled.secretSlots.filter(
        (slot) => slot.slot.endsWith(".db_enc_key") || slot.slot.endsWith(".secret_key_base"),
      );
      expect(realtimeSlots).toHaveLength(2);
      expect(realtimeSlots.every((slot) => slot.generator?.kind === "random-base64url")).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.live("seeds defaults once and plans two database instances plus independent functions", () =>
    Effect.gen(function* () {
      const runtime = { kind: "native" } as const;
      const path = yield* Path.Path;
      const sourceConfig = {
        capabilities: {
          database: { enabled: false },
          functions: {
            enabled: true,
            settings: { edge_runtime: { secrets: { FOO: Redacted.make("bar") } } },
          },
        },
        listeners: { database: { port: 5432 } },
      };
      const compiled = yield* compileStack({
        projectRoot: "/tmp/supabase-project",
        runtime,
        config: sourceConfig,
      });
      const seeded = yield* seedServiceRegistry(
        compiled.definition,
        { projectRoot: "/tmp/supabase-project", path, runtime },
        compiled.sourceConfig,
        compiled.secrets,
      );
      const database = seeded.registry.instances.find(
        (instance) => instance.service === "database",
      );
      const functions = seeded.registry.instances.find(
        (instance) => instance.service === "functions",
      );
      if (database === undefined || functions === undefined)
        throw new Error("missing seeded instances");
      const first = yield* compileServiceInstance(
        { service: "database", config: { settings: {} } },
        yield* context(runtime),
      );
      const second = yield* compileServiceInstance(
        { service: "database", config: { settings: {} } },
        yield* context(runtime),
      );
      const withFirst = yield* registerServiceInstance(seeded.registry, first.instance);
      const withBoth = yield* registerServiceInstance(withFirst, second.instance);
      const plan = yield* createExecutionPlan(runtime, withBoth);

      expect(database.config.enabled).toBe(false);
      expect(functions.config.enabled).toBe(true);
      if (functions.service !== "functions") throw new Error("wrong functions instance");
      const functionSecret = functions.config.settings.edge_runtime?.secrets?.FOO;
      if (functionSecret === undefined || typeof functionSecret !== "object")
        throw new Error("missing configured functions secret");
      expect(functionSecret.slot.startsWith(`secret:${functions.id}.`)).toBe(true);
      expect(seeded.secretSlots.some(({ slot }) => slot === AUTH_JWT_SECRET_SLOT)).toBe(true);
      expect(plan.workloads.filter(({ instanceId }) => instanceId === first.id)).toHaveLength(1);
      expect(plan.workloads.filter(({ instanceId }) => instanceId === second.id)).toHaveLength(1);
      expect(plan.workloads.some(({ instanceId }) => instanceId === functions.id)).toBe(true);
      expect(plan.workloads.some(({ instanceId }) => instanceId === database.id)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.live("allows selected planning around unrelated disabled dependencies", () =>
    Effect.gen(function* () {
      const runtime = { kind: "native" } as const;
      const database = yield* compileServiceInstance(
        { service: "database", config: { enabled: false, settings: {} } },
        yield* context(runtime),
      );
      const functions = yield* compileServiceInstance(
        { service: "functions", config: { settings: {} } },
        yield* context(runtime),
      );
      const registry = yield* registerServiceInstance(
        yield* registerServiceInstance(emptyServiceRegistry(), database.instance),
        functions.instance,
      );
      const plan = yield* createExecutionPlan(
        runtime,
        registry,
        undefined,
        new Set([functions.id]),
      );
      expect(plan.workloads.every(({ instanceId }) => instanceId === functions.id)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
