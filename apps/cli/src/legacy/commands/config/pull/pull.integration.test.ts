import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
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
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { legacyConfigPull } from "./pull.handler.ts";
import type { LegacyConfigPullFlags } from "./pull.command.ts";

/**
 * Setup + fixtures mirror `../diff/diff.integration.test.ts` — same temp
 * workdir helper, same mocked platform API/output/telemetry/linked-project
 * services, same `v2Response()` schema-defaults fixture (an empty
 * config.toml diffs clean against it). The core smoke cases below are
 * structured so a follow-up pass can extend the `setup()` options and add
 * more `describe`/`it.live` blocks without refactoring this shape.
 */

const tempRoot = useLegacyTempWorkdir("supabase-config-pull-int-");

const BRANCH_REF = "cccccccccccccccccccc";

function configPath(): string {
  return join(tempRoot.current, "supabase", "config.toml");
}

function writeConfig(toml: string): string {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  writeFileSync(path, toml);
  return path;
}

/** Schema-valid v2 project-config body whose managed values all sit at the
 * local schema defaults, so an empty config.toml diffs clean against it —
 * copied from `diff.integration.test.ts` (same rationale: the largest,
 * most transform-heavy mapping surface must run end to end and classify
 * cleanly). */
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

/** V1FindBranch body for the branch-name `--project-ref` lookup. */
const BRANCH_BY_NAME = {
  id: "11111111-1111-4111-8111-111111111111",
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

/**
 * Fakes the `git status --porcelain -- config.toml` subprocess the dirty
 * guard (`legacy-git-status.ts`) issues — pattern copied from
 * `legacy-git-status.unit.test.ts`'s own `mockSpawner`. Listed AFTER
 * `buildLegacyTestRuntime` in the layer merge (below) so it overrides the
 * real spawner `BunServices.layer` provides (last-wins, same precedent as
 * `signing-key.integration.test.ts`'s `mockGitCheckIgnore`).
 */
function mockLegacyGitStatusSpawner(
  opts: { readonly dirty?: boolean; readonly spawnFails?: boolean } = {},
): { readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> } {
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      if (opts.spawnFails === true) {
        return yield* Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "git not found",
          }),
        );
      }
      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(0));
      const stdout = opts.dirty === true ? " M config.toml\n" : "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable([new TextEncoder().encode(stdout)]),
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) };
}

interface SetupOpts {
  readonly toml?: string;
  readonly format?: "text" | "json" | "stream-json";
  readonly v2?: { status: number; body: unknown } | "fail";
  readonly branchByName?: { status: number; body: unknown };
  /** `false` simulates a directory with no linked project. */
  readonly linked?: boolean;
  readonly yes?: boolean;
  readonly stdinIsTty?: boolean;
  readonly confirm?: ReadonlyArray<boolean>;
  readonly gitDirty?: boolean;
  readonly gitSpawnFails?: boolean;
}

function setup(opts: SetupOpts = {}) {
  if (opts.toml !== undefined) {
    writeConfig(opts.toml);
  }
  const out = mockOutput({ format: opts.format ?? "text", promptConfirmResponses: opts.confirm });
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
  const gitStatus = mockLegacyGitStatusSpawner({
    dirty: opts.gitDirty,
    spawnFails: opts.gitSpawnFails,
  });
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliSettings: mockLegacyCliSettings({
        workdir: tempRoot.current,
        ...(opts.linked === false ? { projectId: Option.none<string>() } : {}),
      }),
      runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
      processControl,
      tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
    }),
    mockStdin(opts.stdinIsTty ?? false),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    // Listed after `buildLegacyTestRuntime` so it overrides the real spawner
    // BunServices.layer provides (last-wins).
    gitStatus.layer,
  );
  return { layer, out, api, telemetry, linkedProjectCache, processControl };
}

const noFlags: LegacyConfigPullFlags = {
  projectRef: Option.none<string>(),
  remoteLabel: Option.none<string>(),
  dryRun: false,
  force: false,
};

/** Number of lines that differ between two texts of equal line count. */
function countChangedLines(before: string, after: string): number {
  const b = before.split("\n");
  const a = after.split("\n");
  expect(a.length).toBe(b.length);
  return a.filter((line, index) => line !== b[index]).length;
}

