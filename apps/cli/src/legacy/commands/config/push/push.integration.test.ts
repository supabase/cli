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
      cliSettings: mockLegacyCliSettings({ workdir: opts.workdir ?? tempRoot.current }),
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
    v1: opts.v1 ?? {},
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
        "auth.captcha.secret [secret]\n  local:  (not set — unresolved env reference; will not be pushed)\n  remote: (not set)\n\n",
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
