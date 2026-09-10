import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  DEFAULT_API_URL,
  VALID_REF,
  jsonResponse,
  transportFailure,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { GLOBAL_OUTPUT_FORMATS, YesFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  configPull,
  openConfigPullSource,
  runConfigPull,
  type ConfigPullSource,
} from "./pull.handler.ts";
import type { ConfigPullFlags } from "./pull.command.ts";

// Setup mirrors ../diff/diff.integration.test.ts: same temp workdir helper, mocked
// services, and v2Response() fixture.

const tempRoot = useTempWorkdir("supabase-config-pull-int-");

const BRANCH_REF = "cccccccccccccccccccc";
const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";

function configPath(): string {
  return join(tempRoot.current, "supabase", "config.toml");
}

function jsonConfigPath(): string {
  return join(tempRoot.current, "supabase", "config.json");
}

function writeConfig(toml: string): string {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  writeFileSync(path, toml);
  return path;
}

function writeJsonConfig(json: string): string {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  const path = jsonConfigPath();
  writeFileSync(path, json);
  return path;
}

/** Writes `supabase/.env`, backing `env(VAR)` resolution — copied from
 * `../diff/diff.integration.test.ts`'s own helper. */
function writeProjectEnv(dotenv: string): void {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), dotenv);
}

/**
 * Save/restore a `process.env` var around an Effect. Set directly on `process.env` rather than
 * `supabase/.env`: the schema-validation gate resolves `env(VAR)` the same way the loader does
 * (process env layered with the project's own `.env` files), so either source works, and
 * `process.env` is simplest to set/restore in a test.
 */
function withProcessEnv<A, E, R>(
  name: string,
  value: string | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return effect.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (prev === undefined) delete process.env[name];
        else process.env[name] = prev;
      }),
    ),
  );
}

/** Schema-valid v2 project-config body whose managed values all sit at the local schema
 *  defaults, so an empty config.toml diffs clean against it. */
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
      sms_otp_exp: 60,
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
      id: opts.ref ?? VALID_REF,
      attributes: opts.attributes === undefined ? attributes : opts.attributes(attributes),
    },
  };
}

/** V1FindBranch body for the branch-name `--project-ref` lookup. */
const BRANCH_BY_NAME = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "staging",
  project_ref: BRANCH_REF,
  parent_project_ref: VALID_REF,
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

/**
 * Wraps `base` so every `promptConfirm` call runs `onConfirm` first, simulating a concurrent
 * edit landing on disk while the confirmation prompt is on screen (the TOCTOU case
 * `pull.handler.ts`'s write step guards against).
 */
function withConfirmSideEffect(
  base: Layer.Layer<Output>,
  onConfirm: () => void,
): Layer.Layer<Output> {
  return Layer.effect(
    Output,
    Effect.gen(function* () {
      const inner = yield* Output;
      return {
        ...inner,
        promptConfirm: (message: string, promptOpts?: { defaultValue?: boolean }) =>
          Effect.sync(onConfirm).pipe(Effect.andThen(inner.promptConfirm(message, promptOpts))),
      };
    }),
  ).pipe(Layer.provide(base));
}

/**
 * Fakes the `git status --porcelain -- config.toml` subprocess the dirty guard issues. Listed
 * after `buildTestRuntime` in the layer merge below so it overrides the real spawner
 * (last-wins).
 */
function mockGitStatusSpawner(
  opts: { readonly dirty?: boolean; readonly spawnFails?: boolean } = {},
): {
  readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly spawnCalls: number;
} {
  const state = { spawnCalls: 0 };
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      state.spawnCalls += 1;
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
  return {
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    get spawnCalls() {
      return state.spawnCalls;
    },
  };
}

interface SetupOpts {
  readonly toml?: string;
  readonly dotenv?: string;
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: (typeof GLOBAL_OUTPUT_FORMATS)[number];
  readonly v2?: { status: number; body: unknown } | "fail" | "decode-fail";
  readonly branchByName?: { status: number; body: unknown } | "fail";
  readonly branchByUuid?: { status: number; body: unknown };
  /** `false` simulates a directory with no linked project. */
  readonly linked?: boolean;
  /** Overrides `cliSettings.projectId` directly — takes precedence over `linked`. */
  readonly projectId?: Option.Option<string>;
  readonly yes?: boolean;
  readonly stdinIsTty?: boolean;
  readonly confirm?: ReadonlyArray<boolean>;
  readonly gitDirty?: boolean;
  readonly gitSpawnFails?: boolean;
  /** Runs as a side effect of every `promptConfirm` call, BEFORE it resolves
   * — simulates a concurrent edit landing while the prompt is on screen. */
  readonly confirmSideEffect?: () => void;
  /** cliSettings.workdir override (what `--workdir` resolves to); defaults to the temp project root. */
  readonly workdir?: string;
  /** cliSettings.explicitWorkdir override — true iff --workdir/SUPABASE_WORKDIR was set verbatim. */
  readonly explicitWorkdir?: boolean;
}

function setup(opts: SetupOpts = {}) {
  if (opts.toml !== undefined) {
    writeConfig(opts.toml);
  }
  if (opts.dotenv !== undefined) {
    writeProjectEnv(opts.dotenv);
  }
  const out = mockOutput({ format: opts.format ?? "text", promptConfirmResponses: opts.confirm });
  const outputLayer =
    opts.confirmSideEffect === undefined
      ? out.layer
      : withConfirmSideEffect(out.layer, opts.confirmSideEffect);
  const api = mockCommandPlatformApi({
    handler: (request) => {
      const url = request.url;
      if (url.includes("/v2/projects/")) {
        if (opts.v2 === "fail") {
          return Effect.fail(transportFailure(request));
        }
        if (opts.v2 === "decode-fail") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("not json", {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        }
        const v2 = opts.v2 ?? { status: 200, body: v2Response() };
        return Effect.succeed(jsonResponse(request, v2.status, v2.body));
      }
      if (url.includes("/v1/branches/")) {
        const b = opts.branchByUuid ?? { status: 200, body: BRANCH_CONFIG };
        return Effect.succeed(jsonResponse(request, b.status, b.body));
      }
      if (url.includes("/branches/")) {
        if (opts.branchByName === "fail") {
          return Effect.fail(transportFailure(request));
        }
        const b = opts.branchByName ?? { status: 200, body: BRANCH_BY_NAME };
        return Effect.succeed(jsonResponse(request, b.status, b.body));
      }
      return Effect.succeed(jsonResponse(request, 200, {}));
    },
  });
  const telemetry = mockTelemetryStateTracked();
  const linkedProjectCache = mockLinkedProjectCacheTracked();
  const processControl = mockProcessControl();
  const gitStatus = mockGitStatusSpawner({
    dirty: opts.gitDirty,
    spawnFails: opts.gitSpawnFails,
  });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out: { layer: outputLayer },
      api,
      cliSettings: mockCommandSettings({
        workdir: opts.workdir ?? tempRoot.current,
        explicitWorkdir: opts.explicitWorkdir ?? false,
        ...(opts.projectId !== undefined
          ? { projectId: opts.projectId }
          : opts.linked === false
            ? { projectId: Option.none<string>() }
            : {}),
      }),
      runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
      processControl,
      tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
      goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    }),
    mockStdin(opts.stdinIsTty ?? false),
    Layer.succeed(YesFlag, opts.yes ?? false),
    // Listed after `buildTestRuntime` so it overrides the real spawner
    // BunServices.layer provides (last-wins).
    gitStatus.layer,
  );
  return { layer, out, api, telemetry, linkedProjectCache, processControl, gitStatus };
}

