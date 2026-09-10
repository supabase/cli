import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Effect, Exit, Layer, Option, Stdio } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequestModule from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import {
  mockAnalytics,
  mockContextualAnalytics,
  mockOutput,
} from "../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  statusCodeFailure,
  transportFailure,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { link } from "./link.handler.ts";
import { linkHandler } from "./link.command.ts";
import type { LinkFlags } from "./link.command.ts";

const HEALTHY_PROJECT = {
  id: VALID_REF,
  ref: VALID_REF,
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

type LinkBranches = typeof V1ListAllBranchesOutput.Type;
type LinkBranch = LinkBranches[number];

// The currently-linked parent project's ref (env / cache / temp-file candidate).
const PARENT_REF = VALID_REF;
// Distinct 20-lowercase-letter refs used to disambiguate which parent
// candidate (env / linked-project.json cache / project-ref file) won.
const BRANCH_PROJECT_REF = "branchprojectrefabcd";
const OTHER_BRANCH_PROJECT_REF = "otherbranchprojectre";
const CACHE_ONLY_REF = "cachecachecachecache";
const FILE_ONLY_REF = "filefilefilefilefile";
const POSITIONAL_REF = "positionalrefaaaaaaa";

const LINK_BRANCH: LinkBranch = {
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

const LINK_BRANCH_OTHER: LinkBranch = {
  ...LINK_BRANCH,
  id: "44444444-5555-4666-8777-888888888888",
  name: "other-branch",
  project_ref: OTHER_BRANCH_PROJECT_REF,
};

// A default branch's `project_ref` is the parent's own ref, so `getProject(ref)` returns 200
// for it, routing telemetry into the normal 200 arm rather than the 404 branch arm.
const LINK_BRANCH_DEFAULT: LinkBranch = {
  ...LINK_BRANCH,
  id: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
  name: "main",
  project_ref: PARENT_REF,
  is_default: true,
};

const LINK_BRANCH_ZETA: LinkBranch = {
  ...LINK_BRANCH,
  id: "22222222-3333-4444-8555-666666666666",
  name: "zeta",
};

const LINK_BRANCH_ALPHA: LinkBranch = {
  ...LINK_BRANCH,
  id: "33333333-4444-4555-8666-777777777777",
  name: "alpha",
};

const LINK_BRANCH_STAGING: LinkBranch = {
  ...LINK_BRANCH,
  id: "55555555-6666-4777-8888-999999999999",
  name: "staging",
};

// `status: CREATING_PROJECT` with an empty `project_ref`: not finished provisioning yet.
const LINK_BRANCH_NOT_READY: LinkBranch = {
  ...LINK_BRANCH,
  id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  project_ref: "",
  status: "CREATING_PROJECT",
};

function manyBranches(count: number): LinkBranches {
  return Array.from({ length: count }, (_, i) => ({
    ...LINK_BRANCH,
    id: `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
    name: `branch-${i.toString().padStart(2, "0")}`,
  }));
}

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

const tempRoot = useTempWorkdir("supabase-link-int-");

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
          return yield* Effect.fail(transportFailure(request));
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
  const telemetry = mockTelemetryStateTracked();
  const linkedCache = mockLinkedProjectCacheTracked();
  const apiMock = mockCommandPlatformApiService({
    v1: {
      getProject: stub(opts.project, HEALTHY_PROJECT),
      getProjectApiKeys: stub(opts.apiKeys, SERVICE_KEYS),
      getStorageConfig: stub(opts.storageConfig, { migrationVersion: "2026-01-01-000000" }),
      getPoolerConfig: stub(opts.poolerConfig, POOLER_PRIMARY),
      listAllBranches: stub(opts.branches, []),
    },
  });
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    projectId: opts.projectId ?? Option.none(),
  });
  const layer = buildTestRuntime({
    out,
    api: { layer: apiMock.layer, httpClientLayer: tenantHttpLayer(opts) },
    cliSettings,
    analytics,
    telemetry: telemetry.layer,
    linkedProjectCache: linkedCache.layer,
  });
  return { layer, out, analytics, telemetry, linkedCache, apiMock, workdir: tempRoot.current };
}

const flags = (overrides: Partial<LinkFlags> = {}): LinkFlags => ({
  refOrBranch: Option.none(),
  projectRef: Option.some(VALID_REF),
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

// Seeds the 3rd-priority parent candidate for a branch-name lookup, and the file
// `resolver.resolveForLink` falls back to for a plain ref link.
function writeLinkedParentRef(workdir: string, ref: string): void {
  writeTempContent(workdir, "project-ref", ref);
}

// Seeds the 2nd-priority parent candidate, in the shape `link`'s own success path writes.
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

function transportFailureForMock() {
  return transportFailure(HttpClientRequestModule.get("https://api.supabase.com/mock"));
}

describe("link integration", () => {
  describe("plain project-ref linking", () => {
    it.live("links a project, writing the project-ref and version files", () => {
      const { layer, out, workdir } = setup();
      return Effect.gen(function* () {
        yield* link(flags());
        expect(readTemp(workdir, "project-ref")).toBe(VALID_REF);
        expect(readTemp(workdir, "postgres-version")).toBe("15.1.0.117");
        expect(readTemp(workdir, "storage-migration")).toBe("2026-01-01-000000");
        expect(readTemp(workdir, "rest-version")).toBe("v11.1.0");
        expect(readTemp(workdir, "gotrue-version")).toBe("v2.74.2");
        expect(readTemp(workdir, "storage-version")).toBe("v1.28.0");
        expect(readTemp(workdir, "pooler-url")).toBe(
          "postgresql://postgres.ref@pooler.example.co:5432/postgres",
        );
        expect(out.stdoutText).toContain("Finished supabase link.");
      }).pipe(Effect.provide(layer));
    });

    it.live("writes linked-project.json with ref/name/org metadata", () => {
      const { layer, workdir } = setup();
      return Effect.gen(function* () {
        yield* link(flags());
        const linked = JSON.parse(readTemp(workdir, "linked-project.json"));
        expect(linked).toEqual({
          ref: VALID_REF,
          name: "My Project",
          organization_id: "org_123",
          organization_slug: "acme",
        });
      }).pipe(Effect.provide(layer));
    });

    it.live("emits cli_project_linked + org/project groupIdentify keyed by org id", () => {
      const { layer, analytics } = setup();
      return Effect.gen(function* () {
        yield* link(flags());
        expect(analytics.captured.map((c) => c.event)).toContain("cli_project_linked");
        expect(analytics.groupIdentified).toEqual([
          {
            groupType: "organization",
            groupKey: "org_123",
            properties: { organization_slug: "acme" },
          },
          {
            groupType: "project",
            groupKey: VALID_REF,
            properties: { name: "My Project", organization_slug: "acme" },
          },
        ]);
        const capture = analytics.captured.find((c) => c.event === "cli_project_linked");
        expect(capture?.properties).not.toHaveProperty("linked_via");
        expect(capture?.properties).not.toHaveProperty("parent_project_ref");
      }).pipe(Effect.provide(layer));
    });

    it.live("resolves the ref from SUPABASE_PROJECT_ID when no flag is given", () => {
      const { layer, workdir } = setup({ projectId: Option.some(VALID_REF) });
      return Effect.gen(function* () {
        yield* link(flags({ projectRef: Option.none() }));
        expect(readTemp(workdir, "project-ref")).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.live("positional valid ref beats SUPABASE_PROJECT_ID as the link target", () => {
      const { layer, workdir } = setup({ projectId: Option.some(VALID_REF) });
      return Effect.gen(function* () {
        yield* link(flags({ refOrBranch: Option.some(POSITIONAL_REF), projectRef: Option.none() }));
        expect(readTemp(workdir, "project-ref")).toBe(POSITIONAL_REF);
      }).pipe(Effect.provide(layer));
    });

    it.live("fails in non-TTY with no --project-ref and no PROJECT_ID", () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(link(flags({ projectRef: Option.none() })));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("ProjectRefRequiredError");
          expect(json).toContain(`required flag(s) \\"project-ref\\" not set`);
        }
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "fails with InvalidProjectRefError for a malformed ref from SUPABASE_PROJECT_ID (env stays strict)",
      () => {
        const { layer } = setup({ projectId: Option.some("BADREF") });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(link(flags({ projectRef: Option.none() })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("InvalidProjectRefError");
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("tolerates a 404 project (branch linking): writes project-ref, skips telemetry", () => {
      const { layer, workdir, analytics } = setup({
        project: { fail: statusCodeFailure(404) },
      });
      return Effect.gen(function* () {
        yield* link(flags());
        expect(readTemp(workdir, "project-ref")).toBe(VALID_REF);
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
        const exit = yield* Effect.exit(link(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("ProjectPausedError");
          expect(json).toContain("project is paused");
          expect(json).toContain(
            `An admin must unpause it from the Supabase dashboard at https://supabase.com/dashboard/project/${VALID_REF}`,
          );
        }
      }).pipe(Effect.provide(layer));
    });

    it.live("warns to stderr when status is not ACTIVE_HEALTHY but still links", () => {
      const { layer, out, workdir } = setup({
        project: { ok: { ...HEALTHY_PROJECT, status: "COMING_UP" } },
      });
      return Effect.gen(function* () {
        yield* link(flags());
        expect(out.stderrText).toContain(
          "WARNING: Project status is COMING_UP instead of Active Healthy. Some operations might fail.",
        );
        expect(readTemp(workdir, "project-ref")).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.live("fails with LinkProjectStatusError on an unexpected status", () => {
      const { layer } = setup({ project: { fail: statusCodeFailure(500) } });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(link(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("LinkProjectStatusError");
          expect(json).toContain("Unexpected error retrieving remote project status");
        }
      }).pipe(Effect.provide(layer));
    });

    it.live("fails with auth error when api-keys returns non-200", () => {
      const { layer } = setup({ apiKeys: { fail: statusCodeFailure(401) } });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(link(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("LinkAuthTokenError");
          expect(json).toContain("Authorization failed for the access token and project ref pair");
        }
      }).pipe(Effect.provide(layer));
    });

    it.live("fails with missing-key error when api-keys are empty", () => {
      const { layer } = setup({ apiKeys: { ok: [] } });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(link(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("LinkMissingKeyError");
          expect(json).toContain("Anon key not found.");
        }
      }).pipe(Effect.provide(layer));
    });

    it.live("resolves keys by legacy name when no type field is present", () => {
      const { layer, out, workdir } = setup({
        apiKeys: {
          ok: [
            { name: "anon", api_key: "anon-key" },
            { name: "service_role", api_key: "service-role-key" },
          ],
        },
      });
      return Effect.gen(function* () {
        yield* link(flags());
        expect(readTemp(workdir, "project-ref")).toBe(VALID_REF);
        expect(out.stdoutText).toContain("Finished supabase link.");
      }).pipe(Effect.provide(layer));
    });

    it.live("fails with missing-key error when the only secret key is not service_role", () => {
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
        const exit = yield* Effect.exit(link(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LinkMissingKeyError");
        }
      }).pipe(Effect.provide(layer));
    });

    it.live("ignores best-effort service errors without failing the link", () => {
      const { layer, out, workdir } = setup({
        storageConfig: { fail: statusCodeFailure(500) },
        poolerConfig: { fail: statusCodeFailure(503) },
        tenant: "fail",
      });
      return Effect.gen(function* () {
        yield* link(flags());
        expect(readTemp(workdir, "project-ref")).toBe(VALID_REF);
        expect(out.stdoutText).toContain("Finished supabase link.");
        expect(existsSync(tempFile(workdir, "storage-migration"))).toBe(false);
        expect(existsSync(tempFile(workdir, "rest-version"))).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live("removes pooler-url and skips the pooler fetch when --skip-pooler is set", () => {
      const { layer, workdir, apiMock } = setup();
      writeTempContent(workdir, "pooler-url", "stale-pooler-url");
      return Effect.gen(function* () {
        yield* link(flags({ skipPooler: true }));
        expect(existsSync(tempFile(workdir, "pooler-url"))).toBe(false);
        expect(apiMock.requests.map((r) => r.method)).not.toContain("getPoolerConfig");
      }).pipe(Effect.provide(layer));
    });

    it.live("fails when writing the project-ref file errors", () => {
      // Makes `<workdir>/supabase` a file so every temp write fails; with no version in the
      // project status, project-ref is the first mandatory write to hit the broken path.
      const out = mockOutput({ format: "text" });
      const apiMock = mockCommandPlatformApiService({
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
      const cliSettings = mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
      const layer = buildTestRuntime({
        out,
        api: { layer: apiMock.layer, httpClientLayer: tenantHttpLayer({ tenant: "fail" }) },
        cliSettings,
      });
      writeFileSync(join(tempRoot.current, "supabase"), "not-a-dir");
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(link(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(existsSync(tempFile(tempRoot.current, "project-ref"))).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live("flushes telemetry and runs the linked-project cache via ensuring", () => {
      const { layer, telemetry, linkedCache } = setup();
      return Effect.gen(function* () {
        yield* link(flags());
        expect(telemetry.flushed).toBe(true);
        expect(linkedCache.cached).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.live("json output: emits a structured success and suppresses the Finished line", () => {
      const { layer, out, workdir } = setup({ format: "json" });
      return Effect.gen(function* () {
        yield* link(flags());
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({ project_ref: VALID_REF });
        expect(success?.data).not.toHaveProperty("branch");
        expect(out.stdoutText).not.toContain("Finished supabase link.");
        expect(readTemp(workdir, "project-ref")).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    });

    it.live("stream-json output: emits a structured success", () => {
      const { layer, out } = setup({ format: "stream-json" });
      return Effect.gen(function* () {
        yield* link(flags());
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({ project_ref: VALID_REF });
      }).pipe(Effect.provide(layer));
    });
  });

  describe("ref-or-branch argument conflicts", () => {
    it.live(
      "fails with LinkRefArgConflictError when both the positional and --project-ref are set",
      () => {
        const { layer, telemetry, linkedCache } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(link(flags({ refOrBranch: Option.some(VALID_REF) })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LinkRefArgConflictError");
            expect(json).toContain(
              "Cannot use both the [ref-or-branch] argument and the --project-ref flag.",
            );
          }
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
            link(flags({ refOrBranch: Option.some(""), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("ProjectRefRequiredError");
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
          const exit = yield* Effect.exit(link(flags({ projectRef: Option.some("") })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("ProjectRefRequiredError");
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
          yield* link(flags({ refOrBranch: Option.some(""), projectRef: Option.some(VALID_REF) }));
          expect(readTemp(workdir, "project-ref")).toBe(VALID_REF);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "links directly from a positional ref argument without calling the branches endpoint",
      () => {
        const { layer, workdir, apiMock } = setup();
        return Effect.gen(function* () {
          yield* link(flags({ refOrBranch: Option.some(VALID_REF), projectRef: Option.none() }));
          expect(readTemp(workdir, "project-ref")).toBe(VALID_REF);
          expect(apiMock.requests.map((r) => r.method)).not.toContain("listAllBranches");
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("branch-name resolution: parent chain", () => {
    it.live(
      "THE HEADLINE REGRESSION: relinking a different branch resolves via the cached real parent, not the previously-linked branch ref",
      () => {
        // Simulates the state left behind by a prior `supabase link feature-branch`:
        // project-ref holds the branch's own ref, but linked-project.json still holds the
        // real parent.
        const { layer, workdir, apiMock } = setup({
          branches: { ok: [LINK_BRANCH, LINK_BRANCH_OTHER] },
          project: { fail: statusCodeFailure(404) },
        });
        writeLinkedParentRef(workdir, BRANCH_PROJECT_REF);
        writeLinkedProjectCacheFile(workdir, linkedProjectCacheJson(PARENT_REF));
        return Effect.gen(function* () {
          yield* link(
            flags({ refOrBranch: Option.some("other-branch"), projectRef: Option.none() }),
          );
          const branchCall = apiMock.requests.find((r) => r.method === "listAllBranches");
          expect(branchCall?.input).toMatchObject({ ref: PARENT_REF });
          expect(readTemp(workdir, "project-ref")).toBe(OTHER_BRANCH_PROJECT_REF);
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
          yield* link(
            flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
          );
          const branchCall = apiMock.requests.find((r) => r.method === "listAllBranches");
          expect(branchCall?.input).toMatchObject({ ref: PARENT_REF });
          expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "a garbage SUPABASE_PROJECT_ID hard-fails the branch lookup with LinkParentRefInvalidError, never falling through to the cache (PR #6168 review)",
      () => {
        // The first present candidate decides, even if invalid — a typo'd override must not
        // silently fall through to the cache.
        const { layer, apiMock, workdir } = setup({
          branches: { ok: [LINK_BRANCH] },
          projectId: Option.some("not-a-valid-ref"),
        });
        writeLinkedProjectCacheFile(workdir, linkedProjectCacheJson(CACHE_ONLY_REF));
        writeLinkedParentRef(workdir, FILE_ONLY_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LinkParentRefInvalidError");
          }
          expect(apiMock.requests.find((r) => r.method === "listAllBranches")).toBeUndefined();
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
            // Re-seeds every iteration: a successful link overwrites project-ref with the
            // resolved branch ref, clobbering this fixture for the next iteration.
            writeLinkedParentRef(workdir, FILE_ONLY_REF);
            writeLinkedProjectCacheFile(workdir, content);
            yield* link(
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
      "fails with LinkParentRefInvalidError when a parent candidate exists but none is ref-shaped",
      () => {
        const { layer, workdir, apiMock } = setup();
        writeLinkedParentRef(workdir, "not-a-real-ref!!");
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LinkParentRefInvalidError");
            expect(json).toContain(
              `Cannot resolve branch \\"feature-branch\\": the linked project ref is invalid`,
            );
            expect(json).toContain("Relink the parent project first: supabase link --project-ref");
          }
          expect(apiMock.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("fails with LinkBranchNotLinkedError when no parent candidate exists anywhere", () => {
      const { layer, apiMock } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("LinkBranchNotLinkedError");
          expect(json).toContain(`Cannot resolve \\"feature-branch\\": it is not a project ref`);
          expect(json).toContain(
            "If it is a branch name, link the parent project first: supabase link --project-ref",
          );
        }
        expect(apiMock.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "cache alone (linked-project.json with no project-ref file) is never proof of a link: fails with LinkBranchNotLinkedError, no API call (PR #6168 review)",
      () => {
        const { layer, apiMock, workdir } = setup();
        // Simulates a failed prior `link --project-ref <parent>`: `getProject` returned 200
        // (so `linked-project.json` got written) but a later step failed before `project-ref`
        // itself was written. That stale cache entry must never be trusted as parent-resolution
        // evidence for a new branch lookup.
        writeLinkedProjectCacheFile(workdir, linkedProjectCacheJson(PARENT_REF));
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LinkBranchNotLinkedError");
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
        // A directory (not a missing file) makes `fs.readFileString` fail with a real read error.
        mkdirSync(tempFile(workdir, "project-ref"), { recursive: true });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LinkBranchNotLinkedError");
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
          project: { fail: statusCodeFailure(404) },
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* link(
            flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }),
          );
          expect(readTemp(workdir, "linked-project.json")).toBe(
            JSON.stringify({ ref: PARENT_REF }),
          );

          // A second branch-name link must resolve via the parent this write just persisted.
          // project-ref was overwritten by the first call, so this also proves the cache (not
          // the file) is what a second resolution uses.
          yield* link(
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
          project: { fail: statusCodeFailure(404) },
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        const richCache = linkedProjectCacheJson(PARENT_REF);
        writeLinkedProjectCacheFile(workdir, richCache);
        return Effect.gen(function* () {
          yield* link(
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
          project: { fail: statusCodeFailure(404) },
          branches: { ok: [LINK_BRANCH] },
        });
        const cacheContent = linkedProjectCacheJson(CACHE_ONLY_REF);
        writeLinkedProjectCacheFile(workdir, cacheContent);
        return Effect.gen(function* () {
          yield* link(flags({ projectRef: Option.some(BRANCH_PROJECT_REF) }));
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
          project: { fail: statusCodeFailure(404) },
          branches: { ok: [LINK_BRANCH_OTHER] },
        });
        writeLinkedProjectCacheFile(workdir, linkedProjectCacheJson(CACHE_ONLY_REF));
        return Effect.gen(function* () {
          yield* link(flags({ projectRef: Option.some(BRANCH_PROJECT_REF) }));
          expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
          expect(existsSync(tempFile(workdir, "linked-project.json"))).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "raw ref-shaped 404 link where the correlation lookup itself fails: DELETES the unverified cache, link still succeeds (fail-safe, PR #6168 review)",
      () => {
        const { layer, workdir } = setup({
          project: { fail: statusCodeFailure(404) },
          branches: { fail: statusCodeFailure(500) },
        });
        const cacheContent = linkedProjectCacheJson(CACHE_ONLY_REF);
        writeLinkedProjectCacheFile(workdir, cacheContent);
        return Effect.gen(function* () {
          yield* link(flags({ projectRef: Option.some(BRANCH_PROJECT_REF) }));
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
          yield* link(
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
          yield* link(flags({ projectRef: Option.some("feature-branch") }));
          expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("resolves a branch by its UUID", () => {
      const { layer, workdir } = setup({ branches: { ok: [LINK_BRANCH] } });
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        yield* link(flags({ refOrBranch: Option.some(LINK_BRANCH.id), projectRef: Option.none() }));
        expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
      }).pipe(Effect.provide(layer));
    });

    it.live("resolves a branch by an UPPERCASE-hex UUID spelling (PR #6168 review)", () => {
      const { layer, workdir } = setup({ branches: { ok: [LINK_BRANCH] } });
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        yield* link(
          flags({
            refOrBranch: Option.some(LINK_BRANCH.id.toUpperCase()),
            projectRef: Option.none(),
          }),
        );
        expect(readTemp(workdir, "project-ref")).toBe(BRANCH_PROJECT_REF);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "fails with LinkBranchNotReadyError and never falls through to link the parent, even with SUPABASE_PROJECT_ID set",
      () => {
        const { layer, workdir, apiMock } = setup({
          branches: { ok: [LINK_BRANCH_NOT_READY] },
          projectId: Option.some(PARENT_REF),
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LinkBranchNotReadyError");
            expect(json).toContain(
              `Branch \\"feature-branch\\" has no project ref yet (status: CREATING_PROJECT)`,
            );
          }
          expect(existsSync(tempFile(workdir, "project-ref"))).toBe(false);
          expect(apiMock.requests).toEqual([
            { method: "listAllBranches", input: { ref: PARENT_REF } },
          ]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("a failed branch lookup leaves an existing project-ref file untouched", () => {
      const { layer, workdir } = setup({ branches: { ok: [LINK_BRANCH] } });
      // The project-ref file doubles as the existing link and the parent candidate here.
      writeLinkedParentRef(workdir, PARENT_REF);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          link(flags({ refOrBranch: Option.some("does-not-exist"), projectRef: Option.none() })),
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
          link(flags({ refOrBranch: Option.some("does-not-exist"), projectRef: Option.none() })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("LinkBranchNotFoundError");
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
          link(flags({ refOrBranch: Option.some("Staging"), projectRef: Option.none() })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain(`Did you mean \\"staging\\"?`);
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
            link(flags({ refOrBranch: Option.some("missingbranch"), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LinkBranchNotFoundError");
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
          link(flags({ refOrBranch: Option.some("my-branch"), projectRef: Option.none() })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("LinkBranchNotFoundError");
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
          link(flags({ refOrBranch: Option.some("missing-branch"), projectRef: Option.none() })),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const json = JSON.stringify(exit.cause);
          expect(json).toContain("LinkBranchNotFoundError");
          expect(json).toContain(
            `Branch \\"missing-branch\\" not found for project ${PARENT_REF}. Available branches: alpha, zeta`,
          );
        }
        expect(telemetry.flushed).toBe(true);
        expect(linkedCache.cached).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "surfaces a dedicated message when listing branches 404s (parent may itself be a branch)",
      () => {
        const { layer, workdir } = setup({ branches: { fail: statusCodeFailure(404) } });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LinkBranchListStatusError");
            expect(json).toContain(`Cannot list branches for project ${PARENT_REF} (HTTP 404)`);
            expect(json).toContain(
              `If ${PARENT_REF} is itself a preview branch, link its parent project first: supabase link --project-ref`,
            );
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails with LinkBranchListStatusError when listing branches returns a non-200, non-404 status",
      () => {
        const { layer, workdir } = setup({ branches: { fail: statusCodeFailure(500) } });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LinkBranchListStatusError");
            expect(json).toContain("unexpected list branches status 500");
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails with LinkBranchListNetworkError when listing branches fails at the transport layer",
      () => {
        const { layer, workdir } = setup({ branches: { fail: transportFailureForMock() } });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LinkBranchListNetworkError");
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
          yield* link(
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
          yield* link(
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
          branches: { fail: statusCodeFailure(500) },
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("LinkBranchListStatusError");
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
        yield* link(
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
          // A branch's own project ref always 404s on `getProject`, routing telemetry into
          // the branch-resolution arm instead of the plain project arm.
          project: { fail: statusCodeFailure(404) },
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* link(
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
          // `getProject(PARENT_REF)` returns 200 here, unlike the 404 test above.
        });
        writeLinkedParentRef(workdir, PARENT_REF);
        return Effect.gen(function* () {
          yield* link(flags({ refOrBranch: Option.some("main"), projectRef: Option.none() }));
          const captures = analytics.captured.filter((c) => c.event === "cli_project_linked");
          expect(captures).toHaveLength(1);
          const properties = captures[0]?.properties as { groups?: unknown } | undefined;
          expect(properties).toMatchObject({
            linked_via: "branch",
            parent_project_ref: PARENT_REF,
          });
          expect(properties?.groups).toEqual({ organization: "org_123", project: PARENT_REF });
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
        const apiMock = mockCommandPlatformApiService({
          v1: {
            getProject: () => Effect.succeed(HEALTHY_PROJECT),
            getProjectApiKeys: () => Effect.succeed(SERVICE_KEYS),
            getStorageConfig: () => Effect.succeed({ migrationVersion: "m" }),
            getPoolerConfig: () => Effect.succeed(POOLER_PRIMARY),
          },
        });
        const cliSettings = mockCommandSettings({
          workdir: tempRoot.current,
          projectId: Option.none(),
        });
        const layer = Layer.mergeAll(
          buildTestRuntime({
            out,
            api: { layer: apiMock.layer, httpClientLayer: tenantHttpLayer({}) },
            cliSettings,
            analytics,
          }),
          commandRuntimeLayer(["link"]),
          Stdio.layerTest({
            args: Effect.succeed(["link", "--project-ref", VALID_REF]),
          }),
        );
        return Effect.gen(function* () {
          yield* linkHandler(flags({ projectRef: Option.some(VALID_REF) }));
          const event = analytics.captured.find((c) => c.event === "cli_command_executed");
          expect(event?.properties.flags).toEqual({ "project-ref": VALID_REF });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "redacts --project-ref in cli_command_executed when it is a branch name, not a ref",
      () => {
        const out = mockOutput({ format: "text" });
        const analytics = mockContextualAnalytics();
        const apiMock = mockCommandPlatformApiService({ v1: {} });
        const cliSettings = mockCommandSettings({
          workdir: tempRoot.current,
          projectId: Option.none(),
        });
        const layer = Layer.mergeAll(
          buildTestRuntime({
            out,
            api: { layer: apiMock.layer, httpClientLayer: tenantHttpLayer({}) },
            cliSettings,
            analytics,
          }),
          commandRuntimeLayer(["link"]),
          Stdio.layerTest({
            args: Effect.succeed(["link", "--project-ref", "my-branch"]),
          }),
        );
        return Effect.gen(function* () {
          yield* Effect.exit(linkHandler(flags({ projectRef: Option.some("my-branch") })));
          const event = analytics.captured.find((c) => c.event === "cli_command_executed");
          expect(event?.properties.flags).toEqual({ "project-ref": "<redacted>" });
        }).pipe(Effect.provide(layer));
      },
    );
  });
});
