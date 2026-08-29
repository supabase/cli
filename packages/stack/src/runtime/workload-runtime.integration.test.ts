import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { WORKLOAD_CATALOG } from "../model/WorkloadCatalog.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { PersistedStackState } from "../state/StackState.ts";
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
  desiredGeneration: 1,
  desiredLifecycle: "running",
  ports: [
    { field: "database", port: 55432, intent: "exact" },
    { field: "api", port: 54321, intent: "exact" },
  ],
  privatePorts: [
    { workloadId: "database:database", binding: "primary", port: 30_001 },
    { workloadId: "rest:rest", binding: "primary", port: 30_002 },
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
    { workloadId: "pooler:pooler", binding: "primary", port: 30_015 },
  ],
  secrets: {
    "secret:database.internal.password": { policy: "managed", value: "postgres" },
    "secret:auth.settings.jwt_secret": { policy: "managed", value: "symmetric-secret" },
  },
};

const planned = (id: string): PlannedWorkload => {
  const entry = WORKLOAD_CATALOG[id];
  if (entry === undefined) throw new Error(`Missing test catalog entry: ${id}`);
  const separator = id.indexOf(":");
  const capability = CAPABILITY_NAMES.find((name) => name === id.slice(0, separator));
  if (capability === undefined) throw new Error(`Missing test capability: ${id}`);
  const name = id.slice(separator + 1);
  return {
    id,
    capability,
    dependencies: [],
    readiness: { mode: "tcp" },
    restart: { maxAttempts: 1, backoffMs: 0 },
    artifacts: {
      native: { kind: "native", service: entry.service, release: entry.nativeVersion },
      container: { kind: "container", service: entry.service, image: entry.containerImage },
    },
    selected: { kind: "native", service: entry.service, release: entry.nativeVersion },
    specHash: `${capability}:${name}`,
  };
};

