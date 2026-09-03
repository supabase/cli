import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Stdio } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  mockAnalytics,
  mockContextualAnalytics,
  mockOutput,
} from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  legacyJsonResponse,
  legacyTransportFailure,
  mockLegacyCliSettings,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockRuntimeInfo, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacyConfigPush } from "./push.handler.ts";
import { legacyConfigPushHandler } from "./push.command.ts";

const tempRoot = useLegacyTempWorkdir("supabase-config-push-int-");

function writeConfig(toml: string): void {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), toml);
}

// Shared test vector — same one `legacy-vault-decrypt.unit.test.ts` and
// `config-sync.secret.unit.test.ts` use. Decrypts to the plaintext "value".
const DOTENVX_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const DOTENVX_ENCRYPTED_VALUE =
  "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

/** Save/restore `DOTENV_PRIVATE_KEY` around a test — mirrors the SUPABASE_YES pattern below. */
function withDotenvPrivateKey<A, E, R>(
  value: string | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const prev = process.env["DOTENV_PRIVATE_KEY"];
  if (value === undefined) delete process.env["DOTENV_PRIVATE_KEY"];
  else process.env["DOTENV_PRIVATE_KEY"] = value;
  return effect.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (prev === undefined) delete process.env["DOTENV_PRIVATE_KEY"];
        else process.env["DOTENV_PRIVATE_KEY"] = prev;
      }),
    ),
  );
}

// Schema-valid PostgREST GET response with the api disabled remotely (empty
// schema). The real API client validates GET bodies against the generated
// output schema, so every postgrest GET must carry these fields.
const POSTGREST_DISABLED = {
  db_schema: "",
  db_extra_search_path: "",
  max_rows: 0,
  db_pool: null,
  db_pool_acquisition_timeout: null,
};

// Schema-valid `getProject` fixture (CLI-2168's live target-detection probe).
// `name` is distinguishable in assertions so the target-echo text can be
// told apart from a bare-ref fallback.
const TEST_PROJECT = {
  id: "abcdefghijklmnopqrst",
  ref: "abcdefghijklmnopqrst",
  name: "Test Project",
  organization_id: "org_test",
  organization_slug: "test-org",
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

function writeLinkedProjectRefFile(ref: string): void {
  const dir = join(tempRoot.current, "supabase", ".temp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project-ref"), ref);
}

function writeLinkedProjectCacheFile(json: Record<string, unknown>): void {
  const dir = join(tempRoot.current, "supabase", ".temp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "linked-project.json"), JSON.stringify(json));
}

// CLI-2168/CLI-2289 branch-target fixtures — every ref below is exactly 20
// lowercase letters (LEGACY_BRANCH_PROJECT_REF_PATTERN), distinct from
// TEST_PROJECT.ref and from each other, so the same test file can model a
// branch, its parent, and an unrelated project simultaneously.
const BRANCH_REF = "cccccccccccccccccccc";
const PARENT_REF = "pppppppppppppppppppp";
const OTHER_PARENT_REF = "qqqqqqqqqqqqqqqqqqqq";
const PROBE_REF = "zzzzzzzzzzzzzzzzzzzz";
const UUID_TARGET_REF = "rrrrrrrrrrrrrrrrrrrr";
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";

/** `V1ListAllBranchesOutput` item — the best-effort branch-name lookup
 * (`legacyFindBranchName`) matches on `project_ref`. */
const BRANCH_LIST_ITEM = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "feat-x",
  project_ref: BRANCH_REF,
  parent_project_ref: PARENT_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
};

/** `V1GetABranch` body for a branch-name `--project-ref` lookup (CLI-2289). */
const BRANCH_BY_NAME = {
  id: BRANCH_UUID,
  name: "staging",
  project_ref: BRANCH_REF,
  parent_project_ref: TEST_PROJECT.ref,
  is_default: false,
  persistent: true,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
};

/** `V1GetABranchConfig` body for a UUID `--project-ref` lookup (CLI-2289). */
const BRANCH_CONFIG = {
  ref: UUID_TARGET_REF,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "h",
  db_port: 5432,
};

/** Routes mock HTTP responses by URL path so a single handler serves every endpoint. */
interface RouteOpts {
  readonly addons?: { status: number; body: unknown };
  readonly postgrestGet?: { status: number; body: unknown };
  readonly postgrestPatch?: { status: number; body: unknown } | "fail";
  readonly postgresGet?: { status: number; body: unknown };
  readonly postgresPut?: { status: number; body: unknown };
  readonly storageGet?: { status: number; body: unknown };
  readonly storagePatch?: { status: number; body: unknown };
  // CLI-2168/CLI-2289 — live target-detection probe and branch-name/UUID
  // resolution. Defaults keep every existing (plain-project) scenario
  // working without opting in: a project ref probe succeeds, and the
  // branch-lookup endpoints degrade to "not found"/empty rather than
  // hanging or decode-erroring. `"fail"` simulates a transport failure
  // (distinct from an explicit status code) for the hard-failure scenarios.
  readonly project?: { status: number; body: unknown } | "fail";
  readonly branchList?: { status: number; body: unknown };
  readonly branchByName?: { status: number; body: unknown } | "fail";
  readonly branchById?: { status: number; body: unknown };
}

