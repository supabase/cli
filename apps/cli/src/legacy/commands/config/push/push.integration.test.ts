import { describe, expect, it } from "@effect/vitest";
import { V1UpdateAuthServiceConfigOutput } from "@supabase/api/effect";
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
  LEGACY_VALID_REF,
  legacyJsonResponse,
  legacyStatusCodeFailure,
  legacyTransportFailure,
  mockLegacyCliSettings,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyV2ProjectConfigResponse } from "../../../../../tests/helpers/legacy-config-fixtures.ts";
import { mockRuntimeInfo, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { legacySecretDigestHex } from "./push.secret.ts";
import { legacyConfigPush } from "./push.handler.ts";
import { legacyConfigPushHandler } from "./push.command.ts";

const tempRoot = useLegacyTempWorkdir("supabase-config-push-int-");

const REF = LEGACY_VALID_REF;

function writeConfig(toml: string): void {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), toml);
}

/** The shared v2 project-config fixture (schema-default baseline) — see `legacy-config-fixtures.ts`. */
const v2Response = legacyV2ProjectConfigResponse;

/** Digest a plaintext exactly the way `legacyResolveAuthSecrets` compares against — for building a remote response whose digest matches (or deliberately mismatches) a local secret value. */
function digestOf(plaintext: string): string {
  const digest = legacySecretDigestHex(REF, plaintext, []);
  if (digest === undefined) {
    throw new Error("digestOf: plaintext must be non-empty and not an env() reference");
  }
  return digest;
}

// Shared test vector — same one `legacy-vault-decrypt.unit.test.ts` and
// `push.secret.unit.test.ts` use. Decrypts to the plaintext "value".
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

// Schema-valid response for the postgrest PATCH when it's routed through the
// real typed client (`setup()` below) — same shape `V1UpdatePostgrestServiceConfigOutput`
// requires for its own GET counterpart; the response body itself is never
// asserted on, only its schema-validity.
const POSTGREST_WRITE_RESPONSE = {
  db_schema: "",
  db_extra_search_path: "",
  max_rows: 0,
  db_pool: null,
  db_pool_acquisition_timeout: null,
};

/**
 * Every non-nullable field `V1UpdateAuthServiceConfigOutput` requires a
 * concrete value for — the rest of its ~230 fields accept `T | null`, so
 * `null` satisfies them without hand-authoring the whole record.
 */
const AUTH_WRITE_RESPONSE_NON_NULLABLE: Readonly<Record<string, unknown>> = {
  mailer_otp_exp: 3600,
  passkey_enabled: false,
  mfa_phone_otp_length: 6,
  sms_otp_length: 6,
  oauth_server_enabled: false,
  oauth_server_allow_dynamic_registration: false,
  custom_oauth_enabled: false,
  custom_oauth_max_providers: 0,
};

/** Schema-valid `V1UpdateAuthServiceConfigOutput` body for the auth PATCH when it's routed
 *  through the real typed client (`setup()` below). */
function authWriteResponseFixture(): Record<string, unknown> {
  const fixture: Record<string, unknown> = {};
  for (const key of Object.keys(V1UpdateAuthServiceConfigOutput.fields)) {
    fixture[key] =
      key in AUTH_WRITE_RESPONSE_NON_NULLABLE ? AUTH_WRITE_RESPONSE_NON_NULLABLE[key] : null;
  }
  return fixture;
}

// CLI-2168/CLI-2289 branch-target fixtures — every ref below is exactly 20
// lowercase letters (`LEGACY_BRANCH_PROJECT_REF_PATTERN`), distinct from
// `REF` and from each other, so the same test file can model a branch, its
// parent, and an unrelated project simultaneously.
const BRANCH_REF = "cccccccccccccccccccc";
const PARENT_REF = "pppppppppppppppppppp";
const OTHER_PARENT_REF = "qqqqqqqqqqqqqqqqqqqq";
const PROBE_REF = "zzzzzzzzzzzzzzzzzzzz";
const UUID_TARGET_REF = "rrrrrrrrrrrrrrrrrrrr";
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";

/**
 * Schema-valid `V1GetProjectOutput` fixture (CLI-2168's live target-detection
 * probe). Every existing (plain-project) scenario relies on this being the
 * DEFAULT `project` route response with an EMPTY `name` — `normalizeApiName`
 * folds that to `undefined`, so the target-echo line degrades to the
 * pre-CLI-2168 bare `Pushing config to project: <ref>\n` text those
 * scenarios already pin. Dedicated CLI-2168 tests below override `name`
 * to prove the named-project path separately.
 */
