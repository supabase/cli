import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { mockAnalytics, mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyStatusCodeFailure,
  legacyTransportFailure,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { legacyLink } from "./link.handler.ts";
import type { LegacyLinkFlags } from "./link.command.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEALTHY_PROJECT = {
  id: LEGACY_VALID_REF,
  ref: LEGACY_VALID_REF,
  name: "My Project",
  organization_id: "org_123",
  organization_slug: "acme",
  status: "ACTIVE_HEALTHY",
  region: "us-east-1",
  created_at: "2026-01-01T00:00:00Z",
  database: {
    host: "db.example.co",
    version: "15.1.0.117",
    postgres_engine: "15",
    release_channel: "ga",
  },
};

const SERVICE_KEYS = [
  {
    name: "service_role",
    api_key: "service-role-key",
    type: "secret",
    secret_jwt_template: { role: "service_role" },
  },
  { name: "anon", api_key: "anon-key", type: "publishable" },
];

const POOLER_PRIMARY = [
  {
    identifier: "primary",
    database_type: "PRIMARY",
    db_user: "postgres",
    db_host: "pooler.example.co",
    db_port: 6543,
    db_name: "postgres",
    connection_string: "postgresql://postgres.ref:[YOUR-PASSWORD]@pooler.example.co:6543/postgres",
    connectionString: "",
    default_pool_size: null,
    max_client_conn: null,
    pool_mode: "transaction",
  },
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface V1StubResult {
  readonly ok?: unknown;
  readonly fail?: unknown;
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  project?: V1StubResult;
  apiKeys?: V1StubResult;
  storageConfig?: V1StubResult;
  poolerConfig?: V1StubResult;
  tenant?: "ok" | "fail";
  restVersion?: string;
  gotrueVersion?: string;
  storageVersion?: string;
}

const tempRoot = useLegacyTempWorkdir("supabase-link-int-");

function stub(result: V1StubResult | undefined, defaultOk: unknown) {
  if (result?.fail !== undefined) return () => Effect.fail(result.fail);
  return () => Effect.succeed(result?.ok ?? defaultOk);
}

function tenantHttpLayer(opts: SetupOpts): Layer.Layer<HttpClient.HttpClient> {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (opts.tenant === "fail") {
          return yield* Effect.fail(legacyTransportFailure(request));
        }
        const url = request.url;
        if (url.includes("/rest/v1/")) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ info: { version: opts.restVersion ?? "11.1.0" } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.includes("/auth/v1/health")) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ version: opts.gotrueVersion ?? "v2.74.2" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.includes("/storage/v1/version")) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(opts.storageVersion ?? "1.28.0", { status: 200 }),
          );
        }
        return HttpClientResponse.fromWeb(request, new Response("", { status: 404 }));
      }),
    ),
  );
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedCache = mockLegacyLinkedProjectCacheTracked();
  const apiMock = mockLegacyPlatformApiService({
    v1: {
      getProject: stub(opts.project, HEALTHY_PROJECT),
      getProjectApiKeys: stub(opts.apiKeys, SERVICE_KEYS),
      getStorageConfig: stub(opts.storageConfig, { migrationVersion: "2026-01-01-000000" }),
      getPoolerConfig: stub(opts.poolerConfig, POOLER_PRIMARY),
    },
  });
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    projectId: Option.none(),
  });
  const layer = buildLegacyTestRuntime({
    out,
    api: { layer: apiMock.layer, httpClientLayer: tenantHttpLayer(opts) },
    cliConfig,
    analytics,
    telemetry: telemetry.layer,
    linkedProjectCache: linkedCache.layer,
  });
  return { layer, out, analytics, telemetry, linkedCache, apiMock, workdir: tempRoot.current };
}

const flags = (overrides: Partial<LegacyLinkFlags> = {}): LegacyLinkFlags => ({
  projectRef: Option.some(LEGACY_VALID_REF),
  password: Option.none(),
  skipPooler: false,
  ...overrides,
});

function tempFile(workdir: string, name: string): string {
  return join(workdir, "supabase", ".temp", name);
}

