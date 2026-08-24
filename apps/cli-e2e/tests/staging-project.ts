import { createHarness, exec } from "@supabase/cli-test-helpers";
import { Data, Duration, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { ACCESS_TOKEN, readEnv, REGION, TARGET } from "../src/tests/env.ts";

// Shared staging-project helpers used by record and live setup.
const PROJECT_REF_RE = /^[a-z]{20}$/;
const TERMINAL_BAD_STATUSES = new Set(["INIT_FAILED", "RESTORE_FAILED", "REMOVED"]);

const OrgSchema = Schema.Struct({ id: Schema.String });
const ProjectSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
});
const ProjectListEntrySchema = Schema.Struct({
  id: Schema.String,
  ref: Schema.optional(Schema.String),
  name: Schema.String,
});
const ProjectStatusSchema = Schema.Struct({ status: Schema.optional(Schema.String) });
const ApiKeySchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  api_key: Schema.optional(Schema.String),
});
const PoolerConfigSchema = Schema.Struct({
  database_type: Schema.optional(Schema.String),
  connection_string: Schema.optional(Schema.String),
});
class StagingSetupError extends Data.TaggedError("StagingSetupError")<{
  readonly cause: unknown;
}> {}
const decodeOrgList = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(OrgSchema)));
const decodeProject = Schema.decodeEffect(Schema.fromJsonString(ProjectSchema));
const decodeProjectList = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(ProjectListEntrySchema)),
);
const decodeProjectStatus = Schema.decodeEffect(Schema.fromJsonString(ProjectStatusSchema));
const decodeApiKeys = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(ApiKeySchema)));
const decodePoolerConfig = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([PoolerConfigSchema, Schema.Array(PoolerConfigSchema)])),
);

function harness(apiUrl: string) {
  return createHarness(TARGET, { apiUrl, accessToken: ACCESS_TOKEN });
}

type SetupEffect<A> = Effect.Effect<
  A,
  StagingSetupError | HttpClientError.HttpClientError,
  HttpClient.HttpClient
>;

function runSetup<A>(effect: SetupEffect<A>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie));
}

function execCommand(apiUrl: string, args: ReadonlyArray<string>) {
  return Effect.promise(() => exec(harness(apiUrl), [...args])).pipe(Effect.orDie);
}

function request(
  url: string,
  options: {
    readonly method?: "GET" | "POST";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  } = {},
) {
  return Effect.gen(function* () {
    let req = HttpClientRequest.make(options.method ?? "GET")(url, {
      headers: options.headers ?? {},
    });
    if (options.body !== undefined) {
      req = yield* HttpClientRequest.bodyJson(req, options.body);
    }
    return yield* HttpClient.execute(req);
  }).pipe(Effect.mapError((cause) => new StagingSetupError({ cause })));
}

/** A DB password for a throwaway project. */
export function generateDbPassword(): string {
  const configured = readEnv("CLI_E2E_DB_PASSWORD");
  if (configured !== undefined) return configured;
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return "cli-e2e-" + Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function resolveOrgId(apiUrl: string): Promise<string> {
  return runSetup(
    Effect.gen(function* () {
      const result = yield* execCommand(apiUrl, ["orgs", "list", "--output", "json"]);
      if (result.exitCode !== 0) {
        return yield* Effect.die(new Error("orgs list failed: " + result.stderr));
      }
      const orgs = yield* decodeOrgList(result.stdout).pipe(Effect.orDie);
      const first = orgs[0]?.id;
      if (!first) return yield* Effect.die(new Error("No orgs found — cannot create test project"));
      return first;
    }),
  );
}

export function createTestProject(
  apiUrl: string,
  orgId: string,
  name: string,
  password: string,
): Promise<string> {
  return runSetup(
    Effect.gen(function* () {
      const result = yield* execCommand(apiUrl, [
        "projects",
        "create",
        name,
        "--org-id",
        orgId,
        "--db-password",
        password,
        "--region",
        REGION,
        "--output",
        "json",
      ]);
      if (result.exitCode !== 0) {
        return yield* Effect.die(new Error("projects create failed: " + result.stderr));
      }
      const project = yield* decodeProject(result.stdout).pipe(Effect.orDie);
      const ref = project.ref ?? project.id;
      if (!ref || !PROJECT_REF_RE.test(ref)) {
        return yield* Effect.die(new Error("Unexpected project ref from create: " + result.stdout));
      }
      return ref;
    }),
  );
}

export function deleteTestProject(
  apiUrl: string,
  projectRef: string,
  opts: { throwOnError?: boolean } = {},
): Promise<void> {
  return runSetup(
    Effect.gen(function* () {
      const result = yield* execCommand(apiUrl, ["projects", "delete", projectRef, "--yes"]);
      if (result.exitCode === 0) return;
      if (opts.throwOnError) {
        return yield* Effect.die(
          new Error("projects delete exited " + result.exitCode + ": " + result.stderr),
        );
      }
      yield* Effect.logWarning("Warning: failed to delete test project " + projectRef);
    }),
  );
}

export function cleanupProjectsByName(apiUrl: string, names: string[]): Promise<void> {
  return runSetup(
    Effect.gen(function* () {
      const listResult = yield* execCommand(apiUrl, ["projects", "list", "--output", "json"]);
      if (listResult.exitCode !== 0) return;
      const projects = yield* decodeProjectList(listResult.stdout).pipe(Effect.orDie);
      for (const project of projects.filter((entry) => names.includes(entry.name))) {
        const ref = project.ref ?? project.id;
        if (PROJECT_REF_RE.test(ref)) {
          yield* execCommand(apiUrl, ["projects", "delete", ref, "--yes"]);
        }
      }
    }),
  );
}

/** Poll until the project is ACTIVE_HEALTHY. */
export function waitForProjectReady(
  apiBaseUrl: string,
  projectRef: string,
  timeoutMs = 300_000,
): Promise<void> {
  return runSetup(
    Effect.gen(function* () {
      const deadline = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) + timeoutMs;
      while ((yield* Effect.clockWith((clock) => clock.currentTimeMillis)) < deadline) {
        const response = yield* request(apiBaseUrl + "/v1/projects/" + projectRef, {
          headers: { Authorization: "Bearer " + ACCESS_TOKEN },
        });
        const body = yield* response.text;
        if (response.status >= 200 && response.status < 300) {
          const project = yield* decodeProjectStatus(body).pipe(Effect.orDie);
          if (project.status === "ACTIVE_HEALTHY") return;
          if (project.status && TERMINAL_BAD_STATUSES.has(project.status)) {
            return yield* Effect.die(
              new Error(
                "Project " +
                  projectRef +
                  " entered terminal status " +
                  project.status +
                  " during provisioning",
              ),
            );
          }
        }
        yield* Effect.sleep(Duration.seconds(5));
      }
      return yield* Effect.die(
        new Error(
          "Project " + projectRef + " did not become ACTIVE_HEALTHY within " + timeoutMs + "ms",
        ),
      );
    }),
  );
}