const PUSH_TEST_PROJECT = {
  id: REF,
  ref: REF,
  name: "",
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
  parent_project_ref: REF,
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

/**
 * Real-client setup, routed by URL — for scenarios whose only writes are
 * `api` (PATCH /postgrest) and `db.settings` (PUT /config/database/postgres),
 * the two update endpoints whose response schema is simple enough to satisfy
 * without a hand-decoded ~200-field record. The v2 project-config read
 * (`GET /v2/projects/{ref}/config`) always goes through this same mock, via
 * `executeRaw` hitting the real URL.
 */
function setup(opts: {
  readonly toml: string;
  readonly v2?: { status: number; body: unknown } | { status: 200; malformedJson: true } | "fail";
  readonly addons?: { status: number; body: unknown };
  readonly postgrestPatch?: { status: number; body: unknown } | "fail";
  readonly postgresPut?: { status: number; body: unknown } | "fail";
  /** `V1UpdateStorageConfigOutput` is `Schema.Void` — the response body is never decoded, so any status/body pair proves the point. */
  readonly storagePatch?: { status: number; body: unknown } | "fail";
  /** Defaults to a schema-valid `authWriteResponseFixture()` — override the body/status to
   *  exercise a failure, while still validating the auth PATCH's REQUEST body through the real
   *  typed client (`V1UpdateAuthServiceConfigInput`). */
  readonly authPatch?: { status: number; body: unknown } | "fail";
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
  // CLI-2168/CLI-2289 — live target-detection probe and branch-name/UUID
  // resolution. Defaults keep every existing (plain-project) scenario
  // working without opting in: the project probe succeeds with an unnamed
  // project, and the branch-lookup endpoints degrade to "not found"/empty
  // rather than hanging or decode-erroring. `"fail"` simulates a transport
  // failure (distinct from an explicit status code) for the hard-failure
  // scenarios.
  readonly project?: { status: number; body: unknown } | "fail";
  readonly branchList?: { status: number; body: unknown };
  readonly branchByName?: { status: number; body: unknown } | "fail";
  readonly branchById?: { status: number; body: unknown };
  /**
   * `cliSettings.projectId` override — defaults to `Option.some(REF)`.
   * CLI-2168/CLI-2289 scenarios pass `Option.none()` so ref resolution falls
   * through to the `.temp/project-ref` file, or `Option.some(<ref>)` to model
   * an env override distinct from any linked-state files.
   */
  readonly projectId?: Option.Option<string>;
}) {
  writeConfig(opts.toml);
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm,
    promptConfirmFail: opts.promptFail,
  });
  const api = mockLegacyPlatformApi({
    handler: (request) => {
      const url = request.url;
      if (url.includes("/billing/addons")) {
        const a = opts.addons ?? { status: 200, body: { available_addons: [] } };
        return Effect.succeed(legacyJsonResponse(request, a.status, a.body));
      }
      if (url.includes("/v2/projects/")) {
        if (opts.v2 === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        if (opts.v2 !== undefined && "malformedJson" in opts.v2) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("{not valid json", {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        }
        const v2 = opts.v2 ?? { status: 200, body: v2Response() };
        return Effect.succeed(legacyJsonResponse(request, v2.status, v2.body));
      }
      if (url.includes("/postgrest")) {
        if (opts.postgrestPatch === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const p = opts.postgrestPatch ?? { status: 200, body: POSTGREST_WRITE_RESPONSE };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      if (url.includes("/config/database/postgres")) {
        if (opts.postgresPut === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const p = opts.postgresPut ?? { status: 200, body: {} };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      if (url.includes("/config/storage")) {
        if (opts.storagePatch === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const p = opts.storagePatch ?? { status: 200, body: {} };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      if (url.includes("/config/auth")) {
        if (opts.authPatch === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const p = opts.authPatch ?? { status: 200, body: authWriteResponseFixture() };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      const pathname = new URL(url).pathname;
      // CLI-2168's live target-detection probe: a bare project ref defaults
      // to a schema-valid, unnamed project, so every existing (plain-project)
      // scenario keeps working without opting in.
      if (/^\/v1\/projects\/[a-z0-9-]+$/.test(pathname)) {
        if (opts.project === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const p = opts.project ?? { status: 200, body: PUSH_TEST_PROJECT };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      // CLI-2289's branch resolution + the best-effort branch-name lookup —
      // defaults degrade to "not found"/empty rather than hanging.
      if (/^\/v1\/projects\/[a-z0-9-]+\/branches$/.test(pathname)) {
        const b = opts.branchList ?? { status: 200, body: [] };
        return Effect.succeed(legacyJsonResponse(request, b.status, b.body));
      }
      if (/^\/v1\/projects\/[a-z0-9-]+\/branches\/[^/]+$/.test(pathname)) {
        if (opts.branchByName === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const b = opts.branchByName ?? { status: 404, body: {} };
        return Effect.succeed(legacyJsonResponse(request, b.status, b.body));
      }
      if (/^\/v1\/branches\/[0-9a-f-]+$/.test(pathname)) {
        const b = opts.branchById ?? { status: 404, body: {} };
        return Effect.succeed(legacyJsonResponse(request, b.status, b.body));
      }
      // Anything else (network-restrictions/ssl/webhooks) — succeed with an
      // empty body; scenarios that write to one of those use `setupService()`
      // below instead (their typed responses have too many required fields
      // to hand-author).
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

describe("legacy config push integration", () => {
  it.live("pushes local config (text) and surfaces a PATCH failure", () => {
    // Regression test for the encoder's sparse body: `legacyEncodeApiBody`
    // omits every unchanged key entirely (no `undefined`-valued keys), so
    // this now goes through the REAL typed client — a body carrying only
    // `max_rows` must still clear `V1UpdatePostgrestServiceConfigInput`'s
    // schema before the mocked 500 status is even reached.
    const { layer, out } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      yes: true,
      postgrestPatch: { status: 500, body: { message: "boom" } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPushApiUpdateStatusError");
      expect(out.stderrText).toContain(`Pushing config to project: ${REF}`);
      expect(out.stderrText).toContain("Updating API service with config:");
    }).pipe(Effect.provide(layer));
  });

  it.live("an api update transport failure maps to the network error", () => {
    const { layer } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      yes: true,
      postgrestPatch: "fail",
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPushApiUpdateNetworkError");
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

  it.live("merges a matching [remotes.*] block over the base and pushes it", () => {
    const { layer, out, api } = setup({
      toml: `project_id = "test"
[api]
enabled = true
schemas = ["public"]

[remotes.staging]
project_id = "${REF}"
[remotes.staging.api]
schemas = ["public", "remote_schema"]
`,
      yes: true,
      v2: {
        status: 200,
        body: v2Response({
          attributes: (a) => ({
            ...a,
            api: { ...(a["api"] as Record<string, unknown>), db_schema: "public" },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Loading config override: [remotes.staging]");
      expect(out.stderrText.indexOf("Loading config override: [remotes.staging]")).toBeLessThan(
        out.stderrText.indexOf("Pushing config to project:"),
      );
      const update = api.requests.find((r) => r.method === "PATCH" && r.url.includes("/postgrest"));
      expect(update).toBeDefined();
      expect(update?.body).toMatchObject({ db_schema: "public,remote_schema" });
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts when two [remotes.*] blocks share the target project_id", () => {
    const { layer, api } = setup({
      toml: `project_id = "test"\n[remotes.a]\nproject_id = "${REF}"\n[remotes.b]\nproject_id = "${REF}"\n`,
      yes: true,
    });
    return Effect.gen(function* () {
      const message = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(
        Effect.catchTag("LegacyConfigPushLoadConfigError", (error) =>
          Effect.succeed(error.message),
        ),
      );
      expect(message).toContain("duplicate project_id for [remotes.");
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when listing addons returns 503", () => {
    const { layer } = setup({
      toml: `project_id = "test"\n`,
      yes: true,
      addons: { status: 503, body: {} },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports up-to-date when declared local values equal the v2 api block", () => {
    const { layer, out, api } = setup({
      toml: `project_id = "test"
[api]
enabled = true
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000
`,
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      // D13: the scope line prints on every run, not just when a block is
      // missing (family consistency with `config diff`/`config pull`).
      expect(out.stderrText).toContain(
        "Comparison scope: api, auth, database, pooler, realtime, storage",
      );
      expect(out.stderrText).toContain("Remote API config is up to date.");
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        false,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("stops a service when the user declines the prompt (exit 0)", () => {
    const { layer, out, api } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      confirm: [false],
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Updating API service with config:");
      // push.types.ts: a `skipped` service's `changes` still carries what the
      // declined write would have communicated — visible here as the
      // per-property block the confirmation prompt printed before the
      // decline (`api.max_rows`, the only routed change this run).
      expect(out.stderrText).toContain("api.max_rows [update]");
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        false,
      );
    }).pipe(Effect.provide(layer));
  });

  // The next several tests exercise prompt/env-resolution behavior, not api
  // body sparseness, but perform a real api write through the REAL typed
  // client (`setup()`) — the encoder's sparse body must clear
  // `V1UpdatePostgrestServiceConfigInput`'s schema on every one of these
  // paths, not just the happy-path test above.

  it.live("auto-confirms with --yes (echoes the prompt)", () => {
    const { layer, out } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Do you want to push api config to remote? [Y/n] y");
    }).pipe(Effect.provide(layer));
  });

  it.live("defaults to yes on empty non-TTY stdin, echoing the prompt", () => {
    const { layer, api, out } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      stdinIsTty: false,
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        true,
      );
      expect(out.stderrText).toContain("Do you want to push api config to remote? [Y/n] \n");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors a piped 'n' decline on non-TTY stdin (no update)", () => {
    const { layer, api, out } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      stdinIsTty: false,
      pipedAnswers: ["n"],
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        false,
      );
      expect(out.stderrText).toContain("Do you want to push api config to remote? [Y/n] n");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors SUPABASE_YES from supabase/.env even against a piped 'n'", () => {
    const prev = process.env["SUPABASE_YES"];
    delete process.env["SUPABASE_YES"];
    const { layer, api } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      stdinIsTty: false,
      pipedAnswers: ["n"],
    });
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

  it.live("honors SUPABASE_YES set directly in the shell environment", () => {
    // Complements the .env-file case above: a shell-exported SUPABASE_YES
    // (never written to supabase/.env) auto-confirms too.
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "true";
    const { layer, api } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      stdinIsTty: false,
      pipedAnswers: ["n"],
    });
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
    const prev = process.env["SUPABASE_YES"];
    delete process.env["SUPABASE_YES"];
    const sub = join(tempRoot.current, "nested", "dir");
    mkdirSync(sub, { recursive: true });
    const { layer, api } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      stdinIsTty: false,
      pipedAnswers: ["n"],
      workdir: sub,
    });
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

  it.live("emits a structured summary in json mode with every payload field", () => {
    const { layer, out } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      const data = success?.data as Record<string, unknown>;
      expect(data["schema_version"]).toBe(1);
      expect(data["project_ref"]).toBe(REF);
      expect(data["services"]).toEqual([
        { service: "api", status: "updated", changes: [["api", "max_rows"]] },
        { service: "db.settings", status: "up_to_date", changes: [] },
        { service: "db.network_restrictions", status: "disabled", changes: [] },
        { service: "db.ssl_enforcement", status: "disabled", changes: [] },
        { service: "auth", status: "up_to_date", changes: [] },
        { service: "storage", status: "up_to_date", changes: [] },
        { service: "experimental.webhooks", status: "disabled", changes: [] },
      ]);
      expect(data["unsupported"]).toEqual([]);
      expect(data["unmanaged"]).toEqual([]);
      expect(data["secrets"]).toEqual({
        sent: [],
        unchanged: [],
        not_set: [],
        gated: [],
        skipped: [],
      });
      expect(data["remote_only"]).toBe(0);
      expect(data["scope"]).toEqual({
        present: ["api", "auth", "database", "pooler", "realtime", "storage"],
        missing: [],
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry + linked-project cache on failure", () => {
    const { layer, telemetry, linkedProjectCache } = setup({
      toml: `project_id = "test"\n`,
      yes: true,
      addons: { status: 503, body: {} },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
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

  it.live("sends only the changed api key, leaving an undeclared leaf hands-off", () => {
    // Regression test for the encoder's sparse body: only `schemas`/`db_schema`
    // genuinely changes here, and that lone key must still clear
    // `V1UpdatePostgrestServiceConfigInput`'s schema through the real client.
    const { layer, api, out } = setup({
      toml: `project_id = "test"\n[api]\nschemas = ["public", "graphql_public", "custom_schema"]\n`,
      format: "json",
      v2: {
        status: 200,
        body: v2Response({
          attributes: (a) => ({
            ...a,
            api: { ...(a["api"] as Record<string, unknown>), max_rows: 5 },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = api.requests.find((r) => r.method === "PATCH" && r.url.includes("/postgrest"));
      expect(update).toBeDefined();
      expect(update?.body).toEqual({
        db_schema: "public,graphql_public,custom_schema",
      });
      const success = out.messages.find((m) => m.type === "success");
      const data = success?.data as Record<string, unknown>;
      const services = data["services"] as ReadonlyArray<Record<string, unknown>>;
      expect(services.find((s) => s["service"] === "api")).toEqual({
        service: "api",
        status: "updated",
        changes: [["api", "schemas"]],
      });
      // The undeclared, differing `max_rows` is hands-off — reported as
      // remote-only, never routed to a resource.
      expect(data["remote_only"]).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("sends only the one differing db.settings key", () => {
    const { layer, api } = setup({
      toml: `project_id = "test"
[db.settings]
shared_buffers = "256MB"
max_connections = 100
statement_timeout = "8s"
`,
      yes: true,
      v2: {
        status: 200,
        body: v2Response({
          attributes: (a) => ({
            ...a,
            database: {
              ...(a["database"] as Record<string, unknown>),
              postgres_settings: {
                shared_buffers: "256MB",
                max_connections: 100,
                statement_timeout: "4s",
              },
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const put = api.requests.find(
        (r) => r.method === "PUT" && r.url.includes("/config/database/postgres"),
      );
      expect(put).toBeDefined();
      expect(put?.body).toEqual({ statement_timeout: "8s" });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "pushes site_url, sessions.timebox, mfa.phone.max_frequency, and password_requirements through the REAL typed client",
    () => {
      // Regression test for the auth encoder's mapped value types: the REAL
      // typed client validates the request against
      // `V1UpdateAuthServiceConfigInput` before sending, so this pins
      // `sessions_timebox`/`mfa_phone_max_frequency` as numbers (not the
      // declared duration strings) alongside the plain string-mapped fields.
      const toml = `project_id = "test"
[auth]
site_url = "https://example.com"
password_requirements = "lower_upper_letters_digits"
[auth.sessions]
timebox = "24h"
[auth.mfa.phone]
max_frequency = "10s"
`;
      const { layer, api } = setup({ toml, yes: true });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const update = api.requests.find(
          (r) => r.method === "PATCH" && r.url.includes("/config/auth"),
        );
        expect(update).toBeDefined();
        expect(update?.body).toEqual({
          site_url: "https://example.com",
          password_required_characters:
            "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
          sessions_timebox: 24,
          mfa_phone_max_frequency: 10,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("pushes sms.otp_expiry as sms_otp_exp through the REAL typed client", () => {
    // Regression test for the CLI-2316 auth-encoder leaf added alongside the
    // new `auth.sms.otp_length`/`otp_expiry` schema fields: the v2 remote
    // reports the platform default (`sms_otp_exp: 60`, from
    // `legacyV2ProjectConfigResponse`), so only the declared local override
    // should ship.
    const toml = `project_id = "test"
[auth.sms]
otp_expiry = 120
`;
    const { layer, api } = setup({ toml, yes: true });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = api.requests.find(
        (r) => r.method === "PATCH" && r.url.includes("/config/auth"),
      );
      expect(update).toBeDefined();
      expect(update?.body).toEqual({ sms_otp_exp: 120 });
    }).pipe(Effect.provide(layer));
  });

  it.live("routes db.pooler.pool_mode to the unsupported note, never a resource", () => {
    const { layer, out } = setup({
      toml: `project_id = "test"\n[db.pooler]\npool_mode = "session"\n`,
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain(
        "Note: 1 declared property has no Management API field and was not pushed: db.pooler.pool_mode (change them from the dashboard).",
      );
      const success = out.messages.find((m) => m.type === "success");
      const data = success?.data as Record<string, unknown>;
      expect(data["unsupported"]).toEqual([["db", "pooler", "pool_mode"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "401 / 403 / 404 on the config read get purpose-written messages; other statuses stay generic",
    () => {
      const cases: ReadonlyArray<{ status: number; expect: ReadonlyArray<string> }> = [
        { status: 401, expect: ["Authentication failed", "supabase login"] },
        { status: 403, expect: ["Access denied for project", REF] },
        { status: 404, expect: [`Project ${REF} not found`, "supabase projects list"] },
        { status: 500, expect: [`unexpected status 500: {"message":"boom"}`] },
      ];
      return Effect.gen(function* () {
        for (const testCase of cases) {
          const { layer } = setup({
            toml: `project_id = "test"\n`,
            yes: true,
            v2: { status: testCase.status, body: { message: "boom" } },
          });
          const message = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(
            Effect.catchTag("LegacyConfigPushConfigReadStatusError", (error) =>
              Effect.succeed(error.message),
            ),
            Effect.provide(layer),
          );
          for (const fragment of testCase.expect) {
            expect(message).toContain(fragment);
          }
        }
      });
    },
  );

  it.live("a config-read transport failure maps to the read network error", () => {
    const { layer, telemetry } = setup({ toml: `project_id = "test"\n`, yes: true, v2: "fail" });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPushConfigReadNetworkError");
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "an out-of-domain mapped value in the response keeps its typed parse error and pushes nothing",
    () => {
      const { layer, api } = setup({
        toml: `project_id = "test"\n`,
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            attributes: (a) => ({
              ...a,
              storage: { ...(a["storage"] as Record<string, unknown>), file_size_limit: -1 },
            }),
          }),
        },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("ProjectConfigParseError");
        expect(
          api.requests.some(
            (r) => r.method === "PATCH" || r.method === "PUT" || r.method === "POST",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "aborts with LegacyConfigPushConfigEmptyError when the response carries no block at all (D2)",
    () => {
      // Replaces the old "reports every block missing and pushes nothing"
      // expectation: an entirely empty `attributes` means `scope.present` is
      // empty, and per D2 the command must never silently treat that as
      // "everything is a fresh write" — it aborts before touching any
      // resource instead.
      const { layer, out, api } = setup({
        toml: `project_id = "test"\n`,
        yes: true,
        v2: { status: 200, body: v2Response({ attributes: () => ({}) }) },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("LegacyConfigPushConfigEmptyError");
        expect(out.stderrText).toContain(
          "Comparison scope: (none) (not returned: api, auth, database, pooler, realtime, storage)",
        );
        expect(
          api.requests.some(
            (r) => r.method === "PATCH" || r.method === "PUT" || r.method === "POST",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a disabled storage.analytics whose remote is enabled surfaces as unmanaged, not pushed",
    () => {
      const { layer, out, api } = setup({
        toml: `project_id = "test"\n[storage.analytics]\nenabled = false\n`,
        format: "json",
        v2: {
          status: 200,
          body: v2Response({
            attributes: (a) => ({
              ...a,
              storage: {
                ...(a["storage"] as Record<string, unknown>),
                features: {
                  ...((a["storage"] as Record<string, unknown>)["features"] as Record<
                    string,
                    unknown
                  >),
                  iceberg_catalog: {
                    enabled: true,
                    max_namespaces: 5,
                    max_tables: 10,
                    max_catalogs: 2,
                  },
                },
              },
            }),
          }),
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(
          "Note: 1 declared property is not managed by config push and was not compared; run `supabase config diff` to list them.",
        );
        expect(
          api.requests.some((r) => r.method === "PATCH" && r.url.includes("/config/storage")),
        ).toBe(false);
        const success = out.messages.find((m) => m.type === "success");
        const data = success?.data as Record<string, unknown>;
        expect(data["unmanaged"]).toEqual([["storage", "analytics", "enabled"]]);
        expect(data["unsupported"]).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a declared auth.oauth_server surfaces as unmanaged, never as unsupported", () => {
    const { layer, out } = setup({
      toml: `project_id = "test"\n[auth.oauth_server]\nenabled = true\n`,
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain(
        "Note: 1 declared property is not managed by config push and was not compared; run `supabase config diff` to list them.",
      );
      const success = out.messages.find((m) => m.type === "success");
      const data = success?.data as Record<string, unknown>;
      expect(data["unmanaged"]).toEqual([["auth", "oauth_server", "enabled"]]);
      expect(data["unsupported"]).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports the remote-only count when nothing pushable exists anywhere", () => {
    const { layer, out, api } = setup({
      toml: `project_id = "test"\n`,
      format: "json",
      v2: {
        status: 200,
        body: v2Response({
          attributes: (a) => ({
            ...a,
            database: {
              ...(a["database"] as Record<string, unknown>),
              postgres_settings: { work_mem: "64MB" },
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain(
        "Note: 1 remote property is not declared in supabase/config.toml and was left unchanged (config push no longer resets undeclared properties to their defaults; run `supabase config diff` to inspect).",
      );
      expect(
        api.requests.some((r) => r.method === "PATCH" || r.method === "PUT" || r.method === "POST"),
      ).toBe(false);
      const success = out.messages.find((m) => m.type === "success");
      const data = success?.data as Record<string, unknown>;
      expect(data["remote_only"]).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});

// ---------------------------------------------------------------------------
// Gated services (auth / db.network_restrictions / db.ssl_enforcement /
// experimental) and secret handling. These mostly use the direct-service
// mock (no response-schema validation) because auth's typed write response
// has ~200 required fields (`V1UpdateAuthServiceConfigOutput`) that no test
// should have to hand-author; a raw HttpClient still serves the cost-matrix
// /billing/addons call, and `raw.v2GetProjectConfig` serves the effective
// config read. Storage's success-path write (`V1UpdateStorageConfigOutput`
// is `Schema.Void`) goes through the REAL client via `setup()` above instead,
// alongside its `api`/`db.settings` siblings — only its own failure-mapping
// test stays on the service mock, matching the other Update-error tests.
// ---------------------------------------------------------------------------

function addonsHttpLayer(
  body: unknown = { available_addons: [] },
): Layer.Layer<HttpClient.HttpClient> {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  );
}

const BASE_DISABLED = `project_id = "test"\n`;

function setupService(opts: {
  readonly toml: string;
  readonly v1?: Record<string, (input: unknown) => Effect.Effect<unknown, unknown>>;
  readonly v2?: { status: number; body: unknown } | "fail";
  readonly addons?: { available_addons: ReadonlyArray<unknown> };
  readonly format?: "text" | "json" | "stream-json";
  readonly yes?: boolean;
  readonly confirm?: ReadonlyArray<boolean>;
  readonly runtimeCwd?: string;
  /** cliSettings.workdir override (what `--workdir` resolves to); defaults to the temp project root. */
  readonly workdir?: string;
  /** stdin interactivity; defaults to a TTY so prompt-driven tests reach the confirm. */
  readonly stdinIsTty?: boolean;
  /** Piped (non-TTY) stdin answers, one consumed per confirmation prompt. */
  readonly pipedAnswers?: ReadonlyArray<string>;
}) {
  writeConfig(opts.toml);
  const out = mockOutput({ format: opts.format ?? "text", promptConfirmResponses: opts.confirm });
  const apiMock = mockLegacyPlatformApiService({
    v1: {
      // CLI-2168's live target-detection probe — defaults to a schema-valid,
      // unnamed project so every gated-service scenario keeps working
      // without opting in (mirrors `setup()`'s own default above);
      // overridable via `opts.v1.getProject`.
      getProject: () => Effect.succeed(PUSH_TEST_PROJECT),
      ...opts.v1,
    },
    raw: {
      v2GetProjectConfig:
        opts.v2 === "fail" ? "fail" : (opts.v2 ?? { status: 200, body: v2Response() }),
    },
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api: { layer: apiMock.layer, httpClientLayer: addonsHttpLayer(opts.addons) },
      cliSettings: mockLegacyCliSettings({ workdir: opts.workdir ?? tempRoot.current }),
      runtimeInfo: mockRuntimeInfo({ cwd: opts.runtimeCwd ?? tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
      // Gated-service prompts model an interactive user answering via `confirm`.
      tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? true, stdoutIsTty: false }),
    }),
    mockStdin(
      opts.stdinIsTty ?? true,
      opts.pipedAnswers ? `${opts.pipedAnswers.join("\n")}\n` : undefined,
    ),
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
[auth]
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
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
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
[auth]
site_url = "http://localhost:3000"
[auth.email.template.invite]
subject = "You are invited"
content_path = "./templates/missing.html"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
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
[auth]
site_url = "http://localhost:3000"
[auth.email.template.invite]
subject = "Nested invite"
content_path = "./templates/invite.html"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      runtimeCwd: nestedCwd,
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
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
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "my-plaintext-secret"
`;
      const { layer, apiMock, out } = setupService({
        toml,
        yes: true,
        v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
        expect(update).toBeDefined();
        const input = update?.input as Record<string, unknown>;
        expect(input["security_captcha_secret"]).toBe("my-plaintext-secret");
        expect(String(input["security_captcha_secret"])).not.toContain("hash:");
        // D6: no remote digest at all renders "(set)" / "(not set)", never the plaintext.
        // D7: every block — including the last one before the prompt — ends on a blank line.
        expect(out.stderrText).toMatch(
          /\n\nauth\.captcha\.secret \[secret\]\n {2}local: {2}\(set\)\n {2}remote: \(not set\)\n\n/,
        );
        expect(out.stderrText).toMatch(
          /\n\nDo you want to push auth config to remote\? \[Y\/n\] y\n/,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "decrypts a dotenvx encrypted: captcha secret and pushes the plaintext (CLI-1881)",
    () => {
      const toml = `project_id = "test"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "${DOTENVX_ENCRYPTED_VALUE}"
`;
      const { layer, apiMock } = setupService({
        toml,
        yes: true,
        v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
      });
      return withDotenvPrivateKey(
        DOTENVX_PRIVATE_KEY,
        Effect.gen(function* () {
          yield* legacyConfigPush({ projectRef: Option.none() });
          const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
          expect(update).toBeDefined();
          const input = update?.input as Record<string, unknown>;
          expect(input["security_captcha_secret"]).toBe("value");
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.live(
    "aborts before any network call when an encrypted: secret cannot be decrypted (CLI-1881)",
    () => {
      const toml = `project_id = "test"
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
      // decrypted during config load — but no encoder in `push.encoders.ts`
      // (api, db, auth, storage) ever reads `studio.*`, so this proves the
      // pre-check is genuinely document-wide, not merely reachable via `auth.*`.
      const toml = `project_id = "test"
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
    const toml = `project_id = "test"
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
      const toml = `project_id = "test"
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

  it.live("pushes storage when enabled and changed, with the features container absent", () => {
    // Regression test for the encoder's sparse body: the storage encoder
    // omits `features` entirely here, so the sparse body must clear
    // `V1UpdateStorageConfigInput`'s schema through the REAL client — that
    // sparseness is the whole point of the assertion below.
    const { layer, api } = setup({
      toml: `project_id = "test"\n[storage]\nfile_size_limit = "100MiB"\n`,
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = api.requests.find(
        (r) => r.method === "PATCH" && r.url.includes("/config/storage"),
      );
      expect(update).toBeDefined();
      expect(update?.body).toEqual({ fileSizeLimit: 104857600 });
    }).pipe(Effect.provide(layer));
  });

  it.live("pushes db.network_restrictions with both CIDR arrays whenever either changes", () => {
    const toml = `${BASE_DISABLED}[db.network_restrictions]
enabled = true
allowed_cidrs = ["1.2.3.4/32"]
allowed_cidrs_v6 = ["::1/128"]
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: { updateNetworkRestrictions: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateNetworkRestrictions");
      expect(update).toBeDefined();
      expect(update?.input).toEqual({
        ref: REF,
        dbAllowedCidrs: ["1.2.3.4/32"],
        dbAllowedCidrsV6: ["::1/128"],
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("pushes db.ssl_enforcement only when declared in config", () => {
    const toml = `${BASE_DISABLED}[db.ssl_enforcement]\nenabled = true\n`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: { updateSslEnforcementConfig: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateSslEnforcementConfig");
      expect(update).toBeDefined();
      expect(update?.input).toEqual({ ref: REF, requestedConfig: { database: true } });
    }).pipe(Effect.provide(layer));
  });

  it.live("does not touch ssl_enforcement when the section is absent (status: disabled)", () => {
    const { layer, apiMock, out } = setupService({
      toml: BASE_DISABLED,
      format: "json",
      v1: {},
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).not.toContain("updateSslEnforcementConfig");
      const success = out.messages.find((m) => m.type === "success");
      const data = success?.data as Record<string, unknown>;
      const services = data["services"] as ReadonlyArray<Record<string, unknown>>;
      expect(services.find((s) => s["service"] === "db.ssl_enforcement")).toEqual({
        service: "db.ssl_enforcement",
        status: "disabled",
        changes: [],
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("enables webhooks when experimental.webhooks is enabled (no diff)", () => {
    const toml = `${BASE_DISABLED}[experimental.webhooks]\nenabled = true\n`;
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

  it.live("a webhook enable failure fails the push", () => {
    const toml = `${BASE_DISABLED}[experimental.webhooks]\nenabled = true\n`;
    const { layer } = setupService({
      toml,
      yes: true,
      v1: { enableDatabaseWebhook: () => Effect.fail(legacyStatusCodeFailure(500)) },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPushEnableWebhookStatusError");
    }).pipe(Effect.provide(layer));
  });

  it.live("declining the webhooks prompt leaves them disabled", () => {
    const toml = `${BASE_DISABLED}[experimental.webhooks]\nenabled = true\n`;
    const { layer, apiMock, out } = setupService({ toml, confirm: [false] });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Enabling webhooks for project:");
      expect(methodsOf(apiMock)).not.toContain("enableDatabaseWebhook");
    }).pipe(Effect.provide(layer));
  });

  it.live("auth disabled skips email content loading and reports the resource as disabled", () => {
    const { layer, out, apiMock } = setupService({
      toml: `project_id = "test"\n[auth]\nenabled = false\n`,
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).not.toContain("updateAuthServiceConfig");
      const success = out.messages.find((m) => m.type === "success");
      const data = success?.data as Record<string, unknown>;
      const services = data["services"] as ReadonlyArray<Record<string, unknown>>;
      expect(services.find((s) => s["service"] === "auth")).toEqual({
        service: "auth",
        status: "disabled",
        changes: [],
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("storage disabled reports the resource as disabled without a write", () => {
    const { layer, out, apiMock } = setupService({
      toml: `project_id = "test"\n[storage]\nenabled = false\n`,
      format: "json",
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).not.toContain("updateStorageConfig");
      const success = out.messages.find((m) => m.type === "success");
      const data = success?.data as Record<string, unknown>;
      const services = data["services"] as ReadonlyArray<Record<string, unknown>>;
      expect(services.find((s) => s["service"] === "storage")).toEqual({
        service: "storage",
        status: "disabled",
        changes: [],
      });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a v2 response without the data envelope aborts (D2) even though the diff itself would tolerate it",
    () => {
      // `fromApiProjectConfig`'s own envelope-unwrapping (ADR 0019) tolerates
      // a bare-attributes response with no `data` wrapper — but
      // `push.handler.ts`'s own separate `data`/`attributes` extraction
      // (used only for the scope line and the auth-secret comparison) does
      // not replicate that fallback, so `scope.present` comes back empty for
      // this shape even though the diff itself would have used the real
      // values (same duplicated-extraction pattern as `diff.handler.ts`).
      // Per D2, an empty `scope.present` is now a hard abort rather than a
      // silent "push everything" — so this shape can never reach a write,
      // even though the API always sends the `data` envelope in practice.
      const bareAttributes = v2Response().data.attributes;
      const { layer, out, apiMock } = setupService({
        toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
        yes: true,
        v2: { status: 200, body: bareAttributes },
        v1: { updatePostgrestServiceConfig: () => Effect.succeed({}) },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("LegacyConfigPushConfigEmptyError");
        expect(out.stderrText).toContain(
          "Comparison scope: (none) (not returned: api, auth, database, pooler, realtime, storage)",
        );
        expect(methodsOf(apiMock)).not.toContain("updatePostgrestServiceConfig");
      }).pipe(Effect.provide(layer));
    },
  );

  // -- secrets --------------------------------------------------------------

  it.live("a matching secret digest produces no auth write at all", () => {
    const toml = `project_id = "test"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "same-secret"
`;
    const { layer, apiMock, out } = setupService({
      toml,
      yes: true,
      v2: {
        status: 200,
        body: v2Response({
          attributes: (a) => ({
            ...a,
            auth: {
              ...(a["auth"] as Record<string, unknown>),
              security_captcha_enabled: true,
              security_captcha_provider: "hcaptcha",
              security_captcha_secret: digestOf("same-secret"),
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Remote Auth config is up to date.");
      expect(methodsOf(apiMock)).not.toContain("updateAuthServiceConfig");
    }).pipe(Effect.provide(layer));
  });

  it.live("only the secret whose digest differs is sent; the matching one is withheld", () => {
    const toml = `project_id = "test"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "same-secret"
[auth.external.github]
enabled = true
client_id = "id"
secret = "new-secret"
`;
    const { layer, apiMock, out } = setupService({
      toml,
      yes: true,
      v2: {
        status: 200,
        body: v2Response({
          attributes: (a) => ({
            ...a,
            auth: {
              ...(a["auth"] as Record<string, unknown>),
              security_captcha_secret: digestOf("same-secret"),
              external_github_secret: digestOf("old-secret"),
            },
          }),
        }),
      },
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["security_captcha_secret"]).toBeUndefined();
      expect(input["external_github_secret"]).toBe("new-secret");
      expect(input["security_captcha_enabled"]).toBe(true);
      expect(input["security_captcha_provider"]).toBe("hcaptcha");
      // D6: a differing remote digest renders "(set — differs)", not a bare "(set)".
      expect(out.stderrText).toMatch(
        /\n\nauth\.external\.github\.secret \[secret\]\n {2}local: {2}\(set\)\n {2}remote: \(set — differs\)\n\n/,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("an empty/unresolved env() secret is never sent and is reported by name", () => {
    const toml = `project_id = "test"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "env(MISSING_CAPTCHA_SECRET)"
`;
    const { layer, apiMock, out } = setupService({
      toml,
      format: "json",
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["security_captcha_secret"]).toBeUndefined();
      // D4/D6: disclosed inside the resource block, before the prompt, with
      // the "unresolved env reference" wording — and (D7) the block still
      // ends on a blank line even though it's the last thing this resource
      // prints (the format-json push never echoes the prompt itself).
      expect(out.stderrText).toContain(
        "auth.captcha.secret [secret]\n  local:  (not set — empty or unresolved env reference; will not be pushed)\n  remote: (not set)\n\n",
      );
      expect(out.stderrText).toContain(
        "Note: 1 credential value was not pushed (empty or unresolved env reference): auth.captcha.secret",
      );
      const success = out.messages.find((m) => m.type === "success");
      const data = success?.data as Record<string, unknown>;
      // D9: `not_set` (renamed from `not_sent`), and gated secrets have their own bucket.
      expect(data["secrets"]).toMatchObject({
        sent: [],
        not_set: [["auth", "captcha", "secret"]],
        gated: [],
      });
    }).pipe(Effect.provide(layer));
  });

  // -- MFA cost-aware addon prompts ------------------------------------------

  it.live("declining the phone MFA addon drops only the MFA keys", () => {
    const toml = `project_id = "test"
[auth]
site_url = "https://example.com"
[auth.mfa.phone]
verify_enabled = true
enroll_enabled = true
`;
    const { layer, apiMock } = setupService({
      toml,
      confirm: [false, true],
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["site_url"]).toBe("https://example.com");
      expect(input["mfa_phone_verify_enabled"]).toBeUndefined();
      expect(input["mfa_phone_enroll_enabled"]).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("declining the WebAuthn MFA addon drops only the MFA keys", () => {
    const toml = `project_id = "test"
[auth]
site_url = "https://example.com"
[auth.mfa.web_authn]
verify_enabled = true
enroll_enabled = true
`;
    const { layer, apiMock } = setupService({
      toml,
      confirm: [false, true],
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["site_url"]).toBe("https://example.com");
      expect(input["mfa_web_authn_verify_enabled"]).toBeUndefined();
      expect(input["mfa_web_authn_enroll_enabled"]).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "an enroll-only flip (verify_enabled absent) still prompts, and declining drops the change",
    () => {
      // CLI-2313 (PR #6454 review): before this fix, the gate only looked at
      // `verify_enabled` — an `enroll_enabled`-only flip skipped the prompt
      // entirely and pushed the paid addon unconfirmed.
      const toml = `project_id = "test"\n[auth.mfa.phone]\nenroll_enabled = true\n`;
      const { layer, apiMock, out } = setupService({
        toml,
        confirm: [false],
        addons: {
          available_addons: [
            {
              type: "auth_mfa_phone",
              variants: [{ name: "Phone MFA", price: { description: "$75.00/ month" } }],
            },
          ],
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.promptConfirmCalls.map((call) => call.message)).toContain(
          "Enabling Phone MFA will cost you $75.00/ month. Keep it enabled?",
        );
        expect(methodsOf(apiMock)).not.toContain("updateAuthServiceConfig");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "an enroll-only flip (verify_enabled absent) pushes mfa_phone_enroll_enabled when accepted",
    () => {
      const toml = `project_id = "test"\n[auth.mfa.phone]\nenroll_enabled = true\n`;
      const { layer, apiMock } = setupService({
        toml,
        confirm: [true, true],
        addons: {
          available_addons: [
            {
              type: "auth_mfa_phone",
              variants: [{ name: "Phone MFA", price: { description: "$75.00/ month" } }],
            },
          ],
        },
        v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
        expect(update).toBeDefined();
        const input = update?.input as Record<string, unknown>;
        expect(input["mfa_phone_enroll_enabled"]).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("an enroll-only flip never prompts when the remote already has verify_enabled on", () => {
    const toml = `project_id = "test"\n[auth.mfa.phone]\nenroll_enabled = true\n`;
    const { layer, apiMock, out } = setupService({
      toml,
      confirm: [true],
      v2: {
        status: 200,
        body: v2Response({
          attributes: (a) => ({
            ...a,
            auth: { ...(a["auth"] as Record<string, unknown>), mfa_phone_verify_enabled: true },
          }),
        }),
      },
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.promptConfirmCalls.some((call) => call.message.includes("Enabling"))).toBe(false);
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["mfa_phone_enroll_enabled"]).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepting a costed MFA addon prompt shows its price and pushes the setting", () => {
    const toml = `project_id = "test"\n[auth.mfa.phone]\nverify_enabled = true\n`;
    const { layer, apiMock, out } = setupService({
      toml,
      confirm: [true, true],
      addons: {
        available_addons: [
          {
            type: "auth_mfa_phone",
            variants: [{ name: "Phone MFA", price: { description: "$75.00/ month" } }],
          },
        ],
      },
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      // A real-TTY confirm goes through `output.promptConfirm` (clack), which
      // the mock resolves silently — it never echoes the label to stderr the
      // way the `--yes`/non-TTY paths do, so assert on the recorded call.
      expect(out.promptConfirmCalls.map((call) => call.message)).toContain(
        "Enabling Phone MFA will cost you $75.00/ month. Keep it enabled?",
      );
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["mfa_phone_verify_enabled"]).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("declining MFA with no other auth change reports up to date and never writes", () => {
    const toml = `project_id = "test"\n[auth.mfa.phone]\nverify_enabled = true\nenroll_enabled = true\n`;
    const { layer, apiMock, out } = setupService({ toml, confirm: [false] });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Remote Auth config is up to date.");
      expect(methodsOf(apiMock)).not.toContain("updateAuthServiceConfig");
    }).pipe(Effect.provide(layer));
  });

  // -- write failures (exercise the remaining Update error mappers) ---------

  it.live("a db.settings PUT failure fails the push", () => {
    const toml = `project_id = "test"\n[db.settings]\neffective_cache_size = "768MB"\n`;
    const { layer } = setupService({
      toml,
      yes: true,
      v1: { updatePostgresConfig: () => Effect.fail(new Error("boom")) },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("a db.network_restrictions POST failure fails the push", () => {
    const toml = `${BASE_DISABLED}[db.network_restrictions]\nenabled = true\nallowed_cidrs = ["1.2.3.4/32"]\n`;
    const { layer } = setupService({
      toml,
      yes: true,
      v1: { updateNetworkRestrictions: () => Effect.fail(new Error("boom")) },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("a db.ssl_enforcement PUT failure fails the push", () => {
    const toml = `${BASE_DISABLED}[db.ssl_enforcement]\nenabled = true\n`;
    const { layer } = setupService({
      toml,
      yes: true,
      v1: { updateSslEnforcementConfig: () => Effect.fail(new Error("boom")) },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("an auth PATCH failure fails the push", () => {
    const toml = `project_id = "test"\n[auth]\nsite_url = "https://x.example.com"\n`;
    const { layer } = setupService({
      toml,
      yes: true,
      v1: { updateAuthServiceConfig: () => Effect.fail(new Error("boom")) },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("a storage PATCH failure fails the push", () => {
    const toml = `project_id = "test"\n[storage]\nfile_size_limit = "100MiB"\n`;
    const { layer } = setupService({
      toml,
      yes: true,
      v1: { updateStorageConfig: () => Effect.fail(new Error("boom")) },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("a webhook enable transport failure maps to the network error", () => {
    const toml = `${BASE_DISABLED}[experimental.webhooks]\nenabled = true\n`;
    const { layer } = setupService({
      toml,
      yes: true,
      v1: { enableDatabaseWebhook: () => Effect.fail(new Error("ECONNRESET")) },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPushEnableWebhookNetworkError");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "db.network_restrictions reports up to date when declared arrays match the v2 block",
    () => {
      const toml = `${BASE_DISABLED}[db.network_restrictions]
enabled = true
allowed_cidrs = ["0.0.0.0/0"]
allowed_cidrs_v6 = ["::/0"]
`;
      const { layer, apiMock, out } = setupService({ toml, yes: true });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain("Remote DB Network restrictions config is up to date.");
        expect(methodsOf(apiMock)).not.toContain("updateNetworkRestrictions");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("db.ssl_enforcement reports up to date when declared value matches the v2 block", () => {
    const toml = `${BASE_DISABLED}[db.ssl_enforcement]\nenabled = false\n`;
    const { layer, apiMock, out } = setupService({ toml, yes: true });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Remote DB SSL enforcement config is up to date.");
      expect(methodsOf(apiMock)).not.toContain("updateSslEnforcementConfig");
    }).pipe(Effect.provide(layer));
  });
});

// ---------------------------------------------------------------------------
// Fix-pass scenarios (review adjudication rounds — architecture/security/DX).
// Each test cites the decision letter(s) it exercises.
// ---------------------------------------------------------------------------

describe("legacy config push fix-pass scenarios", () => {
  it.live(
    "D1: an undeclared allowed_cidrs_v6 keeps the REMOTE v6 list, not a schema default",
    () => {
      const toml = `${BASE_DISABLED}[db.network_restrictions]
enabled = true
allowed_cidrs = ["9.9.9.9/32"]
`;
      const { layer, apiMock } = setupService({
        toml,
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            attributes: (a) => ({
              ...a,
              database: {
                ...(a["database"] as Record<string, unknown>),
                network_restrictions: {
                  ...((a["database"] as Record<string, unknown>)["network_restrictions"] as Record<
                    string,
                    unknown
                  >),
                  allowed_cidrs: [
                    { address: "9.9.9.8/32", type: "v4" },
                    { address: "2001:db8::/32", type: "v6" },
                  ],
                },
              },
            }),
          }),
        },
        v1: { updateNetworkRestrictions: () => Effect.succeed({}) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const update = apiMock.requests.find((r) => r.method === "updateNetworkRestrictions");
        expect(update).toBeDefined();
        const input = update?.input as Record<string, unknown>;
        expect(input["dbAllowedCidrs"]).toEqual(["9.9.9.9/32"]);
        expect(input["dbAllowedCidrsV6"]).toEqual(["2001:db8::/32"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "D1: an undeclared storage.vector.max_indexes keeps the REMOTE value, not the schema default",
    () => {
      const toml = `project_id = "test"
[storage]
enabled = true
[storage.vector]
enabled = true
max_buckets = 20
`;
      const { layer, apiMock } = setupService({
        toml,
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            attributes: (a) => {
              const storage = a["storage"] as Record<string, unknown>;
              const features = storage["features"] as Record<string, unknown>;
              return {
                ...a,
                storage: {
                  ...storage,
                  features: {
                    ...features,
                    vector_buckets: { enabled: true, max_buckets: 10, max_indexes: 7 },
                  },
                },
              };
            },
          }),
        },
        v1: { updateStorageConfig: () => Effect.succeed({}) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const update = apiMock.requests.find((r) => r.method === "updateStorageConfig");
        expect(update).toBeDefined();
        const input = update?.input as Record<string, unknown>;
        expect(input["features"]).toEqual({
          vectorBuckets: { enabled: true, maxBuckets: 20, maxIndexes: 7 },
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("D1: an undeclared external_<id>_email_optional keeps the REMOTE value", () => {
    const toml = `project_id = "test"
[auth.external.github]
enabled = true
client_id = "new-client-id"
secret = "gh-secret"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v2: {
        status: 200,
        body: v2Response({
          attributes: (a) => ({
            ...a,
            auth: {
              ...(a["auth"] as Record<string, unknown>),
              external_github_enabled: true,
              external_github_client_id: "old-client-id",
              external_github_email_optional: true,
            },
          }),
        }),
      },
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["external_github_client_id"]).toBe("new-client-id");
      expect(input["external_github_email_optional"]).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "D1: a group member the remote never reported is sent at its default and disclosed as [group-write]",
    () => {
      const toml = `project_id = "test"
[storage]
enabled = true
[storage.vector]
enabled = true
max_buckets = 99
`;
      const { layer, apiMock, out } = setupService({
        toml,
        format: "json",
        v2: {
          status: 200,
          body: v2Response({
            attributes: (a) => {
              const storage = a["storage"] as Record<string, unknown>;
              const features = storage["features"] as Record<string, unknown>;
              const { vector_buckets: _vectorBuckets, ...restFeatures } = features;
              return { ...a, storage: { ...storage, features: restFeatures } };
            },
          }),
        },
        v1: { updateStorageConfig: () => Effect.succeed({}) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const update = apiMock.requests.find((r) => r.method === "updateStorageConfig");
        expect(update).toBeDefined();
        const input = update?.input as Record<string, unknown>;
        expect(input["features"]).toEqual({
          vectorBuckets: { enabled: true, maxBuckets: 99, maxIndexes: 5 },
        });
        expect(out.stderrText).toContain(
          "storage.vector.max_indexes [group-write]\n  local:  5 (schema default — not declared in config.toml)\n  remote: (not returned)\n\n",
        );
        expect(out.stderrText).toContain(
          "Note: 1 undeclared property had to be sent alongside a declared change and was written at its config default: storage.vector.max_indexes",
        );
        const success = out.messages.find((m) => m.type === "success");
        const data = success?.data as Record<string, unknown>;
        expect(data["forced"]).toEqual([{ path: ["storage", "vector", "max_indexes"], value: 5 }]);
        expect(data["remote_only"]).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "D2/S5: a missing auth block leaves auth unavailable — zero writes, no prompt, credentials withheld",
    () => {
      const toml = `project_id = "test"
[auth]
site_url = "https://example.com"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "super-secret"
`;
      const { layer, apiMock, out } = setupService({
        toml,
        format: "json",
        v2: {
          status: 200,
          body: v2Response({
            attributes: (a) => {
              const { auth: _auth, ...rest } = a;
              return rest;
            },
          }),
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(
          "Comparison scope: api, database, pooler, realtime, storage (not returned: auth)",
        );
        expect(out.stderrText).not.toContain("Updating Auth service with config:");
        expect(out.stderrText).not.toContain("Do you want to push auth config to remote?");
        expect(methodsOf(apiMock)).not.toContain("updateAuthServiceConfig");
        const success = out.messages.find((m) => m.type === "success");
        const data = success?.data as Record<string, unknown>;
        const services = data["services"] as ReadonlyArray<Record<string, unknown>>;
        expect(services.find((s) => s["service"] === "auth")).toEqual({
          service: "auth",
          status: "unavailable",
          changes: [],
        });
        // Every declared credential is reported withheld (`skipped`), never `sent` —
        // the write never ran, so a "send"-worthy digest never reaches the wire.
        expect(data["secrets"]).toMatchObject({
          sent: [],
          skipped: [["auth", "captcha", "secret"]],
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("the not-set credential note is suppressed when auth itself is unavailable", () => {
    // Same missing-auth-block shape as the D2/S5 test above, but with a
    // declared credential that would otherwise be reported `not_set`
    // (empty/unresolved `env(...)`) rather than `send` — the note is
    // specific to a credential whose OWN value was empty/unresolved, which
    // doesn't apply when the whole resource was never compared.
    const toml = `project_id = "test"
[auth]
site_url = "https://example.com"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "env(MISSING_CAPTCHA_SECRET)"
`;
    const { layer, apiMock, out } = setupService({
      toml,
      format: "json",
      v2: {
        status: 200,
        body: v2Response({
          attributes: (a) => {
            const { auth: _auth, ...rest } = a;
            return rest;
          },
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).not.toContain("credential value was not pushed");
      expect(methodsOf(apiMock)).not.toContain("updateAuthServiceConfig");
      const success = out.messages.find((m) => m.type === "success");
      const data = success?.data as Record<string, unknown>;
      const services = data["services"] as ReadonlyArray<Record<string, unknown>>;
      expect(services.find((s) => s["service"] === "auth")).toEqual({
        service: "auth",
        status: "unavailable",
        changes: [],
      });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "not_pushable status renders correctly for a genuinely reachable unencodable case (an invalid byte size)",
    () => {
      // `storage.file_size_limit` is schema-typed as a plain string, so an
      // invalid byte-size expression survives config LOADING and only
      // fails inside the encoder's own `ramInBytes` call — unlike the two
      // D10 candidates above, this one is reachable end to end, and proves
      // the `not_pushable` status/line/note render correctly.
      const toml = `project_id = "test"\n[storage]\nfile_size_limit = "not-a-size"\n`;
      const { layer, apiMock, out } = setupService({ toml, format: "json" });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(
          "Remote Storage config has 1 difference config push cannot write (see notes below).",
        );
        expect(out.stderrText).toContain(
          "Note: 1 declared property could not be encoded and was not pushed: storage.file_size_limit (the declared value is not a valid byte size)",
        );
        expect(methodsOf(apiMock)).not.toContain("updateStorageConfig");
        const success = out.messages.find((m) => m.type === "success");
        const data = success?.data as Record<string, unknown>;
        const services = data["services"] as ReadonlyArray<Record<string, unknown>>;
        expect(services.find((s) => s["service"] === "storage")).toEqual({
          service: "storage",
          status: "not_pushable",
          changes: [],
        });
        expect(data["unencodable"]).toEqual([
          {
            path: ["storage", "file_size_limit"],
            reason: "the declared value is not a valid byte size",
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "D12: declining the phone MFA addon sends explicit false disables when the remote already had it on",
    () => {
      // Text mode (not json): the addon-decline prompt only ever consumes a
      // real confirm answer in text mode — `keep()` short-circuits to the
      // default (accept) for any machine format, so a decline can never be
      // observed there. `declined_addons`' payload SHAPE is covered by the
      // "emits a structured summary" test instead.
      const toml = `project_id = "test"
[auth.mfa.phone]
verify_enabled = true
`;
      const { layer, apiMock } = setupService({
        toml,
        confirm: [false, true],
        v2: {
          status: 200,
          body: v2Response({
            attributes: (a) => ({
              ...a,
              auth: { ...(a["auth"] as Record<string, unknown>), mfa_phone_enroll_enabled: true },
            }),
          }),
        },
        v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
        expect(update).toBeDefined();
        const input = update?.input as Record<string, unknown>;
        expect(input["mfa_phone_verify_enabled"]).toBe(false);
        expect(input["mfa_phone_enroll_enabled"]).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("S1/D9: declining the auth prompt leaves the secret unsent (text mode)", () => {
    // Text mode: `keep()` only ever consumes a real decline in text mode
    // (json/stream-json short-circuit every prompt to the default accept —
    // see the D12 comment above), so this asserts the write-side effect
    // (no PATCH, no secret leaked) rather than the json payload; the
    // `secrets.skipped` SHAPE for an unsent "send"-decided secret is proven
    // by the "D2/S5" and "an empty/unresolved env()" tests above, whose
    // `authWriteRan === false` comes from a different cause (`unavailable`,
    // `not_set`) but exercises the identical payload branch
    // (`push.format.ts`'s `authWriteRan ? sendDecisions... : []`).
    const toml = `project_id = "test"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "new-secret"
`;
    const { layer, apiMock, out } = setupService({
      toml,
      stdinIsTty: false,
      pipedAnswers: ["n"],
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).not.toContain("updateAuthServiceConfig");
      expect(out.stderrText).toContain("auth.captcha.secret [secret]");
      expect(out.stderrText).toContain("Do you want to push auth config to remote? [Y/n] n");
    }).pipe(Effect.provide(layer));
  });

  it.live("S1/D9: a declared secret under a disabled container is gated, never sent", () => {
    const toml = `project_id = "test"
[auth.captcha]
enabled = false
secret = "irrelevant"
`;
    const { layer, apiMock, out } = setupService({
      toml,
      format: "json",
      yes: true,
      v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      // Declaring `enabled = false` (a value the remote never reported) is
      // itself a routed `local_only` change, so the write still runs — the
      // gated secret must never ride along inside it.
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["security_captcha_enabled"]).toBe(false);
      expect(input["security_captcha_secret"]).toBeUndefined();
      const success = out.messages.find((m) => m.type === "success");
      const data = success?.data as Record<string, unknown>;
      expect(data["secrets"]).toMatchObject({
        sent: [],
        skipped: [],
        gated: [["auth", "captcha", "secret"]],
      });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "S4: sanitizes a hostile [remotes.*] name before printing the config-override line",
    () => {
      const { layer, out } = setup({
        toml: [
          'project_id = "test"',
          '[remotes."evil\\u001B[31m\\nred"]',
          `project_id = "${REF}"`,
          "",
        ].join("\n"),
        yes: true,
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain("Loading config override: [remotes.evil[31m red]");
        expect(out.stderrText).not.toContain("\u001b");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "A5/D8: a content-only auth push prints a [content] block and PATCHes only the template content key",
    () => {
      const templateDir = join(tempRoot.current, "templates-content-only");
      mkdirSync(templateDir, { recursive: true });
      writeFileSync(join(templateDir, "invite.html"), "<h1>Invite</h1>");
      const toml = `project_id = "test"
[auth.email.template.invite]
content_path = "./templates-content-only/invite.html"
`;
      const { layer, apiMock, out } = setupService({
        toml,
        format: "json",
        yes: true,
        v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(
          "Updating Auth service with config:\nauth.email.template.invite.content [content]\n  local:  (file content from content_path)\n  remote: (differs)\n\n",
        );
        const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
        expect(update).toBeDefined();
        expect(update?.input).toEqual({
          ref: REF,
          mailer_templates_invite_content: "<h1>Invite</h1>",
        });
        const success = out.messages.find((m) => m.type === "success");
        const data = success?.data as Record<string, unknown>;
        const services = data["services"] as ReadonlyArray<Record<string, unknown>>;
        // D8: `changes` carries the content extra even though no registry-mapped leaf changed.
        expect(services.find((s) => s["service"] === "auth")).toEqual({
          service: "auth",
          status: "updated",
          changes: [["auth", "email", "template", "invite", "content"]],
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "D8: services[].changes includes the secret path once its write actually sends it",
    () => {
      const toml = `project_id = "test"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "new-secret"
`;
      const { layer, out } = setupService({
        toml,
        format: "json",
        yes: true,
        v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const success = out.messages.find((m) => m.type === "success");
        const data = success?.data as Record<string, unknown>;
        const services = data["services"] as ReadonlyArray<Record<string, unknown>>;
        expect(services.find((s) => s["service"] === "auth")).toEqual({
          service: "auth",
          status: "updated",
          changes: [
            ["auth", "captcha", "enabled"],
            ["auth", "captcha", "provider"],
            ["auth", "captcha", "secret"],
          ],
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a container whose companion is unresolvable never lets its secret ride the write silently: the secret lands in unencodable, never sent",
    () => {
      // `auth.hook.send_email.uri` is undeclared and the fixture's remote
      // never reports `hook_send_email_uri` either, so the hook container's
      // required-together group is incomplete — but `auth.site_url` is a
      // genuine, independently-encodable change, so the auth write still
      // runs. Before the fix, the hook's `secrets` decision (`status: "send"`)
      // rode along into `secrets.sent` even though the hook body was dropped.
      const toml = `project_id = "test"
[auth]
site_url = "http://localhost:3000"
[auth.hook.send_email]
enabled = true
secrets = "v1,whsec_abc"
`;
      const { layer, apiMock, out } = setupService({
        toml,
        format: "json",
        yes: true,
        v1: { updateAuthServiceConfig: () => Effect.succeed({}) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
        expect(update).toBeDefined();
        const input = update?.input as Record<string, unknown>;
        expect(input["site_url"]).toBe("http://localhost:3000");
        expect(input["hook_send_email_secrets"]).toBeUndefined();
        expect(input["hook_send_email_enabled"]).toBeUndefined();
        const success = out.messages.find((m) => m.type === "success");
        const data = success?.data as Record<string, unknown>;
        expect(data["secrets"]).toMatchObject({ sent: [], skipped: [] });
        expect(data["unencodable"]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: ["auth", "hook", "send_email", "secrets"] }),
          ]),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a v2 response with a non-object body maps to the read network error", () => {
    const { layer } = setup({
      toml: `project_id = "test"\n`,
      yes: true,
      v2: { status: 200, body: [] },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPushConfigReadNetworkError");
      expect(JSON.stringify(exit)).toContain("response body is not a JSON object");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "an undecodable v2 response body maps to the read network error with decode: true",
    () => {
      const { layer } = setup({
        toml: `project_id = "test"\n`,
        yes: true,
        v2: { status: 200, malformedJson: true },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const serialized = JSON.stringify(exit);
        expect(serialized).toContain("LegacyConfigPushConfigReadNetworkError");
        expect(serialized).toContain('"decode":true');
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("D11: the json message field is a non-empty summary, not an empty string", () => {
    const { layer, out } = setup({
      toml: `project_id = "test"\n[api]\nmax_rows = 2000\n`,
      format: "json",
      yes: true,
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe(`1 property pushed to ${REF}.`);
    }).pipe(Effect.provide(layer));
  });

  it.live("a webhook-only push counts as 1 property pushed, not 0 (finding 5)", () => {
    // Every managed resource matches the fixture's schema-default remote
    // (`BASE_DISABLED` declares nothing else), so `experimental.webhooks`
    // is the only service that ends up `updated` — before the fix its
    // `changes` was always `[]`, so the summary undercounted it as 0.
    const { layer, out } = setupService({
      toml: `${BASE_DISABLED}[experimental.webhooks]\nenabled = true\n`,
      format: "json",
      yes: true,
      v1: { enableDatabaseWebhook: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe(`1 property pushed to ${REF}.`);
      const data = success?.data as Record<string, unknown>;
      const services = data["services"] as ReadonlyArray<Record<string, unknown>>;
      expect(services.find((s) => s["service"] === "experimental.webhooks")).toEqual({
        service: "experimental.webhooks",
        status: "updated",
        changes: [["experimental", "webhooks", "enabled"]],
      });
    }).pipe(Effect.provide(layer));
  });
});

// A config declaring a real `api` diff (matches the fixture's remote
// `max_rows: 1000`) — used by the branch/project target-detection (CLI-2168)
// and branch-name/UUID resolution (CLI-2289) scenarios below to prove a push
// actually proceeded, the same way the very first test in this file does.
const BRANCH_PUSH_TOML = `project_id = "test"\n[api]\nmax_rows = 2000\n`;

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
    toml: BRANCH_PUSH_TOML,
    projectId: Option.none(),
    format: opts.format,
    yes: opts.yes,
    confirm: opts.confirm,
    stdinIsTty: opts.stdinIsTty,
    pipedAnswers: opts.pipedAnswers,
    project: { status: 404, body: {} },
    branchList: { status: 200, body: [BRANCH_LIST_ITEM] },
    v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
  });
}

describe("legacy config push branch/project target detection (CLI-2168)", () => {
  it.live("a plain project push never triggers the branch confirmation gate", () => {
    const { layer, out, api } = setup({
      toml: BRANCH_PUSH_TOML,
      yes: true,
      project: { status: 200, body: { ...PUSH_TEST_PROJECT, name: "Test Project" } },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain(`Pushing config to project: Test Project (${REF})`);
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
      // into `undefined` before it ever reaches the target object — the
      // same degradation every OTHER scenario in this file relies on via
      // `PUSH_TEST_PROJECT`'s default empty name; this test pins it
      // explicitly.
      const { layer, out } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: true,
        project: { status: 200, body: { ...PUSH_TEST_PROJECT, name: "" } },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(out.stderrText).toContain(`Pushing config to project: ${REF}\n`);
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
        toml: BRANCH_PUSH_TOML,
        yes: true,
        projectId: Option.none(),
        project: { status: 404, body: {} },
        v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
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
        toml: BRANCH_PUSH_TOML,
        yes: true,
        projectId: Option.some(PROBE_REF),
        project: { status: 404, body: {} },
        v2: { status: 200, body: v2Response({ ref: PROBE_REF }) },
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
      expect(api.requests.some((r) => r.url.includes("/v2/projects/"))).toBe(false);
      expect(api.requests.some((r) => r.url.includes("/postgrest"))).toBe(false);
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
      expect(api.requests.some((r) => r.url.includes("/v2/projects/"))).toBe(false);
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
      expect(api.requests.some((r) => r.url.includes("/v2/projects/"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("--yes auto-confirms a branch push and echoes the prompt", () => {
    const { layer, out, api } = setupLinkedBranchPush({ yes: true });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain(
        `branch "feat-x" (${BRANCH_REF})? (skip this check with --yes) [y/N] y`,
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
          // script/agent sees the --yes escape hatch.
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
      const data = success?.data as Record<string, unknown>;
      expect(data["project_ref"]).toBe(BRANCH_REF);
      expect(data["is_branch"]).toBe(true);
      expect(data["branch"]).toBe("feat-x");
      expect(data["parent_project_ref"]).toBe(PARENT_REF);
      expect(Array.isArray(data["services"])).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "an unrelated cached parent does not get credited without a confirming branch-list match",
    () => {
      writeLinkedProjectCacheFile({ ref: PARENT_REF });
      const { layer, out, api } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: true,
        projectId: Option.some(PROBE_REF),
        project: { status: 404, body: {} },
        v2: { status: 200, body: v2Response({ ref: PROBE_REF }) },
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
      toml: BRANCH_PUSH_TOML,
      yes: true,
      projectId: Option.some(PROBE_REF),
      project: { status: 404, body: {} },
      v2: { status: 200, body: v2Response({ ref: PROBE_REF }) },
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
      toml: BRANCH_PUSH_TOML,
      yes: true,
      projectId: Option.some(PROBE_REF),
      project: { status: 404, body: {} },
      v2: { status: 200, body: v2Response({ ref: PROBE_REF }) },
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
      // The target-detection probe is diagnostic-only: a transport failure
      // must never abort a push that would otherwise succeed — including
      // for a plain project whose token can write service config but
      // happens to fail this one informational read. It degrades to
      // "unknown" (never "branch" — that would wrongly gate an ordinary
      // push behind a confirmation that auto-declines, and fails, in an
      // unattended run) and the push proceeds.
      const { layer, out, api } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: true,
        projectId: Option.some(PROBE_REF),
        project: "fail",
        v2: { status: 200, body: v2Response({ ref: PROBE_REF }) },
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
      // technique — the target-detection recovery's own best-effort read
      // must swallow a real read failure (not just a missing file), not
      // propagate it. A cache candidate (with a branch-list response that
      // does NOT confirm this ref) is required so recovery actually reaches
      // the `.temp/project-ref` read at all.
      mkdirSync(join(tempRoot.current, "supabase", ".temp", "project-ref"), { recursive: true });
      writeLinkedProjectCacheFile({ ref: PARENT_REF });
      const { layer, out, api } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: true,
        projectId: Option.some(PROBE_REF),
        project: { status: 404, body: {} },
        branchList: { status: 200, body: [] },
        v2: { status: 200, body: v2Response({ ref: PROBE_REF }) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        expect(
          api.requests.some((r) => r.url.includes(`/v1/projects/${PARENT_REF}/branches`)),
        ).toBe(true);
        expect(out.stderrText).toContain(`Pushing config to branch: ${PROBE_REF}`);
        expect(out.stderrText).not.toContain("Parent project:");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a 500 probing the live target degrades to unknown rather than aborting the push", () => {
    const { layer, out, api } = setup({
      toml: BRANCH_PUSH_TOML,
      yes: true,
      projectId: Option.some(PROBE_REF),
      project: { status: 500, body: { message: "boom" } },
      v2: { status: 200, body: v2Response({ ref: PROBE_REF }) },
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
        toml: BRANCH_PUSH_TOML,
        yes: true,
        format: "json",
        projectId: Option.some(PROBE_REF),
        project: { status: 500, body: {} },
        v2: { status: 200, body: v2Response({ ref: PROBE_REF }) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const success = out.messages.find((m) => m.type === "success");
        const data = success?.data as Record<string, unknown>;
        expect(data["project_ref"]).toBe(PROBE_REF);
        expect("is_branch" in data).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  // The "transport failure"/"500" tests above cover the `"unknown"` outcome
  // for a genuine probe error; only the TIMEOUT-specific sub-case (a live
  // probe that hangs rather than erroring) remains untested — both reach the
  // identical `{ kind: "unknown" }` outcome, so this is a coverage gap in HOW
  // "unknown" is reached, not in the behavior itself. A `TestClock`-driven
  // proof of `LEGACY_BRANCH_LOOKUP_TIMEOUT`'s degradation was deliberately
  // not added here: `legacyConfigPush` does substantial real, unmocked
  // filesystem I/O (project-root discovery, config.toml read, `.env` load)
  // before it ever reaches the probe's `Effect.timeoutOrElse`, and that I/O
  // settles on a real event-loop macrotask turn a virtual `TestClock` cannot
  // provide — forcing it through would need either a real wall-clock wait
  // (banned by this repo's flake-resistance policy) or an in-memory
  // `FileSystem` fake diverging from every other scenario in this file.
});

describe("legacy config push --project-ref branch name/UUID resolution (CLI-2289)", () => {
  it.live(
    "--project-ref <branch-name> resolves via the already-known parent, no extra live probe",
    () => {
      const { layer, out, api } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: true,
        branchByName: { status: 200, body: BRANCH_BY_NAME },
        v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.some("staging") });
        expect(out.stderrText).toContain(`Pushing config to branch: staging (${BRANCH_REF})`);
        expect(out.stderrText).toContain(`  Parent project: ${REF}`);
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
      // target, so `push.handler.ts`'s `knownBranch === undefined` gate is
      // never entered — no prompt at all. The real proof is `out.stderrText`
      // never containing the branch-prompt label — `legacyPromptYesNo`
      // always writes its label to stderr before reading any answer, on
      // both a TTY and non-TTY, so its total absence is conclusive.
      const { layer, out } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: false,
        branchByName: { status: 200, body: BRANCH_BY_NAME },
        v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
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
      writeLinkedProjectCacheFile({ ref: REF, name: "Test Project" });
      const { layer, out } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: true,
        branchByName: { status: 200, body: BRANCH_BY_NAME },
        v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.some("staging") });
        expect(out.stderrText).toContain(`  Parent project: Test Project (${REF})`);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--project-ref <branch-name> ignores a linked-project cache belonging to a different parent",
    () => {
      writeLinkedProjectCacheFile({ ref: OTHER_PARENT_REF, name: "Someone Else" });
      const { layer, out } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: true,
        branchByName: { status: 200, body: BRANCH_BY_NAME },
        v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.some("staging") });
        expect(out.stderrText).toContain(`  Parent project: ${REF}`);
        expect(out.stderrText).not.toContain("Someone Else");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--project-ref <branch-name> resolution works without a spinner in json output mode",
    () => {
      const { layer, out } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: true,
        format: "json",
        branchByName: { status: 200, body: BRANCH_BY_NAME },
        v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.some("staging") });
        const success = out.messages.find((m) => m.type === "success");
        const data = success?.data as Record<string, unknown>;
        expect(data["is_branch"]).toBe(true);
        expect(data["branch"]).toBe("staging");
        expect(data["parent_project_ref"]).toBe(REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--project-ref <uuid> resolves without any linked project (CLI-2289 regression)", () => {
    const { layer, out, api } = setup({
      toml: BRANCH_PUSH_TOML,
      yes: true,
      projectId: Option.none(),
      project: { status: 404, body: {} },
      branchById: { status: 200, body: BRANCH_CONFIG },
      v2: { status: 200, body: v2Response({ ref: UUID_TARGET_REF }) },
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
      // branch NAME target gets, so `push.handler.ts`'s `target.kind ===
      // "branch" && knownBranch === undefined` gate is never entered: no
      // prompt at all, even on a fully unattended run (no `--yes`, non-TTY,
      // empty stdin). Per-service prompts (`keep()`) still default to
      // `true` on empty non-TTY stdin, so the mutation still proceeds.
      const { layer, out, api } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: false,
        stdinIsTty: false,
        projectId: Option.none(),
        project: { status: 404, body: {} },
        branchById: { status: 200, body: BRANCH_CONFIG },
        v2: { status: 200, body: v2Response({ ref: UUID_TARGET_REF }) },
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
      toml: BRANCH_PUSH_TOML,
      yes: true,
      branchByName: { status: 404, body: { message: "not found" } },
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
      // linked-project cache stays untouched.
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a branch-name lookup failure in json mode still resolves cleanly without a spinner",
    () => {
      const { layer, api } = setup({
        toml: BRANCH_PUSH_TOML,
        yes: true,
        format: "json",
        branchByName: { status: 404, body: { message: "not found" } },
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
      toml: BRANCH_PUSH_TOML,
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
      // linked-project cache write is a no-op.
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("--project-ref <branch-name> with a corrupt linked ref reports it as invalid", () => {
    const { layer, api, telemetry, linkedProjectCache } = setup({
      toml: BRANCH_PUSH_TOML,
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
      toml: BRANCH_PUSH_TOML,
      yes: true,
      branchByName: { status: 200, body: { ...BRANCH_BY_NAME, project_ref: "" } },
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
      toml: BRANCH_PUSH_TOML,
      yes: true,
      branchByName: "fail",
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
      toml: BRANCH_PUSH_TOML,
      yes: true,
      branchByName: { status: 500, body: { message: "boom" } },
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
      setup({ toml: `project_id = "test"\n`, yes: true, analytics }).layer,
      commandRuntimeLayer(["config", "push"]),
      Stdio.layerTest({
        args: Effect.succeed(["config", "push", "--project-ref", projectRef]),
      }),
    );

  it.live("logs a ref-shaped --project-ref verbatim in cli_command_executed", () => {
    const analytics = mockContextualAnalytics();
    const ref = REF;
    return Effect.gen(function* () {
      yield* Effect.exit(legacyConfigPushHandler({ projectRef: Option.some(ref) }));
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ "project-ref": ref });
    }).pipe(Effect.provide(wiringLayer(analytics, ref)));
  });

  it.live("redacts a --project-ref value that is not ref-shaped", () => {
    const analytics = mockContextualAnalytics();
    const value = "s3cret-paste-mistake";
    return Effect.gen(function* () {
      yield* Effect.exit(legacyConfigPushHandler({ projectRef: Option.some(value) }));
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ "project-ref": "<redacted>" });
    }).pipe(Effect.provide(wiringLayer(analytics, value)));
  });
});
