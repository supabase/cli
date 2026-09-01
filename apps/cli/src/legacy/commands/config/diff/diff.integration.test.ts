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
import { LEGACY_CONFIG_DIFF_PAYLOAD_VERSION } from "./diff.format.ts";
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
    // A realistic fresh-project GoTrue record at platform defaults — the
    // largest, most transform-heavy mapping surface (durations, inversions,
    // unconfigured sentinels, provisioning-default subjects) must run end to
    // end and classify CLEANLY against an empty config.toml. An `auth: {}`
    // here previously let two classifier blockers through untested.
    auth: {
      site_url: "http://127.0.0.1:3000",
      uri_allow_list: "https://127.0.0.1:3000",
      jwt_exp: 3600,
      refresh_token_rotation_enabled: true,
      security_refresh_token_reuse_interval: 10,
      security_manual_linking_enabled: false,
      disable_signup: false,
      external_anonymous_users_enabled: false,
      password_min_length: 6,
      password_required_characters: "",
      rate_limit_anonymous_users: 30,
      rate_limit_token_refresh: 150,
      rate_limit_otp: 30,
      rate_limit_verify: 30,
      rate_limit_sms_sent: 30,
      rate_limit_web3: 30,
      // GoTrue reports 0 hours for unconfigured session bounds; the mapping
      // canonicalizes them to the STRING "0s" (registry unconfiguredValue).
      sessions_timebox: 0,
      sessions_inactivity_timeout: 0,
      external_email_enabled: true,
      mailer_secure_email_change_enabled: true,
      mailer_autoconfirm: true,
      security_update_password_require_reauthentication: false,
      mailer_otp_length: 6,
      mailer_otp_exp: 3600,
      smtp_max_frequency: 1,
      smtp_host: null,
      // Provisioning-default subject lines (recorded config_auth fixtures).
      mailer_subjects_invite: "You have been invited",
      mailer_subjects_confirmation: "Confirm Your Signup",
      mailer_subjects_recovery: "Reset Your Password",
      mailer_subjects_magic_link: "Your Magic Link",
      mailer_subjects_email_change: "Confirm Email Change",
      mailer_subjects_reauthentication: "Confirm Reauthentication",
      mailer_subjects_password_changed_notification: "Your password has been changed",
      mailer_subjects_email_changed_notification: "Your email address has been changed",
      mailer_subjects_phone_changed_notification: "Your phone number has been changed",
      mailer_subjects_identity_linked_notification: "A new identity has been linked",
      mailer_subjects_identity_unlinked_notification: "An identity has been unlinked",
      mailer_subjects_mfa_factor_enrolled_notification: "A new MFA factor has been enrolled",
      mailer_subjects_mfa_factor_unenrolled_notification: "An MFA factor has been unenrolled",
      mailer_notifications_password_changed_enabled: false,
      mailer_notifications_email_changed_enabled: false,
      mailer_notifications_phone_changed_enabled: false,
      mailer_notifications_identity_linked_enabled: false,
      mailer_notifications_identity_unlinked_enabled: false,
      mailer_notifications_mfa_factor_enrolled_enabled: false,
      mailer_notifications_mfa_factor_unenrolled_enabled: false,
      external_phone_enabled: false,
      sms_autoconfirm: false,
      sms_max_frequency: 5,
      sms_otp_exp: 600,
      sms_otp_length: 6,
      external_github_enabled: false,
      external_github_client_id: "",
      mfa_totp_enroll_enabled: false,
      mfa_totp_verify_enabled: false,
      mfa_phone_enroll_enabled: false,
      mfa_phone_verify_enabled: false,
      mfa_phone_otp_length: 6,
      mfa_phone_template: "Your code is {{ .Code }}",
      mfa_phone_max_frequency: 5,
      mfa_web_authn_enroll_enabled: false,
      mfa_web_authn_verify_enabled: false,
      mfa_max_enrolled_factors: 10,
    },
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

/** V1GetABranch body for the branch-name `--project-ref` lookup. */
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

