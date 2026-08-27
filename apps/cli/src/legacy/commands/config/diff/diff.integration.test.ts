import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
} from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  LEGACY_VALID_REF,
  legacyJsonResponse,
  legacyTransportFailure,
  mockLegacyCliSettings,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyConfigDiff } from "./diff.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-config-diff-int-");

const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";
const BRANCH_REF = "cccccccccccccccccccc";

function writeConfig(toml: string): string {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.toml");
  writeFileSync(path, toml);
  return path;
}

function writeProjectEnv(dotenv: string): void {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), dotenv);
}

/**
 * Schema-valid v2 project-config body whose managed values all sit at the
 * local schema defaults, so an empty config.toml diffs clean against it.
 */
function v2Response(
  opts: {
    readonly ref?: string;
    readonly attributes?: (attributes: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  const attributes: Record<string, unknown> = {
    database: {
      major_version: 17,
      ssl_enforced: false,
      network_restrictions: {
        entitlement: "allowed",
        status: "applied",
        allowed_cidrs: [
          { address: "0.0.0.0/0", type: "v4" },
          { address: "::/0", type: "v6" },
        ],
      },
      postgres_settings: {},
    },
    pooler: {
      pool_mode: "transaction",
      ignore_startup_parameters: "",
      server_idle_timeout: 0,
      server_lifetime: 0,
      query_wait_timeout: 0,
      reserve_pool_size: 0,
      default_pool_size: 20,
      max_client_conn: 100,
    },
    auth: {},
    api: {
      db_schema: "public,graphql_public",
      db_extra_search_path: "public,extensions",
      max_rows: 1000,
      db_pool_acquisition_timeout: 10,
      db_pool: null,
    },
    realtime: {
      private_only: false,
      max_concurrent_users: 200,
      max_events_per_second: 100,
      max_bytes_per_second: 100000,
      max_channels_per_client: 100,
      max_joins_per_second: 100,
      max_presence_events_per_second: 100,
      max_payload_size_in_kb: 100,
      presence_enabled: true,
      suspend: false,
      connection_pool: 10,
      postgres_changes_pool: null,
    },
    storage: {
      file_size_limit: 52428800,
      features: {
        image_transformation: { enabled: false },
        s3_protocol: { enabled: true },
        purge_cache: { enabled: false },
        iceberg_catalog: { enabled: false, max_namespaces: 5, max_tables: 10, max_catalogs: 2 },
        vector_buckets: { enabled: true, max_buckets: 10, max_indexes: 5 },
      },
      capabilities: { list_v2: true, iceberg_catalog: false },
      upstream_target: "main",
      migration_version: "20240701",
      database_pool_mode: "transaction",
    },
  };
  return {
    data: {
      type: "project_config",
      id: opts.ref ?? LEGACY_VALID_REF,
      attributes: opts.attributes === undefined ? attributes : opts.attributes(attributes),
    },
  };
}

/** V1GetABranch body for the `--target <name>` lookup. */
const BRANCH_BY_NAME = {
  id: BRANCH_UUID,
  name: "staging",
  project_ref: BRANCH_REF,
  parent_project_ref: LEGACY_VALID_REF,
  is_default: false,
  persistent: true,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
};

/** V1GetABranchConfig body for the `--target <uuid>` lookup. */
const BRANCH_CONFIG = {
  ref: BRANCH_REF,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "h",
  db_port: 5432,
};

interface SetupOpts {
  readonly toml?: string;
  readonly dotenv?: string;
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly v2?: { status: number; body: unknown } | "fail";
  readonly branchByName?: { status: number; body: unknown };
  readonly branchByUuid?: { status: number; body: unknown };
}

function setup(opts: SetupOpts = {}) {
  if (opts.toml !== undefined) {
    writeConfig(opts.toml);
  }
  if (opts.dotenv !== undefined) {
    writeProjectEnv(opts.dotenv);
  }
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    handler: (request) => {
      const url = request.url;
      if (url.includes("/v2/projects/")) {
        if (opts.v2 === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const v2 = opts.v2 ?? { status: 200, body: v2Response() };
        return Effect.succeed(legacyJsonResponse(request, v2.status, v2.body));
      }
      if (url.includes("/v1/branches/")) {
        const b = opts.branchByUuid ?? { status: 200, body: BRANCH_CONFIG };
        return Effect.succeed(legacyJsonResponse(request, b.status, b.body));
      }
      if (url.includes("/branches/")) {
        const b = opts.branchByName ?? { status: 200, body: BRANCH_BY_NAME };
        return Effect.succeed(legacyJsonResponse(request, b.status, b.body));
      }
      return Effect.succeed(legacyJsonResponse(request, 200, {}));
    },
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const processControl = mockProcessControl();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliSettings: mockLegacyCliSettings({ workdir: tempRoot.current }),
      runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
      processControl,
      goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    }),
  );
  return { layer, out, api, telemetry, linkedProjectCache, processControl };
}

const noFlags = {
  projectRef: Option.none<string>(),
  target: Option.none<string>(),
  exitCode: false,
};