describe("workload runtime catalog", () => {
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
      expect(intents.filter(({ workloadId }) => workloadId === "mail:mail")).toHaveLength(3);
      expect(
        intents.every(({ binding }) => ["primary", "ui", "smtp", "pop3"].includes(binding)),
      ).toBe(true);
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
      expect(spec.cwd(state, workload)).toBeTruthy();
      expect(spec.privateEndpoint(state, spec.readiness.binding)).toEqual({
        host: "127.0.0.1",
        port: expect.any(Number),
      });
      expect(spec.privateEndpoint(state, spec.readiness.binding, "container")).toEqual({
        host: WORKLOAD_CATALOG[id]?.containerAlias,
        port: spec.bindings[spec.readiness.binding]?.containerPort,
      });
      expect(spec.networkAliases).toEqual([WORKLOAD_CATALOG[id]?.containerAlias]);
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
      expect(runtimeSpecFor(mail)?.env(state, mail, 8025)).toMatchObject({
        MP_UI_BIND_ADDR: "127.0.0.1:30010",
        MP_SMTP_BIND_ADDR: "127.0.0.1:30011",
        MP_POP3_BIND_ADDR: "127.0.0.1:30012",
      });
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

  it.live(
    "consumes nested capability settings and separates native/container database endpoints",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compileStack({
          projectRoot: state.identity.projectRoot,
          runtime: { kind: "native" },
          config: {
            capabilities: {
              rest: { settings: { schemas: ["private"], extra_search_path: ["extensions"] } },
              storage: {
                settings: {
                  image_transformation: { enabled: true },
                  s3_protocol: { enabled: false },
                },
              },
              functions: {
                settings: {
                  edge_runtime: { policy: "oneshot", deno_version: 1 },
                  inspector: { mode: "brk", main: true },
                  functions: { hello: { verify_jwt: false } },
                },
              },
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
        const configured: PersistedStackState = { ...state, definition: compiled.definition };
        const rest = runtimeSpecFor(planned("rest:rest"));
        const storage = runtimeSpecFor(planned("storage:storage"));
        const functions = planned("functions:edge-runtime");
        expect(rest?.env(configured, planned("rest:rest"), 3000, "native")).toMatchObject({
          PGRST_DB_SCHEMAS: "private",
          PGRST_DB_EXTRA_SEARCH_PATH: "extensions",
          PGRST_DB_URI: expect.stringContaining("@127.0.0.1:30001"),
        });
        expect(rest?.env(configured, planned("rest:rest"), 3000, "container")).toMatchObject({
          PGRST_DB_URI: expect.stringContaining("@supabase-database:5432"),
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
        });
        const auth = runtimeSpecFor(planned("auth:auth"));
        expect(auth?.env(configured, planned("auth:auth"), 9999)).toMatchObject({
          GOTRUE_SITE_URL: "https://example.test",
          GOTRUE_URI_ALLOW_LIST: "https://example.test/callback",
          GOTRUE_DISABLE_SIGNUP: "true",
          GOTRUE_PASSWORD_MIN_LENGTH: "12",
          GOTRUE_PASSWORD_REQUIRED_CHARACTERS:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
          GOTRUE_MFA_PHONE_OTP_LENGTH: "8",
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
          GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: "https://issuer.example/callback",
          GOTRUE_SMS_TWILIO_ACCOUNT_SID: "AC123",
          GOTRUE_SMS_TWILIO_VERIFY_ACCOUNT_SID: "VA123",
        });
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
          analytics?.containerMounts?.(configured, planned("analytics:analytics"), analyticsInputs),
        ).toEqual([
          {
            source: "/tmp/gcp.json",
            target: "/opt/app/rel/logflare/bin/gcloud.json",
            readOnly: true,
          },
        ]);
        const pooler = runtimeSpecFor(planned("pooler:pooler"));
        expect(pooler?.env(configured, planned("pooler:pooler"), 6543)).toMatchObject({
          POOL_MODE: "session",
          MAX_CLIENT_CONN: "250",
        });
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
          FUNCTIONS_FUNCTIONS_HELLO_VERIFY_JWT: "false",
        });
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
        });
        expect(
          runtimeSpecFor(planned("storage:storage"))?.env(
            configured,
            planned("storage:storage"),
            5000,
            "container",
          ).IMGPROXY_URL,
        ).toBe("http://supabase-imgproxy:8080");
        const nodeArtifactRoot = "/tmp/native-artifact";
        expect(
          studio?.nativeProcess(nodeArtifactRoot, configured, planned("studio:studio"), 3000),
        ).toEqual({
          executable: "/tmp/native-artifact/node/bin/node",
          args: ["/tmp/native-artifact/app/apps/studio/docker-entrypoint.mjs"],
          cwd: "/tmp/native-artifact/app",
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
          args: [
            "--config",
            "/tmp/native-artifact/share/doc/vector/config/vector.yaml",
            "--watch-config",
            "false",
          ],
          cwd: "/tmp/supabase-runtime-spec",
        });
        const vector = planned("analytics:vector");
        expect(containerResolutionFor(configured, vector)?.command).toEqual([]);
        const vectorResolution = containerResolutionFor(configured, vector, {
          analytics: { vectorConfigPath: "/tmp/vector.yaml" },
        });
        expect(vectorResolution?.command).toEqual([
          "--config",
          "/etc/vector/vector.yaml",
          "--watch-config",
          "false",
        ]);
        expect(vectorResolution?.mounts).toEqual([
          { source: "/tmp/vector.yaml", target: "/etc/vector/vector.yaml", readOnly: true },
        ]);
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
      const symmetricDefault = containerResolutionFor(state, functions);
      expect(symmetricDefault?.env).toMatchObject({
        SUPABASE_INTERNAL_JWT_SECRET: "symmetric-secret",
        SUPABASE_JWKS: '{"keys":[]}',
      });
      const symmetric = containerResolutionFor(state, functions, {
        auth: { jwks: '{"keys":[{"kty":"EC"}]}' },
      });
      expect(symmetric?.env).toMatchObject({
        SUPABASE_INTERNAL_JWT_SECRET: "symmetric-secret",
        SUPABASE_JWKS: '{"keys":[{"kty":"EC"}]}',
      });

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