/** V1GetABranchConfig body for the UUID `--project-ref` lookup. */
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
  /** `false` simulates a directory with no linked project. */
  readonly linked?: boolean;
  /** Overrides the process cwd (defaults to the temp workdir). */
  readonly cwd?: string;
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
      cliSettings: mockLegacyCliSettings({
        workdir: tempRoot.current,
        ...(opts.linked === false ? { projectId: Option.none<string>() } : {}),
      }),
      runtimeInfo: mockRuntimeInfo({ cwd: opts.cwd ?? tempRoot.current }),
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
        "1 difference found (1 update, 0 remote-only, 0 local-only).",
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

  it.live("--exit-code sets exit 2 when differences are found", () => {
    // Drift gets its own exit code (2) so scripts can tell it from failure
    // (1) — `config diff --exit-code || alert` must not fire on an expired
    // token.
    const { layer, processControl } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, exitCode: true });
      expect(processControl.exitCode).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.live("declared properties the response does not carry are local_only", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[auth]\nsite_url = "https://local.example.com"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => {
            // Drop site_url from the otherwise-complete auth record so the
            // response genuinely does not carry the declared property.
            const { site_url: _siteUrl, ...auth } = attributes["auth"] as Record<string, unknown>;
            return { ...attributes, auth };
          },
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stdoutText).toContain("auth.site_url [local-only]");
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
            auth: {
              external_github_enabled: true,
              external_github_client_id: "id",
              // The platform reports secret fields as HMAC digests, never
              // plaintext — the digest must not surface either.
              external_github_secret: "v1,whmac-sha256-digest-of-the-secret",
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, exitCode: true });
      expect(out.stdoutText).toContain("No config differences found.");
      expect(out.stdoutText).toContain(
        "Note: 1 credential value not compared (masked by the API): auth.external.github.secret",
      );
      // The secret STRING never leaks — neither the local plaintext resolved
      // from the env var nor the API-reported HMAC digest, on either stream.
      // Pins the "secrets never leak" claim against formatter changes.
      const everything = out.stdoutText + out.stderrText;
      expect(everything).not.toContain("shh");
      expect(everything).not.toContain("whmac-sha256");
      expect(processControl.exitCode).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("secret strings never reach the machine payload either", () => {
    const { layer, out } = setup({
      toml: [
        'project_id = "test"',
        "[auth.external.github]",
        "enabled = true",
        'client_id = "id"',
        'secret = "env(GITHUB_SECRET)"',
        "",
      ].join("\n"),
      dotenv: "GITHUB_SECRET=shh\n",
      format: "json",
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            auth: {
              external_github_enabled: true,
              external_github_client_id: "id",
              external_github_secret: "v1,whmac-sha256-digest-of-the-secret",
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      const serialized = JSON.stringify(success);
      expect(serialized).not.toContain("shh");
      expect(serialized).not.toContain("whmac-sha256");
      // The message itself carries the masked caveat, so `.message` echoers
      // never claim full sync.
      expect(success?.message).toContain("masked by the API");
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

  it.live("a branch-named --project-ref resolves via the parent project", () => {
    const { layer, out, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, projectRef: Option.some("staging") });
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

  it.live("branch-name resolution uses the linked PARENT, not a branch ref in project-ref", () => {
    // After `link <branch>`, `.temp/project-ref` holds the BRANCH's own ref,
    // and the parent-scoped branches endpoint rejects branch refs — the
    // parent must come from the parent-scoped resolver (which prefers the
    // linked-project.json parent recovery), never the file verbatim.
    const temp = join(tempRoot.current, "supabase", ".temp");
    mkdirSync(temp, { recursive: true });
    writeFileSync(join(temp, "project-ref"), BRANCH_REF);
    writeFileSync(join(temp, "linked-project.json"), JSON.stringify({ ref: LEGACY_VALID_REF }));
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      linked: false,
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, projectRef: Option.some("staging") });
      const urls = api.requests.map((request) => request.url);
      expect(
        urls.some((url) => url.includes(`/v1/projects/${LEGACY_VALID_REF}/branches/staging`)),
      ).toBe(true);
      expect(urls.some((url) => url.includes(`/v1/projects/${BRANCH_REF}/`))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("a UUID --project-ref resolves directly, even in an unlinked directory", () => {
    // The UUID endpoint (`GET /v1/branches/{id}`) does not use a parent
    // project ref, so the lookup must not demand a linked directory — the
    // parent is only resolved (lazily) for branch-NAME lookups.
    const { layer, api, out } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      linked: false,
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, projectRef: Option.some(BRANCH_UUID) });
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes(`/v1/branches/${BRANCH_UUID}`))).toBe(true);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
      // A UUID is an identifier, not a display name — never quoted as one.
      expect(out.stderrText).toContain(
        `Comparing against branch ${BRANCH_UUID} (project ref ${BRANCH_REF})`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("a ref-shaped --project-ref never touches the branches API", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff({ ...noFlags, projectRef: Option.some(BRANCH_REF) });
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes("/branches/"))).toBe(false);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("an unknown branch fails with a branches-list suggestion", () => {
    const { layer, telemetry, linkedProjectCache } = setup({
      toml: 'project_id = "test"\n',
      branchByName: { status: 404, body: { message: "not found" } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff({ ...noFlags, projectRef: Option.some("ghost") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("LegacyConfigDiffBranchNotFoundError");
      expect(rendered).toContain('Branch \\"ghost\\" not found');
      expect(rendered).toContain("supabase branches list");
      // Legacy Shell Invariant #1: telemetry flushes on failure too; the
      // linked-project cache stays untouched because no target ref resolved.
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("a non-404 branch lookup failure keeps its status error", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      branchByName: { status: 500, body: { message: "boom" } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff({ ...noFlags, projectRef: Option.some("staging") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigDiffBranchResolveStatusError");
    }).pipe(Effect.provide(layer));
  });

  it.live("a missing config file points at supabase init before any resolution", () => {
    const { layer, telemetry, api } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("LegacyConfigDiffLoadConfigError");
      expect(rendered).toContain("supabase/config.toml: file not found");
      expect(rendered).toContain("supabase init");
      // The load runs before any network call, and telemetry still flushes.
      expect(api.requests).toHaveLength(0);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("a malformed config aborts before any network call, even with a branch target", () => {
    // A broken TOML must not burn a branch-resolution round trip — the local
    // document is parsed and validated first.
    const { layer, api, telemetry } = setup({ toml: "not [valid toml\n" });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff({ ...noFlags, projectRef: Option.some("staging") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to parse supabase/config.toml");
      expect(api.requests).toHaveLength(0);
      expect(telemetry.flushed).toBe(true);
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

  it.live("an out-of-domain mapped value in the response keeps its typed parse error", () => {
    // Wire-valid but semantically impossible: the registry's typed throw
    // (ADR 0021 API-arm family) stays in the typed channel as
    // ProjectConfigParseError, keeping its upstream suggestion and its
    // purpose-built actionability adapter instead of masquerading as a
    // network failure.
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            storage: {
              ...(attributes["storage"] as Record<string, unknown>),
              file_size_limit: -1,
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("ProjectConfigParseError");
      expect(rendered).toContain("Could not read the project config");
      // The upstream remedy survives to the renderer instead of being
      // stringified away.
      expect(rendered).toContain("suggestion");
    }).pipe(Effect.provide(layer));
  });

  it.live("an unknown enum value in the response degrades instead of failing", () => {
    // ADR 0019 rule 2: the fetch goes through executeRaw, so the generated
    // contract's closed enums (pooler.pool_mode is three literals there)
    // never gate the response — a new platform enum member reaches the
    // lenient config mirror, whose registry row omits the unrecognized value
    // rather than failing the whole diff.
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            pooler: {
              ...(attributes["pooler"] as Record<string, unknown>),
              pool_mode: "burst_v9",
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stdoutText).toContain("No config differences found.");
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
      expect(success?.message).toContain("1 config difference found.");
      const data = success?.data as Record<string, unknown>;
      expect(data["target"]).toMatchObject({
        project_ref: LEGACY_VALID_REF,
        local_scope: "base",
      });
      // `schema_version` is the PAYLOAD contract's version; the user's
      // `$schema` document reference travels separately as `config_schema`.
      expect(data["schema_version"]).toBe(LEGACY_CONFIG_DIFF_PAYLOAD_VERSION);
      expect(data["schema_version"]).toBe(1);
      expect(typeof data["config_schema"]).toBe("string");
      expect(data["scope"]).toEqual({
        present: ["api", "auth", "database", "pooler", "realtime", "storage"],
        missing: [],
      });
      expect(data["changes"]).toEqual([
        { path: ["api", "max_rows"], class: "update", declared: true, local: 500, remote: 1000 },
      ]);
      expect(data["counts"]).toEqual({ update: 1, remote_only: 0, local_only: 0, total: 1 });
      expect(data["masked"]).toEqual([]);
      expect(data["unmanaged"]).toEqual([]);
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

  it.live("-o json emits the raw payload on a payload-pure stdout", () => {
    // Legacy Shell Invariant #6: `--output` is honored and takes priority.
    // No envelope — the payload object itself, parseable from stdout.
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
      goOutput: "json",
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      const payload = JSON.parse(out.stdoutText) as Record<string, unknown>;
      expect(payload["changes"]).toEqual([
        { path: ["api", "max_rows"], class: "update", declared: true, local: 500, remote: 1000 },
      ]);
      expect(payload["counts"]).toMatchObject({ total: 1 });
      // The envelope fields of --output-format json must not leak in.
      expect(payload["message"]).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("-o pretty falls through to the text renderer", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
      goOutput: "pretty",
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stdoutText).toContain("api.max_rows [update]");
      expect(out.stdoutText).toContain("1 difference found");
    }).pipe(Effect.provide(layer));
  });

  it.live("-o yaml/toml/env encode the payload through the shared encoders", () => {
    const run = (goOutput: "yaml" | "toml" | "env", assert: (stdout: string) => void) => {
      const { layer, out } = setup({
        toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
        goOutput,
      });
      return Effect.gen(function* () {
        yield* legacyConfigDiff(noFlags);
        assert(out.stdoutText);
      }).pipe(Effect.provide(layer));
    };
    return Effect.gen(function* () {
      yield* run("yaml", (stdout) => {
        expect(stdout).toContain("class: update");
      });
      yield* run("toml", (stdout) => {
        expect(stdout).toContain('class = "update"');
      });
      yield* run("env", (stdout) => {
        expect(stdout).toContain("COUNTS_TOTAL=1");
      });
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
          path: ["api", "max_rows"],
          class: "update",
          declared: true,
          local: 500,
          remote: 1000,
          env_variables: ["PGRST_MAX_ROWS"],
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
      expect(out.stdoutText).toContain("db.settings.work_mem [remote-only]");
      expect(out.stdoutText).toContain("local:  (unset)");
      expect(out.stdoutText).toContain('remote: "64MB"');
    }).pipe(Effect.provide(layer));
  });

  it.live("remote-only drift on a defaulted path shows the local schema default", () => {
    // The someone-changed-it-in-the-dashboard case: the file never declares
    // api.max_rows, the remote reports 250, and a `config push` would write
    // the schema default 1000 over it — the output must say so instead of
    // implying the key exists only remotely.
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            api: { ...(attributes["api"] as Record<string, unknown>), max_rows: 250 },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stdoutText).toContain("api.max_rows [remote-only]");
      expect(out.stdoutText).toContain(
        "local:  1000 (schema default — not declared in config.toml)",
      );
      expect(out.stdoutText).toContain("remote: 250");
    }).pipe(Effect.provide(layer));
  });

  it.live("the config file is read relative to --workdir, not the invoking directory", () => {
    // `--workdir ../other` must compare `../other`'s config.toml against
    // `../other`'s linked project — reading the invoking directory's file
    // would silently diff the WRONG config (the resolver and linked-project
    // cache already use the workdir). The ambient cwd here points somewhere
    // with no supabase/ directory at all; only cliSettings.workdir knows
    // where the project lives.
    const elsewhere = join(tempRoot.current, "unrelated-cwd");
    mkdirSync(elsewhere, { recursive: true });
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
      cwd: elsewhere,
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stdoutText).toContain("api.max_rows [update]");
    }).pipe(Effect.provide(layer));
  });

  it.live("hostile names cannot inject ANSI or forge output lines in text mode", () => {
    // Path segments are attacker-influenced ([remotes.*] names and
    // sms.test_otp keys are unconstrained TOML keys) — a name carrying an
    // escape byte or newline must not reach the terminal raw, where it could
    // recolor output or append a fake "No config differences found." line.
    const { layer, out } = setup({
      toml: [
        'project_id = "test"',
        '[remotes."evil\\u001B[31mred"]',
        `project_id = "${LEGACY_VALID_REF}"`,
        '[remotes."evil\\u001B[31mred".api]',
        "max_rows = 500",
        "",
      ].join("\n"),
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stderrText).toContain("[remotes.evil[31mred]");
      expect(out.stderrText).not.toContain("\u001b");
      expect(out.stdoutText).not.toContain("\u001b");
    }).pipe(Effect.provide(layer));
  });

  it.live("an empty block record is reported not-returned, not silently compared", () => {
    // A permission-truncated `auth: {}` is schema-valid; claiming it was
    // compared while every auth key silently vanishes would make a red CI
    // unfixable by any file edit.
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({ attributes: (attributes) => ({ ...attributes, auth: {} }) }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stderrText).toContain(
        "Comparison scope: api, database, pooler, realtime, storage (not returned: auth)",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("a declared path push cannot communicate surfaces in the unmanaged note", () => {
    // auth.oauth_server is dropped from the local projection entirely (push
    // has no oauth_server handling), so a declared `enabled = true`
    // disagreeing with the remote's default `false` cannot be a change entry
    // — but it must not vanish silently either.
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[auth.oauth_server]\nenabled = true\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            auth: { oauth_server_enabled: false },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigDiff(noFlags);
      expect(out.stdoutText).toContain("No config differences found.");
      expect(out.stdoutText).toContain(
        "Note: 1 declared property cannot be pushed and was not compared: auth.oauth_server.enabled",
      );
    }).pipe(Effect.provide(layer));
  });
});