function setup(opts: {
  readonly toml: string;
  readonly routes?: RouteOpts;
  readonly format?: "text" | "json" | "stream-json";
  readonly yes?: boolean;
  readonly confirm?: ReadonlyArray<boolean>;
  readonly promptFail?: boolean;
  /** stdin interactivity; defaults to a TTY so prompt-driven tests reach the confirm. */
  readonly stdinIsTty?: boolean;
  /** Piped (non-TTY) stdin answers, one consumed per confirmation prompt. */
  readonly pipedAnswers?: ReadonlyArray<string>;
  /** Working directory the handler runs from; defaults to the temp project root. */
  readonly runtimeCwd?: string;
  /** cliSettings.workdir override (what `--workdir` resolves to); defaults to the temp project root. */
  readonly workdir?: string;
  /** Analytics mock for tests asserting on captured telemetry events. */
  readonly analytics?: ReturnType<typeof mockAnalytics>;
  /**
   * `cliSettings.projectId` override — defaults to `Option.some(TEST_PROJECT.ref)`. CLI-2168/CLI-2289
   * scenarios pass `Option.none()` so ref resolution falls through to the
   * `.temp/project-ref` file, or `Option.some(<ref>)` to model an env override
   * distinct from any linked-state files.
   */
  readonly projectId?: Option.Option<string>;
}) {
  writeConfig(opts.toml);
  const routes = opts.routes ?? {};
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm,
    promptConfirmFail: opts.promptFail,
  });
  const api = mockLegacyPlatformApi({
    handler: (request) => {
      const url = request.url;
      if (url.includes("/billing/addons")) {
        const a = routes.addons ?? { status: 200, body: { available_addons: [] } };
        return Effect.succeed(legacyJsonResponse(request, a.status, a.body));
      }
      if (url.includes("/postgrest")) {
        if (request.method === "GET") {
          const g = routes.postgrestGet ?? { status: 200, body: POSTGREST_DISABLED };
          return Effect.succeed(legacyJsonResponse(request, g.status, g.body));
        }
        if (routes.postgrestPatch === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const p = routes.postgrestPatch ?? { status: 200, body: POSTGREST_DISABLED };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      if (url.includes("/config/database/postgres")) {
        if (request.method === "GET") {
          const g = routes.postgresGet ?? { status: 200, body: {} };
          return Effect.succeed(legacyJsonResponse(request, g.status, g.body));
        }
        const p = routes.postgresPut ?? { status: 200, body: {} };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      if (url.includes("/config/storage")) {
        if (request.method === "GET") {
          const g = routes.storageGet ?? { status: 200, body: {} };
          return Effect.succeed(legacyJsonResponse(request, g.status, g.body));
        }
        const p = routes.storagePatch ?? { status: 200, body: {} };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      const pathname = new URL(url).pathname;
      // CLI-2168's live target-detection probe: a bare project ref defaults
      // to a schema-valid project, so every existing (plain-project)
      // scenario keeps working without opting in.
      if (/^\/v1\/projects\/[a-z0-9-]+$/.test(pathname)) {
        if (routes.project === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const p = routes.project ?? { status: 200, body: TEST_PROJECT };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      // CLI-2289's branch resolution + the best-effort branch-name lookup —
      // defaults degrade to "not found"/empty rather than hanging.
      if (/^\/v1\/projects\/[a-z0-9-]+\/branches$/.test(pathname)) {
        const b = routes.branchList ?? { status: 200, body: [] };
        return Effect.succeed(legacyJsonResponse(request, b.status, b.body));
      }
      if (/^\/v1\/projects\/[a-z0-9-]+\/branches\/[^/]+$/.test(pathname)) {
        if (routes.branchByName === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const b = routes.branchByName ?? { status: 404, body: {} };
        return Effect.succeed(legacyJsonResponse(request, b.status, b.body));
      }
      if (/^\/v1\/branches\/[0-9a-f-]+$/.test(pathname)) {
        const b = routes.branchById ?? { status: 404, body: {} };
        return Effect.succeed(legacyJsonResponse(request, b.status, b.body));
      }
      // Anything else (auth/storage/etc.) — succeed with empty so unconfigured
      // gated services don't hang if a test enables them.
      return Effect.succeed(legacyJsonResponse(request, 200, {}));
    },
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliSettings: mockLegacyCliSettings({
        workdir: opts.workdir ?? tempRoot.current,
        ...(opts.projectId === undefined ? {} : { projectId: opts.projectId }),
      }),
      runtimeInfo: mockRuntimeInfo({ cwd: opts.runtimeCwd ?? tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
      tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? true, stdoutIsTty: false }),
      ...(opts.analytics === undefined ? {} : { analytics: opts.analytics }),
    }),
    mockStdin(
      opts.stdinIsTty ?? true,
      opts.pipedAnswers ? `${opts.pipedAnswers.join("\n")}\n` : undefined,
    ),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
  );
  return { layer, out, api, telemetry, linkedProjectCache };
}

// A config where only the api service is enabled (auth/db.settings/storage stay
// at defaults; auth/storage GETs are served empty, db.settings always runs).
const API_ONLY_TOML = `project_id = "test"
[auth]
enabled = false
[storage]
enabled = false
`;

const STORAGE_CONFIG_WITHOUT_POOL_MODE = {
  fileSizeLimit: 52428800,
  features: {
    imageTransformation: { enabled: false },
    s3Protocol: { enabled: false },
    purgeCache: { enabled: false },
    icebergCatalog: { enabled: false, maxNamespaces: 0, maxTables: 0, maxCatalogs: 0 },
    vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
  },
  capabilities: { list_v2: true, iceberg_catalog: false },
  external: { upstreamTarget: "main" },
  migrationVersion: "20240701",
};

/**
 * The realistic "already ran `supabase link <branch>`" state (CLI-2168):
 * `.temp/project-ref` holds the BRANCH's own ref, `.temp/linked-project.json`
 * caches the PARENT (name "My App"), the live probe 404s (the ref is a
 * branch, not a project), and the parent's branch list confirms it — so the
 * target resolves to `{ kind: "branch", ref: BRANCH_REF, parentRef:
 * PARENT_REF, parentName: "My App", branch: "feat-x" }`. `projectId:
 * Option.none()` so ref resolution reads the `.temp/project-ref` file
 * instead of the (env-equivalent) default.
 */
function setupLinkedBranchPush(
  opts: {
    readonly format?: "text" | "json" | "stream-json";
    readonly yes?: boolean;
    readonly confirm?: ReadonlyArray<boolean>;
    readonly stdinIsTty?: boolean;
    readonly pipedAnswers?: ReadonlyArray<string>;
  } = {},
) {
  writeLinkedProjectRefFile(BRANCH_REF);
  writeLinkedProjectCacheFile({ ref: PARENT_REF, name: "My App" });
  return setup({
    toml: API_ONLY_TOML,
    projectId: Option.none(),
    format: opts.format,
    yes: opts.yes,
    confirm: opts.confirm,
    stdinIsTty: opts.stdinIsTty,
    pipedAnswers: opts.pipedAnswers,
    routes: {
      project: { status: 404, body: {} },
      branchList: { status: 200, body: [BRANCH_LIST_ITEM] },
      postgrestGet: { status: 200, body: POSTGREST_DISABLED },
      postgresGet: { status: 200, body: {} },
    },
  });
}

describe("legacy config push integration", () => {
  it.live("pushes local config (text, Go parity) and surfaces a PATCH failure", () => {
    const { layer, out } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: {
        addons: { status: 200, body: { available_addons: [] } },
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgrestPatch: "fail",
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.stderrText).toContain(
        "Pushing config to project: Test Project (abcdefghijklmnopqrst)",
      );
      expect(out.stderrText).toContain("Updating API service with config:");
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts on malformed config.toml before any network call", () => {
    const { layer, api } = setup({ toml: "malformed", yes: true });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a branch name/UUID target resolves (or fails resolving) BEFORE a malformed config.toml is ever read",
    () => {
      // Branch/UUID resolution runs before the config load (unlike a
      // ref-shaped/absent target, which never needs a network call to
      // resolve at all) — a `[remotes.<name>]` overlay is merged INSIDE
      // `loadCliConfig` itself, before its one full schema decode, so
      // resolving the target first and loading exactly once is the only way
      // to both avoid a double-decode and let a base config that's only
      // valid once the matching remote applies still succeed. The accepted
      // tradeoff: an unresolvable branch name costs a network round trip
      // even though the local config.toml is malformed and would abort
      // anyway once reached.
      const { layer, api } = setup({ toml: "malformed", yes: true });
      return Effect.gen(function* () {
        const exit = yield* legacyConfigPush({ projectRef: Option.some("somebranch") }).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("LegacyConfigPushBranchNotFoundError");
        expect(rendered).not.toContain("LegacyConfigPushLoadConfigError");
        expect(api.requests.some((r) => r.url.includes("/branches"))).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("merges a matching [remotes.*] block over the base and pushes it", () => {
    const { layer, out, api } = setup({
      toml: `${API_ONLY_TOML}[api]
enabled = true
schemas = ["public"]

[remotes.staging]
project_id = "abcdefghijklmnopqrst"
[remotes.staging.api]
schemas = ["public", "remote_schema"]
`,
      yes: true,
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      // Go prints the override line, before the "Pushing config to project" line.
      expect(out.stderrText).toContain("Loading config override: [remotes.staging]");
      expect(out.stderrText.indexOf("Loading config override: [remotes.staging]")).toBeLessThan(
        out.stderrText.indexOf("Pushing config to project:"),
      );
      // The remote's schema override is what gets pushed (proving the merge).
      const patch = api.requests.find((r) => r.method === "PATCH" && r.url.includes("/postgrest"));
      expect(patch).toBeDefined();
      expect(patch?.body).toMatchObject({ db_schema: "public,remote_schema" });
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts when two [remotes.*] blocks share the target project_id", () => {
    const { layer, api } = setup({
      toml: `${API_ONLY_TOML}[remotes.a]
project_id = "abcdefghijklmnopqrst"
[remotes.b]
project_id = "abcdefghijklmnopqrst"
`,
      yes: true,
    });
    return Effect.gen(function* () {
      const message = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(
        Effect.catchTag("LegacyConfigPushLoadConfigError", (error) =>
          Effect.succeed(error.message),
        ),
      );
      expect(message).toContain("duplicate project_id for [remotes.");
      // The guard runs during config load, before any network call.
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when listing addons returns 503", () => {
    const { layer } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: { addons: { status: 503, body: {} } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports up-to-date when the remote api matches local", () => {
    const { layer, out, api } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: {
        postgrestGet: {
          status: 200,
          body: {
            db_schema: "public,graphql_public",
            db_extra_search_path: "public,extensions",
            max_rows: 1000,
            db_pool: null,
            db_pool_acquisition_timeout: null,
            jwt_secret: "x",
          },
        },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Remote API config is up to date.");
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        false,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("stops a service when the user declines the prompt (exit 0)", () => {
    const { layer, out, api } = setup({
      toml: API_ONLY_TOML,
      confirm: [false],
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Updating API service with config:");
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        false,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("auto-confirms with --yes (echoes the prompt)", () => {
    const { layer, out } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Do you want to push api config to remote? [Y/n] y");
    }).pipe(Effect.provide(layer));
  });

  it.live("defaults to yes on empty non-TTY stdin, echoing the prompt", () => {
    // The confirmation prompt prints the label and scans stdin even on a
    // non-terminal; with no piped input the scan is empty and it falls back
    // to the default (`true`), so the push proceeds.
    const { layer, api, out } = setup({
      toml: API_ONLY_TOML,
      stdinIsTty: false,
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        true,
      );
      // Label printed + empty answer echoed on non-TTY stdin.
      expect(out.stderrText).toContain("Do you want to push api config to remote? [Y/n] \n");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors a piped 'n' decline on non-TTY stdin (no update)", () => {
    // Regression: piped stdin is scanned before defaulting, so a piped `n`
    // cancels the push even on a non-terminal — it must not silently apply.
    const { layer, api, out } = setup({
      toml: API_ONLY_TOML,
      stdinIsTty: false,
      pipedAnswers: ["n"],
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        false,
      );
      // The consumed answer is echoed to stderr on non-TTY stdin.
      expect(out.stderrText).toContain("Do you want to push api config to remote? [Y/n] n");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors SUPABASE_YES from supabase/.env even against a piped 'n'", () => {
    // `config push` imports `supabase/.env` before the confirmation prompt,
    // so a project-local `SUPABASE_YES=true` auto-confirms before stdin is
    // read — the push proceeds despite the piped `n`.
    const prev = process.env["SUPABASE_YES"];
    delete process.env["SUPABASE_YES"];
    const { layer, api } = setup({
      toml: API_ONLY_TOML,
      stdinIsTty: false,
      pipedAnswers: ["n"],
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    // Written after setup()'s writeConfig created supabase/.
    writeFileSync(join(tempRoot.current, "supabase", ".env"), "SUPABASE_YES=true\n");
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        true,
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.provide(layer),
    );
  });

  it.live("loads config-push env from the project root when --workdir names a subdirectory", () => {
    // The handler resolves against cliSettings.workdir, so a `--workdir`
    // pointing INSIDE the project must still walk up to the project root for
    // the env load (like loadCliConfig) — a SUPABASE_YES in
    // <root>/supabase/.env auto-confirms even then.
    const prev = process.env["SUPABASE_YES"];
    delete process.env["SUPABASE_YES"];
    const sub = join(tempRoot.current, "nested", "dir");
    mkdirSync(sub, { recursive: true });
    const { layer, api } = setup({
      toml: API_ONLY_TOML,
      stdinIsTty: false,
      pipedAnswers: ["n"],
      workdir: sub,
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    // `.env` lives at the project ROOT (setup's writeConfig wrote config.toml there).
    writeFileSync(join(tempRoot.current, "supabase", ".env"), "SUPABASE_YES=true\n");
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        true,
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.provide(layer),
    );
  });

  it.live("emits a structured summary in json mode without prompts", () => {
    const { layer, out } = setup({
      toml: API_ONLY_TOML,
      format: "json",
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data?.project_ref).toBe("abcdefghijklmnopqrst");
      expect(Array.isArray(success?.data?.services)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("pushes storage when the remote response omits databasePoolMode", () => {
    const { layer, api } = setup({
      toml: `project_id = "test"
[auth]
enabled = false
[storage]
enabled = true
file_size_limit = "50MiB"
`,
      yes: true,
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
        storageGet: { status: 200, body: STORAGE_CONFIG_WITHOUT_POOL_MODE },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(
        api.requests.some((r) => r.method === "GET" && r.url.includes("/config/storage")),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry + linked-project cache on failure", () => {
    const { layer, telemetry, linkedProjectCache } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: { addons: { status: 503, body: {} } },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the api GET returns an unexpected status", () => {
    const { layer } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: { postgrestGet: { status: 500, body: { message: "boom" } } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts with exit 1 when no config.toml exists", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) =>
        Effect.succeed(legacyJsonResponse(request, 200, { available_addons: [] })),
    });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliSettings: mockLegacyCliSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      mockStdin(true),
      Layer.succeed(LegacyYesFlag, true),
    );
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

// ---------------------------------------------------------------------------
// Gated services (auth / storage / db.network_restrictions / db.ssl_enforcement
// / experimental). These use the direct-service mock (no response-schema
// validation) because the typed auth/storage GET responses have ~200 required
// fields; a raw HttpClient still serves the cost-matrix /billing/addons call.
// ---------------------------------------------------------------------------

function addonsHttpLayer(): Layer.Layer<HttpClient.HttpClient> {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ available_addons: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  );
}

// api + db.settings run before every gated service; keep them up-to-date so
// only the service under test produces a diff.
const baseStubs = {
  // CLI-2168's live target-detection probe runs before any gated service —
  // default to the same schema-valid fixture `setup()`'s HTTP-level mock
  // uses, so every existing scenario keeps working without opting in.
  getProject: () => Effect.succeed(TEST_PROJECT),
  getPostgrestServiceConfig: () =>
    Effect.succeed({
      db_schema: "public,graphql_public",
      db_extra_search_path: "public,extensions",
      max_rows: 1000,
    }),
  getPostgresConfig: () => Effect.succeed({}),
};

// Disables auth + storage by default so a test can enable just its target service.
const BASE_DISABLED = `project_id = "test"\n[auth]\nenabled = false\n[storage]\nenabled = false\n`;

function setupService(opts: {
  readonly toml: string;
  readonly v1: Record<string, (input: unknown) => Effect.Effect<unknown, unknown>>;
  readonly yes?: boolean;
  readonly confirm?: ReadonlyArray<boolean>;
  readonly runtimeCwd?: string;
}) {
  writeConfig(opts.toml);
  const out = mockOutput({ format: "text", promptConfirmResponses: opts.confirm });
  const apiMock = mockLegacyPlatformApiService({ v1: { ...baseStubs, ...opts.v1 } });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api: { layer: apiMock.layer, httpClientLayer: addonsHttpLayer() },
      cliSettings: mockLegacyCliSettings({ workdir: tempRoot.current }),
      runtimeInfo: mockRuntimeInfo({ cwd: opts.runtimeCwd ?? tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
      // Gated-service prompts model an interactive user answering via `confirm`.
      tty: mockTty({ stdinIsTty: true, stdoutIsTty: false }),
    }),
    mockStdin(true),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
  );
  return { layer, out, apiMock };
}

function methodsOf(apiMock: ReturnType<typeof setupService>["apiMock"]): Array<string> {
  return apiMock.requests.map((r) => r.method);
}

describe("legacy config push gated services", () => {
  it.live("pushes auth email HTML loaded from content_path", () => {
    const templateDir = join(tempRoot.current, "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "invite.html"), "<h1>Invite</h1>");
    writeFileSync(join(templateDir, "password_changed.html"), "<p>Password changed</p>");

    const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = true
site_url = "http://localhost:3000"
[auth.email.template.invite]
subject = "You are invited"
content_path = "./templates/invite.html"
[auth.email.notification.password_changed]
enabled = true
subject = "Password changed"
content_path = "./templates/password_changed.html"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: {
        getAuthServiceConfig: () => Effect.succeed({}),
        updateAuthServiceConfig: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["mailer_subjects_invite"]).toBe("You are invited");
      expect(input["mailer_templates_invite_content"]).toBe("<h1>Invite</h1>");
      expect(input["mailer_subjects_password_changed_notification"]).toBe("Password changed");
      expect(input["mailer_templates_password_changed_notification_content"]).toBe(
        "<p>Password changed</p>",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts before network I/O when auth email content_path is unreadable", () => {
    const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = true
site_url = "http://localhost:3000"
[auth.email.template.invite]
subject = "You are invited"
content_path = "./templates/missing.html"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: {
        getAuthServiceConfig: () => Effect.succeed({}),
        updateAuthServiceConfig: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(apiMock.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves auth template paths from the discovered project root", () => {
    const nestedCwd = join(tempRoot.current, "packages", "app");
    const templateDir = join(tempRoot.current, "templates");
    mkdirSync(nestedCwd, { recursive: true });
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "invite.html"), "<h1>Nested invite</h1>");

    const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = true
site_url = "http://localhost:3000"
[auth.email.template.invite]
subject = "Nested invite"
content_path = "./templates/invite.html"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      runtimeCwd: nestedCwd,
      v1: {
        getAuthServiceConfig: () => Effect.succeed({}),
        updateAuthServiceConfig: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["mailer_templates_invite_content"]).toBe("<h1>Nested invite</h1>");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "sends the raw captcha secret (not the hash) when pushing auth (security regression)",
    () => {
      const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = true
site_url = "http://localhost:3000"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "my-plaintext-secret"
`;
      const { layer, apiMock } = setupService({
        toml,
        yes: true,
        v1: {
          getAuthServiceConfig: () => Effect.succeed({}),
          updateAuthServiceConfig: () => Effect.succeed({}),
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
        expect(update).toBeDefined();
        const input = update?.input as Record<string, unknown>;
        expect(input["security_captcha_secret"]).toBe("my-plaintext-secret");
        expect(String(input["security_captcha_secret"])).not.toContain("hash:");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "decrypts a dotenvx encrypted: captcha secret and pushes the plaintext (CLI-1881)",
    () => {
      const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = true
site_url = "http://localhost:3000"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "${DOTENVX_ENCRYPTED_VALUE}"
`;
      const { layer, apiMock } = setupService({
        toml,
        yes: true,
        v1: {
          getAuthServiceConfig: () => Effect.succeed({}),
          updateAuthServiceConfig: () => Effect.succeed({}),
        },
      });
      return withDotenvPrivateKey(
        DOTENVX_PRIVATE_KEY,
        Effect.gen(function* () {
          yield* legacyConfigPush({ projectRef: Option.none() });
          const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
          expect(update).toBeDefined();
          const input = update?.input as Record<string, unknown>;
          // Go decrypts before hashing/pushing — the plaintext goes to the API,
          // never the dotenvx ciphertext.
          expect(input["security_captcha_secret"]).toBe("value");
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.live(
    "aborts before any network call when an encrypted: secret cannot be decrypted (CLI-1881)",
    () => {
      // `auth.enabled = false` on purpose: the decrypt hook runs for every
      // `config.Secret` field during config load, before any feature gate is
      // consulted — an undecryptable secret aborts even when the section that
      // contains it would otherwise be skipped entirely.
      const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = false
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "${DOTENVX_ENCRYPTED_VALUE}"
`;
      const { layer, api } = setup({ toml, yes: true });
      return withDotenvPrivateKey(
        undefined,
        Effect.gen(function* () {
          const message = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(
            Effect.catchTag("LegacyConfigPushLoadConfigError", (error) =>
              Effect.succeed(error.message),
            ),
          );
          expect(message).toBe("failed to parse config: missing private key");
          // The guard runs during config load, before any network call — not
          // even the cost-matrix (list-addons) request that normally runs first.
          expect(api.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.live(
    "aborts on an undecryptable secret config push never itself reads or pushes (CLI-1881)",
    () => {
      // `studio.openai_api_key` is a `config.Secret` field that is still
      // decrypted during config load — but no `config-sync/*.sync.ts` file
      // (api, db, auth, storage, experimental) ever reads `studio.*`, so this
      // proves the pre-check is genuinely document-wide, not merely reachable
      // via `auth.*`.
      const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = false
[studio]
openai_api_key = "${DOTENVX_ENCRYPTED_VALUE}"
`;
      const { layer, api } = setup({ toml, yes: true });
      return withDotenvPrivateKey(
        undefined,
        Effect.gen(function* () {
          const message = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(
            Effect.catchTag("LegacyConfigPushLoadConfigError", (error) =>
              Effect.succeed(error.message),
            ),
          );
          expect(message).toBe("failed to parse config: missing private key");
          expect(api.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.live("aborts on an undecryptable [db.vault] secret (CLI-1881)", () => {
    // `db.vault` decodes as `map[string]Secret` in Go (`pkg/config/db.go:96`), so Go's
    // decrypt hook covers it during `config.Load` — but the shared
    // `legacyAssertDecryptableSecrets` path list used to omit `db.vault` on the theory
    // that only the db-config reader's own downstream vault loop needed it. `config push`
    // never runs that downstream loop, so this proves the shared path list now covers
    // `db.vault` for every caller.
    const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = false
[db.vault]
my_secret = "${DOTENVX_ENCRYPTED_VALUE}"
`;
    const { layer, api } = setup({ toml, yes: true });
    return withDotenvPrivateKey(
      undefined,
      Effect.gen(function* () {
        const message = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(
          Effect.catchTag("LegacyConfigPushLoadConfigError", (error) =>
            Effect.succeed(error.message),
          ),
        );
        expect(message).toBe("failed to parse config: missing private key");
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.live(
    "aborts on an undecryptable secret in a deprecated [auth.external.slack] block (CLI-1881)",
    () => {
      // `@supabase/config` strips `auth.external.{linkedin,slack}` from
      // `loaded.document` before returning it
      // (`normalizeDeprecatedExternalProviders`) — but the decrypt hook runs
      // at DECODE time, strictly before that later validate-time deletion, so
      // a `secret` hiding in one of these deprecated blocks still aborts the
      // load. This proves the pre-check folds
      // `removedDeprecatedExternalProviders` back in rather than missing it.
      const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = false
[auth.external.slack]
secret = "${DOTENVX_ENCRYPTED_VALUE}"
`;
      const { layer, api } = setup({ toml, yes: true });
      return withDotenvPrivateKey(
        undefined,
        Effect.gen(function* () {
          const message = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(
            Effect.catchTag("LegacyConfigPushLoadConfigError", (error) =>
              Effect.succeed(error.message),
            ),
          );
          expect(message).toBe("failed to parse config: missing private key");
          expect(api.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.live("pushes storage when enabled and changed", () => {
    const toml = `project_id = "test"
[auth]
enabled = false
[storage]
enabled = true
file_size_limit = "100MiB"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: {
        getStorageConfig: () =>
          Effect.succeed({
            fileSizeLimit: 0,
            features: {
              imageTransformation: { enabled: false },
              s3Protocol: { enabled: false },
              icebergCatalog: { enabled: false, maxNamespaces: 0, maxTables: 0, maxCatalogs: 0 },
              vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
            },
          }),
        updateStorageConfig: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).toContain("updateStorageConfig");
    }).pipe(Effect.provide(layer));
  });

  it.live("pushes db.network_restrictions when enabled and changed", () => {
    const toml = `${BASE_DISABLED}[db.network_restrictions]
enabled = true
allowed_cidrs = ["1.2.3.4/32"]
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: {
        getNetworkRestrictions: () =>
          Effect.succeed({ config: { dbAllowedCidrs: ["0.0.0.0/0"], dbAllowedCidrsV6: [] } }),
        updateNetworkRestrictions: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).toContain("updateNetworkRestrictions");
    }).pipe(Effect.provide(layer));
  });

  it.live("pushes db.ssl_enforcement only when declared in config", () => {
    const toml = `${BASE_DISABLED}[db.ssl_enforcement]
enabled = true
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: {
        getSslEnforcementConfig: () => Effect.succeed({ currentConfig: { database: false } }),
        updateSslEnforcementConfig: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).toContain("updateSslEnforcementConfig");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not touch ssl_enforcement when the section is absent", () => {
    const { layer, apiMock } = setupService({ toml: BASE_DISABLED, yes: true, v1: {} });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).not.toContain("getSslEnforcementConfig");
    }).pipe(Effect.provide(layer));
  });

  it.live("enables webhooks when experimental.webhooks is enabled (no GET/diff)", () => {
    const toml = `${BASE_DISABLED}[experimental.webhooks]
enabled = true
`;
    const { layer, apiMock, out } = setupService({
      toml,
      yes: true,
      v1: { enableDatabaseWebhook: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Enabling webhooks for project:");
      expect(methodsOf(apiMock)).toContain("enableDatabaseWebhook");
    }).pipe(Effect.provide(layer));
  });
});

describe("legacy config push branch/project target detection (CLI-2168)", () => {
  it.live("a plain project push never triggers the branch confirmation gate", () => {
    const { layer, out, api } = setup({ toml: API_ONLY_TOML, yes: true });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain(
        `Pushing config to project: Test Project (${TEST_PROJECT.ref})`,
      );
      expect(out.stderrText).not.toContain("Pushing config to branch");
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "an empty project name from the live probe degrades to the bare-ref target-echo line",
    () => {
      // `normalizeApiName` (push.branch-target.ts, shared by both the
      // project-probe and branch-list call sites) folds an empty `name`
      // into `undefined` before it ever reaches the target object.
      // `legacyFormatNamedRef` also has its own defensive empty-string
      // check, so this specific text-echo assertion is a belt-and-suspenders
      // proof of the end-to-end behavior rather than of `normalizeApiName`
      // in isolation — but it's the one place `target.name` is actually
      // consumed, so it's still the correct place to pin "an empty API name
      // degrades to the bare-ref line, never a stray `project:  (<ref>)`".
      const { layer, out } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        routes: { project: { status: 200, body: { ...TEST_PROJECT, name: "" } } },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(`Pushing config to project: ${TEST_PROJECT.ref}\n`);
        expect(out.stderrText).not.toContain("project:  (");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "the realistic 'link <branch>' then flag-less push flow shows both target lines and proceeds",
    () => {
      const { layer, out, api } = setupLinkedBranchPush({ yes: true });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(`Pushing config to branch: feat-x (${BRANCH_REF})`);
        expect(out.stderrText).toContain(`  Parent project: My App (${PARENT_REF})`);
        expect(
          api.requests.some((r) => r.url.includes(`/v1/projects/${PARENT_REF}/branches`)),
        ).toBe(true);
        expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
          true,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a branch push with no branch-list match still trusts a just-linked parent (no cached name)",
    () => {
      writeLinkedProjectRefFile(BRANCH_REF);
      writeLinkedProjectCacheFile({ ref: PARENT_REF });
      const { layer, out, api } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        projectId: Option.none(),
        routes: {
          project: { status: 404, body: {} },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(`Pushing config to branch: ${BRANCH_REF}`);
        expect(out.stderrText).toContain(`  Parent project: ${PARENT_REF}`);
        expect(out.stderrText).not.toContain("My App");
        expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
          true,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a live 404 with nothing cached degrades to a bare branch line with zero branch lookups",
    () => {
      const { layer, out, api } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        projectId: Option.some(PROBE_REF),
        routes: {
          project: { status: 404, body: {} },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(`Pushing config to branch: ${PROBE_REF}\n`);
        expect(out.stderrText).not.toContain("Parent project:");
        expect(api.requests.some((r) => r.url.includes("/branches"))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("declining the branch confirmation prompt on a TTY fails before any mutation", () => {
    const { layer, api, telemetry, linkedProjectCache } = setupLinkedBranchPush({
      confirm: [false],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyConfigPushCancelledError");
      }
      expect(api.requests.some((r) => r.url.includes("/billing/addons"))).toBe(false);
      expect(api.requests.some((r) => r.url.includes("/postgrest"))).toBe(false);
      expect(api.requests.some((r) => r.url.includes("/config/database/postgres"))).toBe(false);
      expect(api.requests.some((r) => r.url.includes("/config/storage"))).toBe(false);
      // Legacy Shell Invariant #1: a declined branch gate still flushes
      // telemetry and writes the linked-project cache, same as any other
      // failure.
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("an unattended run with no --yes and empty stdin declines and fails by default", () => {
    const { layer, api } = setupLinkedBranchPush({ stdinIsTty: false });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyConfigPushCancelledError");
      }
      expect(api.requests.some((r) => r.url.includes("/postgrest"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("an explicit piped 'n' on non-TTY stdin declines and fails a branch push", () => {
    const { layer, api } = setupLinkedBranchPush({
      stdinIsTty: false,
      pipedAnswers: ["n"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyConfigPushCancelledError");
      }
      expect(api.requests.some((r) => r.url.includes("/postgrest"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("--yes auto-confirms a branch push and echoes the prompt", () => {
    const { layer, out, api } = setupLinkedBranchPush({ yes: true });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain(
        'branch "feat-x" (' + BRANCH_REF + ")? (skip this check with --yes) [y/N] y",
      );
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "json output mode declines and fails a branch push without --yes (CLI-2168 safety default)",
    () => {
      const { layer, out, api } = setupLinkedBranchPush({ format: "json" });
      return Effect.gen(function* () {
        const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const rendered = JSON.stringify(exit.cause);
          expect(rendered).toContain("LegacyConfigPushCancelledError");
          // A machine-mode/non-TTY decline never renders the interactive
          // prompt's own "(skip this check with --yes)" hint at all
          // (`legacyPromptYesNo` returns the default silently) — the
          // cancelled error's own `suggestion` field is the ONLY place a
          // script/agent sees the --yes escape hatch. `normalizeCliError`
          // reads `suggestion` generically off any tagged error, and
          // `output.fail` threads it into the machine error envelope.
          expect(rendered).toContain("--yes");
          expect(rendered).toContain("SUPABASE_YES");
        }
        expect(out.messages.some((m) => m.type === "success")).toBe(false);
        expect(api.requests.some((r) => ["PATCH", "PUT", "POST"].includes(r.method))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("json output mode with --yes reports the branch target in the machine payload", () => {
    const { layer, out } = setupLinkedBranchPush({ format: "json", yes: true });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.project_ref).toBe(BRANCH_REF);
      expect(success?.data?.is_branch).toBe(true);
      expect(success?.data?.branch).toBe("feat-x");
      expect(success?.data?.parent_project_ref).toBe(PARENT_REF);
      expect(Array.isArray(success?.data?.services)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "an unrelated cached parent does not get credited without a confirming branch-list match",
    () => {
      writeLinkedProjectCacheFile({ ref: PARENT_REF });
      const { layer, out, api } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        projectId: Option.some(PROBE_REF),
        routes: {
          project: { status: 404, body: {} },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(`Pushing config to branch: ${PROBE_REF}`);
        expect(out.stderrText).not.toContain("Parent project:");
        expect(
          api.requests.some((r) => r.url.includes(`/v1/projects/${PARENT_REF}/branches`)),
        ).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a self-referential cached parent is dropped without any branch-list lookup", () => {
    writeLinkedProjectCacheFile({ ref: PROBE_REF });
    const { layer, out, api } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      projectId: Option.some(PROBE_REF),
      routes: {
        project: { status: 404, body: {} },
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain(`Pushing config to branch: ${PROBE_REF}`);
      expect(out.stderrText).not.toContain("Parent project:");
      expect(api.requests.some((r) => r.url.includes("/branches"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("a non-ref-shaped cached parent is dropped without any branch-list lookup", () => {
    writeLinkedProjectCacheFile({ ref: "not-a-real-ref" });
    const { layer, out, api } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      projectId: Option.some(PROBE_REF),
      routes: {
        project: { status: 404, body: {} },
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain(`Pushing config to branch: ${PROBE_REF}`);
      expect(out.stderrText).not.toContain("Parent project:");
      expect(api.requests.some((r) => r.url.includes("/branches"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a transport failure probing the live target degrades to unknown rather than aborting the push",
    () => {
      // The target-detection probe is diagnostic-only (CLI-2168 review
      // finding): a transport failure must never abort a push that would
      // otherwise succeed — including for a plain project whose token can
      // write service config but happens to fail this one informational
      // read. It degrades to "unknown" (never "branch" — that would
      // wrongly gate an ordinary push behind a confirmation that
      // auto-declines, and fails, in an unattended run) and the push
      // proceeds.
      const { layer, out, api } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        projectId: Option.some(PROBE_REF),
        routes: {
          project: "fail",
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(
          `Pushing config to: ${PROBE_REF} (could not determine whether this is a branch or the main project)`,
        );
        expect(out.stderrText).not.toContain("Do you want to push config to branch");
        expect(api.requests.some((r) => r.url.includes("/branches"))).toBe(false);
        expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
          true,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a broken .temp/project-ref (a directory, not a file) degrades gracefully instead of failing",
    () => {
      // Mirrors the established `legacyReadProjectRefFile` EISDIR regression
      // technique (`legacy-temp-paths.unit.test.ts`) — the target-detection
      // recovery's own best-effort read must swallow a real read failure
      // (not just a missing file), not propagate it. A cache candidate (with
      // a branch-list response that does NOT confirm this ref) is required
      // so recovery actually reaches the `.temp/project-ref` read at all —
      // with no cache candidate at all, it returns before ever attempting
      // that read.
      mkdirSync(join(tempRoot.current, "supabase", ".temp", "project-ref"), { recursive: true });
      writeLinkedProjectCacheFile({ ref: PARENT_REF });
      const { layer, out, api } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        projectId: Option.some(PROBE_REF),
        routes: {
          project: { status: 404, body: {} },
          branchList: { status: 200, body: [] },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(
          api.requests.some((r) => r.url.includes(`/v1/projects/${PARENT_REF}/branches`)),
        ).toBe(true);
        // The EISDIR read degrades to "no file ref", so the fallback trust
        // check (`fileRef.value === ref`) can't fire either — same bare
        // shape a genuinely absent file would produce.
        expect(out.stderrText).toContain(`Pushing config to branch: ${PROBE_REF}`);
        expect(out.stderrText).not.toContain("Parent project:");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a 500 probing the live target degrades to unknown rather than aborting the push", () => {
    const { layer, out, api } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      projectId: Option.some(PROBE_REF),
      routes: {
        project: { status: 500, body: { message: "boom" } },
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain(
        `Pushing config to: ${PROBE_REF} (could not determine whether this is a branch or the main project)`,
      );
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "an unknown target (a live probe failure) never carries is_branch in the machine payload",
    () => {
      const { layer, out } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        format: "json",
        projectId: Option.some(PROBE_REF),
        routes: {
          project: { status: 500, body: {} },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data?.project_ref).toBe(PROBE_REF);
        expect("is_branch" in (success?.data ?? {})).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  // The "transport failure"/"500" tests above cover the `"unknown"` outcome
  // for a genuine probe error; only the TIMEOUT-specific sub-case (a live
  // probe that hangs rather than erroring) remains untested — both reach
  // the identical `{ kind: "unknown" }` outcome, so this is a coverage gap
  // in HOW `"unknown"` is reached, not in the behavior itself. A
  // `TestClock`-driven proof of the `LEGACY_BRANCH_LOOKUP_TIMEOUT`
  // degradation was deliberately NOT added here — see the test-report notes
  // for why: `legacyConfigPush` does
  // substantial real, unmocked filesystem I/O (project-root discovery,
  // config.toml read, `.env` load) via `BunFileSystem` before it ever
  // reaches the probe's `Effect.timeoutOrElse`, and that I/O settles on a
  // real event-loop macrotask turn that a virtual `TestClock` cannot
  // provide. `it.effect` + `Effect.forkChild` + `TestClock.adjust` +
  // `Fiber.join` (this codebase's own precedent, e.g.
  // `legacy-branch-target` health-check tests) hangs the full 5s Vitest
  // timeout here, even preceded by up to 20 `Effect.yieldNow` turns —
  // confirming the block is real macrotask I/O, not merely an
  // under-scheduled fiber. Forcing it through would need either a real
  // wall-clock wait (banned by this repo's flake-resistance policy) or
  // swapping this one test's `FileSystem` for an in-memory fake diverging
  // from every other scenario in this file — neither is a "cheap addition".
});

describe("legacy config push --project-ref branch name/UUID resolution (CLI-2289)", () => {
  it.live(
    "--project-ref <branch-name> resolves via the already-known parent, no extra live probe",
    () => {
      const { layer, out, api } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        routes: {
          branchByName: { status: 200, body: BRANCH_BY_NAME },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.some("staging") });
        expect(out.stderrText).toContain(`Pushing config to branch: staging (${BRANCH_REF})`);
        expect(out.stderrText).toContain(`  Parent project: ${TEST_PROJECT.ref}`);
        expect(
          api.requests.some(
            (r) => r.method === "GET" && new URL(r.url).pathname === `/v1/projects/${BRANCH_REF}`,
          ),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--project-ref <branch-name> skips the branch confirmation prompt, with no --yes and no queued answer",
    () => {
      // `knownBranch` is `{kind: "name", branchName, parentRef}` for a NAME
      // target, so push.handler.ts's `knownBranch === undefined` gate is
      // never entered — no prompt at all. `yes: false`
      // with no `confirm`/`pipedAnswers` queued at all means the mock's own
      // "no more queued answers" fallback (`promptConfirmResponses.shift()
      // ?? true`) would silently mask a wrongly-shown prompt if we only
      // asserted success, so the real proof is `out.stderrText` never
      // containing the branch-prompt label — `legacyPromptYesNo` always
      // writes its label to stderr before reading any answer, on both a TTY
      // and non-TTY, so its total absence is conclusive either way.
      const { layer, out } = setup({
        toml: API_ONLY_TOML,
        yes: false,
        routes: {
          branchByName: { status: 200, body: BRANCH_BY_NAME },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyConfigPush({ projectRef: Option.some("staging") }).pipe(
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stderrText).toContain(`Pushing config to branch: staging (${BRANCH_REF})`);
        expect(out.stderrText).not.toContain("Do you want to push config to branch");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--project-ref <branch-name> enriches the parent name from a matching linked-project cache",
    () => {
      writeLinkedProjectCacheFile({ ref: TEST_PROJECT.ref, name: "Test Project" });
      const { layer, out } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        routes: {
          branchByName: { status: 200, body: BRANCH_BY_NAME },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.some("staging") });
        expect(out.stderrText).toContain(`  Parent project: Test Project (${TEST_PROJECT.ref})`);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--project-ref <branch-name> ignores a linked-project cache belonging to a different parent",
    () => {
      writeLinkedProjectCacheFile({ ref: OTHER_PARENT_REF, name: "Someone Else" });
      const { layer, out } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        routes: {
          branchByName: { status: 200, body: BRANCH_BY_NAME },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.some("staging") });
        expect(out.stderrText).toContain(`  Parent project: ${TEST_PROJECT.ref}`);
        expect(out.stderrText).not.toContain("Someone Else");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--project-ref <branch-name> resolution works without a spinner in json output mode",
    () => {
      const { layer, out } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        format: "json",
        routes: {
          branchByName: { status: 200, body: BRANCH_BY_NAME },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.some("staging") });
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data?.is_branch).toBe(true);
        expect(success?.data?.branch).toBe("staging");
        expect(success?.data?.parent_project_ref).toBe(TEST_PROJECT.ref);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--project-ref <uuid> resolves without any linked project (CLI-2289 regression)", () => {
    const { layer, out, api } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      projectId: Option.none(),
      routes: {
        project: { status: 404, body: {} },
        branchById: { status: 200, body: BRANCH_CONFIG },
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.some(BRANCH_UUID) }).pipe(
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain(`Pushing config to branch: ${UUID_TARGET_REF}`);
      expect(out.stderrText).not.toContain(BRANCH_UUID);
      const branchRequests = api.requests.filter((r) => r.url.includes("/branches"));
      expect(branchRequests).toHaveLength(1);
      expect(branchRequests[0]?.url).toContain(`/v1/branches/${BRANCH_UUID}`);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "--project-ref <uuid> never shows the branch confirmation prompt, on an unattended run with no --yes",
    () => {
      // `knownBranch` is `{kind: "uuid"}` (defined, not `undefined`) for a
      // UUID target — the same "explicit target this invocation" shape a
      // branch NAME target gets, so push.handler.ts's `target.kind ===
      // "branch" && knownBranch === undefined` gate is never entered: no
      // prompt at all, even on a
      // fully unattended run (no `--yes`, non-TTY, empty stdin). Checking
      // `out.stderrText` for the exact branch-prompt label (rather than
      // relying on `--yes`'s own echo, which the existing UUID regression
      // test above already uses and which cannot distinguish "prompted then
      // auto-confirmed" from "never prompted") is the only reliable signal
      // here: `legacyPromptYesNo` prints its label to stderr even on a
      // non-TTY before scanning stdin, so its total absence proves the gate
      // never ran. Per-service prompts (`keep()`) still default to `true` on
      // empty non-TTY stdin (mirrors the "defaults to yes on empty non-TTY
      // stdin" test above), so the mutation still proceeds.
      const { layer, out, api } = setup({
        toml: API_ONLY_TOML,
        yes: false,
        stdinIsTty: false,
        projectId: Option.none(),
        routes: {
          project: { status: 404, body: {} },
          branchById: { status: 200, body: BRANCH_CONFIG },
          postgrestGet: { status: 200, body: POSTGREST_DISABLED },
          postgresGet: { status: 200, body: {} },
        },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyConfigPush({ projectRef: Option.some(BRANCH_UUID) }).pipe(
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stderrText).toContain(`Pushing config to branch: ${UUID_TARGET_REF}`);
        expect(out.stderrText).not.toContain("Do you want to push config to branch");
        expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
          true,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--project-ref <unknown-branch-name> fails with a branches-list suggestion", () => {
    const { layer, api, telemetry, linkedProjectCache } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: { branchByName: { status: 404, body: { message: "not found" } } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.some("ghost") }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("LegacyConfigPushBranchNotFoundError");
      expect(rendered).toContain('Branch \\"ghost\\" not found');
      expect(rendered).toContain("supabase branches list");
      expect(api.requests.some((r) => r.url.includes("/billing/addons"))).toBe(false);
      // Legacy Shell Invariant #1: telemetry flushes even though ref
      // resolution itself failed — but no ref was ever resolved, so the
      // linked-project cache stays untouched (mirrors `diff.integration.test.ts`'s
      // equivalent "an unknown branch fails..." assertion).
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a branch-name lookup failure in json mode still resolves cleanly without a spinner",
    () => {
      const { layer, api } = setup({
        toml: API_ONLY_TOML,
        yes: true,
        format: "json",
        routes: { branchByName: { status: 404, body: { message: "not found" } } },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyConfigPush({ projectRef: Option.some("ghost") }).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("LegacyConfigPushBranchNotFoundError");
        expect(api.requests.some((r) => r.url.includes("/billing/addons"))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--project-ref <branch-name> in an unlinked directory fails naming the value", () => {
    const { layer, api, telemetry, linkedProjectCache } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      projectId: Option.none(),
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.some("somebranch") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("LegacyConfigPushBranchNotLinkedError");
      expect(rendered).toContain('\\"somebranch\\"');
      expect(api.requests).toHaveLength(0);
      // Legacy Shell Invariant #1: fails purely from local file/env state,
      // before any ref is resolved — telemetry still flushes, but the
      // linked-project cache write is a no-op (mirrors `diff.integration.test.ts`'s
      // equivalent "in an unlinked dir fails immediately" assertion).
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("--project-ref <branch-name> with a corrupt linked ref reports it as invalid", () => {
    const { layer, api, telemetry, linkedProjectCache } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      projectId: Option.some("not-a-valid-ref"),
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.some("somebranch") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("LegacyConfigPushParentRefInvalidError");
      expect(rendered).toContain('\\"somebranch\\"');
      expect(api.requests).toHaveLength(0);
      // Legacy Shell Invariant #1: no ref ever resolved here either.
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("a resolved branch with no project ref yet fails with a not-ready error", () => {
    const { layer, api, telemetry, linkedProjectCache } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: { branchByName: { status: 200, body: { ...BRANCH_BY_NAME, project_ref: "" } } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.some("staging") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("LegacyConfigPushBranchNotReadyError");
      expect(rendered).toContain("has no project ref yet");
      expect(api.requests.some((r) => r.url.includes("/billing/addons"))).toBe(false);
      // This fails inside `legacyResolveConfigTarget` itself (the
      // placeholder ref is rejected before it's ever assigned to the
      // handler's `resolvedRef`), so the cache write is still a no-op.
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("a transport failure resolving a branch name maps to the resolve network error", () => {
    const { layer, telemetry, linkedProjectCache } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: { branchByName: "fail" },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.some("staging") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPushBranchResolveNetworkError");
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("a non-404 branch-name lookup failure keeps its status error", () => {
    const { layer, telemetry, linkedProjectCache } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: { branchByName: { status: 500, body: { message: "boom" } } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.some("staging") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPushBranchResolveStatusError");
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });
});

describe("legacy config push telemetry wiring", () => {
  // Drives the exact `Command.withHandler` wiring (legacyConfigPushHandler)
  // rather than the bare handler: the safeFlags guard lives in the wiring,
  // and nothing validates `--project-ref` before instrumentation fires.
  const wiringLayer = (analytics: ReturnType<typeof mockAnalytics>, projectRef: string) =>
    Layer.mergeAll(
      setup({ toml: API_ONLY_TOML, yes: true, analytics }).layer,
      commandRuntimeLayer(["config", "push"]),
      Stdio.layerTest({
        args: Effect.succeed(["config", "push", "--project-ref", projectRef]),
      }),
    );

  it.live("logs a ref-shaped --project-ref verbatim in cli_command_executed", () => {
    const analytics = mockContextualAnalytics();
    const ref = "abcdefghijklmnopqrst";
    return Effect.gen(function* () {
      yield* Effect.exit(legacyConfigPushHandler({ projectRef: Option.some(ref) }));
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ "project-ref": ref });
    }).pipe(Effect.provide(wiringLayer(analytics, ref)));
  });

  it.live("redacts a --project-ref value that is not ref-shaped", () => {
    // An arbitrary string (typo, wrong clipboard paste) may contain user
    // data — it must reach PostHog as the redaction sentinel, never verbatim.
    const analytics = mockContextualAnalytics();
    const value = "s3cret-paste-mistake";
    return Effect.gen(function* () {
      yield* Effect.exit(legacyConfigPushHandler({ projectRef: Option.some(value) }));
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ "project-ref": "<redacted>" });
    }).pipe(Effect.provide(wiringLayer(analytics, value)));
  });
});