export function getAnonKey(apiBaseUrl: string, projectRef: string, attempts = 12): Promise<string> {
  return runSetup(
    Effect.gen(function* () {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const response = yield* request(apiBaseUrl + "/v1/projects/" + projectRef + "/api-keys", {
          headers: { Authorization: "Bearer " + ACCESS_TOKEN },
        });
        const body = yield* response.text;
        if (response.status >= 200 && response.status < 300) {
          const keys = yield* decodeApiKeys(body).pipe(Effect.orDie);
          const anon = keys.find((key) => key.name === "anon" && key.api_key)?.api_key;
          if (anon) return anon;
          if (keys.length > 0) {
            return yield* Effect.die(new Error("Project " + projectRef + " returned no anon JWT"));
          }
        }
        if (attempt === attempts) {
          return yield* Effect.die(
            new Error(
              "Failed to resolve anon key for " + projectRef + " after " + attempts + " attempts",
            ),
          );
        }
        yield* Effect.sleep(Duration.seconds(10));
      }
      return yield* Effect.die(new Error("Failed to resolve anon key for " + projectRef));
    }),
  );
}

export function getServiceRoleKey(
  apiBaseUrl: string,
  projectRef: string,
  attempts = 12,
): Promise<string> {
  return runSetup(
    Effect.gen(function* () {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const response = yield* request(apiBaseUrl + "/v1/projects/" + projectRef + "/api-keys", {
          headers: { Authorization: "Bearer " + ACCESS_TOKEN },
        });
        const body = yield* response.text;
        if (response.status >= 200 && response.status < 300) {
          const keys = yield* decodeApiKeys(body).pipe(Effect.orDie);
          const secret =
            keys.find((key) => key.name === "service_role" && key.api_key)?.api_key ??
            keys.find((key) => key.api_key?.startsWith("sb_secret_"))?.api_key;
          if (secret) return secret;
        }
        if (attempt === attempts) {
          return yield* Effect.die(
            new Error("Failed to resolve service-role key for " + projectRef),
          );
        }
        yield* Effect.sleep(Duration.seconds(10));
      }
      return yield* Effect.die(new Error("Failed to resolve service-role key for " + projectRef));
    }),
  );
}

export function createStorageBucket(
  projectHost: string,
  projectRef: string,
  serviceRoleKey: string,
  bucket: string,
): Promise<void> {
  return runSetup(
    Effect.gen(function* () {
      const response = yield* request(
        "https://" + projectRef + "." + projectHost + "/storage/v1/bucket",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + serviceRoleKey,
            "Content-Type": "application/json",
          },
          body: { id: bucket, name: bucket, public: false },
        },
      );
      const body = yield* response.text;
      if ((response.status < 200 || response.status >= 300) && response.status !== 409) {
        return yield* Effect.die(
          new Error("Failed to create bucket " + bucket + ": " + response.status + " " + body),
        );
      }
    }),
  );
}

export function getPoolerSessionUrl(
  apiBaseUrl: string,
  projectRef: string,
  password: string,
  attempts = 12,
): Promise<string> {
  return runSetup(
    Effect.gen(function* () {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const response = yield* request(
          apiBaseUrl + "/v1/projects/" + projectRef + "/config/database/pooler",
          { headers: { Authorization: "Bearer " + ACCESS_TOKEN } },
        );
        const body = yield* response.text;
        if (response.status >= 200 && response.status < 300) {
          const payload = yield* decodePoolerConfig(body).pipe(Effect.orDie);
          const configs = Array.isArray(payload) ? payload : [payload];
          const primary =
            configs.find((config) => config.database_type === "PRIMARY") ?? configs[0];
          if (primary?.connection_string) {
            const url = new URL(primary.connection_string);
            url.password = password;
            url.port = "5432";
            if (!url.searchParams.has("connect_timeout")) {
              url.searchParams.set("connect_timeout", "30");
            }
            return url.toString();
          }
        }
        if (attempt === attempts) {
          return yield* Effect.die(
            new Error(
              "Failed to resolve pooler config for " +
                projectRef +
                " after " +
                attempts +
                " attempts",
            ),
          );
        }
        yield* Effect.sleep(Duration.seconds(10));
      }
      return yield* Effect.die(new Error("Failed to resolve pooler config for " + projectRef));
    }),
  );
}