describe("legacy config pull integration", () => {
  it.live(
    "root-target single-property update writes the file with exactly one changed line",
    () => {
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      const { layer, out, telemetry, linkedProjectCache } = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        yield* legacyConfigPull(noFlags);
        const after = readFileSync(configPath(), "utf8");
        expect(countChangedLines(before, after)).toBe(1);
        expect(after).toContain("max_rows = 1000");
        expect(after).not.toContain("max_rows = 500");
        expect(out.stdoutText).toContain("1 change written.");
        expect(telemetry.flushed).toBe(true);
        expect(linkedProjectCache.cachedRef).toBe(LEGACY_VALID_REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--dry-run leaves the file untouched and reports dry_run in the payload", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer, out } = setup({ toml: before, format: "json", yes: true });
    const path = configPath();
    const beforeStat = { mtimeMs: statSync(path).mtimeMs, contents: readFileSync(path, "utf8") };
    return Effect.gen(function* () {
      yield* legacyConfigPull({ ...noFlags, dryRun: true });
      expect(statSync(path).mtimeMs).toBe(beforeStat.mtimeMs);
      expect(readFileSync(path, "utf8")).toBe(beforeStat.contents);
      const success = out.messages.find((message) => message.type === "success");
      const data = success?.data as Record<string, unknown>;
      expect(data["dry_run"]).toBe(true);
      expect(data["wrote"]).toBe(false);
      const changes = data["changes"] as ReadonlyArray<Record<string, unknown>>;
      expect(changes.every((change) => change["written"] === false)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("a branch-named target creates a new [remotes.<name>] block at EOF", () => {
    const before = 'project_id = "test"\n';
    const { layer } = setup({
      toml: before,
      yes: true,
      v2: {
        status: 200,
        body: v2Response({
          ref: BRANCH_REF,
          attributes: (attributes) => ({
            ...attributes,
            api: { ...(attributes["api"] as Record<string, unknown>), max_rows: 250 },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPull({ ...noFlags, projectRef: Option.some("staging") });
      const after = readFileSync(configPath(), "utf8");
      expect(after.startsWith(before)).toBe(true);
      const remotesIndex = after.indexOf("[remotes.staging]");
      expect(remotesIndex).toBeGreaterThan(-1);
      // One blank line before the new block, per `applyConfigEdits`' own
      // `[remotes.<label>]` placement rule.
      expect(after.slice(0, remotesIndex).endsWith("\n\n")).toBe(true);
      const remotesBlock = after.slice(remotesIndex);
      expect(remotesBlock).toContain(`project_id = "${BRANCH_REF}"`);
      expect(remotesBlock).toContain("max_rows = 250");
      // `project_id` is written first within the new block.
      expect(remotesBlock.indexOf("project_id")).toBeLessThan(remotesBlock.indexOf("max_rows"));
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "writing a push-unmanaged family (ADR 0021) on its first pull notes it can't be sent back",
    () => {
      // `auth.oauth_server.enabled` is undeclared before this run, so it
      // plans as a normal `remote_only` write (`applyPushUnmanagedOmissions`
      // only prunes a path from the local projection once it's DECLARED —
      // `../diff/diff.integration.test.ts`'s own "unmanaged" case pins the
      // declared-already state). The convergence check's own post-write
      // projection has it declared, so it reclassifies as `unmanaged` there
      // — decision 4's "written but config push cannot send it back" note.
      const { layer, out } = setup({
        toml: 'project_id = "test"\n',
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            attributes: (attributes) => ({
              ...attributes,
              auth: {
                ...(attributes["auth"] as Record<string, unknown>),
                oauth_server_enabled: true,
              },
            }),
          }),
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPull(noFlags);
        const after = readFileSync(configPath(), "utf8");
        expect(after).toContain("[auth.oauth_server]");
        expect(after).toContain("enabled = true");
        expect(out.stdoutText).toContain(
          "auth.oauth_server.enabled was written here, but `config push` cannot send it back",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a clean remote reports nothing to write without prompting", () => {
    const { layer, out } = setup({ toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      yield* legacyConfigPull(noFlags);
      expect(out.stdoutText).toContain("No config differences found.");
      expect(out.promptConfirmCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("declining the confirmation prompt leaves the file unchanged", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer, out } = setup({
      toml: before,
      yes: false,
      stdinIsTty: true,
      confirm: [false],
    });
    return Effect.gen(function* () {
      yield* legacyConfigPull(noFlags);
      expect(readFileSync(configPath(), "utf8")).toBe(before);
      expect(out.promptConfirmCalls).toHaveLength(1);
      expect(out.promptConfirmCalls[0]?.message).toContain("Apply 1 change(s) to");
      expect(out.stdoutText).toContain("not written (declined)");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output-format json reports written flags, destination, and counts", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer, out } = setup({ toml: before, format: "json", yes: true });
    return Effect.gen(function* () {
      yield* legacyConfigPull(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      const data = success?.data as Record<string, unknown>;
      expect(data["config_path"]).toBe(join("supabase", "config.toml"));
      expect(data["destination"]).toEqual({ scope: "base", created: false });
      expect(data["wrote"]).toBe(true);
      expect(data["counts"]).toMatchObject({ written: 1 });
      expect(data["changes"]).toEqual([
        {
          path: ["api", "max_rows"],
          class: "update",
          declared: true,
          local: 500,
          remote: 1000,
          written: true,
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("telemetry flushes and the linked-project cache writes on a failed run too", () => {
    const { layer, telemetry, linkedProjectCache, api } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("LegacyConfigPullLoadConfigError");
      // The load runs before any network call or target resolution, so the
      // linked-project cache never fires — no ref ever resolved.
      expect(api.requests).toHaveLength(0);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });
});
