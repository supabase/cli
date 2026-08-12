import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Effect, Exit, Layer, Option, Stdio } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequestModule from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { CurrentAnalyticsContext } from "../../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
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
import { legacyLinkHandler } from "./link.command.ts";
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

type LegacyLinkBranches = typeof V1ListAllBranchesOutput.Type;
type LegacyLinkBranch = LegacyLinkBranches[number];

// The currently-linked PARENT project's ref (env / cache / temp-file candidate).
const PARENT_REF = LEGACY_VALID_REF;
// Distinct 20-lowercase-letter refs used to disambiguate which parent
// candidate (env / linked-project.json cache / project-ref file) won.
const BRANCH_PROJECT_REF = "branchprojectrefabcd";
const OTHER_BRANCH_PROJECT_REF = "otherbranchprojectre";
const CACHE_ONLY_REF = "cachecachecachecache";
const FILE_ONLY_REF = "filefilefilefilefile";
const POSITIONAL_REF = "positionalrefaaaaaaa";

const LINK_BRANCH: LegacyLinkBranch = {
  id: "11111111-2222-4333-8444-555555555555",
  name: "feature-branch",
  project_ref: BRANCH_PROJECT_REF,
  parent_project_ref: PARENT_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: true,
};

const LINK_BRANCH_OTHER: LegacyLinkBranch = {
  ...LINK_BRANCH,
  id: "44444444-5555-4666-8777-888888888888",
  name: "other-branch",
  project_ref: OTHER_BRANCH_PROJECT_REF,
};

// A DEFAULT branch's `project_ref` IS the parent's own ref (PR #6168 review) —
// `getProject(ref)` therefore returns 200 for it, routing telemetry into the
// normal 200 arm rather than the 404 `else if (branchResolution)` arm.
const LINK_BRANCH_DEFAULT: LegacyLinkBranch = {
  ...LINK_BRANCH,
  id: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
  name: "main",
  project_ref: PARENT_REF,
  is_default: true,
};

const LINK_BRANCH_ZETA: LegacyLinkBranch = {
  ...LINK_BRANCH,
  id: "22222222-3333-4444-8555-666666666666",
  name: "zeta",
};

const LINK_BRANCH_ALPHA: LegacyLinkBranch = {
  ...LINK_BRANCH,
  id: "33333333-4444-4555-8666-777777777777",
  name: "alpha",
};

const LINK_BRANCH_STAGING: LegacyLinkBranch = {
  ...LINK_BRANCH,
  id: "55555555-6666-4777-8888-999999999999",
  name: "staging",
};

// `status: CREATING_PROJECT` with an empty `project_ref` — the branch exists
// but hasn't finished provisioning yet.
const LINK_BRANCH_NOT_READY: LegacyLinkBranch = {
  ...LINK_BRANCH,
  id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  project_ref: "",
  status: "CREATING_PROJECT",
};

