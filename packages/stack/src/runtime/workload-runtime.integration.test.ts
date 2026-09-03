import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Redacted, Schema } from "effect";
import { WORKLOAD_CATALOG } from "../model/WorkloadCatalog.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import { deriveStackId } from "../identity/Identity.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makePortCoordinator, type ListenerIntents } from "../state/PortCoordinator.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { CAPABILITY_NAMES } from "../public/Capability.ts";
import { compileStack } from "../model/Compiler.ts";
import {
  containerResolutionFor,
  FUNCTIONS_BOOTSTRAP_CONTAINER_PATH,
  FUNCTIONS_CONTAINER_ROOT,
  privateBindingIntentsFor,
  resolveContainerResolutionFor,
  runtimeSpecFor,
  validateWorkloadRuntimeInputs,
} from "./WorkloadRuntimeSpec.ts";

const disabledListenerIntents: ListenerIntents = {
  api: { enabled: false, address: "127.0.0.1", port: "automatic" },
  database: { enabled: false, address: "127.0.0.1", port: "automatic" },
  pooler: { enabled: false, address: "127.0.0.1", port: "automatic" },
  studio: { enabled: false, address: "127.0.0.1", port: "automatic" },
  mailUi: { enabled: false, address: "127.0.0.1", port: "automatic" },
  smtp: { enabled: false, address: "127.0.0.1", port: "automatic" },
  pop3: { enabled: false, address: "127.0.0.1", port: "automatic" },
  functionsInspector: { enabled: false, address: "127.0.0.1", port: "automatic" },
};

const state: PersistedStackState = {
  format: "supabase-stack-state-v1",
  identity: {
    stackId: "stack-runtime-spec-test",
    projectRoot: "/tmp/supabase-runtime-spec",
    checkoutRoot: "/tmp/supabase-runtime-spec",
    workspaceId: "/tmp/supabase-runtime-spec",
    checkoutId: ".",
    branchContext: "ordinary-workspace",
    localProjectKey: ".",
    stackName: "runtime-spec",
  },
  runtime: { kind: "native" },
  desiredLifecycle: "running",
  ports: [
    { field: "database", port: 55432, intent: "exact" },
    { field: "api", port: 54321, intent: "exact" },
  ],
  privatePorts: [
    { workloadId: "database:database", binding: "primary", port: 30_001 },
    { workloadId: "rest:rest", binding: "primary", port: 30_002 },
    { workloadId: "rest:rest", binding: "admin", port: 30_015 },
    { workloadId: "auth:auth", binding: "primary", port: 30_003 },
    { workloadId: "realtime:realtime", binding: "primary", port: 30_004 },
    { workloadId: "storage:storage", binding: "primary", port: 30_005 },
    { workloadId: "storage:imgproxy", binding: "primary", port: 30_006 },
    { workloadId: "functions:edge-runtime", binding: "primary", port: 30_007 },
    { workloadId: "studio:studio", binding: "primary", port: 30_008 },
    { workloadId: "studio:pgmeta", binding: "primary", port: 30_009 },
    { workloadId: "mail:mail", binding: "ui", port: 30_010 },
    { workloadId: "mail:mail", binding: "smtp", port: 30_011 },
    { workloadId: "mail:mail", binding: "pop3", port: 30_012 },
    { workloadId: "analytics:analytics", binding: "primary", port: 30_013 },
    { workloadId: "analytics:vector", binding: "primary", port: 30_014 },
    { workloadId: "pooler:pooler", binding: "primary", port: 30_016 },
    { workloadId: "pooler:pooler", binding: "admin", port: 30_017 },
  ],
  secrets: {
    "secret:database.internal.password": { policy: "managed", value: "postgres" },
    "secret:auth.settings.jwt_secret": { policy: "managed", value: "symmetric-secret" },
    "secret:auth.settings.publishable_key": {
      policy: "managed",
      value: "sb_publishable_test",
    },
    "secret:auth.settings.secret_key": { policy: "managed", value: "sb_secret_test" },
    "secret:realtime.settings.db_enc_key": { policy: "managed", value: "realtime-db-key" },
    "secret:realtime.settings.secret_key_base": {
      policy: "managed",
      value: "realtime-secret-base",
    },
  },
};

const planned = (id: string): PlannedWorkload => {
  const entry = WORKLOAD_CATALOG[id];
  if (entry === undefined) throw new Error(`Missing test catalog entry: ${id}`);
  const separator = id.indexOf(":");
  const capability = CAPABILITY_NAMES.find((name) => name === id.slice(0, separator));
  if (capability === undefined) throw new Error(`Missing test capability: ${id}`);
  return {
    id,
    capability,
    dependencies: [],
    readiness: {},
    artifacts: {
      native: { kind: "native", release: entry.nativeVersion },
      container: { kind: "container", image: entry.containerImage },
    },
    selected: { kind: "native", release: entry.nativeVersion },
  };
};