function readTemp(workdir: string, name: string): string {
  return readFileSync(tempFile(workdir, name), "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy link integration", () => {
  it.live("links a project, writing the project-ref and version files", () => {
    const { layer, out, workdir } = setup();
    return Effect.gen(function* () {
      yield* legacyLink(flags());
      expect(readTemp(workdir, "project-ref")).toBe(LEGACY_VALID_REF);
      expect(readTemp(workdir, "postgres-version")).toBe("15.1.0.117");
      expect(readTemp(workdir, "storage-migration")).toBe("2026-01-01-000000");
      expect(readTemp(workdir, "rest-version")).toBe("v11.1.0");
      expect(readTemp(workdir, "gotrue-version")).toBe("v2.74.2");
      expect(readTemp(workdir, "storage-version")).toBe("v1.28.0");
      // [YOUR-PASSWORD] stripped + transaction-mode port rewritten to 5432.
      expect(readTemp(workdir, "pooler-url")).toBe(
        "postgresql://postgres.ref@pooler.example.co:5432/postgres",
      );
      expect(out.stdoutText).toContain("Finished supabase link.");
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project.json with ref/name/org metadata", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* legacyLink(flags());
      const linked = JSON.parse(readTemp(workdir, "linked-project.json"));
      expect(linked).toEqual({
        ref: LEGACY_VALID_REF,
        name: "My Project",
        organization_id: "org_123",
        organization_slug: "acme",
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits cli_project_linked + org/project groupIdentify keyed by org id", () => {
    const { layer, analytics } = setup();
    return Effect.gen(function* () {
      yield* legacyLink(flags());
      expect(analytics.captured.map((c) => c.event)).toContain("cli_project_linked");
      expect(analytics.groupIdentified).toEqual([
        {
          groupType: "organization",
          groupKey: "org_123",
          properties: { organization_slug: "acme" },
        },
        {
          groupType: "project",
          groupKey: LEGACY_VALID_REF,
          properties: { name: "My Project", organization_slug: "acme" },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves the ref from SUPABASE_PROJECT_ID when no flag is given", () => {
    const out = mockOutput({ format: "text" });
    const apiMock = mockLegacyPlatformApiService({
      v1: {
        getProject: () => Effect.succeed(HEALTHY_PROJECT),
        getProjectApiKeys: () => Effect.succeed(SERVICE_KEYS),
        getStorageConfig: () => Effect.succeed({ migrationVersion: "m" }),
        getPoolerConfig: () => Effect.succeed(POOLER_PRIMARY),
      },
    });
    const cliConfig = mockLegacyCliConfig({
      workdir: tempRoot.current,
      projectId: Option.some(LEGACY_VALID_REF),
    });
    const layer = buildLegacyTestRuntime({
      out,
      api: { layer: apiMock.layer, httpClientLayer: tenantHttpLayer({}) },
      cliConfig,
    });
    return Effect.gen(function* () {
      yield* legacyLink(flags({ projectRef: Option.none() }));
      expect(readTemp(tempRoot.current, "project-ref")).toBe(LEGACY_VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails in non-TTY with no --project-ref and no PROJECT_ID", () => {
    const out = mockOutput({ format: "text" });
    const apiMock = mockLegacyPlatformApiService({ v1: {} });
    const cliConfig = mockLegacyCliConfig({
      workdir: tempRoot.current,
      projectId: Option.none(),
    });
    const layer = buildLegacyTestRuntime({
      out,
      api: { layer: apiMock.layer, httpClientLayer: tenantHttpLayer({}) },
      cliConfig,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLink(flags({ projectRef: Option.none() })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyProjectRefRequiredError");
        expect(json).toContain(`required flag(s) \\"project-ref\\" not set`);
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyInvalidProjectRefError for a malformed ref", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLink(flags({ projectRef: Option.some("BADREF") })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("tolerates a 404 project (branch linking): writes project-ref, skips telemetry", () => {
    const { layer, workdir, analytics } = setup({
      project: { fail: legacyStatusCodeFailure(404) },
    });
    return Effect.gen(function* () {
      yield* legacyLink(flags());
      expect(readTemp(workdir, "project-ref")).toBe(LEGACY_VALID_REF);
      // No postgres-version / linked-project.json and no telemetry for a 404.
      expect(existsSync(tempFile(workdir, "postgres-version"))).toBe(false);
      expect(existsSync(tempFile(workdir, "linked-project.json"))).toBe(false);
      expect(analytics.captured.map((c) => c.event)).not.toContain("cli_project_linked");
      expect(analytics.groupIdentified).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with project-paused error + dashboard suggestion when INACTIVE", () => {
    const { layer } = setup({
      project: { ok: { ...HEALTHY_PROJECT, status: "INACTIVE" } },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLink(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyProjectPausedError");
        expect(json).toContain("project is paused");
        expect(json).toContain(
          `An admin must unpause it from the Supabase dashboard at https://supabase.com/dashboard/project/${LEGACY_VALID_REF}`,
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("warns to stderr when status is not ACTIVE_HEALTHY but still links", () => {
    const { layer, out, workdir } = setup({
      project: { ok: { ...HEALTHY_PROJECT, status: "COMING_UP" } },
    });
    return Effect.gen(function* () {
      yield* legacyLink(flags());
      expect(out.stderrText).toContain(
        "WARNING: Project status is COMING_UP instead of Active Healthy. Some operations might fail.",
      );
      expect(readTemp(workdir, "project-ref")).toBe(LEGACY_VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyLinkProjectStatusError on an unexpected status", () => {
    const { layer } = setup({ project: { fail: legacyStatusCodeFailure(500) } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLink(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyLinkProjectStatusError");
        expect(json).toContain("Unexpected error retrieving remote project status");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with auth error when api-keys returns non-200", () => {
    const { layer } = setup({ apiKeys: { fail: legacyStatusCodeFailure(401) } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLink(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyLinkAuthTokenError");
        expect(json).toContain("Authorization failed for the access token and project ref pair");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with missing-key error when api-keys are empty", () => {
    const { layer } = setup({ apiKeys: { ok: [] } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLink(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyLinkMissingKeyError");
        expect(json).toContain("Anon key not found.");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves keys by legacy name when no type field is present", () => {
    // Untyped keys exercise the `name`-based fallback in extractServiceKeys.
    const { layer, out, workdir } = setup({
      apiKeys: {
        ok: [
          { name: "anon", api_key: "anon-key" },
          { name: "service_role", api_key: "service-role-key" },
        ],
      },
    });
    return Effect.gen(function* () {
      yield* legacyLink(flags());
      expect(readTemp(workdir, "project-ref")).toBe(LEGACY_VALID_REF);
      expect(out.stdoutText).toContain("Finished supabase link.");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with missing-key error when the only secret key is not service_role", () => {
    // A `secret` key whose JWT role is not `service_role` is skipped, leaving no
    // usable key — exercises the secret-branch `continue` + missing-key path.
    const { layer } = setup({
      apiKeys: {
        ok: [
          {
            name: "other",
            api_key: "other-key",
            type: "secret",
            secret_jwt_template: { role: "authenticated" },
          },
        ],
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLink(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyLinkMissingKeyError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores best-effort service errors without failing the link", () => {
    const { layer, out, workdir } = setup({
      storageConfig: { fail: legacyStatusCodeFailure(500) },
      poolerConfig: { fail: legacyStatusCodeFailure(503) },
      tenant: "fail",
    });
    return Effect.gen(function* () {
      yield* legacyLink(flags());
      // Link still succeeds and writes the project-ref.
      expect(readTemp(workdir, "project-ref")).toBe(LEGACY_VALID_REF);
      expect(out.stdoutText).toContain("Finished supabase link.");
      // The best-effort files are absent because their services errored.
      expect(existsSync(tempFile(workdir, "storage-migration"))).toBe(false);
      expect(existsSync(tempFile(workdir, "rest-version"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("removes pooler-url and skips the pooler fetch when --skip-pooler is set", () => {
    const { layer, workdir, apiMock } = setup();
    mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
    writeFileSync(tempFile(workdir, "pooler-url"), "stale-pooler-url");
    return Effect.gen(function* () {
      yield* legacyLink(flags({ skipPooler: true }));
      expect(existsSync(tempFile(workdir, "pooler-url"))).toBe(false);
      expect(apiMock.requests.map((r) => r.method)).not.toContain("getPoolerConfig");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when writing the project-ref file errors", () => {
    // Make `<workdir>/supabase` a file so creating supabase/.temp fails for every
    // temp write. The project status carries no version, so the first mandatory
    // write to hit the broken path is project-ref (mirrors Go's read-only FS test).
    const out = mockOutput({ format: "text" });
    const apiMock = mockLegacyPlatformApiService({
      v1: {
        getProject: () =>
          Effect.succeed({
            ...HEALTHY_PROJECT,
            database: { ...HEALTHY_PROJECT.database, version: "" },
          }),
        getProjectApiKeys: () => Effect.succeed(SERVICE_KEYS),
        getStorageConfig: () => Effect.succeed({ migrationVersion: "m" }),
        getPoolerConfig: () => Effect.succeed(POOLER_PRIMARY),
      },
    });
    const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current, projectId: Option.none() });
    const layer = buildLegacyTestRuntime({
      out,
      api: { layer: apiMock.layer, httpClientLayer: tenantHttpLayer({ tenant: "fail" }) },
      cliConfig,
    });
    writeFileSync(join(tempRoot.current, "supabase"), "not-a-dir");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyLink(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(existsSync(tempFile(tempRoot.current, "project-ref"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry and runs the linked-project cache via ensuring", () => {
    const { layer, telemetry, linkedCache } = setup();
    return Effect.gen(function* () {
      yield* legacyLink(flags());
      expect(telemetry.flushed).toBe(true);
      expect(linkedCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("json output: emits a structured success and suppresses the Finished line", () => {
    const { layer, out, workdir } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyLink(flags());
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ project_ref: LEGACY_VALID_REF });
      expect(out.stdoutText).not.toContain("Finished supabase link.");
      expect(readTemp(workdir, "project-ref")).toBe(LEGACY_VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("stream-json output: emits a structured success", () => {
    const { layer, out } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyLink(flags());
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ project_ref: LEGACY_VALID_REF });
    }).pipe(Effect.provide(layer));
  });
});