function manyBranches(count: number): LegacyLinkBranches {
  return Array.from({ length: count }, (_, i) => ({
    ...LINK_BRANCH,
    id: `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
    name: `branch-${i.toString().padStart(2, "0")}`,
  }));
}

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
  branches?: V1StubResult;
  tenant?: "ok" | "fail";
  restVersion?: string;
  gotrueVersion?: string;
  storageVersion?: string;
  projectId?: Option.Option<string>;
  analytics?: ReturnType<typeof mockAnalytics>;
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
  const analytics = opts.analytics ?? mockAnalytics();
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedCache = mockLegacyLinkedProjectCacheTracked();
  const apiMock = mockLegacyPlatformApiService({
    v1: {
      getProject: stub(opts.project, HEALTHY_PROJECT),
      getProjectApiKeys: stub(opts.apiKeys, SERVICE_KEYS),
      getStorageConfig: stub(opts.storageConfig, { migrationVersion: "2026-01-01-000000" }),
      getPoolerConfig: stub(opts.poolerConfig, POOLER_PRIMARY),
      listAllBranches: stub(opts.branches, []),
    },
  });
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    projectId: opts.projectId ?? Option.none(),
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
  refOrBranch: Option.none(),
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

function existsTemp(workdir: string, name: string): boolean {
  return existsSync(tempFile(workdir, name));
}

function writeTempContent(workdir: string, name: string, content: string): void {
  mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
  writeFileSync(tempFile(workdir, name), content);
}

// Seeds `<workdir>/supabase/.temp/project-ref` — the 3rd-priority parent
// candidate for a branch-name lookup, and also the file `resolver.resolveForLink`
// falls back to for a plain ref link.
function writeLinkedParentRef(workdir: string, ref: string): void {
  writeTempContent(workdir, "project-ref", ref);
}

// Seeds `<workdir>/supabase/.temp/linked-project.json` — the 2nd-priority parent
// candidate. Real content shape mirrors what `legacyLink`'s own success path writes.
function writeLinkedProjectCacheFile(workdir: string, content: string): void {
  writeTempContent(workdir, "linked-project.json", content);
}

function linkedProjectCacheJson(ref: string): string {
  return JSON.stringify({
    ref,
    name: "Parent Project",
    organization_id: "org_123",
    organization_slug: "acme",
  });
}

function legacyTransportFailureForMock() {
  return legacyTransportFailure(HttpClientRequestModule.get("https://api.supabase.com/mock"));
}

// `withLegacyCommandInstrumentation` threads `flags`/`command`/etc. through
// `CurrentAnalyticsContext`, not the direct `capture()` call args — mirrors the
// identical local helper in `functions/download/download.integration.test.ts`
// and `legacy-command-instrumentation.unit.test.ts`. The shared `mockAnalytics()`
// deliberately doesn't merge this context (most callers don't need it), but
// `legacyLink`'s own `withAnalyticsContext({ groups: { project: ref } })` call
// (CLI-2167 branch-link telemetry) needs it merged to assert on `groups`.
// Shape-compatible with `mockAnalytics()`'s return (adds `identified`/`aliased`/
// `groupIdentified` tracking) so it's a drop-in `SetupOpts.analytics` override.
function mockContextualAnalytics(): ReturnType<typeof mockAnalytics> {
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const identified: Array<{ distinctId: string; properties: Record<string, unknown> }> = [];
  const aliased: Array<{ distinctId: string; alias: string }> = [];
  const groupIdentified: Array<{
    groupType: string;
    groupKey: string;
    properties: Record<string, unknown>;
  }> = [];
  const layer = Layer.succeed(
    Analytics,
    Analytics.of({
      capture: (event: string, properties: Record<string, unknown> = {}) =>
        Effect.gen(function* () {
          const context = yield* CurrentAnalyticsContext;
          captured.push({ event, properties: { ...context, ...properties } });
        }),
      identify: (distinctId: string, properties: Record<string, unknown> = {}) =>
        Effect.sync(() => {
          identified.push({ distinctId, properties });
        }),
      alias: (distinctId: string, alias: string) =>
        Effect.sync(() => {
          aliased.push({ distinctId, alias });
        }),
      groupIdentify: (
        groupType: string,
        groupKey: string,
        properties: Record<string, unknown> = {},
      ) =>
        Effect.sync(() => {
          groupIdentified.push({ groupType, groupKey, properties });
        }),
    }),
  );
  return { layer, captured, identified, aliased, groupIdentified };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy link integration", () => {
  describe("plain project-ref linking", () => {
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
        // A plain (non-branch) ref link never carries the CLI-2167 branch-link
        // telemetry extension.
        const capture = analytics.captured.find((c) => c.event === "cli_project_linked");
        expect(capture?.properties).not.toHaveProperty("linked_via");
        expect(capture?.properties).not.toHaveProperty("parent_project_ref");
      }).pipe(Effect.provide(layer));
    });

    it.live("resolves the ref from SUPABASE_PROJECT_ID when no flag is given", () => {
      const { layer, workdir } = setup({ projectId: Option.some(LEGACY_VALID_REF) });
      return Effect.gen(function* () {
        yield* legacyLink(flags({ projectRef: Option.none() }));
        expect(readTemp(workdir, "project-ref")).toBe(LEGACY_VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.live("positional valid ref beats SUPABASE_PROJECT_ID as the link target", () => {
      const { layer, workdir } = setup({ projectId: Option.some(LEGACY_VALID_REF) });
      return Effect.gen(function* () {
        yield* legacyLink(
          flags({ refOrBranch: Option.some(POSITIONAL_REF), projectRef: Option.none() }),
        );
        expect(readTemp(workdir, "project-ref")).toBe(POSITIONAL_REF);
      }).pipe(Effect.provide(layer));
    });

    it.live("fails in non-TTY with no --project-ref and no PROJECT_ID", () => {
      const { layer } = setup();
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

    it.live(
      "fails with LegacyInvalidProjectRefError for a malformed ref from SUPABASE_PROJECT_ID (env stays strict)",
      () => {
        const { layer } = setup({ projectId: Option.some("BADREF") });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyLink(flags({ projectRef: Option.none() })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
          }
        }).pipe(Effect.provide(layer));
      },
    );

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
        // This is a plain ref link that happens to 404 (assumed to be a branch),
        // with NO name/UUID resolution — `branchResolution` never fired, so the
        // CLI-2167 branch-link telemetry extension doesn't fire either. Emits
        // nothing at all for `cli_project_linked`, unlike the resolved-branch
        // case (see "branch-name resolution: telemetry" below).
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
      writeTempContent(workdir, "pooler-url", "stale-pooler-url");
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
      const cliConfig = mockLegacyCliConfig({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
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
        expect(success?.data).not.toHaveProperty("branch");
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

  describe("ref-or-branch argument conflicts", () => {
    it.live(
      "fails with LegacyLinkRefArgConflictError when both the positional and --project-ref are set",
      () => {
        const { layer, telemetry, linkedCache } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(flags({ refOrBranch: Option.some(LEGACY_VALID_REF) })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyLinkRefArgConflictError");
            expect(json).toContain(
              "Cannot use both the [ref-or-branch] argument and the --project-ref flag.",
            );
          }
          // PR #6168 review: this check now sits INSIDE the `Effect.ensuring`
          // wrapper too — previously the earliest possible failure in the
          // handler, exiting before telemetry's finalizer was ever reached.
          expect(telemetry.flushed).toBe(true);
          expect(linkedCache.cached).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "treats an empty-string positional as absent, falling through to the no-value behavior",
      () => {
        const { layer } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(flags({ refOrBranch: Option.some(""), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyProjectRefRequiredError");
            expect(json).toContain(`required flag(s) \\"project-ref\\" not set`);
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "treats an empty-string --project-ref as absent, falling through to the no-value behavior",
      () => {
        const { layer } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyLink(flags({ projectRef: Option.some("") })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyProjectRefRequiredError");
            expect(json).toContain(`required flag(s) \\"project-ref\\" not set`);
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "an empty-string positional alongside a real --project-ref links normally (no conflict)",
      () => {
        const { layer, workdir } = setup();
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some(""), projectRef: Option.some(LEGACY_VALID_REF) }),
          );
          expect(readTemp(workdir, "project-ref")).toBe(LEGACY_VALID_REF);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "links directly from a positional ref argument without calling the branches endpoint",
      () => {
        const { layer, workdir, apiMock } = setup();
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some(LEGACY_VALID_REF), projectRef: Option.none() }),
          );
          expect(readTemp(workdir, "project-ref")).toBe(LEGACY_VALID_REF);
          expect(apiMock.requests.map((r) => r.method)).not.toContain("listAllBranches");
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("branch-name resolution: parent chain", () => {
    it.live(
      "THE HEADLINE REGRESSION: relinking a different branch resolves via the cached real parent, not the previously-linked branch ref",
      () => {
        // Simulate the state left behind by a PRIOR `supabase link feature-branch`:
        // project-ref holds the branch's own ref, but linked-project.json still
        // holds the real parent (untouched, since branch links 404 on getProject).
        const { layer, workdir, apiMock } = setup({
          branches: { ok: [LINK_BRANCH, LINK_BRANCH_OTHER] },
          project: { fail: legacyStatusCodeFailure(404) },
        });
        writeLinkedParentRef(workdir, BRANCH_PROJECT_REF);
        writeLinkedProjectCacheFile(workdir, linkedProjectCacheJson(PARENT_REF));
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some("other-branch"), projectRef: Option.none() }),
          );
          const branchCall = apiMock.requests.find((r) => r.method === "listAllBranches");
          // The dealbreaker bug: this must be the PARENT ref, never BRANCH_PROJECT_REF.
          expect(branchCall?.input).toMatchObject({ ref: PARENT_REF });
          expect(readTemp(workdir, "project-ref")).toBe(OTHER_BRANCH_PROJECT_REF);
          // The 404 branch-link path leaves the cache untouched — the invariant a
          // THIRD relink still depends on.
          expect(readTemp(workdir, "linked-project.json")).toBe(linkedProjectCacheJson(PARENT_REF));
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "SUPABASE_PROJECT_ID wins over both the cache file and the project-ref file when ref-shaped",
      () => {
        const { layer, apiMock } = setup({
          branches: { ok: [LINK_BRANCH] },
          projectId: Option.some(PARENT_REF),
        });
        const workdir = tempRoot.current;
        writeLinkedProjectCacheFile(workdir, linkedProjectCacheJson(CACHE_ONLY_REF));
        writeLinkedParentRef(workdir, FILE_ONLY_REF);
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
          );
          const branchCall = apiMock.requests.find((r) => r.method === "listAllBranches");
          expect(branchCall?.input).toMatchObject({ ref: PARENT_REF });
          expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a garbage SUPABASE_PROJECT_ID falls through to the cache file, not the project-ref file (first-VALID-wins)",
      () => {
        const { layer, apiMock, workdir } = setup({
          branches: { ok: [LINK_BRANCH] },
          projectId: Option.some("not-a-valid-ref"),
        });
        writeLinkedProjectCacheFile(workdir, linkedProjectCacheJson(CACHE_ONLY_REF));
        writeLinkedParentRef(workdir, FILE_ONLY_REF);
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
          );
          const branchCall = apiMock.requests.find((r) => r.method === "listAllBranches");
          expect(branchCall?.input).toMatchObject({ ref: CACHE_ONLY_REF });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "degrades to the project-ref file when the linked-project.json cache is unreadable or has no usable ref",
      () => {
        const { layer, apiMock, workdir } = setup({ branches: { ok: [LINK_BRANCH] } });
        const corruptCacheContents = [
          "not json at all {",
          "null",
          JSON.stringify({ notRef: "x" }),
          JSON.stringify({ ref: 12345 }),
          JSON.stringify({ ref: "" }),
        ];
        return Effect.gen(function* () {
          for (const content of corruptCacheContents) {
            // Re-seed on every iteration: a successful link overwrites project-ref
            // with the resolved branch ref, so the prior iteration's own write
            // would otherwise clobber this fixture before the next check runs.
            writeLinkedParentRef(workdir, FILE_ONLY_REF);
            writeLinkedProjectCacheFile(workdir, content);
            yield* legacyLink(
              flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
            );
            const branchCall = apiMock.requests
              .filter((r) => r.method === "listAllBranches")
              .at(-1);
            expect(branchCall?.input).toMatchObject({ ref: FILE_ONLY_REF });
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails with LegacyLinkParentRefInvalidError when a parent candidate exists but none is ref-shaped",
      () => {
        const { layer, workdir, apiMock } = setup();
        writeLinkedParentRef(workdir, "not-a-real-ref!!");
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(
              flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyLinkParentRefInvalidError");
            expect(json).toContain(
              `Cannot resolve branch \\"feature-branch\\": the linked project ref is invalid`,
            );
            expect(json).toContain("Relink the parent project first: supabase link --project-ref");
          }
          // The invalid parent is rejected before any API call is attempted.
          expect(apiMock.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails with LegacyLinkBranchNotLinkedError when no parent candidate exists anywhere",
      () => {
        const { layer, apiMock } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(
              flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyLinkBranchNotLinkedError");
            expect(json).toContain(`Cannot resolve \\"feature-branch\\": it is not a project ref`);
            expect(json).toContain(
              "If it is a branch name, link the parent project first: supabase link --project-ref",
            );
          }
          expect(apiMock.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "cache alone (linked-project.json with no project-ref file) is never proof of a link: fails with LegacyLinkBranchNotLinkedError, no API call (PR #6168 review)",
      () => {
        const { layer, apiMock, workdir } = setup();
        // Simulates a FAILED prior `link --project-ref <parent>`: `getProject`
        // returned 200 (so `linked-project.json` got written via the failure
        // arm's `Effect.ensuring`) but a later step failed before `project-ref`
        // itself was ever written. That stale cache entry must never be trusted
        // as parent-resolution evidence for a NEW branch lookup.
        writeLinkedProjectCacheFile(workdir, linkedProjectCacheJson(PARENT_REF));
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(
              flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyLinkBranchNotLinkedError");
            expect(json).toContain(`Cannot resolve \\"feature-branch\\": it is not a project ref`);
          }
          expect(apiMock.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "treats an unreadable project-ref path (e.g. a directory) as no candidate rather than failing",
      () => {
        const { layer, workdir, apiMock } = setup();
        // A directory at the project-ref path makes `fs.readFileString` fail with
        // a real (non-not-exist) read error, exercising the defensive fallback
        // distinct from the plain "file missing" case.
        mkdirSync(tempFile(workdir, "project-ref"), { recursive: true });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(
              flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyLinkBranchNotLinkedError");
          }
          expect(apiMock.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("branch-name resolution: 404-path cache write/invalidation (PR #6168 review)", () => {
    it.live(
      "name-resolved branch link with no cache file (P1 fix): persists {ref: parentRef}, and a follow-up branch resolution proves the parent chain survives",
      () => {
        const { layer, workdir, apiMock } = setup({
          branches: { ok: [LINK_BRANCH, LINK_BRANCH_OTHER] },
          project: { fail: legacyStatusCodeFailure(404) },
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
          );
          expect(readTemp(workdir, "linked-project.json")).toBe(
            JSON.stringify({ ref: PARENT_REF }),
          );

          // Follow-up: a second branch-name link must still resolve via the
          // parent this write just persisted — proving it's real parent-chain
          // evidence, not a dead write. `project-ref` was overwritten to the
          // first branch's own ref by the first call, so this also proves the
          // cache (not the file) is what a second resolution actually used.
          yield* legacyLink(
            flags({ refOrBranch: Option.some("other-branch"), projectRef: Option.none() }),
          );
          const branchCalls = apiMock.requests.filter((r) => r.method === "listAllBranches");
          expect(branchCalls.at(-1)?.input).toMatchObject({ ref: PARENT_REF });
          expect(readTemp(workdir, "project-ref")).toBe(OTHER_BRANCH_PROJECT_REF);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "name-resolved branch link whose cache already agrees with the parent: cache left byte-identical (richer record not clobbered by the ref-only write)",
      () => {
        const { layer, workdir } = setup({
          branches: { ok: [LINK_BRANCH] },
          project: { fail: legacyStatusCodeFailure(404) },
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        const richCache = linkedProjectCacheJson(PARENT_REF);
        writeLinkedProjectCacheFile(workdir, richCache);
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
          );
          expect(readTemp(workdir, "linked-project.json")).toBe(richCache);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "raw ref-shaped 404 link whose ref IS among the stale cache's branches: keeps the cache, link still succeeds",
      () => {
        const { layer, workdir, apiMock } = setup({
          project: { fail: legacyStatusCodeFailure(404) },
          branches: { ok: [LINK_BRANCH] },
        });
        const cacheContent = linkedProjectCacheJson(CACHE_ONLY_REF);
        writeLinkedProjectCacheFile(workdir, cacheContent);
        return Effect.gen(function* () {
          yield* legacyLink(flags({ projectRef: Option.some(BRANCH_PROJECT_REF) }));
          expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
          expect(readTemp(workdir, "linked-project.json")).toBe(cacheContent);
          const branchCall = apiMock.requests.find((r) => r.method === "listAllBranches");
          expect(branchCall?.input).toMatchObject({ ref: CACHE_ONLY_REF });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "raw ref-shaped 404 link whose ref is NOT among the stale cache's branches: deletes the cache, link still succeeds",
      () => {
        const { layer, workdir } = setup({
          project: { fail: legacyStatusCodeFailure(404) },
          branches: { ok: [LINK_BRANCH_OTHER] },
        });
        writeLinkedProjectCacheFile(workdir, linkedProjectCacheJson(CACHE_ONLY_REF));
        return Effect.gen(function* () {
          yield* legacyLink(flags({ projectRef: Option.some(BRANCH_PROJECT_REF) }));
          expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
          expect(existsSync(tempFile(workdir, "linked-project.json"))).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "raw ref-shaped 404 link where the correlation lookup itself fails: DELETES the unverified cache, link still succeeds (fail-safe, PR #6168 review)",
      () => {
        // Superseded behavior: an unverifiable divergent cache used to be
        // kept. Fail-safe wins — a wrong parent claim silently misdirects
        // parent-scoped mutations, while deletion just downgrades later
        // branches commands to a loud, recoverable not-linked error.
        const { layer, workdir } = setup({
          project: { fail: legacyStatusCodeFailure(404) },
          branches: { fail: legacyStatusCodeFailure(500) },
        });
        const cacheContent = linkedProjectCacheJson(CACHE_ONLY_REF);
        writeLinkedProjectCacheFile(workdir, cacheContent);
        return Effect.gen(function* () {
          yield* legacyLink(flags({ projectRef: Option.some(BRANCH_PROJECT_REF) }));
          expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
          expect(existsTemp(workdir, "linked-project.json")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("branch-name resolution: matching and safety", () => {
    it.live(
      "resolves a positional branch name via the parent linked in the project-ref temp file",
      () => {
        const { layer, workdir, apiMock } = setup({ branches: { ok: [LINK_BRANCH] } });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
          );
          expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
          const branchRequest = apiMock.requests.find((r) => r.method === "listAllBranches");
          expect(branchRequest?.input).toMatchObject({ ref: PARENT_REF });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "resolves a branch name passed via --project-ref using the same linked-parent lookup",
      () => {
        const { layer, workdir } = setup({ branches: { ok: [LINK_BRANCH] } });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* legacyLink(flags({ projectRef: Option.some("feature-branch") }));
          expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("resolves a branch by its UUID", () => {
      const { layer, workdir } = setup({ branches: { ok: [LINK_BRANCH] } });
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        yield* legacyLink(
          flags({ refOrBranch: Option.some(LINK_BRANCH.id), projectRef: Option.none() }),
        );
        expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
      }).pipe(Effect.provide(layer));
    });

    it.live("resolves a branch by an UPPERCASE-hex UUID spelling (PR #6168 review)", () => {
      const { layer, workdir } = setup({ branches: { ok: [LINK_BRANCH] } });
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        yield* legacyLink(
          flags({
            refOrBranch: Option.some(LINK_BRANCH.id.toUpperCase()),
            projectRef: Option.none(),
          }),
        );
        expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "fails with LegacyLinkBranchNotReadyError and never falls through to link the parent, even with SUPABASE_PROJECT_ID set",
      () => {
        const { layer, workdir, apiMock } = setup({
          branches: { ok: [LINK_BRANCH_NOT_READY] },
          projectId: Option.some(PARENT_REF),
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(
              flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyLinkBranchNotReadyError");
            expect(json).toContain(
              `Branch \\"feature-branch\\" has no project ref yet (status: CREATING_PROJECT)`,
            );
          }
          // No project-ref written, and no attempt to link the parent (env) ref instead.
          expect(existsSync(tempFile(workdir, "project-ref"))).toBe(false);
          expect(apiMock.requests).toEqual([
            { method: "listAllBranches", input: { ref: PARENT_REF } },
          ]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("a failed branch lookup leaves an existing project-ref file untouched", () => {
      const { layer, workdir } = setup({ branches: { ok: [LINK_BRANCH] } });
      // The project-ref file doubles as both "the existing link" and the parent
      // candidate for this lookup — a realistic prior-link state.
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyLink(
            flags({ refOrBranch: Option.some("does-not-exist"), projectRef: Option.none() }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(readTemp(workdir, "project-ref")).toBe(PARENT_REF);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("branch-name resolution: message variants", () => {
    it.live("caps the available-branches list at 20 names with a remainder count", () => {
      const { layer, workdir } = setup({ branches: { ok: manyBranches(25) } });
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyLink(
            flags({ refOrBranch: Option.some("does-not-exist"), projectRef: Option.none() }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("LegacyLinkBranchNotFoundError");
          expect(json).toContain("branch-00");
          expect(json).toContain("branch-19");
          expect(json).not.toContain("branch-20");
          expect(json).toContain("… (5 more — run supabase branches list)");
        }
      }).pipe(Effect.provide(layer));
    });

    it.live('suggests a case-insensitive near-miss ("Did you mean")', () => {
      const { layer, workdir } = setup({
        branches: { ok: [LINK_BRANCH, LINK_BRANCH_STAGING] },
      });
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyLink(flags({ refOrBranch: Option.some("Staging"), projectRef: Option.none() })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain(`Did you mean \\"staging\\"?`);
          // "Staging" has an uppercase letter, so no ref-typo hint.
          expect(json).not.toContain("If you meant a project ref");
        }
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "includes a ref-typo hint for an all-lowercase value not found in an empty branch list",
      () => {
        const { layer, workdir } = setup({ branches: { ok: [] } });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(
              flags({ refOrBranch: Option.some("missingbranch"), projectRef: Option.none() }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyLinkBranchNotFoundError");
            expect(json).toContain(
              `Branch \\"missingbranch\\" not found: project ${PARENT_REF} has no branches.`,
            );
            expect(json).toContain(
              `If you meant a project ref: refs are exactly 20 lowercase letters (\\"missingbranch\\" has 13).`,
            );
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("omits the ref-typo hint when the value is not purely lowercase letters", () => {
      const { layer, workdir } = setup({ branches: { ok: [LINK_BRANCH] } });
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyLink(flags({ refOrBranch: Option.some("my-branch"), projectRef: Option.none() })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("LegacyLinkBranchNotFoundError");
          expect(json).toContain(`Branch \\"my-branch\\" not found for project ${PARENT_REF}.`);
          expect(json).not.toContain("If you meant a project ref");
        }
      }).pipe(Effect.provide(layer));
    });

    it.live("lists sorted available branch names when the branch is not found", () => {
      const { layer, workdir, telemetry, linkedCache } = setup({
        branches: { ok: [LINK_BRANCH_ZETA, LINK_BRANCH_ALPHA] },
      });
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyLink(
            flags({ refOrBranch: Option.some("missing-branch"), projectRef: Option.none() }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("LegacyLinkBranchNotFoundError");
          expect(json).toContain(
            `Branch \\"missing-branch\\" not found for project ${PARENT_REF}. Available branches: alpha, zeta`,
          );
        }
        // PR #6168 review: a branch-name resolution failure now sits INSIDE the
        // `Effect.ensuring` wrapper, so telemetry still flushes even though the
        // link itself never reached ref resolution — previously this failure
        // exited before the wrapper was ever reached, and telemetry silently
        // never flushed. `ref` itself never resolved, so the linked-project
        // cache fill correctly stays a no-op.
        expect(telemetry.flushed).toBe(true);
        expect(linkedCache.cached).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "surfaces a dedicated message when listing branches 404s (parent may itself be a branch)",
      () => {
        const { layer, workdir } = setup({ branches: { fail: legacyStatusCodeFailure(404) } });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(
              flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyLinkBranchListStatusError");
            expect(json).toContain(`Cannot list branches for project ${PARENT_REF} (HTTP 404)`);
            expect(json).toContain(
              `If ${PARENT_REF} is itself a preview branch, link its parent project first: supabase link --project-ref`,
            );
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails with LegacyLinkBranchListStatusError when listing branches returns a non-200, non-404 status",
      () => {
        const { layer, workdir } = setup({ branches: { fail: legacyStatusCodeFailure(500) } });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(
              flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyLinkBranchListStatusError");
            expect(json).toContain("unexpected list branches status 500");
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails with LegacyLinkBranchListNetworkError when listing branches fails at the transport layer",
      () => {
        const { layer, workdir } = setup({ branches: { fail: legacyTransportFailureForMock() } });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(
              flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyLinkBranchListNetworkError");
            expect(json).toContain("failed to list branches:");
          }
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("branch-name resolution: output contract", () => {
    it.live(
      "text mode: shows the Resolving branch... spinner, writes the resolved line to stderr, and keeps stdout to the Finished line",
      () => {
        const { layer, out, workdir } = setup({ branches: { ok: [LINK_BRANCH] } });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
          );
          expect(out.progressEvents).toContainEqual({
            type: "start",
            message: "Resolving branch...",
          });
          expect(out.stderrText).toBe(
            `Resolved branch "feature-branch" of project ${PARENT_REF} to project ref ${BRANCH_PROJECT_REF}.\n`,
          );
          expect(out.stdoutText).toBe("Finished supabase link.\n");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "json mode: emits branch + parent_project_ref in the success payload with zero progress events",
      () => {
        const { layer, out, workdir } = setup({
          format: "json",
          branches: { ok: [LINK_BRANCH] },
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
          );
          expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
          const success = out.messages.find((m) => m.type === "success");
          expect(success?.data).toMatchObject({
            project_ref: BRANCH_PROJECT_REF,
            branch: "feature-branch",
            parent_project_ref: PARENT_REF,
          });
          expect(out.progressEvents).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "json mode: a branch-list failure produces zero progress events (spinner suppressed)",
      () => {
        const { layer, out, workdir } = setup({
          format: "json",
          branches: { fail: legacyStatusCodeFailure(500) },
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyLink(
              flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LegacyLinkBranchListStatusError");
          }
          expect(out.progressEvents).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("stream-json mode: emits branch + parent_project_ref in the success payload", () => {
      const { layer, out, workdir } = setup({
        format: "stream-json",
        branches: { ok: [LINK_BRANCH] },
      });
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        yield* legacyLink(
          flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
        );
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({
          project_ref: BRANCH_PROJECT_REF,
          branch: "feature-branch",
          parent_project_ref: PARENT_REF,
        });
      }).pipe(Effect.provide(layer));
    });
  });

  describe("branch-name resolution: telemetry", () => {
    it.live(
      "fires cli_project_linked with linked_via/parent_project_ref and a project group, no groupIdentify, and never the branch name",
      () => {
        const analytics = mockContextualAnalytics();
        const { layer, workdir } = setup({
          branches: { ok: [LINK_BRANCH] },
          analytics,
          // A branch's own project ref always 404s on `getProject` (it isn't a
          // real top-level project) — this is what routes telemetry into the
          // CLI-2167 `else if (branchResolution)` branch instead of the plain
          // `if (project)` branch.
          project: { fail: legacyStatusCodeFailure(404) },
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* legacyLink(
            flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
          );
          const capture = analytics.captured.find((c) => c.event === "cli_project_linked");
          const properties = capture?.properties as { groups?: unknown } | undefined;
          expect(properties).toMatchObject({
            linked_via: "branch",
            parent_project_ref: PARENT_REF,
          });
          expect(properties?.groups).toEqual({ project: BRANCH_PROJECT_REF });
          expect(analytics.groupIdentified).toHaveLength(0);
          // The branch NAME is user-created content and must never leave the
          // machine in any captured analytics payload.
          expect(JSON.stringify(analytics.captured)).not.toContain("feature-branch");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "default-branch link (getProject(parent) returns 200): the normal 200 arm ALSO carries linked_via/parent_project_ref, plus its usual org/project groupIdentify richness (PR #6168 review)",
      () => {
        const analytics = mockContextualAnalytics();
        const { layer, workdir } = setup({
          branches: { ok: [LINK_BRANCH_DEFAULT] },
          analytics,
          // No `project` override — `HEALTHY_PROJECT.ref === PARENT_REF`, so
          // `getProject(PARENT_REF)` returns 200 here, unlike the 404 test
          // above: a default branch's own `project_ref` IS the parent's ref.
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* legacyLink(flags({ refOrBranch: Option.some("main"), projectRef: Option.none() }));
          const captures = analytics.captured.filter((c) => c.event === "cli_project_linked");
          expect(captures).toHaveLength(1);
          const properties = captures[0]?.properties as { groups?: unknown } | undefined;
          expect(properties).toMatchObject({
            linked_via: "branch",
            parent_project_ref: PARENT_REF,
          });
          expect(properties?.groups).toEqual({ organization: "org_123", project: PARENT_REF });
          // The normal 200 arm's usual richness is untouched by the extension.
          expect(analytics.groupIdentified).toEqual([
            {
              groupType: "organization",
              groupKey: "org_123",
              properties: { organization_slug: "acme" },
            },
            {
              groupType: "project",
              groupKey: PARENT_REF,
              properties: { name: "My Project", organization_slug: "acme" },
            },
          ]);
          expect(JSON.stringify(analytics.captured)).not.toContain('"main"');
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("telemetry: --project-ref redaction (CLI-2167)", () => {
    it.live(
      "does not redact --project-ref in cli_command_executed when it is ref-shaped (Go parity: cmd/link.go:52)",
      () => {
        const out = mockOutput({ format: "text" });
        const analytics = mockContextualAnalytics();
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
          projectId: Option.none(),
        });
        const layer = Layer.mergeAll(
          buildLegacyTestRuntime({
            out,
            api: { layer: apiMock.layer, httpClientLayer: tenantHttpLayer({}) },
            cliConfig,
            analytics,
          }),
          commandRuntimeLayer(["link"]),
          Stdio.layerTest({
            args: Effect.succeed(["link", "--project-ref", LEGACY_VALID_REF]),
          }),
        );
        return Effect.gen(function* () {
          yield* legacyLinkHandler(flags({ projectRef: Option.some(LEGACY_VALID_REF) }));
          const event = analytics.captured.find((c) => c.event === "cli_command_executed");
          expect(event?.properties.flags).toEqual({ "project-ref": LEGACY_VALID_REF });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "redacts --project-ref in cli_command_executed when it is a branch name, not a ref",
      () => {
        const out = mockOutput({ format: "text" });
        const analytics = mockContextualAnalytics();
        const apiMock = mockLegacyPlatformApiService({ v1: {} });
        const cliConfig = mockLegacyCliConfig({
          workdir: tempRoot.current,
          projectId: Option.none(),
        });
        const layer = Layer.mergeAll(
          buildLegacyTestRuntime({
            out,
            api: { layer: apiMock.layer, httpClientLayer: tenantHttpLayer({}) },
            cliConfig,
            analytics,
          }),
          commandRuntimeLayer(["link"]),
          Stdio.layerTest({
            args: Effect.succeed(["link", "--project-ref", "my-branch"]),
          }),
        );
        return Effect.gen(function* () {
          yield* Effect.exit(legacyLinkHandler(flags({ projectRef: Option.some("my-branch") })));
          const event = analytics.captured.find((c) => c.event === "cli_command_executed");
          expect(event?.properties.flags).toEqual({ "project-ref": "<redacted>" });
        }).pipe(Effect.provide(layer));
      },
    );
  });
});