describe("workload runtime catalog", () => {
  it.live("consumes persisted runtime defaults without rebuilding them", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
      }).pipe(Effect.provide(NodeServices.layer));
      const configured: PersistedStackState = { ...state, definition: compiled.definition };
      const rest = planned("rest:rest");
      expect(runtimeSpecFor(rest)?.env(configured, rest, 3000)).toMatchObject({
        PGRST_DB_SCHEMAS: "public,graphql_public",
        PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions",
        PGRST_DB_MAX_ROWS: "1000",
      });
      const auth = planned("auth:auth");
      expect(runtimeSpecFor(auth)?.env(configured, auth, 3000)).toMatchObject({
        GOTRUE_SITE_URL: "http://127.0.0.1:3000",
        GOTRUE_JWT_EXP: "3600",
        GOTRUE_SMTP_ADMIN_EMAIL: "admin@email.com",
        GOTRUE_SMTP_SENDER_NAME: "Admin",
      });
      const storage = planned("storage:storage");
      expect(runtimeSpecFor(storage)?.env(configured, storage, 5000)).toMatchObject({
        FILE_SIZE_LIMIT: "52428800",
        ENABLE_IMAGE_TRANSFORMATION: "false",
        S3_PROTOCOL_ENABLED: "true",
        S3_PROTOCOL_ACCESS_KEY_ID: "625729a08b95bf1b7ff351a663f3a23c",
        STORAGE_S3_REGION: "local",
      });
      const realtime = planned("realtime:realtime");
      expect(runtimeSpecFor(realtime)?.env(configured, realtime, 4000)).toMatchObject({
        MAX_HEADER_LENGTH: "4096",
      });
      const functions = planned("functions:edge-runtime");
      expect(runtimeSpecFor(functions)?.env(configured, functions, 9000)).toMatchObject({
        SUPABASE_INTERNAL_FUNCTIONS_ROOT: `${state.identity.projectRoot}/supabase/functions`,
        EDGE_RUNTIME_POLICY: "per_worker",
        EDGE_RUNTIME_DENO_VERSION: "2",
      });
      expect(runtimeSpecFor(functions)?.args(configured, functions, 9000)).toContain(
        "--policy=per_worker",
      );

      const bigquery = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
        config: { capabilities: { analytics: { settings: { backend: "bigquery" } } } },
      }).pipe(Effect.provide(NodeServices.layer));
      const analytics = planned("analytics:analytics");
      expect(
        runtimeSpecFor(analytics)?.env(
          { ...state, definition: bigquery.definition },
          analytics,
          4000,
        ),
      ).toMatchObject({
        GOOGLE_PROJECT_ID: "local",
        GOOGLE_PROJECT_NUMBER: "0",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("derives one closed private binding intent for every planned workload binding", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
      }).pipe(Effect.provide(NodeServices.layer));
      const intents = privateBindingIntentsFor(compiled.executionPlan);
      expect(intents).toContainEqual({ workloadId: "database:database", binding: "primary" });
      expect(intents).toContainEqual({ workloadId: "mail:mail", binding: "ui" });
      expect(intents).toContainEqual({ workloadId: "mail:mail", binding: "smtp" });
      expect(intents).toContainEqual({ workloadId: "mail:mail", binding: "pop3" });
      expect(intents).toContainEqual({ workloadId: "rest:rest", binding: "admin" });
      expect(intents.filter(({ workloadId }) => workloadId === "mail:mail")).toHaveLength(3);
      expect(
        intents.every(({ binding }) =>
          ["primary", "admin", "ui", "smtp", "pop3"].includes(binding),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("compiles pgmeta's primary and admin ports before the Vector companion", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
        config: {
          capabilities: {
            analytics: { enabled: true, settings: { vector_port: 9001 } },
            studio: { enabled: true },
          },
        },
      }).pipe(Effect.provide(NodeServices.layer));
      const relevant = privateBindingIntentsFor(compiled.executionPlan).filter(
        ({ workloadId }) => workloadId === "studio:pgmeta" || workloadId === "analytics:vector",
      );
      expect(relevant).toEqual([
        { workloadId: "studio:pgmeta", binding: "primary" },
        { workloadId: "studio:pgmeta", binding: "admin" },
        { workloadId: "analytics:vector", binding: "primary" },
      ]);

      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-pgmeta-ports-" });
      const identity = {
        ...state.identity,
        projectRoot: root,
        checkoutRoot: root,
        workspaceId: root,
        checkoutId: root,
      };
      const stackId = yield* deriveStackId(identity);
      const store = yield* makeStackStateStore({ stateRoot: root });
      yield* store.initialize(stackId, {
        ...state,
        identity: { ...identity, stackId },
        desiredLifecycle: "stopped",
        ports: [],
        privatePorts: [],
      });
      const reservation = yield* makePortCoordinator({
        stateRoot: root,
        store,
        checkHostPort: () => Effect.void,
      }).planAndReserve(stackId, disabledListenerIntents, {
        privateBindings: privateBindingIntentsFor(compiled.executionPlan),
      });
      const pgmetaPrimary = reservation.privateAssignments.find(
        ({ workloadId, binding }) => workloadId === "studio:pgmeta" && binding === "primary",
      );
      const pgmetaAdmin = reservation.privateAssignments.find(
        ({ workloadId, binding }) => workloadId === "studio:pgmeta" && binding === "admin",
      );
      const vectorPrimary = reservation.privateAssignments.find(
        ({ workloadId, binding }) => workloadId === "analytics:vector" && binding === "primary",
      );
      if (pgmetaPrimary === undefined || pgmetaAdmin === undefined || vectorPrimary === undefined)
        throw new Error("Compiled plan did not reserve pgmeta and Vector bindings");
      expect(pgmetaAdmin.port).toBe(pgmetaPrimary.port + 1);
      expect(vectorPrimary.port).toBeGreaterThan(pgmetaAdmin.port);
      const pgmetaResolution = containerResolutionFor(
        { ...state, privatePorts: reservation.privateAssignments },
        planned("studio:pgmeta"),
      );
      expect(pgmetaResolution?.publications).toEqual([
        { address: "127.0.0.1", hostPort: pgmetaPrimary.port, containerPort: 8080 },
        { address: "127.0.0.1", hostPort: pgmetaAdmin.port, containerPort: 8081 },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("provides private command, environment and readiness metadata for every workload", () => {
    for (const [index, id] of Object.keys(WORKLOAD_CATALOG).entries()) {
      const workload = planned(id);
      const spec = runtimeSpecFor(workload);
      expect(spec).toBeDefined();
      if (spec === undefined) continue;
      const port = 30_000 + index;
      expect(spec.containerPort).toBeGreaterThan(0);
      expect(spec.env(state, workload, port).SUPABASE_STACK_WORKLOAD).toBe(id);
      expect(spec.readiness.protocol).toMatch(/http|tcp/u);
      expect(spec.args(state, workload, port)).toBeInstanceOf(Array);
      expect(typeof spec.cwd(state, workload)).toBe("string");
      expect(spec.privateEndpoint(state, spec.readiness.binding)).toEqual({
        host: "127.0.0.1",
        port: expect.any(Number),
      });
      expect(spec.privateEndpoint(state, spec.readiness.binding, "container")).toEqual({
        host: WORKLOAD_CATALOG[id]?.containerAlias,
        port: spec.bindings[spec.readiness.binding]?.containerPort,
      });
      expect(containerResolutionFor(state, workload)?.networkAliases).toEqual([
        WORKLOAD_CATALOG[id]?.containerAlias,
      ]);
    }
  });

  it("uses native-only BEAM distribution for Realtime, Analytics, and Pooler", () => {
    const beamWorkloads = ["realtime:realtime", "analytics:analytics", "pooler:pooler"] as const;
    for (const [index, id] of beamWorkloads.entries()) {
      const workload = planned(id);
      const spec = runtimeSpecFor(workload);
      expect(spec).toBeDefined();
      if (spec === undefined) continue;
      expect(spec.env(state, workload, 30_100 + index, "native")).toMatchObject({
        RELEASE_DISTRIBUTION: "none",
      });
      expect(spec.env(state, workload, 30_100 + index, "container")).not.toHaveProperty(
        "RELEASE_DISTRIBUTION",
      );
    }
  });

  it.live("uses durable binding assignments for native endpoints and container publications", () =>
    Effect.gen(function* () {
      const mail = planned("mail:mail");
      const mailResolution = containerResolutionFor(state, mail);
      expect(mailResolution?.publications).toEqual([
        { address: "127.0.0.1", hostPort: 30010, containerPort: 8025 },
        { address: "127.0.0.1", hostPort: 30011, containerPort: 1025 },
        { address: "127.0.0.1", hostPort: 30012, containerPort: 1110 },
      ]);
      expect(runtimeSpecFor(mail)?.env(state, mail, 30010)).toMatchObject({
        MP_UI_BIND_ADDR: "127.0.0.1:30010",
        MP_SMTP_BIND_ADDR: "127.0.0.1:30011",
        MP_POP3_BIND_ADDR: "127.0.0.1:30012",
      });
      const realtime = planned("realtime:realtime");
      expect(runtimeSpecFor(realtime)?.env(state, realtime, 32000).PORT).toBe("32000");
      expect(
        runtimeSpecFor(realtime)?.env(state, realtime, 32000).SUPABASE_STACK_PRIVATE_PORT,
      ).toBe("32000");
      const secondState: PersistedStackState = {
        ...state,
        privatePorts: state.privatePorts.map((assignment) => ({
          ...assignment,
          port: assignment.port + 1000,
        })),
      };
      expect(
        runtimeSpecFor(planned("rest:rest"))?.env(secondState, planned("rest:rest"), 3000),
      ).toMatchObject({
        PGRST_DB_URI: expect.stringContaining("@127.0.0.1:31001"),
      });
      expect(
        runtimeSpecFor(planned("storage:storage"))?.env(
          secondState,
          planned("storage:storage"),
          5000,
        ).IMGPROXY_URL,
      ).toBe("http://127.0.0.1:31006");
      const missing = {
        ...state,
        privatePorts: state.privatePorts.filter(
          ({ workloadId, binding }) => !(workloadId === mail.id && binding === "smtp"),
        ),
      };
      const failed = yield* resolveContainerResolutionFor(missing, mail).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("uses owner-resolved StackId data paths for native persistence", () =>
    Effect.sync(() => {
      const database = planned("database:database");
      const storage = planned("storage:storage");
      const databaseSpec = runtimeSpecFor(database);
      const storageSpec = runtimeSpecFor(storage);
      expect(
        databaseSpec?.env(state, database, 5432, "native", {
          database: { dataPath: "/state/stack/data/database" },
        }).PGDATA,
      ).toBe("/state/stack/data/database");
      expect(
        storageSpec?.env(state, storage, 5000, "native", {
          storage: { dataPath: "/state/stack/data/storage" },
        }).FILE_STORAGE_BACKEND_PATH,
      ).toBe("/state/stack/data/storage");
      expect(
        storageSpec?.env(state, storage, 5000, "container", {
          storage: { dataPath: "/ignored/native/path" },
        }).FILE_STORAGE_BACKEND_PATH,
      ).toBe("/mnt");
      expect(
        runtimeSpecFor(planned("storage:imgproxy"))?.env(
          state,
          planned("storage:imgproxy"),
          5001,
          "native",
          {
            storage: { dataPath: "/state/stack/data/storage" },
          },
        ).IMGPROXY_LOCAL_FILESYSTEM_ROOT,
      ).toBe("/");
      expect(
        runtimeSpecFor(planned("storage:imgproxy"))?.env(
          state,
          planned("storage:imgproxy"),
          5001,
          "container",
        ).IMGPROXY_LOCAL_FILESYSTEM_ROOT,
      ).toBe("/");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("resolves service-owned startup processes and container init contracts", () => {
    const root = "/tmp/slim artifact";
    const auth = planned("auth:auth");
    expect(runtimeSpecFor(auth)?.nativeStartupProcesses(root, state, auth, 9999)).toEqual([
      { executable: `${root}/bin/auth`, args: ["migrate"], cwd: root },
    ]);
    const storage = planned("storage:storage");
    expect(runtimeSpecFor(storage)?.nativeStartupProcesses(root, state, storage, 5000)).toEqual([
      {
        executable: `${root}/node/bin/node`,
        args: [`${root}/app/dist/scripts/migrate-call.js`],
        cwd: `${root}/app`,
      },
    ]);
    const realtime = planned("realtime:realtime");
    expect(runtimeSpecFor(realtime)?.nativeStartupProcesses(root, state, realtime, 4000)).toEqual([
      { executable: `${root}/bin/migrate`, args: [], cwd: root },
      {
        executable: `${root}/bin/realtime`,
        args: ["eval", "Realtime.Release.seeds(Realtime.Repo)"],
        cwd: root,
      },
    ]);
    const analytics = planned("analytics:analytics");
    expect(runtimeSpecFor(analytics)?.nativeStartupProcesses(root, state, analytics, 4000)).toEqual(
      [
        {
          executable: `${root}/bin/logflare`,
          args: ["eval", "Logflare.Release.migrate"],
          cwd: root,
        },
      ],
    );
    const pooler = planned("pooler:pooler");
    expect(runtimeSpecFor(pooler)?.nativeStartupProcesses(root, state, pooler, 6543)).toEqual([
      { executable: `${root}/bin/migrate`, args: [], cwd: root },
    ]);
    const tenantInput = { pooler: { tenantPath: "/tmp/pooler-tenant.exs" } };
    const tenantStartup = runtimeSpecFor(pooler)?.nativeStartupProcesses(
      root,
      state,
      pooler,
      6543,
      tenantInput,
    );
    expect(tenantStartup).toHaveLength(2);
    expect(tenantStartup?.[1]).toEqual({
      executable: "/bin/sh",
      args: [
        "-c",
        'exec "$1" eval "$(cat "$SUPABASE_POOLER_TENANT_PATH")"',
        "supavisor",
        `${root}/bin/supavisor`,
      ],
      cwd: root,
      env: { SUPABASE_POOLER_TENANT_PATH: "/tmp/pooler-tenant.exs" },
    });
    expect(tenantStartup?.[1]?.args.join(" ")).not.toContain("secret");

    const nativeTenantEnv = runtimeSpecFor(pooler)?.env(state, pooler, 6543, "native", tenantInput);
    expect(nativeTenantEnv).not.toHaveProperty("SUPABASE_POOLER_TENANT_PATH");
    const containerTenantEnv = runtimeSpecFor(pooler)?.env(
      state,
      pooler,
      6543,
      "container",
      tenantInput,
    );
    expect(containerTenantEnv?.SUPABASE_POOLER_TENANT_PATH).toBe("/app/pooler_tenant.exs");

    expect(containerResolutionFor(state, auth)?.command).toEqual([]);
    expect(containerResolutionFor(state, auth)?.startup).toEqual([
      { entrypoint: "/usr/local/bin/auth", command: ["migrate"] },
    ]);
    expect(containerResolutionFor(state, storage)?.command).toEqual([]);
    expect(containerResolutionFor(state, storage)?.startup).toEqual([
      { entrypoint: "/node/bin/node", command: ["dist/scripts/migrate-call.js"] },
    ]);
    expect(containerResolutionFor(state, realtime)?.entrypoint).toBe("/usr/bin/tini");
    expect(containerResolutionFor(state, realtime)?.command).toEqual([
      "-s",
      "-g",
      "--",
      "/app/bin/server",
    ]);
    expect(containerResolutionFor(state, realtime)?.startup).toEqual([
      { entrypoint: "/app/bin/migrate", command: [] },
      {
        entrypoint: "/app/bin/realtime",
        command: ["eval", "Realtime.Release.seeds(Realtime.Repo)"],
      },
    ]);
    expect(containerResolutionFor(state, analytics)?.command).toEqual([]);
    expect(containerResolutionFor(state, pooler)?.entrypoint).toBe("/usr/bin/tini");
    expect(containerResolutionFor(state, pooler)?.command).toEqual([
      "-s",
      "-g",
      "--",
      "/app/bin/server",
    ]);
    expect(containerResolutionFor(state, pooler)?.startup).toEqual([
      { entrypoint: "/app/bin/migrate", command: [] },
    ]);
    const poolerWithTenant = containerResolutionFor(state, pooler, tenantInput);
    expect(poolerWithTenant?.command).toEqual(["-s", "-g", "--", "/app/bin/server"]);
    expect(poolerWithTenant?.startup).toEqual([
      { entrypoint: "/app/bin/migrate", command: [] },
      {
        entrypoint: "/usr/bin/sh",
        command: ["-c", 'exec /app/bin/supavisor eval "$(cat "$SUPABASE_POOLER_TENANT_PATH")"'],
      },
    ]);
    expect(poolerWithTenant?.mounts).toEqual([
      { source: "/tmp/pooler-tenant.exs", target: "/app/pooler_tenant.exs", readOnly: true },
    ]);
    expect(poolerWithTenant?.env.SUPABASE_POOLER_TENANT_PATH).toBe("/app/pooler_tenant.exs");
    expect(poolerWithTenant?.command.join(" ")).not.toContain("secret");
  });

  it.live(
    "consumes nested capability settings and separates native/container database endpoints",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compileStack({
          projectRoot: state.identity.projectRoot,
          runtime: { kind: "native" },
          config: {
            capabilities: {
              rest: {
                settings: {
                  schemas: ["private"],
                  extra_search_path: ["extensions"],
                  external_url: "https://api.example",
                },
              },
              storage: {
                settings: {
                  image_transformation: { enabled: true },
                  s3_protocol: { enabled: false },
                },
              },
              functions: {
                settings: {
                  edge_runtime: {
                    policy: "oneshot",
                    deno_version: 1,
                    verify_jwt_default: false,
                    import_map_default: "shared-deno.json",
                  },
                  inspector: { mode: "brk", main: true },
                  functions: { hello: { verify_jwt: false } },
                },
              },
              studio: { settings: { api_url: "https://studio.example" } },
              pooler: { enabled: true, settings: { pool_mode: "session", max_client_conn: 250 } },
              auth: {
                settings: {
                  site_url: "https://example.test",
                  additional_redirect_urls: ["https://example.test/callback"],
                  jwt_issuer: "https://issuer.example",
                  enable_signup: false,
                  minimum_password_length: 12,
                  password_requirements: "letters_digits",
                  email: {
                    double_confirm_changes: true,
                    secure_password_change: false,
                    template: {
                      confirmation: {
                        content_path: "templates/confirmation.html",
                        subject: "Confirm",
                      },
                    },
                    notification: {
                      password_recovery: {
                        enabled: true,
                        content_path: "templates/recovery.html",
                        subject: "Reset",
                      },
                    },
                  },
                  sms: {
                    enable_signup: true,
                    twilio: { enabled: true, account_sid: "AC123", message_service_sid: "MG123" },
                    twilio_verify: { enabled: true, account_sid: "VA123" },
                    test_otp: { "+33123456789": "123456" },
                  },
                  mfa: { phone: { otp_length: 8 } },
                },
              },
              analytics: {
                settings: {
                  backend: "bigquery",
                  gcp_project_id: "project-42",
                  gcp_project_number: "42",
                  gcp_jwt_path: "secrets/gcp.json",
                },
              },
              realtime: { settings: { ip_version: "IPv6" } },
            },
          },
        });
        const configured: PersistedStackState = {
          ...state,
          definition: compiled.definition,
          secrets: {
            ...state.secrets,
            "secret:analytics.settings.api_key": { policy: "passthrough", value: "api-key" },
          },
        };
        const rest = runtimeSpecFor(planned("rest:rest"));
        const storage = runtimeSpecFor(planned("storage:storage"));
        const functions = planned("functions:edge-runtime");
        const functionsEnvironment = runtimeSpecFor(functions)?.env(
          configured,
          functions,
          9000,
          "native",
        );
        const functionsConfig = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          functionsEnvironment?.SUPABASE_INTERNAL_FUNCTIONS_CONFIG ?? "{}",
        );
        expect(functionsConfig).toMatchObject({
          $default: {
            verify_jwt: false,
            import_map_root: "shared-deno.json",
          },
        });
        expect(runtimeSpecFor(functions)?.env(configured, functions, 9000, "native")).toMatchObject(
          {
            SUPABASE_URL: "http://127.0.0.1:54321",
          },
        );
        expect(
          runtimeSpecFor(functions)?.env(configured, functions, 9000, "container", {
            hostRoute: { host: "host.docker.internal", gateway: "host-gateway" },
          }),
        ).toMatchObject({ SUPABASE_URL: "http://host.docker.internal:54321" });
        expect(rest?.env(configured, planned("rest:rest"), 3000, "native")).toMatchObject({
          PGRST_DB_SCHEMAS: "private",
          PGRST_DB_EXTRA_SEARCH_PATH: "extensions",
          PGRST_DB_URI: expect.stringContaining("@127.0.0.1:30001"),
          PGRST_ADMIN_SERVER_PORT: "30015",
          PGRST_OPENAPI_SERVER_PROXY_URI: "https://api.example",
        });
        expect(rest?.env(configured, planned("rest:rest"), 3000, "container")).toMatchObject({
          PGRST_DB_URI: expect.stringContaining("@supabase-database:5432"),
          PGRST_ADMIN_SERVER_PORT: "3001",
        });
        const dependentHosts: ReadonlyArray<{
          readonly id: string;
          readonly key: string;
        }> = [
          { id: "realtime:realtime", key: "DB_HOST" },
          { id: "studio:pgmeta", key: "PG_META_DB_HOST" },
          { id: "analytics:analytics", key: "DB_HOSTNAME" },
        ];
        for (const { id, key } of dependentHosts) {
          const dependent = runtimeSpecFor(planned(id));
          expect(dependent?.env(configured, planned(id), 4000, "container")[key]).toBe(
            "supabase-database",
          );
        }
        expect(storage?.env(configured, planned("storage:storage"), 5000)).toMatchObject({
          ENABLE_IMAGE_TRANSFORMATION: "true",
          S3_PROTOCOL_ENABLED: "false",
          FILE_SIZE_LIMIT: "52428800",
          VECTOR_ENABLED: "true",
          VECTOR_BUCKET_PROVIDER: "pgvector",
          VECTOR_STORE_MIGRATIONS_ENABLED: "true",
          VECTOR_DATABASE_URL: expect.stringContaining("postgres:postgres@127.0.0.1"),
        });
        const auth = runtimeSpecFor(planned("auth:auth"));
        expect(auth?.env(configured, planned("auth:auth"), 9999)).toMatchObject({
          GOTRUE_SITE_URL: "https://example.test",
          GOTRUE_URI_ALLOW_LIST: "https://example.test/callback",
          GOTRUE_DISABLE_SIGNUP: "true",
          GOTRUE_PASSWORD_MIN_LENGTH: "12",
          GOTRUE_PASSWORD_REQUIRED_CHARACTERS:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
          GOTRUE_SMS_PROVIDER: "twilio",
          GOTRUE_SMS_TEST_OTP: "+33123456789:123456",
          GOTRUE_SMS_OTP_LENGTH: "6",
          GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED: "true",
          GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION: "false",
          GOTRUE_SMTP_HOST: "127.0.0.1",
          GOTRUE_SMTP_PORT: "30011",
        });
        expect(
          auth?.env(configured, planned("auth:auth"), 9999, "native", {
            auth: { templateBaseUrl: "http://supabase-gateway:8088" },
          }),
        ).toMatchObject({
          GOTRUE_MAILER_TEMPLATES_CONFIRMATION:
            "http://supabase-gateway:8088/email/confirmation.html",
          GOTRUE_MAILER_SUBJECTS_CONFIRMATION: "Confirm",
          GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_RECOVERY_ENABLED: "true",
          GOTRUE_MAILER_TEMPLATES_PASSWORD_RECOVERY_NOTIFICATION:
            "http://supabase-gateway:8088/email/password_recovery_notification.html",
          GOTRUE_MAILER_SUBJECTS_PASSWORD_RECOVERY_NOTIFICATION: "Reset",
        });
        yield* validateWorkloadRuntimeInputs(configured, planned("auth:auth"), {
          auth: { templateBaseUrl: "http://supabase-gateway:8088" },
        });
        const missingTemplateBase = yield* validateWorkloadRuntimeInputs(
          configured,
          planned("auth:auth"),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(missingTemplateBase)).toBe(true);
        expect(auth?.env(configured, planned("auth:auth"), 9999)).toMatchObject({
          GOTRUE_JWT_ISSUER: "https://issuer.example",
          GOTRUE_SMS_TWILIO_ACCOUNT_SID: "AC123",
          GOTRUE_SMS_TWILIO_VERIFY_ACCOUNT_SID: "VA123",
        });
        expect(
          auth?.env(configured, planned("auth:auth"), 9999).GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI,
        ).toBeUndefined();
        expect(
          auth?.env(configured, planned("auth:auth"), 9999, "container", {
            auth: { jwtKeys: '[{"kty":"EC"}]' },
          }).GOTRUE_JWT_KEYS,
        ).toBe('[{"kty":"EC"}]');
        const realtime = runtimeSpecFor(planned("realtime:realtime"));
        expect(
          realtime?.env(configured, planned("realtime:realtime"), 4000, "container", {
            auth: { jwks: '{"keys":[]}' },
          }),
        ).toMatchObject({ ERL_AFLAGS: "-proto_dist inet6_tcp", API_JWT_JWKS: '{"keys":[]}' });
        expect(realtime?.readiness.headers).toBeUndefined();
        expect(realtime?.readiness.path).toBe("/healthcheck");
        const analytics = runtimeSpecFor(planned("analytics:analytics"));
        const analyticsInputs = { analytics: { gcpJwtPath: "/tmp/gcp.json" } };
        expect(
          analytics?.env(
            configured,
            planned("analytics:analytics"),
            4000,
            "native",
            analyticsInputs,
          ),
        ).toMatchObject({
          GOOGLE_PROJECT_ID: "project-42",
          GOOGLE_PROJECT_NUMBER: "42",
          GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
        });
        expect(
          analytics?.env(configured, planned("analytics:analytics"), 4000, "native"),
        ).toMatchObject({
          LOGFLARE_PRIVATE_ACCESS_TOKEN: "api-key",
        });
        expect(
          analytics?.env(configured, planned("analytics:analytics"), 4000, "native"),
        ).not.toHaveProperty("LOGFLARE_PUBLIC_ACCESS_TOKEN");
        expect(
          analytics?.env(configured, planned("analytics:analytics"), 4000, "container"),
        ).toMatchObject({
          LOGFLARE_PRIVATE_ACCESS_TOKEN: "api-key",
        });
        expect(
          analytics?.env(configured, planned("analytics:analytics"), 4000, "container"),
        ).not.toHaveProperty("LOGFLARE_PUBLIC_ACCESS_TOKEN");
        expect(
          analytics?.containerMounts?.(configured, planned("analytics:analytics"), analyticsInputs),
        ).toEqual([
          {
            source: "/tmp/gcp.json",
            target: "/opt/app/rel/logflare/bin/gcloud.json",
            readOnly: true,
          },
        ]);
        expect(analytics?.args(configured, planned("analytics:analytics"), 4000)).toEqual([
          "start",
        ]);
        expect(containerResolutionFor(configured, planned("analytics:analytics"))?.command).toEqual(
          [],
        );
        const pooler = runtimeSpecFor(planned("pooler:pooler"));
        expect(pooler?.env(configured, planned("pooler:pooler"), 30016)).toMatchObject({
          POOL_MODE: "session",
          MAX_CLIENT_CONN: "250",
          TENANT_ID: "pooler-dev",
          PORT: "30017",
          PROXY_PORT_SESSION: "30016",
          PROXY_PORT_TRANSACTION: "6543",
        });
        expect(pooler?.env(configured, planned("pooler:pooler"), 30016, "container")).toMatchObject(
          {
            PROXY_PORT_SESSION: "5432",
            PROXY_PORT_TRANSACTION: "6543",
          },
        );
        expect(containerResolutionFor(configured, planned("pooler:pooler"))?.publications).toEqual([
          { address: "127.0.0.1", hostPort: 30016, containerPort: 5432 },
          { address: "127.0.0.1", hostPort: 30017, containerPort: 4000 },
        ]);
        const resolution = containerResolutionFor(configured, functions, {
          hostRoute: { host: "host.docker.internal", gateway: "host-gateway" },
        });
        expect(resolution?.command.join(" ")).toContain(
          `--main-service=${FUNCTIONS_BOOTSTRAP_CONTAINER_PATH}`,
        );
        expect(resolution?.mounts).toEqual([
          {
            source: `${state.identity.projectRoot}/supabase/functions`,
            target: FUNCTIONS_CONTAINER_ROOT,
            readOnly: true,
          },
        ]);
        expect(resolution?.env).toMatchObject({
          EDGE_RUNTIME_POLICY: "oneshot",
          EDGE_RUNTIME_DENO_VERSION: "1",
          INSPECTOR_MODE: "brk",
          INSPECTOR_MAIN: "true",
        });
        expect(
          Object.keys(resolution?.env ?? {}).some((key) => key.startsWith("FUNCTIONS_FUNCTIONS_")),
        ).toBe(false);
        expect(resolution?.env.EDGE_RUNTIME_PORT).toBe("9000");
        expect(resolution?.hostRoute).toEqual({
          host: "host.docker.internal",
          gateway: "host-gateway",
        });
        const bootstrapResolution = containerResolutionFor(configured, functions, {
          functions: { bootstrapPath: "/tmp/functions/4/main.ts" },
        });
        expect(bootstrapResolution?.bootstrap).toEqual({
          source: "/tmp/functions/4/main.ts",
          destination: "/root",
        });
        expect(
          runtimeSpecFor(functions)?.nativeProcess(
            "/tmp/edge-artifact",
            configured,
            functions,
            9000,
            { functions: { bootstrapPath: "/tmp/functions/4/main.ts" } },
          ).args,
        ).toContain("--main-service=/tmp/functions/4");
        const studio = runtimeSpecFor(planned("studio:studio"));
        expect(
          studio?.env(configured, planned("studio:studio"), 3000, "container", {
            hostRoute: { host: "host.docker.internal", gateway: "host-gateway" },
          }),
        ).toMatchObject({
          SUPABASE_URL: "http://host.docker.internal:54321",
          STUDIO_PG_META_URL: "http://supabase-pgmeta:8080",
          LOGFLARE_URL: "http://supabase-analytics:4000",
          EDGE_FUNCTIONS_MANAGEMENT_FOLDER: FUNCTIONS_CONTAINER_ROOT,
        });
        expect(studio?.env(configured, planned("studio:studio"), 3000, "native")).toMatchObject({
          SUPABASE_URL: "https://studio.example",
          SUPABASE_PUBLIC_URL: "http://127.0.0.1:54321",
        });
        expect(studio?.containerMounts?.(configured, planned("studio:studio"))).toEqual([
          {
            source: `${state.identity.projectRoot}/supabase/functions`,
            target: FUNCTIONS_CONTAINER_ROOT,
            readOnly: true,
          },
        ]);
        expect(
          runtimeSpecFor(planned("storage:storage"))?.env(
            configured,
            planned("storage:storage"),
            5000,
            "container",
          ).IMGPROXY_URL,
        ).toBe("http://supabase-imgproxy:5001");
        const nodeArtifactRoot = "/tmp/native-artifact";
        expect(
          studio?.nativeProcess(nodeArtifactRoot, configured, planned("studio:studio"), 3000),
        ).toEqual({
          executable: "/tmp/native-artifact/node/bin/node",
          args: ["/tmp/native-artifact/app/apps/studio/docker-entrypoint.mjs"],
          cwd: "/tmp/native-artifact/app",
        });
        expect(
          runtimeSpecFor(planned("database:database"))?.nativeProcess(
            nodeArtifactRoot,
            configured,
            planned("database:database"),
            5432,
          ),
        ).toMatchObject({
          gracefulStopSignal: "SIGINT",
          gracefulStopTimeout: "15 seconds",
        });
        expect(
          runtimeSpecFor(planned("analytics:vector"))?.nativeProcess(
            nodeArtifactRoot,
            configured,
            planned("analytics:vector"),
            9001,
          ),
        ).toEqual({
          executable: "/tmp/native-artifact/bin/vector",
          args: ["--config", "/tmp/native-artifact/share/doc/vector/config/vector.yaml"],
          cwd: "/tmp/supabase-runtime-spec",
        });
        expect(
          runtimeSpecFor(planned("analytics:vector"))?.nativeProcess(
            nodeArtifactRoot,
            configured,
            planned("analytics:vector"),
            9001,
            { analytics: { vectorConfigPath: "/tmp/vector.yaml" } },
          ),
        ).toEqual({
          executable: "/tmp/native-artifact/bin/vector",
          args: ["--config", "/tmp/vector.yaml"],
          cwd: "/tmp/supabase-runtime-spec",
        });
        expect(
          runtimeSpecFor(planned("analytics:vector"))?.env(
            configured,
            planned("analytics:vector"),
            30014,
            "native",
          ).VECTOR_API_ADDRESS,
        ).toBe("127.0.0.1:30014");
        expect(
          runtimeSpecFor(planned("analytics:vector"))?.env(
            configured,
            planned("analytics:vector"),
            9001,
            "container",
          ).VECTOR_API_ADDRESS,
        ).toBe("0.0.0.0:9001");
        expect(
          runtimeSpecFor(planned("analytics:vector"))?.env(
            configured,
            planned("analytics:vector"),
            9001,
            "native",
          ),
        ).toMatchObject({
          LOGFLARE_URL: "http://127.0.0.1:30013",
          LOGFLARE_PRIVATE_ACCESS_TOKEN: "api-key",
        });
        expect(
          runtimeSpecFor(planned("analytics:vector"))?.env(
            configured,
            planned("analytics:vector"),
            9001,
            "container",
          ),
        ).toMatchObject({
          LOGFLARE_URL: "http://supabase-analytics:4000",
          LOGFLARE_PRIVATE_ACCESS_TOKEN: "api-key",
        });
        const vector = planned("analytics:vector");
        expect(containerResolutionFor(configured, vector)?.command).toEqual([]);
        expect(containerResolutionFor(configured, vector)?.mounts).toEqual([]);
        expect(
          containerResolutionFor(configured, vector, {
            analytics: { vectorConfigPath: "/tmp/vector.yaml" },
          }),
        ).toMatchObject({
          command: ["--config", "/etc/vector/vector.yaml"],
          mounts: [
            {
              source: "/tmp/vector.yaml",
              target: "/etc/vector/vector.yaml",
              readOnly: true,
            },
          ],
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("selects PostgREST symmetric and resolved-JWKS credentials", () =>
    Effect.gen(function* () {
      const rest = runtimeSpecFor(planned("rest:rest"));
      expect(rest?.env(state, planned("rest:rest"), 3000).PGRST_JWT_SECRET).toBe(
        "symmetric-secret",
      );
      const compiled = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
        config: { security: { jwt: { signing: { kind: "jwks-file", path: "jwt.json" } } } },
      }).pipe(Effect.provide(NodeServices.layer));
      const configured: PersistedStackState = { ...state, definition: compiled.definition };
      expect(
        rest?.env(configured, planned("rest:rest"), 3000, "native", {
          auth: { jwks: '{"keys":[]}' },
        }).PGRST_JWT_SECRET,
      ).toBe('{"keys":[]}');
      const failed = yield* validateWorkloadRuntimeInputs(configured, planned("rest:rest")).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(failed)).toBe(true);
      const unresolved = yield* resolveContainerResolutionFor(
        configured,
        planned("rest:rest"),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(unresolved)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("emits only enabled Auth provider fields and gates phone MFA options", () =>
    Effect.gen(function* () {
      const disabledCompiled = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
      }).pipe(Effect.provide(NodeServices.layer));
      const disabledState: PersistedStackState = {
        ...state,
        definition: disabledCompiled.definition,
      };
      const disabled = runtimeSpecFor(planned("auth:auth"))?.env(
        disabledState,
        planned("auth:auth"),
        9999,
      );
      expect(disabled?.GOTRUE_EXTERNAL_GOOGLE_ENABLED).toBe("false");
      expect(disabled?.GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI).toBeUndefined();
      expect(disabled?.GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID).toBeUndefined();
      expect(disabled?.GOTRUE_MFA_PHONE_ENROLL_ENABLED).toBe("false");
      expect(disabled?.GOTRUE_MFA_PHONE_VERIFY_ENABLED).toBe("false");
      expect(disabled?.GOTRUE_MFA_PHONE_OTP_LENGTH).toBeUndefined();

      const enabledCompiled = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
        config: {
          capabilities: {
            auth: {
              settings: {
                external: {
                  google: {
                    enabled: true,
                    client_id: "google-client",
                    url: "https://accounts.google.test",
                  },
                },
                mfa: { phone: { enroll_enabled: true, otp_length: 8 } },
              },
            },
          },
        },
      }).pipe(Effect.provide(NodeServices.layer));
      const enabledState: PersistedStackState = {
        ...state,
        definition: enabledCompiled.definition,
      };
      const enabled = runtimeSpecFor(planned("auth:auth"))?.env(
        enabledState,
        planned("auth:auth"),
        9999,
      );
      expect(enabled).toMatchObject({
        GOTRUE_EXTERNAL_GOOGLE_ENABLED: "true",
        GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: "google-client",
        GOTRUE_EXTERNAL_GOOGLE_URL: "https://accounts.google.test",
        GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: expect.stringContaining("/callback"),
        GOTRUE_MFA_PHONE_ENROLL_ENABLED: "true",
        GOTRUE_MFA_PHONE_OTP_LENGTH: "8",
        GOTRUE_MFA_PHONE_TEMPLATE: "Your code is {{ .Code }}",
        GOTRUE_MFA_PHONE_MAX_FREQUENCY: "5s",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("maps persisted Storage S3 credentials and omits vector settings when disabled", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
        config: {
          capabilities: {
            storage: {
              settings: {
                s3_protocol: {
                  enabled: true,
                  region: "eu-west-1",
                  access_key_id: "access-42",
                  secret_access_key: Redacted.make("secret-42"),
                },
                vector: { enabled: false },
              },
            },
          },
        },
      }).pipe(Effect.provide(NodeServices.layer));
      const configured: PersistedStackState = {
        ...state,
        definition: compiled.definition,
        secrets: {
          ...state.secrets,
          "secret:storage.settings.s3_protocol.secret_access_key": {
            policy: "managed",
            value: "secret-42",
          },
        },
      };
      const env = runtimeSpecFor(planned("storage:storage"))?.env(
        configured,
        planned("storage:storage"),
        5000,
      );
      expect(env).toMatchObject({
        S3_PROTOCOL_ENABLED: "true",
        S3_PROTOCOL_ACCESS_KEY_ID: "access-42",
        S3_PROTOCOL_ACCESS_KEY_SECRET: "secret-42",
        STORAGE_S3_REGION: "eu-west-1",
      });
      expect(env).not.toHaveProperty("VECTOR_ENABLED");
      expect(env).not.toHaveProperty("VECTOR_DATABASE_URL");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("validates owner-resolved Pooler tenant paths before runtime creation", () =>
    Effect.gen(function* () {
      const failed = yield* validateWorkloadRuntimeInputs(state, planned("pooler:pooler"), {
        pooler: { tenantPath: "/tmp/tenant\n.exs" },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
    }),
  );

  it("uses Auth's local JWT secret for every internal JWT consumer", () => {
    const consumers = [
      ["auth:auth", "GOTRUE_JWT_SECRET"],
      ["realtime:realtime", "API_JWT_SECRET"],
      ["storage:storage", "AUTH_JWT_SECRET"],
      ["storage:storage", "PGRST_JWT_SECRET"],
      ["pooler:pooler", "API_JWT_SECRET"],
      ["pooler:pooler", "METRICS_JWT_SECRET"],
      ["functions:edge-runtime", "SUPABASE_INTERNAL_JWT_SECRET"],
    ] as const;
    for (const [id, key] of consumers) {
      const workload = planned(id);
      const spec = runtimeSpecFor(workload);
      expect(spec?.env(state, workload, 3000)[key]).toBe("symmetric-secret");
    }
  });

  it("uses managed per-stack Realtime encryption keys", () => {
    const workload = planned("realtime:realtime");
    expect(runtimeSpecFor(workload)?.env(state, workload, 3000)).toMatchObject({
      DB_ENC_KEY: "realtime-db-key",
      SECRET_KEY_BASE: "realtime-secret-base",
    });
  });

  it.live("keeps Auth's local JWT secret alongside resolved JWKS material", () =>
    Effect.gen(function* () {
      const compileWith = (config: Parameters<typeof compileStack>[0]["config"]) =>
        compileStack({
          projectRoot: state.identity.projectRoot,
          runtime: { kind: "native" },
          config,
        }).pipe(Effect.provide(NodeServices.layer));
      const jwks = '{"keys":[{"kty":"EC"}]}';
      const jwksCompiled = yield* compileWith({
        security: { jwt: { signing: { kind: "jwks-file", path: "jwt.json" } } },
      });
      const jwksState: PersistedStackState = {
        ...state,
        definition: jwksCompiled.definition,
      };
      const internal = [
        ["auth:auth", "GOTRUE_JWT_SECRET"],
        ["realtime:realtime", "API_JWT_SECRET"],
        ["realtime:realtime", "METRICS_JWT_SECRET"],
        ["storage:storage", "AUTH_JWT_SECRET"],
        ["storage:storage", "PGRST_JWT_SECRET"],
        ["pooler:pooler", "API_JWT_SECRET"],
        ["pooler:pooler", "METRICS_JWT_SECRET"],
        ["functions:edge-runtime", "SUPABASE_INTERNAL_JWT_SECRET"],
      ] as const;
      for (const [id, key] of internal) {
        const workload = planned(id);
        const spec = runtimeSpecFor(workload);
        expect(
          spec?.env(jwksState, workload, 3000, "native", {
            auth: { jwtKeys: '[{"kty":"EC"}]', jwks },
          })[key],
        ).toBe("symmetric-secret");
      }
      expect(
        runtimeSpecFor(planned("rest:rest"))?.env(jwksState, planned("rest:rest"), 3000, "native", {
          auth: { jwtKeys: '[{"kty":"EC"}]', jwks },
        }).PGRST_JWT_SECRET,
      ).toBe(jwks);

      const thirdPartyCompiled = yield* compileWith({
        capabilities: {
          auth: {
            settings: {
              third_party: { firebase: { enabled: true, project_id: "project-42" } },
            },
          },
        },
      });
      const thirdPartyState: PersistedStackState = {
        ...state,
        definition: thirdPartyCompiled.definition,
      };
      expect(
        runtimeSpecFor(planned("realtime:realtime"))?.env(
          thirdPartyState,
          planned("realtime:realtime"),
          3000,
          "native",
          { auth: { jwks } },
        ).API_JWT_SECRET,
      ).toBe("symmetric-secret");
      expect(
        runtimeSpecFor(planned("realtime:realtime"))?.env(
          thirdPartyState,
          planned("realtime:realtime"),
          3000,
          "native",
          { auth: { jwks } },
        ).API_JWT_JWKS,
      ).toBe(jwks);
      expect(
        runtimeSpecFor(planned("storage:storage"))?.env(
          thirdPartyState,
          planned("storage:storage"),
          3000,
          "native",
          { auth: { jwks } },
        ).AUTH_JWT_SECRET,
      ).toBe("symmetric-secret");
      expect(
        runtimeSpecFor(planned("pooler:pooler"))?.env(
          thirdPartyState,
          planned("pooler:pooler"),
          3000,
          "native",
          { auth: { jwks } },
        ).METRICS_JWT_SECRET,
      ).toBe("symmetric-secret");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("requires resolved JWKS material for an enabled third-party provider", () =>
    Effect.gen(function* () {
      const compiled = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
        config: {
          capabilities: {
            auth: {
              settings: {
                third_party: { firebase: { enabled: true, project_id: "project-42" } },
              },
            },
          },
        },
      }).pipe(Effect.provide(NodeServices.layer));
      const configured: PersistedStackState = { ...state, definition: compiled.definition };
      const failed = yield* validateWorkloadRuntimeInputs(configured, planned("rest:rest")).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(failed)).toBe(true);
      const valid = yield* validateWorkloadRuntimeInputs(configured, planned("rest:rest"), {
        auth: { jwks: '{"keys":[]}' },
      }).pipe(Effect.exit);
      expect(Exit.isSuccess(valid)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("passes Edge Runtime the JWT material used by functions serve", () =>
    Effect.gen(function* () {
      const functions = planned("functions:edge-runtime");
      const functionSpec = runtimeSpecFor(functions);
      expect(functionSpec).toBeDefined();
      if (functionSpec === undefined) return;
      const symmetricDefault = containerResolutionFor(state, functions);
      expect(symmetricDefault?.env).toMatchObject({
        SUPABASE_INTERNAL_JWT_SECRET: "symmetric-secret",
        SUPABASE_INTERNAL_PUBLISHABLE_KEY: "sb_publishable_test",
        SUPABASE_INTERNAL_SECRET_KEY: "sb_secret_test",
        SUPABASE_INTERNAL_HOST_PORT: "54321",
        SUPABASE_JWKS: '{"keys":[]}',
      });
      expect(
        functionSpec?.containerArgs(state, functions, functionSpec.containerPort),
      ).not.toContain("sb_publishable_test");
      expect(
        functionSpec?.containerArgs(state, functions, functionSpec.containerPort),
      ).not.toContain("sb_secret_test");
      expect(functionSpec?.args(state, functions, functionSpec.containerPort)).not.toContain(
        "sb_publishable_test",
      );
      expect(functionSpec?.args(state, functions, functionSpec.containerPort)).not.toContain(
        "sb_secret_test",
      );
      const withoutApiAssignment: PersistedStackState = {
        ...state,
        ports: state.ports.filter((assignment) => assignment.field !== "api"),
      };
      expect(containerResolutionFor(withoutApiAssignment, functions)?.env).not.toHaveProperty(
        "SUPABASE_INTERNAL_HOST_PORT",
      );
      const symmetric = containerResolutionFor(state, functions, {
        auth: { jwks: '{"keys":[{"kty":"EC"}]}' },
        functions: {
          secrets: {
            APP_SECRET: "value",
            EMPTY_SECRET: "",
            EDGE_RUNTIME_PORT: "secret-collision",
            SUPABASE_INTERNAL_JWT_SECRET: "forbidden-jwt",
            SUPABASE_INTERNAL_PUBLISHABLE_KEY: "forbidden-publishable",
            SUPABASE_INTERNAL_SECRET_KEY: "forbidden-secret",
            SUPABASE_INTERNAL_HOST_PORT: "forbidden-port",
            SUPABASE_JWKS: "forbidden-jwks",
          },
        },
      });
      expect(symmetric?.env).toMatchObject({
        SUPABASE_INTERNAL_JWT_SECRET: "symmetric-secret",
        SUPABASE_INTERNAL_PUBLISHABLE_KEY: "sb_publishable_test",
        SUPABASE_INTERNAL_SECRET_KEY: "sb_secret_test",
        SUPABASE_INTERNAL_HOST_PORT: "54321",
        SUPABASE_JWKS: '{"keys":[{"kty":"EC"}]}',
        APP_SECRET: "value",
        EMPTY_SECRET: "",
      });
      expect(symmetric?.env.EDGE_RUNTIME_PORT).toBe("9000");

      const jwksCompiled = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
        config: { security: { jwt: { signing: { kind: "jwks-file", path: "jwt.json" } } } },
      }).pipe(Effect.provide(NodeServices.layer));
      const jwksState: PersistedStackState = { ...state, definition: jwksCompiled.definition };
      const jwksResolution = yield* resolveContainerResolutionFor(jwksState, functions, {
        auth: { jwtKeys: '[{"kty":"EC"}]', jwks: '{"keys":[{"kty":"EC"}]}' },
      });
      expect(jwksResolution?.env).toMatchObject({
        SUPABASE_JWKS: '{"keys":[{"kty":"EC"}]}',
        SUPABASE_INTERNAL_JWT_SECRET: "symmetric-secret",
      });

      const thirdPartyCompiled = yield* compileStack({
        projectRoot: state.identity.projectRoot,
        runtime: { kind: "native" },
        config: {
          capabilities: {
            auth: {
              settings: {
                third_party: { firebase: { enabled: true, project_id: "project-42" } },
              },
            },
          },
        },
      }).pipe(Effect.provide(NodeServices.layer));
      const thirdPartyState: PersistedStackState = {
        ...state,
        definition: thirdPartyCompiled.definition,
      };
      const thirdPartyResolution = yield* resolveContainerResolutionFor(
        thirdPartyState,
        functions,
        { auth: { jwks: '{"keys":[{"kty":"EC"}]}' } },
      );
      expect(thirdPartyResolution?.env.SUPABASE_JWKS).toBe('{"keys":[{"kty":"EC"}]}');
      expect(thirdPartyResolution?.env.SUPABASE_INTERNAL_JWT_SECRET).toBe("symmetric-secret");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