const noFlags: ConfigPullFlags = {
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

describe("config pull integration", () => {
  it.live(
    "root-target single-property update writes the file with exactly one changed line",
    () => {
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      const { layer, out, telemetry, linkedProjectCache } = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const after = readFileSync(configPath(), "utf8");
        expect(countChangedLines(before, after)).toBe(1);
        expect(after).toContain("max_rows = 1000");
        expect(after).not.toContain("max_rows = 500");
        expect(out.stdoutText).toContain("1 change written.");
        expect(telemetry.flushed).toBe(true);
        expect(linkedProjectCache.cachedRef).toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--dry-run leaves the file untouched and reports dry_run in the payload", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer, out } = setup({ toml: before, format: "json", yes: true });
    const path = configPath();
    const beforeStat = { mtimeMs: statSync(path).mtimeMs, contents: readFileSync(path, "utf8") };
    return Effect.gen(function* () {
      yield* configPull({ ...noFlags, dryRun: true });
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
      yield* configPull({ ...noFlags, projectRef: Option.some("staging") });
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
    "a first-pull auth.oauth_server.enabled no longer trips the ADR 0021 unpushable warning (CLI-2314)",
    () => {
      // `enabled` is now an ordinary comparable path: writing it converges local and remote
      // exactly, so no residual `unmanaged` entry exists to warn about. Its siblings
      // (`allow_dynamic_registration`/`authorization_url_path`) are still pruned while the
      // container is disabled, but symmetrically on both arms, so a pull never writes a value
      // for them that itself goes unmanaged.
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
        yield* configPull(noFlags);
        const after = readFileSync(configPath(), "utf8");
        expect(after).toContain("[auth.oauth_server]");
        expect(after).toContain("enabled = true");
        expect(out.stdoutText).not.toContain("cannot send it back");
        expect(out.stdoutText).not.toContain("Warnings:");
        expect(out.stdoutText).toContain("1 change written.");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a first-pull auth.rate_limit.email_sent DOES trip the ADR 0021 unpushable warning, for a sparse remote (review round, CLI-2314)",
    () => {
      // applyDisabledSentinels's cross-section rule deletes auth.rate_limit.email_sent whenever
      // auth.email.smtp.enabled decodes false, on both arms. The stock fixture's smtp_host: ""
      // would decode enabled: false and prune email_sent on the API arm too; omitting smtp_host
      // entirely (a genuinely sparse response) is what spares it there. Combined with the local
      // document never declaring [auth.email.smtp], this reproduces the one live trigger for the
      // unpushable warning.
      const { layer, out } = setup({
        toml: 'project_id = "test"\n',
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            attributes: (attributes) => {
              const auth = { ...(attributes["auth"] as Record<string, unknown>) };
              delete auth["smtp_host"];
              auth["rate_limit_email_sent"] = 50;
              return { ...attributes, auth };
            },
          }),
        },
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const after = readFileSync(configPath(), "utf8");
        expect(after).toContain("[auth.rate_limit]");
        expect(after).toContain("email_sent = 50");
        expect(out.stdoutText).toContain("Warnings:");
        expect(out.stdoutText).toContain(
          "auth.rate_limit.email_sent was written here, but `config push` cannot send it back to the platform",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a clean remote reports nothing to write without prompting", () => {
    const { layer, out } = setup({ toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
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
      yield* configPull(noFlags);
      expect(readFileSync(configPath(), "utf8")).toBe(before);
      expect(out.promptConfirmCalls).toHaveLength(1);
      // No [remotes.*] suffix for a root-bound write.
      expect(out.promptConfirmCalls[0]?.message).toBe(
        `Apply 1 change(s) to ${join("supabase", "config.toml")}?`,
      );
      expect(out.stdoutText).toContain("not written (declined)");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output-format json reports written flags, destination, and counts", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer, out } = setup({ toml: before, format: "json", yes: true });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
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
          document_path: ["api", "max_rows"],
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("telemetry flushes and the linked-project cache writes on a failed run too", () => {
    const { layer, telemetry, linkedProjectCache, api } = setup();
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("ConfigPullLoadConfigError");
      // A defaulted workdir with no project keeps the supabase init suggestion; only an
      // explicit --workdir/SUPABASE_WORKDIR gets the resolved-path wording.
      expect(rendered).toContain("supabase init");
      // The load runs before any network call or target resolution, so the linked-project
      // cache never fires.
      expect(api.requests).toHaveLength(0);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "does not climb to an ancestor project's config when --workdir names a subdirectory with no config of its own",
    () => {
      // The ancestor (tempRoot) genuinely has a valid config.toml (captured below to prove
      // it's never touched); the subdirectory genuinely has none.
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      const sub = join(tempRoot.current, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const { layer } = setup({ toml: before, yes: true, workdir: sub, explicitWorkdir: true });
      const path = configPath();
      const beforeStat = { mtimeMs: statSync(path).mtimeMs, contents: readFileSync(path, "utf8") };
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("ConfigPullLoadConfigError");
        expect(rendered).toContain("file not found");
        // An explicit workdir skips the ancestor-search "supabase init" hint; it names the
        // resolved directory and the flag/env var to change instead.
        expect(rendered).not.toContain("supabase init");
        expect(rendered).toContain("--workdir/SUPABASE_WORKDIR");
        expect(rendered).toContain(sub);
        expect(statSync(path).mtimeMs).toBe(beforeStat.mtimeMs);
        expect(readFileSync(path, "utf8")).toBe(beforeStat.contents);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "an explicit --workdir naming a directory that does not exist at all fails before any config load",
    () => {
      const missing = join(tempRoot.current, "does-not-exist");
      const { layer, api } = setup({ workdir: missing, explicitWorkdir: true });
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("ConfigPullWorkdirError");
        expect(rendered).toContain("failed to change workdir: chdir");
        expect(api.requests).toHaveLength(0);
        expect(existsSync(missing)).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "reuses an existing [remotes.*] block regardless of its own label when its project_id matches the target",
    () => {
      const before = [
        'project_id = "test"',
        "[remotes.prod]",
        `project_id = "${BRANCH_REF}"`,
        "[remotes.prod.api]",
        "max_rows = 500",
        "",
      ].join("\n");
      const { layer, out } = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        yield* configPull({ ...noFlags, projectRef: Option.some("staging") });
        expect(out.stderrText).toContain("→ [remotes.prod]");
        expect(out.stderrText).not.toContain("[remotes.staging]");
        const after = readFileSync(configPath(), "utf8");
        expect(after).not.toContain("[remotes.staging]");
        expect(after).toContain("[remotes.prod.api]");
        expect(after).toContain("max_rows = 1000");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--remote-label naming the block block reuse already selected succeeds unchanged", () => {
    const before = [
      'project_id = "test"',
      "[remotes.prod]",
      `project_id = "${BRANCH_REF}"`,
      "[remotes.prod.api]",
      "max_rows = 500",
      "",
    ].join("\n");
    const { layer, out } = setup({ toml: before, yes: true });
    return Effect.gen(function* () {
      yield* configPull({
        ...noFlags,
        projectRef: Option.some("staging"),
        remoteLabel: Option.some("prod"),
      });
      expect(out.stderrText).toContain("→ [remotes.prod]");
      expect(readFileSync(configPath(), "utf8")).toContain("max_rows = 1000");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "the confirmation prompt names the destination block when writing into a [remotes.*] block (CLI-2064 item F.5)",
    () => {
      const before = [
        'project_id = "test"',
        "[remotes.prod]",
        `project_id = "${BRANCH_REF}"`,
        "[remotes.prod.api]",
        "max_rows = 500",
        "",
      ].join("\n");
      const { layer, out } = setup({ toml: before, stdinIsTty: true, confirm: [true] });
      return Effect.gen(function* () {
        yield* configPull({ ...noFlags, projectRef: Option.some("staging") });
        expect(out.promptConfirmCalls[0]?.message).toBe(
          `Apply 1 change(s) to ${join("supabase", "config.toml")} [remotes.prod]?`,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--remote-label naming a block that already tracks a different project fails with a collision error",
    () => {
      const before = [
        'project_id = "test"',
        "[remotes.prod]",
        'project_id = "dddddddddddddddddddd"',
        "",
      ].join("\n");
      const { layer } = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        const exit = yield* configPull({
          ...noFlags,
          remoteLabel: Option.some("prod"),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("ConfigPullRemoteLabelCollisionError");
        expect(rendered).toContain('--remote-label \\"prod\\"');
        expect(rendered).toContain("dddddddddddddddddddd");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--remote-label naming a nonexistent label while a different block already tracks the ref fails with a collision error",
    () => {
      const before = [
        'project_id = "test"',
        "[remotes.other]",
        `project_id = "${VALID_REF}"`,
        "",
      ].join("\n");
      const { layer } = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        const exit = yield* configPull({
          ...noFlags,
          remoteLabel: Option.some("newname"),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("ConfigPullRemoteLabelCollisionError");
        // Names the actually conflicting block (`other`), not the requested-but-unused label.
        expect(rendered).toContain("[remotes.other] already tracks project");
        expect(rendered).toContain(VALID_REF);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "an env()-spelled [remotes.*].project_id resolving to the target ref is a hard error, and the file stays untouched",
    () => {
      const before = [
        'project_id = "test"',
        "[remotes.x]",
        'project_id = "env(REMOTE_REF)"',
        "",
      ].join("\n");
      const { layer, api } = setup({
        toml: before,
        dotenv: `REMOTE_REF=${VALID_REF}\n`,
        yes: true,
      });
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("ConfigPullRemoteEnvRefError");
        expect(rendered).toContain("REMOTE_REF");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        // Fails purely from the scope resolver — never even reaches the fetch.
        expect(api.requests.some((request) => request.url.includes("/v2/projects/"))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--remote-label alongside an env-spelled match creates the requested block instead of refusing (CLI-2064 item B)",
    () => {
      const before = [
        'project_id = "test"',
        "[remotes.x]",
        'project_id = "env(REMOTE_REF)"',
        "",
      ].join("\n");
      const { layer } = setup({
        toml: before,
        dotenv: `REMOTE_REF=${VALID_REF}\n`,
        yes: true,
      });
      return Effect.gen(function* () {
        yield* configPull({ ...noFlags, remoteLabel: Option.some("y") });
        const after = readFileSync(configPath(), "utf8");
        expect(after).toContain("[remotes.y]");
        expect(after).toContain(`project_id = "${VALID_REF}"`);
        // The unrelated env()-spelled block is left exactly as it was.
        expect(after).toContain('project_id = "env(REMOTE_REF)"');
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a branch-named target that collides with an existing, differently-tracked block fails with a collision error, and the file stays untouched (CLI-2064 item A)",
    () => {
      const before = [
        'project_id = "test"',
        "[remotes.staging]",
        'project_id = "dddddddddddddddddddd"',
        "[remotes.staging.api]",
        "max_rows = 999",
        "",
      ].join("\n");
      const { layer } = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        const exit = yield* configPull({
          ...noFlags,
          projectRef: Option.some("staging"),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("ConfigPullRemoteLabelCollisionError");
        expect(rendered).toContain("dddddddddddddddddddd");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a --remote-label collision is still caught when the raw value differs from the existing block's name only by control characters (CLI-2064 item A, sanitization bypass)",
    () => {
      const before = [
        'project_id = "test"',
        "[remotes.staging]",
        'project_id = "dddddddddddddddddddd"',
        "",
      ].join("\n");
      const { layer } = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        const exit = yield* configPull({
          ...noFlags,
          remoteLabel: Option.some(`stag${String.fromCharCode(1)}ing`),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("ConfigPullRemoteLabelCollisionError");
        expect(rendered).toContain("dddddddddddddddddddd");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "the destination line prints to stderr before any network call, and survives a failed fetch",
    () => {
      const { layer, out } = setup({ toml: 'project_id = "test"\n', v2: "fail" });
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(out.stderrText).toContain(`Pulling config from project ${VALID_REF} → config root`);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("no temp file is left behind in supabase/ after a successful write", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer } = setup({ toml: before, yes: true });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
      const entries = readdirSync(join(tempRoot.current, "supabase"));
      expect(entries.some((name) => name.includes(".tmp."))).toBe(false);
      expect(entries).toContain("config.toml");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "an editor refusal (an edit path through an inline table) leaves the file byte-identical and fails with ConfigPullUnsupportedLayoutError",
    () => {
      // A genuine duplicate [api] table header would be rejected by smol-toml itself at load
      // time, never reaching applyConfigEdits. An inline table is the reachable equivalent:
      // valid, loadable TOML whose surgical text-span editor still refuses to edit through it.
      const before = 'project_id = "test"\napi = { max_rows = 500 }\n';
      const { layer } = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("ConfigPullUnsupportedLayoutError");
        // Prose, not the raw reason token, plus a remediation sentence.
        expect(rendered).toContain("an inline table on this path");
        expect(rendered).toContain("Rewrite it as a standard [table] section, then rerun.");
        expect(rendered).not.toContain("inline_table_on_path");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a local-only declared property survives the write and is reported skipped", () => {
    const before = [
      'project_id = "test"',
      "[auth]",
      'site_url = "https://local.example.com"',
      "[api]",
      "max_rows = 500",
      "",
    ].join("\n");
    const { layer, out } = setup({
      toml: before,
      format: "json",
      yes: true,
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => {
            const { site_url: _siteUrl, ...auth } = attributes["auth"] as Record<string, unknown>;
            return { ...attributes, auth };
          },
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
      expect(readFileSync(configPath(), "utf8")).toContain(
        'site_url = "https://local.example.com"',
      );
      const success = out.messages.find((message) => message.type === "success");
      const data = success?.data as Record<string, unknown>;
      const changes = data["changes"] as ReadonlyArray<Record<string, unknown>>;
      const siteUrlChange = changes.find(
        (change) => (change["path"] as Array<string>).join(".") === "auth.site_url",
      );
      expect(siteUrlChange).toMatchObject({ written: false, skipped_reason: "local_only" });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "an env()-declared property is never replaced, even when other keys in the same run are written",
    () => {
      const before = [
        'project_id = "test"',
        "[auth]",
        'site_url = "env(SITE_URL)"',
        "[api]",
        "max_rows = 500",
        "",
      ].join("\n");
      const { layer, out } = setup({
        toml: before,
        dotenv: "SITE_URL=https://local.example.com\n",
        format: "json",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const after = readFileSync(configPath(), "utf8");
        expect(after).toContain('site_url = "env(SITE_URL)"');
        expect(after).toContain("max_rows = 1000");
        const success = out.messages.find((message) => message.type === "success");
        const data = success?.data as Record<string, unknown>;
        const changes = data["changes"] as ReadonlyArray<Record<string, unknown>>;
        const siteUrlChange = changes.find(
          (change) => (change["path"] as Array<string>).join(".") === "auth.site_url",
        );
        expect(siteUrlChange).toMatchObject({ written: false, skipped_reason: "env_reference" });
        expect(siteUrlChange?.["env_variables"]).toEqual(["SITE_URL"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a declared secret is never written, even though the config file has it declared before AND after the run",
    () => {
      const before = [
        'project_id = "test"',
        "[auth.email.smtp]",
        'pass = "env(SMTP_PASS)"',
        "[api]",
        "max_rows = 500",
        "",
      ].join("\n");
      const { layer, out } = setup({ toml: before, dotenv: "SMTP_PASS=hunter2\n", yes: true });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        expect(readFileSync(configPath(), "utf8")).toContain('pass = "env(SMTP_PASS)"');
        expect(out.stdoutText).toContain(
          "Note: 1 credential value not compared (masked by the API): auth.email.smtp.pass",
        );
        expect(out.stdoutText + out.stderrText).not.toContain("hunter2");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a REMOTE value spelled as env() is never written — the loader would resolve it against the LOCAL environment on the next load (CLI-2064 security finding)",
    () => {
      const before = [
        'project_id = "test"',
        "[auth]",
        'site_url = "https://local.example.com"',
        "[api]",
        "max_rows = 500",
        "",
      ].join("\n");
      const { layer, out } = setup({
        toml: before,
        format: "json",
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            attributes: (attributes) => ({
              ...attributes,
              auth: {
                ...(attributes["auth"] as Record<string, unknown>),
                site_url: "env(SUPABASE_ACCESS_TOKEN)",
              },
            }),
          }),
        },
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const after = readFileSync(configPath(), "utf8");
        // site_url stays byte-identical since the remote's env()-spelled value is never
        // written, while the unrelated max_rows change is written normally.
        expect(after).toContain('site_url = "https://local.example.com"');
        expect(after).toContain("max_rows = 1000");
        const success = out.messages.find((message) => message.type === "success");
        const data = success?.data as Record<string, unknown>;
        const changes = data["changes"] as ReadonlyArray<Record<string, unknown>>;
        const siteUrlChange = changes.find(
          (change) => (change["path"] as Array<string>).join(".") === "auth.site_url",
        );
        expect(siteUrlChange).toMatchObject({
          written: false,
          skipped_reason: "remote_env_reference",
        });
        const counts = data["counts"] as Record<string, unknown>;
        expect(counts["skipped"]).toBeGreaterThanOrEqual(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("writing a dual-scope property to the config root warns before the prompt", () => {
    const before = 'project_id = "test"\n[auth]\nsite_url = "https://custom.example.com"\n';
    const { layer, out } = setup({ toml: before, yes: true });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
      expect(out.stdoutText).toContain("Warnings:");
      expect(out.stdoutText).toContain(
        "auth.site_url also configures the local stack (`supabase start`) — writing it to the config root changes local dev behavior too.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "the same dual-scope property written into a [remotes.*] block carries no dual-scope warning",
    () => {
      const { layer, out } = setup({
        toml: 'project_id = "test"\n',
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            ref: BRANCH_REF,
            attributes: (attributes) => ({
              ...attributes,
              auth: {
                ...(attributes["auth"] as Record<string, unknown>),
                site_url: "https://staging.example.com",
              },
            }),
          }),
        },
      });
      return Effect.gen(function* () {
        yield* configPull({ ...noFlags, projectRef: Option.some("staging") });
        expect(out.stdoutText).not.toContain("Warnings:");
        expect(out.stdoutText).not.toContain("also configures the local stack");
        expect(readFileSync(configPath(), "utf8")).toContain(
          'site_url = "https://staging.example.com"',
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a remote block's write that duplicates the config root's own value warns of redundancy",
    () => {
      // array_drift (an array-valued remote_only write into a block the root also declares) is
      // unreachable through the real loader: applyRemoteOverride's overlay merge always
      // inherits a root-declared path as "declared", so such a write can only classify as
      // "update", never "remote_only". It's covered instead at the planner-unit level
      // (pull.plan.unit.test.ts) via a synthetic changeSet/rootDocument pair.
      const before = [
        'project_id = "test"',
        "[api]",
        "max_rows = 1000",
        "[remotes.staging]",
        `project_id = "${BRANCH_REF}"`,
        "[remotes.staging.api]",
        "max_rows = 500",
        "",
      ].join("\n");
      const { layer, out } = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        yield* configPull({ ...noFlags, projectRef: Option.some("staging") });
        expect(out.stdoutText).toContain(
          "api.max_rows already matches the config root's value — this remote block now carries a redundant copy.",
        );
        expect(readFileSync(configPath(), "utf8")).toContain("max_rows = 1000");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "uncommitted changes abort without --force in text+non-tty mode, leaving the file untouched",
    () => {
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      // --yes is set to prove it doesn't override the dirty guard; only --force does.
      const { layer } = setup({ toml: before, gitDirty: true, yes: true });
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("ConfigPullUncommittedChangesError");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("uncommitted changes abort without --force in json mode too, even on a real TTY", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer } = setup({
      toml: before,
      gitDirty: true,
      format: "json",
      yes: true,
      stdinIsTty: true,
    });
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("ConfigPullUncommittedChangesError");
      expect(readFileSync(configPath(), "utf8")).toBe(before);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "on a TTY in text mode, --yes does NOT bypass the uncommitted-changes guard — it aborts instead of silently overwriting (CLI-2064 item C)",
    () => {
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      const { layer } = setup({ toml: before, gitDirty: true, yes: true, stdinIsTty: true });
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("ConfigPullUncommittedChangesError");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "--force writes despite uncommitted changes, with no warning or prompt-default flip",
    () => {
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      const { layer, out } = setup({ toml: before, gitDirty: true, yes: true });
      return Effect.gen(function* () {
        yield* configPull({ ...noFlags, force: true });
        expect(readFileSync(configPath(), "utf8")).toContain("max_rows = 1000");
        expect(out.stdoutText).not.toContain("uncommitted changes");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "on a TTY, uncommitted changes warn and flip the confirmation default to no; declining leaves the file untouched",
    () => {
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      const { layer, out } = setup({
        toml: before,
        gitDirty: true,
        stdinIsTty: true,
        confirm: [false],
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        expect(out.stdoutText).toContain(
          "supabase/config.toml has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.",
        );
        expect(out.promptConfirmCalls[0]?.opts).toEqual({ defaultValue: false });
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a git spawn failure degrades silently and the run proceeds as if clean", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer, out } = setup({ toml: before, gitSpawnFails: true, yes: true });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
      expect(readFileSync(configPath(), "utf8")).toContain("max_rows = 1000");
      expect(out.stdoutText).not.toContain("uncommitted changes");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a converged remote never spawns the git dirty check, even with uncommitted changes (bug A)",
    () => {
      const before = 'project_id = "test"\n';
      const { layer, out, gitStatus } = setup({
        toml: before,
        format: "json",
        gitDirty: true,
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const success = out.messages.find((message) => message.type === "success");
        expect(success?.message).toContain("No config differences found.");
        const data = success?.data as Record<string, unknown>;
        expect(data["wrote"]).toBe(false);
        expect(gitStatus.spawnCalls).toBe(0);
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a block-only run is still a write: uncommitted changes abort it too, without --force",
    () => {
      const before = 'project_id = "test"\n';
      const { layer, gitStatus } = setup({
        toml: before,
        gitDirty: true,
        yes: true,
        v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      });
      return Effect.gen(function* () {
        const exit = yield* configPull({
          ...noFlags,
          projectRef: Option.some("staging"),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("ConfigPullUncommittedChangesError");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        expect(gitStatus.spawnCalls).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a zero-drift branch target still creates its [remotes.*] block; a second run reuses it and writes nothing",
    () => {
      const before = 'project_id = "test"\n';
      const first = setup({
        toml: before,
        stdinIsTty: true,
        confirm: [true],
        v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      });
      return Effect.gen(function* () {
        yield* configPull({ ...noFlags, projectRef: Option.some("staging") });
        expect(first.out.promptConfirmCalls).toHaveLength(1);
        expect(first.out.promptConfirmCalls[0]?.message).toContain("Create [remotes.staging] in");
        expect(first.out.promptConfirmCalls[0]?.message).toContain(join("supabase", "config.toml"));
        // The block-only body states its one action too, not only the confirmation prompt above.
        expect(first.out.stdoutText).toContain(
          `New block [remotes.staging] will be created (project_id = ${BRANCH_REF}).`,
        );
        expect(first.out.stdoutText).toContain(
          "Created [remotes.staging]; no config differences to apply.",
        );
        const afterFirst = readFileSync(configPath(), "utf8");
        const remotesIndex = afterFirst.indexOf("[remotes.staging]");
        expect(remotesIndex).toBeGreaterThan(-1);
        expect(afterFirst.slice(0, remotesIndex)).toBe(`${before}\n`);
        expect(afterFirst.slice(remotesIndex)).toBe(
          `[remotes.staging]\nproject_id = "${BRANCH_REF}"\n`,
        );

        const second = setup({
          toml: afterFirst,
          format: "json",
          v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
        });
        yield* configPull({ ...noFlags, projectRef: Option.some("staging") }).pipe(
          Effect.provide(second.layer),
        );
        const success = second.out.messages.find((message) => message.type === "success");
        const data = success?.data as Record<string, unknown>;
        expect(data["destination"]).toMatchObject({ created: false });
        expect(data["wrote"]).toBe(false);
        expect(readFileSync(configPath(), "utf8")).toBe(afterFirst);
      }).pipe(Effect.provide(first.layer));
    },
  );

  it.live("a zero-drift target with --remote-label creates the named block instead", () => {
    const before = 'project_id = "test"\n';
    const { layer, out } = setup({ toml: before, yes: true });
    return Effect.gen(function* () {
      yield* configPull({ ...noFlags, remoteLabel: Option.some("customname") });
      expect(out.stderrText).toContain("→ [remotes.customname]");
      expect(readFileSync(configPath(), "utf8")).toBe(
        `${before}\n[remotes.customname]\nproject_id = "${VALID_REF}"\n`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "--dry-run on a zero-drift branch target previews the would-be-created block without writing",
    () => {
      const before = 'project_id = "test"\n';
      const { layer, out } = setup({
        toml: before,
        format: "json",
        v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      });
      return Effect.gen(function* () {
        yield* configPull({
          ...noFlags,
          projectRef: Option.some("staging"),
          dryRun: true,
        });
        expect(readFileSync(configPath(), "utf8")).toBe(before);
        const success = out.messages.find((message) => message.type === "success");
        const data = success?.data as Record<string, unknown>;
        expect(data["dry_run"]).toBe(true);
        expect(data["destination"]).toMatchObject({ created: true, label: "staging" });
        expect(data["wrote"]).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a declined confirmation on a zero-drift branch target creates nothing", () => {
    const before = 'project_id = "test"\n';
    const { layer, out } = setup({
      toml: before,
      stdinIsTty: true,
      confirm: [false],
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* configPull({ ...noFlags, projectRef: Option.some("staging") });
      expect(readFileSync(configPath(), "utf8")).toBe(before);
      expect(out.promptConfirmCalls).toHaveLength(1);
      expect(out.stdoutText).toContain("[remotes.staging] not created (declined).");
    }).pipe(Effect.provide(layer));
  });

  it.live("--yes skips the confirmation prompt entirely, even on a real TTY", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer, out } = setup({ toml: before, yes: true, stdinIsTty: true });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(readFileSync(configPath(), "utf8")).toContain("max_rows = 1000");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "pulling twice against the same remote converges: the second run reports nothing left to write",
    () => {
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      const first = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const afterFirst = readFileSync(configPath(), "utf8");
        expect(afterFirst).toContain("max_rows = 1000");

        const second = setup({ toml: afterFirst, yes: true });
        yield* configPull(noFlags).pipe(Effect.provide(second.layer));
        expect(second.out.stdoutText).toContain("No config differences found.");
        expect(readFileSync(configPath(), "utf8")).toBe(afterFirst);
      }).pipe(Effect.provide(first.layer));
    },
  );

  it.live(
    "the file changing on disk between confirmation and write fails without touching the concurrent edit",
    () => {
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      const concurrent = 'project_id = "test"\n[api]\nmax_rows = 999\n';
      const { layer } = setup({
        toml: before,
        stdinIsTty: true,
        confirm: [true],
        confirmSideEffect: () => writeFileSync(configPath(), concurrent),
      });
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("ConfigPullFileChangedError");
        expect(readFileSync(configPath(), "utf8")).toBe(concurrent);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("every -o/--output value is rejected before any config load or network call", () => {
    const values = GLOBAL_OUTPUT_FORMATS;
    const run = (goOutput: (typeof values)[number]) => {
      const { layer, api } = setup({
        toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
        goOutput,
      });
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("ConfigPullOutputFlagUnsupportedError");
        expect(rendered).toContain(
          "the -o/--output flag is not supported by config pull; use --output-format json|stream-json instead.",
        );
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    };
    return Effect.gen(function* () {
      for (const value of values) {
        yield* run(value);
      }
    });
  });

  it.live("a branch-named target resolves via the linked parent project", () => {
    const { layer, api, out } = setup({
      toml: 'project_id = "test"\n',
      yes: true,
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* configPull({ ...noFlags, projectRef: Option.some("staging") });
      expect(out.stderrText).toContain(`Pulling config from 'staging' (branch ${BRANCH_REF})`);
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes(`/v1/projects/${VALID_REF}/branches/staging`))).toBe(
        true,
      );
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("a branch UUID target resolves directly, even in an unlinked directory", () => {
    const { layer, api, out } = setup({
      toml: 'project_id = "test"\n',
      yes: true,
      linked: false,
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
      yield* configPull({ ...noFlags, projectRef: Option.some(BRANCH_UUID) });
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes(`/v1/branches/${BRANCH_UUID}`))).toBe(true);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
      expect(out.stderrText).toContain(
        `Pulling config from branch ${BRANCH_UUID} (project ref ${BRANCH_REF})`,
      );
      // A UUID target creates a new `[remotes.*]` block falling back to the
      // resolved project ref as the label (no branch name to use instead).
      expect(readFileSync(configPath(), "utf8")).toContain(`[remotes.${BRANCH_REF}]`);
    }).pipe(Effect.provide(layer));
  });

  it.live("a ref-shaped target never calls the branches API", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      yes: true,
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* configPull({ ...noFlags, projectRef: Option.some(BRANCH_REF) });
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes("/branches/"))).toBe(false);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a branch name in an unlinked directory fails with a not-linked error before any request",
    () => {
      const { layer, api, telemetry, linkedProjectCache } = setup({
        toml: 'project_id = "test"\n',
        linked: false,
      });
      return Effect.gen(function* () {
        const exit = yield* configPull({
          ...noFlags,
          projectRef: Option.some("somebranch"),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("ConfigPullBranchNotLinkedError");
        expect(rendered).toContain('\\"somebranch\\"');
        expect(api.requests).toHaveLength(0);
        expect(telemetry.flushed).toBe(true);
        expect(linkedProjectCache.cachedRef).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a branch-name target with a corrupt linked ref reports it as invalid", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      projectId: Option.some("not-a-valid-ref"),
    });
    return Effect.gen(function* () {
      const exit = yield* configPull({
        ...noFlags,
        projectRef: Option.some("somebranch"),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("ConfigPullParentRefInvalidError");
      expect(rendered).toContain('\\"somebranch\\"');
      expect(rendered).toContain("Relink the parent project");
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("an unknown branch fails with a branches-list suggestion", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      branchByName: { status: 404, body: { message: "not found" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configPull({ ...noFlags, projectRef: Option.some("ghost") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("ConfigPullBranchNotFoundError");
      expect(rendered).toContain('Branch \\"ghost\\" not found');
      expect(rendered).toContain("supabase branches list");
    }).pipe(Effect.provide(layer));
  });

  it.live("a resolved branch with no project ref yet fails with a not-ready error", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      branchByName: { status: 200, body: { ...BRANCH_BY_NAME, project_ref: "" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configPull({
        ...noFlags,
        projectRef: Option.some("staging"),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("ConfigPullBranchNotReadyError");
      expect(rendered).toContain("has no project ref yet");
      expect(api.requests.some((request) => request.url.includes("/v2/projects/"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("a non-404 branch lookup failure keeps its status error", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      branchByName: { status: 500, body: { message: "boom" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configPull({
        ...noFlags,
        projectRef: Option.some("staging"),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("ConfigPullReadStatusError");
    }).pipe(Effect.provide(layer));
  });

  it.live("a malformed config aborts before any network call, even with a branch target", () => {
    const { layer, api, telemetry } = setup({ toml: "not [valid toml\n" });
    return Effect.gen(function* () {
      const exit = yield* configPull({
        ...noFlags,
        projectRef: Option.some("staging"),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(`failed to parse ${join("supabase", "config.toml")}`);
      expect(api.requests).toHaveLength(0);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("duplicate [remotes.*] project_ids abort the load", () => {
    const before = [
      'project_id = "test"',
      "[remotes.a]",
      `project_id = "${VALID_REF}"`,
      "[remotes.b]",
      `project_id = "${VALID_REF}"`,
      "",
    ].join("\n");
    const { layer } = setup({ toml: before });
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("ConfigPullLoadConfigError");
    }).pipe(Effect.provide(layer));
  });

  it.live("an out-of-domain mapped value in the response keeps its typed parse error", () => {
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
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("ProjectConfigParseError");
      expect(rendered).toContain("Could not read the project config");
    }).pipe(Effect.provide(layer));
  });

  it.live("a 401 on the config read points at re-authenticating", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 401, body: { message: "unauthorized" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("ConfigPullReadStatusError");
      expect(rendered).toContain("supabase login");
    }).pipe(Effect.provide(layer));
  });

  it.live("a 403 on the config read names the sanitized ref", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 403, body: { message: "forbidden" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("ConfigPullReadStatusError");
      expect(rendered).toContain("Access denied");
      expect(rendered).toContain(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("a 404 on the config read suggests projects list and hedges the api host", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 404, body: { message: "not found" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain(`Could not read configuration for project ${VALID_REF}`);
      expect(rendered).toContain("supabase projects list");
      expect(rendered).toContain(DEFAULT_API_URL);
    }).pipe(Effect.provide(layer));
  });

  it.live("other config-read statuses keep the generic unexpected-status message", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 500, body: { message: "boom" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain('unexpected status 500: {\\"message\\":\\"boom\\"}');
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "a config.json project is rewritten preserving key order and indent, changing only the drifted property",
    () => {
      const before = `${JSON.stringify({ project_id: "test", api: { max_rows: 500 } }, null, 4)}\n`;
      writeJsonConfig(before);
      const { layer } = setup({ yes: true });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const after = readFileSync(jsonConfigPath(), "utf8");
        expect(after).toBe(
          `${JSON.stringify({ project_id: "test", api: { max_rows: 1000 } }, null, 4)}\n`,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a branch-lookup transport failure maps to the read network error", () => {
    const { layer } = setup({ toml: 'project_id = "test"\n', branchByName: "fail" });
    return Effect.gen(function* () {
      const exit = yield* configPull({
        ...noFlags,
        projectRef: Option.some("staging"),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("ConfigPullReadNetworkError");
      expect(rendered).toContain("failed to resolve branch");
    }).pipe(Effect.provide(layer));
  });

  it.live("a fetch failure in json mode still maps cleanly without a spinner", () => {
    const { layer } = setup({ toml: 'project_id = "test"\n', v2: "fail", format: "json" });
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("ConfigPullReadNetworkError");
    }).pipe(Effect.provide(layer));
  });

  it.live("a config-read status failure in json mode still maps cleanly without a spinner", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 500, body: { message: "boom" } },
      format: "json",
    });
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("ConfigPullReadStatusError");
    }).pipe(Effect.provide(layer));
  });

  it.live("an undecodable config-read body fails as a decode network error", () => {
    const { layer } = setup({ toml: 'project_id = "test"\n', v2: "decode-fail" });
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("ConfigPullReadNetworkError");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "an undecodable config-read body in json mode still maps cleanly without a spinner",
    () => {
      const { layer } = setup({ toml: 'project_id = "test"\n', v2: "decode-fail", format: "json" });
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("ConfigPullReadNetworkError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a response body with no data/attributes degrades to an empty scope instead of crashing",
    () => {
      const { layer, out } = setup({
        toml: 'project_id = "test"\n',
        v2: { status: 200, body: {} },
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        expect(out.stderrText).toContain("Comparison scope: (none)");
        expect(out.stdoutText).toContain("No config differences found.");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--dry-run in text mode renders the full change-by-change preview", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer, out } = setup({ toml: before, yes: true });
    return Effect.gen(function* () {
      yield* configPull({ ...noFlags, dryRun: true });
      expect(out.stdoutText).toContain("api.max_rows [update, write]");
      expect(out.stdoutText).toContain("1 change would be written (dry run).");
      expect(readFileSync(configPath(), "utf8")).toBe(before);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "the file disappearing between confirmation and re-read fails with ConfigPullFileChangedError",
    () => {
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      const { layer } = setup({
        toml: before,
        stdinIsTty: true,
        confirm: [true],
        confirmSideEffect: () => rmSync(configPath()),
      });
      return Effect.gen(function* () {
        const exit = yield* configPull(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("ConfigPullFileChangedError");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("--remote-label creates a brand-new block when nothing else conflicts", () => {
    const before = 'project_id = "test"\n';
    const { layer, out } = setup({
      toml: before,
      yes: true,
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
      yield* configPull({ ...noFlags, remoteLabel: Option.some("newstage") });
      expect(out.stderrText).toContain("→ [remotes.newstage]");
      const after = readFileSync(configPath(), "utf8");
      expect(after).toContain("[remotes.newstage]");
      expect(after).toContain(`project_id = "${VALID_REF}"`);
    }).pipe(Effect.provide(layer));
  });

  it.live("a filesystem write failure maps to ConfigPullWriteError", () => {
    const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
    const { layer } = setup({ toml: before, yes: true });
    const dir = join(tempRoot.current, "supabase");
    chmodSync(dir, 0o500);
    return Effect.gen(function* () {
      const exit = yield* configPull(noFlags).pipe(Effect.exit);
      chmodSync(dir, 0o700);
      // Running as root (some CI/container setups) bypasses the permission bit, so skip the
      // assertion instead of asserting a false negative.
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit)).toContain("ConfigPullWriteError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("a response missing an entire block is noted as not-returned", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({ attributes: (attributes) => ({ ...attributes, auth: {} }) }),
      },
    });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
      expect(out.stderrText).toContain(
        "Comparison scope: api, database, pooler, realtime, storage (not returned: auth)",
      );
      expect(out.stdoutText).toContain(
        "Note: 1 block was not returned by the API and was not compared: auth",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("multiple simultaneous changes pluralize the summary and difference counts", () => {
    const before =
      'project_id = "test"\n[api]\nmax_rows = 500\nextra_search_path = "custom_schema"\n';
    const { layer, out } = setup({ toml: before, yes: true });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
      expect(out.stdoutText).toContain("2 differences found (2 to write, 0 to skip).");
      expect(out.stdoutText).toContain("2 changes written.");
    }).pipe(Effect.provide(layer));
  });

  it.live("a branch-named target resolves in json mode without a spinner", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      format: "json",
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* configPull({ ...noFlags, projectRef: Option.some("staging") });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({ target: { branch: "staging" } });
    }).pipe(Effect.provide(layer));
  });

  it.live("an unknown branch in json mode fails without a spinner", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      format: "json",
      branchByName: { status: 404, body: { message: "not found" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configPull({ ...noFlags, projectRef: Option.some("ghost") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("ConfigPullBranchNotFoundError");
    }).pipe(Effect.provide(layer));
  });

  it.live("a single declared-but-unpushable property surfaces in the unmanaged note", () => {
    // enabled matches the remote and produces no change; its sibling allow_dynamic_registration
    // is what demonstrates declared-but-unpushable, since DISABLED_SENTINEL_PRUNES drops it from
    // the local projection while the container is disabled.
    const before = [
      'project_id = "test"',
      "[auth.oauth_server]",
      "enabled = false",
      "allow_dynamic_registration = true",
      "",
    ].join("\n");
    const { layer, out } = setup({
      toml: before,
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            auth: {
              ...(attributes["auth"] as Record<string, unknown>),
              oauth_server_enabled: false,
              oauth_server_allow_dynamic_registration: false,
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
      expect(out.stdoutText).toContain("No config differences found.");
      expect(out.stdoutText).toContain(
        "Note: 1 declared property is not part of the current comparison and was not compared: auth.oauth_server.allow_dynamic_registration",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "declared-but-unpushable properties surface in the unmanaged note, pluralized when there's more than one",
    () => {
      // enabled matches the remote and produces no change here; its two siblings
      // (allow_dynamic_registration, authorization_url_path) are what DISABLED_SENTINEL_PRUNES
      // drops from the local projection while the container is disabled, exercising the
      // pluralized note.
      const before = [
        'project_id = "test"',
        "[auth.oauth_server]",
        "enabled = false",
        "allow_dynamic_registration = true",
        'authorization_url_path = "/consent"',
        "",
      ].join("\n");
      const { layer, out } = setup({
        toml: before,
        v2: {
          status: 200,
          body: v2Response({
            attributes: (attributes) => ({
              ...attributes,
              auth: {
                ...(attributes["auth"] as Record<string, unknown>),
                oauth_server_enabled: false,
                oauth_server_allow_dynamic_registration: false,
                oauth_server_authorization_path: "/other",
              },
            }),
          }),
        },
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        expect(out.stdoutText).toContain("No config differences found.");
        expect(out.stdoutText).toContain(
          "Note: 2 declared properties are not part of the current comparison and were not compared: auth.oauth_server.allow_dynamic_registration, auth.oauth_server.authorization_url_path",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a run where every difference is skipped reports 'No changes written', with the skip reason rendered inline",
    () => {
      const before = 'project_id = "test"\n[auth]\nsite_url = "env(SITE_URL)"\n';
      const { layer, out } = setup({
        toml: before,
        dotenv: "SITE_URL=https://local.example.com\n",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        expect(out.stdoutText).toContain("auth.site_url [update, skip: env() reference]");
        expect(out.stdoutText).toContain("No changes written.");
        expect(readFileSync(configPath(), "utf8")).toBe(before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("a warning with a path reaches the machine payload's warnings array", () => {
    const before = 'project_id = "test"\n[auth]\nsite_url = "https://custom.example.com"\n';
    const { layer, out } = setup({ toml: before, format: "json", yes: true });
    return Effect.gen(function* () {
      yield* configPull(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      const data = success?.data as Record<string, unknown>;
      expect(data["warnings"]).toEqual([{ kind: "dual_scope", path: ["auth", "site_url"] }]);
    }).pipe(Effect.provide(layer));
  });

  const TWILIO_AUTH_TOKEN_VAR = "SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN";
  const TWILIO_BEFORE =
    'project_id = "test"\n' +
    "[auth.sms.twilio]\n" +
    "enabled = false\n" +
    'account_sid = ""\n' +
    'message_service_sid = ""\n' +
    `auth_token = "env(${TWILIO_AUTH_TOKEN_VAR})"\n`;

  function twilioV2(opts: { readonly withMessageServiceSid: boolean }) {
    return {
      status: 200,
      body: v2Response({
        attributes: (attributes) => ({
          ...attributes,
          auth: {
            ...(attributes["auth"] as Record<string, unknown>),
            sms_provider: "twilio",
            sms_twilio_account_sid: "ACreal0000000000000000000000000",
            ...(opts.withMessageServiceSid
              ? { sms_twilio_message_service_sid: "MGreal0000000000000000000000000" }
              : {}),
          },
        }),
      }),
    };
  }

  it.live(
    "twilio scenario A: the fixpoint absorbs a disabled SMS provider's credentials once its own `enabled` toggle is written, and the written file reloads (CLI-2064 live-bug repro)",
    () => {
      const { layer, out } = setup({
        toml: TWILIO_BEFORE,
        yes: true,
        v2: twilioV2({ withMessageServiceSid: true }),
      });
      return withProcessEnv(
        TWILIO_AUTH_TOKEN_VAR,
        "a-real-secret-value",
        Effect.gen(function* () {
          yield* configPull(noFlags);
          const after = readFileSync(configPath(), "utf8");
          expect(after).toContain("enabled = true");
          expect(after).toContain('account_sid = "ACreal0000000000000000000000000"');
          expect(after).toContain('message_service_sid = "MGreal0000000000000000000000000"');
          // `auth_token` is masked (secret) AND env-sourced — pull never
          // touches it, written or not.
          expect(after).toContain(`auth_token = "env(${TWILIO_AUTH_TOKEN_VAR})"`);
          expect(out.stdoutText).not.toContain("would_invalidate");
          expect(out.stdoutText).not.toContain("requires values pull cannot write");
          expect(out.stdoutText).toContain("3 changes written.");

          // The written file reloads cleanly. A second config pull run against the same remote
          // converges to nothing left to write for this family.
          const second = setup({
            toml: after,
            yes: true,
            v2: twilioV2({ withMessageServiceSid: true }),
          });
          yield* configPull(noFlags).pipe(Effect.provide(second.layer));
          expect(second.out.stdoutText).toContain("No config differences found.");
          expect(readFileSync(configPath(), "utf8")).toBe(after);
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "twilio scenario B: the schema-validation gate drops the whole family when a sibling stays unwritable (remote silent on message_service_sid), and the written file still reloads",
    () => {
      const { layer, out } = setup({
        toml: TWILIO_BEFORE,
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            attributes: (attributes) => ({
              ...attributes,
              // An unrelated change so this run has something else to write, proving the drop
              // is scoped to the twilio family, not the whole run.
              api: { ...(attributes["api"] as Record<string, unknown>), max_rows: 250 },
              auth: {
                ...(attributes["auth"] as Record<string, unknown>),
                sms_provider: "twilio",
                sms_twilio_account_sid: "ACreal0000000000000000000000000",
                // sms_twilio_message_service_sid is deliberately absent: the remote never
                // reports it, so message_service_sid stays "" after the fixpoint absorbs
                // account_sid, and the projected file would fail to decode once enabled is
                // written.
              },
            }),
          }),
        },
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const after = readFileSync(configPath(), "utf8");
        // The unrelated change still wrote.
        expect(after).toContain("max_rows = 250");
        // The whole twilio family (including account_sid, which the fixpoint did classify as
        // writable) was dropped, not just the sibling that made it unwritable.
        expect(after).toContain("enabled = false");
        expect(after).not.toContain("ACreal0000000000000000000000000");
        expect(out.stdoutText).toContain(
          "auth.sms.twilio.enabled [update, skip: requires values pull cannot write]",
        );
        expect(out.stdoutText).toContain(
          "auth.sms.twilio.account_sid [update, skip: requires values pull cannot write]",
        );
        expect(out.stdoutText).toContain("auth.sms.twilio was not changed: it requires");
        expect(out.stdoutText).toContain("auth.sms.twilio.message_service_sid");

        // The written file reloads cleanly — it was never touched for the twilio family.
        // openConfigPullSource re-reads and re-decodes the same path; a failing decode would
        // fail this yield*.
        const configText = readFileSync(configPath(), "utf8");
        const reloaded = yield* openConfigPullSource();
        expect(reloaded.loaded.config.auth.sms.twilio.enabled).toBe(false);

        // A second run reports the same drift and skip: the writable subset has converged
        // (nothing left for the unrelated change), while the twilio family drifts exactly as
        // before.
        const second = setup({
          toml: configText,
          yes: true,
          v2: {
            status: 200,
            body: v2Response({
              attributes: (attributes) => ({
                ...attributes,
                api: { ...(attributes["api"] as Record<string, unknown>), max_rows: 250 },
                auth: {
                  ...(attributes["auth"] as Record<string, unknown>),
                  sms_provider: "twilio",
                  sms_twilio_account_sid: "ACreal0000000000000000000000000",
                },
              }),
            }),
          },
        });
        yield* configPull(noFlags).pipe(Effect.provide(second.layer));
        expect(second.out.stdoutText).toContain(
          "auth.sms.twilio.enabled [update, skip: requires values pull cannot write]",
        );
        expect(readFileSync(configPath(), "utf8")).toBe(configText);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "twilio scenario B's would_invalidate skip/note reach the machine payload (skipped_reason + warnings.missing_fields)",
    () => {
      const { layer, out } = setup({
        toml: TWILIO_BEFORE,
        format: "json",
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            attributes: (attributes) => ({
              ...attributes,
              auth: {
                ...(attributes["auth"] as Record<string, unknown>),
                sms_provider: "twilio",
                sms_twilio_account_sid: "ACreal0000000000000000000000000",
              },
            }),
          }),
        },
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const success = out.messages.find((message) => message.type === "success");
        const data = success?.data as Record<string, unknown>;
        const changes = data["changes"] as ReadonlyArray<Record<string, unknown>>;
        const enabledChange = changes.find(
          (change) =>
            (change["path"] as ReadonlyArray<string>).join(".") === "auth.sms.twilio.enabled",
        );
        expect(enabledChange?.["written"]).toBe(false);
        expect(enabledChange?.["skipped_reason"]).toBe("would_invalidate");
        const warnings = data["warnings"] as ReadonlyArray<Record<string, unknown>>;
        const warning = warnings.find((entry) => entry["kind"] === "would_invalidate");
        expect(warning?.["path"]).toEqual(["auth", "sms", "twilio"]);
        expect(warning?.["missing_fields"]).toEqual([
          { path: ["auth", "sms", "twilio", "message_service_sid"] },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "fixpoint-only case: a gated non-secret sibling absorbed in round 2 lands in the SAME body/payload with warnings applied (auth.captcha, dual_scope)",
    () => {
      const before =
        'project_id = "test"\n[auth.captcha]\nenabled = false\nprovider = "hcaptcha"\n';
      const { layer, out } = setup({
        toml: before,
        format: "json",
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            attributes: (attributes) => ({
              ...attributes,
              auth: {
                ...(attributes["auth"] as Record<string, unknown>),
                security_captcha_enabled: true,
                security_captcha_provider: "turnstile",
              },
            }),
          }),
        },
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const after = readFileSync(configPath(), "utf8");
        expect(after).toContain("enabled = true");
        expect(after).toContain('provider = "turnstile"');

        const success = out.messages.find((message) => message.type === "success");
        const data = success?.data as Record<string, unknown>;
        const changes = data["changes"] as ReadonlyArray<Record<string, unknown>>;
        const providerChange = changes.find(
          (change) =>
            (change["path"] as ReadonlyArray<string>).join(".") === "auth.captcha.provider",
        );
        expect(providerChange?.["written"]).toBe(true);
        expect(data["warnings"]).toEqual(
          expect.arrayContaining([{ kind: "dual_scope", path: ["auth", "captcha", "provider"] }]),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a numeric env() value resolvable only via the project's supabase/.env validates and writes normally, nothing dropped (review T0)",
    () => {
      // PULL_TEST_NUMERIC_ENV resolves only through the project's own supabase/.env, never
      // process.env, so this exercises the validation gate's own env(...) resolution path.
      const before =
        'project_id = "test"\n[api]\nmax_rows = "env(PULL_TEST_NUMERIC_ENV)"\nschemas = ["public"]\n';
      const { layer, out } = setup({
        toml: before,
        dotenv: "PULL_TEST_NUMERIC_ENV=1000\n",
        yes: true,
      });
      return Effect.gen(function* () {
        yield* configPull(noFlags);
        const after = readFileSync(configPath(), "utf8");
        expect(after).toContain('max_rows = "env(PULL_TEST_NUMERIC_ENV)"');
        expect(after).toContain("graphql_public");
        expect(out.stdoutText).not.toContain("would_invalidate");
        expect(out.stdoutText).not.toContain("requires values pull cannot write");
        expect(out.stdoutText).toContain("1 change written.");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "a pre-write decode failure at a path unrelated to the plan is exempted: pull still writes its planned change and exits 0 (review T0)",
    () => {
      // runConfigPull is called directly with a hand-augmented source.loaded.rawDocument/.text:
      // the real loader aborts the whole command on a root-level business-rule violation, so a
      // broken [auth.sms.twilio] is never reachable past openConfigPullSource's initial load.
      // Constructing the source directly is the only way to exercise the validation gate's own
      // pre-existing exemption for a failure the load path would already have caught.
      const before = 'project_id = "test"\n[api]\nmax_rows = 500\n';
      const { layer, out } = setup({ toml: before, yes: true });
      return Effect.gen(function* () {
        const source = yield* openConfigPullSource();
        const brokenRawDocument = {
          ...source.loaded.rawDocument,
          auth: { sms: { twilio: { enabled: true, account_sid: "", message_service_sid: "" } } },
        };
        const brokenText =
          `${source.text}[auth.sms.twilio]\n` +
          "enabled = true\n" +
          'account_sid = ""\n' +
          'message_service_sid = ""\n';
        writeFileSync(configPath(), brokenText);
        const brokenSource: ConfigPullSource = {
          loaded: { ...source.loaded, rawDocument: brokenRawDocument },
          text: brokenText,
        };
        yield* runConfigPull({
          target: { ref: VALID_REF, branch: undefined },
          remoteLabel: undefined,
          dryRun: false,
          force: false,
          yes: true,
          source: brokenSource,
        });
        const after = readFileSync(configPath(), "utf8");
        expect(after).toContain("max_rows = 1000");
        // The pre-existing, unrelated twilio state is left exactly as it was; pull never
        // attributes it to this run's own plan.
        expect(after).toContain("[auth.sms.twilio]");
        expect(after).toContain("enabled = true");
        expect(out.stdoutText).not.toContain("would_invalidate");
        expect(out.stdoutText).toContain("1 change written.");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "remote-destination pull: a written value that only violates a business rule once the block is SELECTED gets its family dropped, even though the raw/unmerged document decodes fine on its own (review T1)",
    () => {
      const MERGE_CHECK_REF = "eeeeeeeeeeeeeeeeeeee";
      const before = [
        'project_id = "test"',
        "[remotes.staging]",
        `project_id = "${MERGE_CHECK_REF}"`,
        "[remotes.staging.auth.sms.twilio]",
        "enabled = false",
        'account_sid = ""',
        'message_service_sid = ""',
        'auth_token = "env(PULL_TEST_MERGE_TWILIO_AUTH_TOKEN)"',
        "",
      ].join("\n");
      const { layer, out } = setup({
        toml: before,
        yes: true,
        v2: {
          status: 200,
          body: v2Response({
            ref: MERGE_CHECK_REF,
            attributes: (attributes) => ({
              ...attributes,
              auth: {
                ...(attributes["auth"] as Record<string, unknown>),
                sms_provider: "twilio",
                sms_twilio_account_sid: "ACreal0000000000000000000000000",
                // sms_twilio_message_service_sid is deliberately absent: writing
                // enabled/account_sid alone into [remotes.staging.*] decodes fine raw (remotes
                // skip business-rule checks), but fails once this block is selected and merged
                // over root — the same projection a future config pull/push targeting this ref
                // would use.
              },
            }),
          }),
        },
      });
      return Effect.gen(function* () {
        yield* configPull({ ...noFlags, projectRef: Option.some(MERGE_CHECK_REF) });
        const after = readFileSync(configPath(), "utf8");
        expect(after).toContain("[remotes.staging.auth.sms.twilio]");
        expect(after).toContain("enabled = false");
        expect(after).not.toContain("ACreal0000000000000000000000000");
        expect(out.stdoutText).toContain(
          "auth.sms.twilio.enabled [update, skip: requires values pull cannot write]",
        );
        expect(out.stdoutText).toContain(
          "auth.sms.twilio.account_sid [update, skip: requires values pull cannot write]",
        );
        expect(out.stdoutText).toContain("auth.sms.twilio was not changed: it requires");
        expect(out.stdoutText).toContain("auth.sms.twilio.message_service_sid");
      }).pipe(Effect.provide(layer));
    },
  );
});
