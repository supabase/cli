import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Path, Schema } from "effect";
import { compileStack, createExecutionPlan, seedServiceRegistry } from "../model/Compiler.ts";
import type { ExecutionPlan, PlannedWorkload } from "../model/ExecutionPlan.ts";
import { catalogEntryFor } from "../model/WorkloadCatalog.ts";
import { PersistedStackStateSchema, type PersistedStackState } from "../state/StackState.ts";
import { isRecord, settingValue } from "../state/MaterializedSettings.ts";
import type { StackConfig } from "../public/Config.ts";
import { resolveSecrets } from "../state/SecretStore.ts";
import {
  containerResolutionFor,
  privateBindingIntentsFor,
  resolveContainerResolutionFor,
  runtimeSpecFor,
} from "./WorkloadRuntimeSpec.ts";

const makeFixture = (
  runtime: PersistedStackState["runtime"] = { kind: "container", engine: "docker" },
  config?: StackConfig,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const compiled = yield* compileStack({ projectRoot: "/tmp/workload-runtime", runtime, config });
    const seeded = yield* seedServiceRegistry(
      compiled.definition,
      { projectRoot: "/tmp/workload-runtime", path, runtime },
      compiled.sourceConfig,
      compiled.secrets,
    );
    const resolved = yield* resolveSecrets(
      { declarations: seeded.secretSlots },
      undefined,
      "stopped",
    );
    const database = seeded.registry.instances.find((entry) => entry.service === "database");
    if (database === undefined) return yield* Effect.die("database fixture missing");
    const databaseWithPassword = {
      ...database,
      config: { ...database.config, passwordSecretRef: "secret:database.password" },
    };
    const registry = {
      ...seeded.registry,
      instances: seeded.registry.instances.map((entry) =>
        entry.id === database.id ? databaseWithPassword : entry,
      ),
    };
    const base = {
      format: "supabase-stack-state-v2" as const,
      identity: {
        projectRoot: "/tmp/workload-runtime",
        branchContext: "test",
        stackName: "workload-runtime",
      },
      runtime,
      preparation: "on-demand" as const,
      security: {
        jwt: {
          issuer: null,
          expirySeconds: 3600,
          signing: {
            kind: "symmetric" as const,
            secret: { slot: "secret:auth.settings.jwt_secret" },
          },
        },
      },
      listeners: {},
      registry,
      ports: [],
      privatePorts: [],
      secrets: {
        ...resolved.persisted,
        "secret:database.password": { policy: "managed", value: "database-secret" },
      },
    } satisfies PersistedStackState;
    const plan = yield* createExecutionPlan(runtime, registry);
    const intents = privateBindingIntentsFor(plan, base);
    const state: PersistedStackState = {
      ...base,
      privatePorts: intents.map((intent, index) => ({ ...intent, port: 30_000 + index })),
    };
    return { state, plan };
  }).pipe(Effect.provide(NodeServices.layer));

const workloadFor = (plan: ExecutionPlan, recipeId: string): PlannedWorkload => {
  const workload = plan.workloads.find((entry) => entry.recipeId === recipeId);
  if (workload === undefined) throw new Error(`Missing workload ${recipeId}`);
  return workload;
};

