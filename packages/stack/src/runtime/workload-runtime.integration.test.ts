import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { WORKLOAD_CATALOG } from "../model/WorkloadCatalog.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { CAPABILITY_NAMES } from "../public/Capability.ts";
import { compileStack } from "../model/Compiler.ts";
import {
  containerResolutionFor,
  FUNCTIONS_CONTAINER_ROOT,
  runtimeSpecFor,
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
  ports: [{ field: "database", port: 55432, intent: "exact" }],
  secrets: {
    "secret:database.internal.password": { policy: "managed", value: "postgres" },
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
      expect(spec.privateEndpoint(port)).toEqual({ host: "127.0.0.1", port });
    }
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
                  enable_signup: false,
                  minimum_password_length: 12,
                  password_requirements: "letters_digits",
                  sms: {
                    enable_signup: true,
                    twilio: { enabled: true, account_sid: "AC123", message_service_sid: "MG123" },
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
                },
              },
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
          PGRST_DB_URI: expect.stringContaining("@127.0.0.1:55432"),
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
        });
        const analytics = runtimeSpecFor(planned("analytics:analytics"));
        expect(analytics?.env(configured, planned("analytics:analytics"), 4000)).toMatchObject({
          GOOGLE_PROJECT_ID: "project-42",
          GOOGLE_PROJECT_NUMBER: "42",
        });
        const pooler = runtimeSpecFor(planned("pooler:pooler"));
        expect(pooler?.env(configured, planned("pooler:pooler"), 6543)).toMatchObject({
          POOL_MODE: "session",
          MAX_CLIENT_CONN: "250",
        });
        const resolution = containerResolutionFor(configured, functions, 9000);
        expect(resolution?.command.join(" ")).toContain(
          `--main-service=${FUNCTIONS_CONTAINER_ROOT}`,
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
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