describe("legacy config diff integration", () => {
  it.live("reports drift against the linked project without touching the config file", () => {
    const { layer, out, processControl, telemetry, linkedProjectCache } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
    });
    const configPath = join(tempRoot.current, "supabase", "config.toml");
    const before = {
      mtimeMs: statSync(configPath).mtimeMs,
      contents: readFileSync(configPath, "utf8"),
    };
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);

      // Never writes: mtime and contents unchanged after a run with differences.
      expect(statSync(configPath).mtimeMs).toBe(before.mtimeMs);
      expect(readFileSync(configPath, "utf8")).toBe(before.contents);

      expect(out.stderrText).toContain(
        `Comparing against project ${LEGACY_VALID_REF} using base config`,
      );
      expect(out.stderrText).toContain(
        "Comparison scope: api, auth, database, pooler, realtime, storage",
      );
      expect(out.stdoutText).toContain("api.max_rows [update]");
      expect(out.stdoutText).toContain("local:  500");
      expect(out.stdoutText).toContain("remote: 1000");
      expect(out.stdoutText).toContain(
        "1 difference(s) found (1 update, 0 remote-only, 0 local-only).",
      );
      // Differences without --exit-code leave the exit status alone.
      expect(processControl.exitCode).toBeUndefined();
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBe(LEGACY_VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("a clean config produces the success message and exit 0 even with --exit-code", () => {
    const { layer, out, processControl } = setup({ toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, exitCode: true });
      expect(out.stdoutText).toContain("No config differences found.");
      expect(processControl.exitCode).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("--exit-code sets exit 1 when differences are found", () => {
    const { layer, processControl } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, exitCode: true });
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("declared properties the response does not carry are local_only", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[auth]\nsite_url = "https://local.example.com"\n',
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stdoutText).toContain("auth.site_url [local only]");
      expect(out.stdoutText).toContain('local:  "https://local.example.com"');
      expect(out.stdoutText).toContain("remote: (not returned)");
    }).pipe(Effect.provide(layer));
  });

  it.live("env()-resolved values compare resolved and name the variable on drift", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = "env(PGRST_MAX_ROWS)"\n',
      dotenv: "PGRST_MAX_ROWS=500\n",
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stdoutText).toContain("api.max_rows [update]");
      expect(out.stdoutText).toContain("local:  500 (from env PGRST_MAX_ROWS)");
    }).pipe(Effect.provide(layer));
  });

  it.live("declared secrets are masked, not compared, and never count for --exit-code", () => {
    const { layer, out, processControl } = setup({
      toml: [
        'project_id = "test"',
        "[auth.external.github]",
        "enabled = true",
        'client_id = "id"',
        'secret = "env(GITHUB_SECRET)"',
        "",
      ].join("\n"),
      dotenv: "GITHUB_SECRET=shh\n",
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            auth: { external_github_enabled: true, external_github_client_id: "id" },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, exitCode: true });
      expect(out.stdoutText).toContain("No config differences found.");
      expect(out.stdoutText).toContain(
        "Note: 1 credential value(s) not compared (masked by the API): auth.external.github.secret",
      );
      expect(processControl.exitCode).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("a matching [remotes.*] block becomes the local operand", () => {
    const { layer, out } = setup({
      toml: [
        'project_id = "test"',
        "[api]",
        "max_rows = 500",
        "[remotes.staging]",
        `project_id = "${LEGACY_VALID_REF}"`,
        "[remotes.staging.api]",
        "max_rows = 1000",
        "",
      ].join("\n"),
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stderrText).toContain(
        `Comparing against project ${LEGACY_VALID_REF} using [remotes.staging]`,
      );
      // The merged branch operand (max_rows = 1000) matches the remote, so the
      // base config's 500 must NOT surface as drift.
      expect(out.stdoutText).toContain("No config differences found.");
    }).pipe(Effect.provide(layer));
  });

  it.live("--target resolves a branch name via the parent project", () => {
    const { layer, out, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, target: Option.some("staging") });
      expect(out.stderrText).toContain(
        `Comparing against 'staging' (branch ${BRANCH_REF}) using base config`,
      );
      const urls = api.requests.map((request) => request.url);
      expect(
        urls.some((url) => url.includes(`/v1/projects/${LEGACY_VALID_REF}/branches/staging`)),
      ).toBe(true);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("--target resolves a branch UUID directly", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, target: Option.some(BRANCH_UUID) });
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes(`/v1/branches/${BRANCH_UUID}`))).toBe(true);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("--target accepts a raw project ref without touching the branches API", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, target: Option.some(BRANCH_REF) });
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes("/branches/"))).toBe(false);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("an unknown branch fails with a branches-list suggestion", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      branchByName: { status: 404, body: { message: "not found" } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff({ ...noFlags, target: Option.some("ghost") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("LegacyConfigDiffBranchNotFoundError");
      expect(rendered).toContain('Branch \\"ghost\\" not found');
      expect(rendered).toContain("supabase branches list");
    }).pipe(Effect.provide(layer));
  });

  it.live("a non-404 branch lookup failure keeps its status error", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      branchByName: { status: 500, body: { message: "boom" } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff({ ...noFlags, target: Option.some("staging") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigDiffBranchResolveStatusError");
    }).pipe(Effect.provide(layer));
  });

  it.live("--target and --project-ref together are rejected", () => {
    const { layer, api } = setup({ toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff({
        exitCode: false,
        target: Option.some("staging"),
        projectRef: Option.some(LEGACY_VALID_REF),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigDiffFlagConflictError");
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("a missing config file points at supabase init", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("LegacyConfigDiffLoadConfigError");
      expect(rendered).toContain("supabase/config.toml: file not found");
      expect(rendered).toContain("supabase init");
    }).pipe(Effect.provide(layer));
  });

  it.live("a malformed config file fails as a parse error", () => {
    const { layer } = setup({ toml: "not [valid toml\n" });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to parse supabase/config.toml");
    }).pipe(Effect.provide(layer));
  });

  it.live("duplicate [remotes.*] project_ids abort the load", () => {
    const { layer } = setup({
      toml: [
        'project_id = "test"',
        "[remotes.a]",
        `project_id = "${LEGACY_VALID_REF}"`,
        "[remotes.b]",
        `project_id = "${LEGACY_VALID_REF}"`,
        "",
      ].join("\n"),
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigDiffLoadConfigError");
    }).pipe(Effect.provide(layer));
  });

  it.live("a remote config transport failure maps to the read network error", () => {
    const { layer, telemetry } = setup({ toml: 'project_id = "test"\n', v2: "fail" });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigDiffReadNetworkError");
      // Telemetry still flushes on failure via Effect.ensuring.
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("a remote config error status maps to the read status error", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 403, body: { message: "forbidden" } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigDiffReadStatusError");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output-format json emits the structured change set", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      expect(success).toBeDefined();
      expect(success?.message).toContain("1 config difference(s) found.");
      const data = success?.data as Record<string, unknown>;
      expect(data["target"]).toMatchObject({
        project_ref: LEGACY_VALID_REF,
        local_scope: "base",
      });
      expect(data["scope"]).toEqual(["api", "auth", "database", "pooler", "realtime", "storage"]);
      expect(data["changes"]).toEqual([
        { path: "api.max_rows", class: "update", local: 500, remote: 1000 },
      ]);
      expect(data["counts"]).toEqual({ update: 1, remote_only: 0, local_only: 0, total: 1 });
      expect(data["masked"]).toEqual([]);
      expect(typeof data["schema_version"]).toBe("string");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output-format stream-json reports zero differences as a success result", () => {
    const { layer, out } = setup({ toml: 'project_id = "test"\n', format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.message).toContain("No config differences found.");
    }).pipe(Effect.provide(layer));
  });

  it.live("the Go-compat -o flag is rejected outright before any work happens", () => {
    // Net-new TS command, no Go parity: every `-o` value is rejected — the
    // machine formats and `pretty` alike (CLI-2156, per Colum).
    const run = (goOutput: "json" | "pretty") => {
      const { layer, api } = setup({
        toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
        goOutput,
      });
      return Effect.gen(function* () {
        const exit = yield* legacyConfigDiff(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("LegacyConfigDiffOutputFlagUnsupportedError");
        expect(rendered).toContain("use --output-format json|stream-json instead");
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    };
    return Effect.gen(function* () {
      yield* run("json");
      yield* run("pretty");
    });
  });

  it.live("a fetch failure in json mode still maps cleanly without a spinner", () => {
    const { layer } = setup({ toml: 'project_id = "test"\n', v2: "fail", format: "json" });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigDiffReadNetworkError");
    }).pipe(Effect.provide(layer));
  });

  it.live("json payload carries the remotes scope and env variable annotations", () => {
    const { layer, out } = setup({
      toml: [
        'project_id = "test"',
        "[remotes.staging]",
        `project_id = "${LEGACY_VALID_REF}"`,
        "[remotes.staging.api]",
        'max_rows = "env(PGRST_MAX_ROWS)"',
        "",
      ].join("\n"),
      dotenv: "PGRST_MAX_ROWS=500\n",
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      const data = success?.data as Record<string, unknown>;
      expect(data["target"]).toMatchObject({ local_scope: "remotes.staging" });
      expect(data["changes"]).toEqual([
        {
          path: "api.max_rows",
          class: "update",
          local: 500,
          remote: 1000,
          env_variable: "PGRST_MAX_ROWS",
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("remote-only drift renders (unset) locals distinguishably from empty ones", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            database: {
              ...(attributes["database"] as Record<string, unknown>),
              postgres_settings: { work_mem: "64MB" },
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stdoutText).toContain("db.settings.work_mem [remote only]");
      expect(out.stdoutText).toContain("local:  (unset)");
      expect(out.stdoutText).toContain('remote: "64MB"');
    }).pipe(Effect.provide(layer));
  });
});