describe("workload runtime", () => {
  it.live("assigns private bindings to their physical instance and workload IDs", () =>
    Effect.gen(function* () {
      const { state, plan } = yield* makeFixture();
      const database = workloadFor(plan, "database:database");
      const assignment = state.privatePorts.find(
        (entry) => entry.workloadId === database.id && entry.binding === "sql:internal",
      );
      expect(assignment).toMatchObject({
        instanceId: database.instanceId,
        workloadId: database.id,
      });
      expect(
        new Set(
          state.privatePorts.map(
            (entry) => `${entry.instanceId}:${entry.workloadId}:${entry.binding}`,
          ),
        ).size,
      ).toBe(state.privatePorts.length);
    }),
  );

  it.live("resolves a container alias and publications for one physical workload", () =>
    Effect.gen(function* () {
      const { state, plan } = yield* makeFixture();
      const workload = workloadFor(plan, "rest:rest");
      const resolution = yield* resolveContainerResolutionFor(state, workload);
      const catalog = catalogEntryFor(workload.recipeId);
      expect(catalog).toBeDefined();
      expect(resolution?.networkAliases).toEqual([
        `${catalog?.containerAlias}-${workload.instanceId}`,
      ]);
      expect(resolution?.publications.every((entry) => entry.address === "127.0.0.1")).toBe(true);
      expect(resolution?.publications.length).toBeGreaterThan(0);
    }),
  );

  it.live("keeps runtime environment resolution tied to the selected recipe", () =>
    Effect.gen(function* () {
      const { state, plan } = yield* makeFixture({ kind: "native" });
      const workload = workloadFor(plan, "rest:rest");
      const spec = runtimeSpecFor(workload);
      if (spec === undefined) return yield* Effect.die("REST runtime spec missing");
      const port = state.privatePorts.find(
        (entry) => entry.instanceId === workload.instanceId && entry.workloadId === workload.id,
      )?.port;
      if (port === undefined) return yield* Effect.die("REST private port missing");
      expect(spec.env(state, workload, port).PGRST_DB_SCHEMAS).toContain("public");
      expect(containerResolutionFor(state, workload)?.networkAliases[0]).toContain(
        workload.instanceId,
      );
    }),
  );

  it.live("provides Functions with the managed database endpoint for each runtime", () =>
    Effect.gen(function* () {
      for (const runtime of [
        { kind: "native" },
        { kind: "container", engine: "docker" },
      ] as const) {
        const { state, plan } = yield* makeFixture(runtime);
        const workload = workloadFor(plan, "functions:edge-runtime");
        const spec = runtimeSpecFor(workload);
        if (spec === undefined) return yield* Effect.die("Functions runtime spec missing");
        const port = state.privatePorts.find(
          (entry) => entry.instanceId === workload.instanceId && entry.workloadId === workload.id,
        )?.port;
        if (port === undefined) return yield* Effect.die("Functions private port missing");
        const database = state.registry.instances.find((entry) => entry.service === "database");
        if (database === undefined) return yield* Effect.die("database fixture missing");
        const publicDatabasePort = 31_000;
        const stateWithDatabaseListener = {
          ...state,
          ports: [
            {
              owner: "instance" as const,
              instanceId: database.id,
              binding: "sql",
              address: "127.0.0.1",
              port: publicDatabasePort,
              intent: "automatic" as const,
            },
          ],
        };
        const environment = spec.env(
          stateWithDatabaseListener,
          workload,
          port,
          runtime.kind,
          runtime.kind === "container" ? { hostRoute: { host: "host-gateway" } } : {},
        );
        const databaseHost = runtime.kind === "native" ? "127.0.0.1" : "host-gateway";
        const expectedPort = publicDatabasePort;
        expect(environment.SUPABASE_DB_URL).toBe(
          `postgresql://supabase_admin:database-secret@${databaseHost}:${expectedPort}/postgres`,
        );
        expect(
          spec.env(
            state,
            workload,
            port,
            runtime.kind,
            runtime.kind === "container" ? { hostRoute: { host: "host-gateway" } } : {},
          ).SUPABASE_DB_URL,
        ).toBeUndefined();
      }
    }),
  );

  it.live("gives Studio the designated default Functions management root", () =>
    Effect.gen(function* () {
      const { state, plan } = yield* makeFixture({ kind: "native" });
      const workload = workloadFor(plan, "studio:studio");
      const analytics = workloadFor(plan, "analytics:analytics");
      const spec = runtimeSpecFor(workload);
      if (spec === undefined) return yield* Effect.die("Studio runtime spec missing");
      const port = state.privatePorts.find(
        (entry) => entry.instanceId === workload.instanceId && entry.workloadId === workload.id,
      )?.port;
      if (port === undefined) return yield* Effect.die("Studio private port missing");
      const functions = state.registry.instances.find((entry) => entry.service === "functions");
      if (functions === undefined || !isRecord(functions.config.settings))
        return yield* Effect.die("Functions fixture missing");
      const expectedRoot = settingValue(state, functions.config.settings.functions_root);
      expect(expectedRoot.length).toBeGreaterThan(0);
      const stateWithAnalyticsPort = {
        ...state,
        privatePorts: [
          ...state.privatePorts,
          {
            instanceId: analytics.instanceId,
            workloadId: analytics.id,
            binding: "primary",
            port: 32_000,
          },
        ],
      };
      expect(
        spec.env(stateWithAnalyticsPort, workload, port).EDGE_FUNCTIONS_MANAGEMENT_FOLDER,
      ).toBe(expectedRoot);
      const disabledFunctionsState = yield* Schema.decodeUnknownEffect(PersistedStackStateSchema)({
        ...stateWithAnalyticsPort,
        registry: {
          ...stateWithAnalyticsPort.registry,
          instances: stateWithAnalyticsPort.registry.instances.map((entry) =>
            entry.id === functions.id
              ? { ...entry, config: { ...entry.config, enabled: false } }
              : entry,
          ),
        },
      });
      expect(
        spec.env(disabledFunctionsState, workload, port).EDGE_FUNCTIONS_MANAGEMENT_FOLDER,
      ).toBeUndefined();
    }),
  );

  it.live("preserves Functions global defaults when rendering per-function bootstrap config", () =>
    Effect.gen(function* () {
      const { state, plan } = yield* makeFixture(
        { kind: "native" },
        {
          capabilities: {
            functions: {
              settings: {
                edge_runtime: {
                  verify_jwt_default: false,
                  import_map_default: "shared-deno.json",
                },
                functions: {
                  hello: { enabled: true },
                  explicit: { enabled: true, verify_jwt: true, import_map: "custom-deno.json" },
                },
              },
            },
          },
        },
      );
      const workload = workloadFor(plan, "functions:edge-runtime");
      const spec = runtimeSpecFor(workload);
      if (spec === undefined) return yield* Effect.die("Functions runtime spec missing");
      const port = state.privatePorts.find(
        (entry) => entry.instanceId === workload.instanceId && entry.workloadId === workload.id,
      )?.port;
      if (port === undefined) return yield* Effect.die("Functions private port missing");
      const config = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Record(
            Schema.String,
            Schema.Struct({
              enabled: Schema.optionalKey(Schema.Boolean),
              verifyJWT: Schema.optionalKey(Schema.Boolean),
              importMapRoot: Schema.optionalKey(Schema.String),
              importMapPath: Schema.optionalKey(Schema.String),
            }),
          ),
        ),
      )(spec.env(state, workload, port).SUPABASE_INTERNAL_FUNCTIONS_CONFIG);
      expect(config).toMatchObject({
        $default: { verifyJWT: false, importMapRoot: "shared-deno.json" },
        hello: { enabled: true },
        explicit: { enabled: true, verifyJWT: true, importMapPath: "custom-deno.json" },
      });
      expect(config.hello?.verifyJWT).toBeUndefined();
      expect(config.hello?.importMapPath).toBeUndefined();
    }),
  );

  it.live("preserves host function paths for the mirrored container root", () =>
    Effect.gen(function* () {
      const { state, plan } = yield* makeFixture(
        { kind: "container", engine: "docker" },
        {
          capabilities: {
            functions: {
              settings: {
                functions: {
                  hello: {
                    enabled: true,
                    entrypoint: "/tmp/workload-runtime/supabase/functions/hello/index.ts",
                    import_map: "/tmp/workload-runtime/supabase/functions/shared/deno.json",
                    static_files: ["/tmp/workload-runtime/supabase/functions/hello/public/*.txt"],
                  },
                },
              },
            },
          },
        },
      );
      const workload = workloadFor(plan, "functions:edge-runtime");
      const spec = runtimeSpecFor(workload);
      if (spec === undefined) return yield* Effect.die("Functions runtime spec missing");
      const port = state.privatePorts.find(
        (entry) => entry.instanceId === workload.instanceId && entry.workloadId === workload.id,
      )?.port;
      if (port === undefined) return yield* Effect.die("Functions private port missing");
      const encoded = spec.env(
        state,
        workload,
        port,
        "container",
      ).SUPABASE_INTERNAL_FUNCTIONS_CONFIG;
      const config = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Record(
            Schema.String,
            Schema.Struct({
              entrypointPath: Schema.optionalKey(Schema.String),
              importMapPath: Schema.optionalKey(Schema.String),
              staticFiles: Schema.optionalKey(Schema.Array(Schema.String)),
            }),
          ),
        ),
      )(encoded);
      expect(config.hello).toEqual({
        entrypointPath: "/tmp/workload-runtime/supabase/functions/hello/index.ts",
        importMapPath: "/tmp/workload-runtime/supabase/functions/shared/deno.json",
        staticFiles: ["/tmp/workload-runtime/supabase/functions/hello/public/*.txt"],
      });
    }),
  );
});
