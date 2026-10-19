import type { V1CreateABranchOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";
import { CliError, CliOutput, Command } from "effect/cli";

import {
  mockAnalytics,
  mockOutput,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { GLOBAL_FLAGS, YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  type MockCommandPlatformApiOpts,
  useTempWorkdir,
  withConfigEnv,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import { branchesCreateCommand, type BranchesCreateFlags } from "./create.command.ts";
import { branchesCreate } from "./create.handler.ts";
import { classifyCliCauseActionability } from "../../../shared/telemetry/error-actionability.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";

type CreatedBranch = typeof V1CreateABranchOutput.Type;

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const CREATED: CreatedBranch = {
  id: "11111111-2222-4333-8444-555555555555",
  name: "feat-x",
  project_ref: "aaaaaaaaaaaaaaaaaaaa",
  parent_project_ref: "bbbbbbbbbbbbbbbbbbbb",
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
};

const ORG_SLUG = "test-org";

function projectResponse() {
  return {
    id: VALID_REF,
    ref: VALID_REF,
    organization_id: "org",
    organization_slug: ORG_SLUG,
    name: "Test",
    region: "us-east-1",
    created_at: "2026-01-01T00:00:00Z",
    status: "ACTIVE_HEALTHY",
    database: { host: "h", version: "15", postgres_engine: "15", release_channel: "ga" },
  };
}

function entitlementResponse(opts: { readonly featureKey: string; readonly hasAccess: boolean }) {
  return {
    entitlements: [
      {
        feature: { key: opts.featureKey, type: "boolean" as const },
        hasAccess: opts.hasAccess,
        type: "boolean" as const,
        config: { enabled: !opts.hasAccess },
      },
    ],
  };
}

const tempRoot = useTempWorkdir("supabase-branches-create-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: unknown;
  readonly status?: number;
  readonly network?: "fail";
  readonly gated?: boolean;
  readonly featureKey?: string;
  readonly yes?: boolean;
  readonly stdinIsTty?: boolean;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
}

const hostedCreatePolicy = Layer.succeed(TargetPolicy, { group: "hosted", consent: "yes" });

function apiOptions(opts: SetupOpts): MockCommandPlatformApiOpts {
  const status = opts.status ?? 201;
  const body = opts.response ?? CREATED;
  const featureKey = opts.featureKey ?? "branching_limit";
  return {
    network: opts.network,
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "POST" && request.url.includes("/branches")) {
          return jsonResponse(request, status, body);
        }
        if (request.method === "GET" && request.url.endsWith(`/v1/projects/${VALID_REF}`)) {
          return jsonResponse(request, 200, projectResponse());
        }
        if (request.method === "GET" && request.url.includes("/entitlements")) {
          return jsonResponse(
            request,
            200,
            entitlementResponse({ featureKey, hasAccess: !(opts.gated ?? false) }),
          );
        }
        return jsonResponse(request, 200, null);
      }),
  };
}

function buildApiLayer(opts: SetupOpts) {
  return mockCommandPlatformApi(apiOptions(opts));
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.promptConfirmResponses,
  });
  const analytics = mockAnalytics();
  const api = buildApiLayer(opts);
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings,
      analytics,
      tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
      stdin: mockStdin(opts.stdinIsTty ?? false),
      outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
    }),
    Layer.succeed(YesFlag, opts.yes ?? true),
    hostedCreatePolicy,
  );
  return { layer, out, api, analytics };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const api = buildApiLayer(opts);
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings,
      analytics,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    }),
    Layer.succeed(YesFlag, opts.yes ?? true),
    hostedCreatePolicy,
  );
  return { layer, out, api, telemetry, cache, analytics };
}

const baseFlags: BranchesCreateFlags = {
  name: Option.none(),
  remote: Option.none(),
  projectRef: Option.none(),
  region: Option.none(),
  size: Option.none(),
  persistent: Option.none(),
  withData: Option.none(),
  notifyUrl: Option.none(),
  gitBranch: Option.none(),
};

describe("branches create integration", () => {
  it.effect("creates a branch with explicit name and prints text-mode header + table", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* branchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      expect(out.stdoutText).toContain("Created preview branch:");
      expect(out.stdoutText).toContain("feat-x");
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/branches`);
      expect(api.requests[0]?.body).toMatchObject({
        branch_name: "feat-x",
        is_default: false,
      });
      assertPermissionDrift({ command: "branches create", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "lists projects for the picker, creates the branch, then fills the linked-project cache",
    () => {
      const out = mockOutput({ format: "text", promptSelectResponses: [VALID_REF] });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          if (request.method === "POST") {
            return Effect.succeed(jsonResponse(request, 201, CREATED));
          }
          return Effect.succeed(
            jsonResponse(
              request,
              200,
              request.url === "https://api.supabase.com/v1/projects"
                ? [projectResponse()]
                : projectResponse(),
            ),
          );
        },
      });
      const cliSettings = mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings,
          tty: mockTty({ stdinIsTty: true }),
          linkedProjectCache: realLinkedProjectCache({
            httpClient: api.httpClientLayer,
            cliSettings,
          }),
        }),
        Layer.succeed(YesFlag, true),
        hostedCreatePolicy,
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
        expect(yield* fs.exists(cachePath)).toBe(false);
        yield* branchesCreate({ ...baseFlags, name: Option.some("feat-x") });
        expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          "GET https://api.supabase.com/v1/projects",
          `POST https://api.supabase.com/v1/projects/${VALID_REF}/branches`,
          `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
        ]);
        expect(out.stdoutText).toContain("Created preview branch:");
        expect(out.stdoutText).toContain("feat-x");
        expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
          ref: VALID_REF,
        });
        assertPermissionDrift({ command: "branches create", requests: api.requests, exact: true });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("includes optional flags in the request body only when set", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesCreate({
        ...baseFlags,
        name: Option.some("with-region"),
        region: Option.some("us-east-1"),
        persistent: Option.some(true),
        withData: Option.some(true),
        notifyUrl: Option.some("https://hook.example.com"),
      });
      expect(api.requests[0]?.body).toMatchObject({
        branch_name: "with-region",
        is_default: false,
        region: "us-east-1",
        persistent: true,
        with_data: true,
        notify_url: "https://hook.example.com",
      });
      assertPermissionDrift({
        command: "branches create",
        activeFlags: {
          region: true,
          persistent: true,
          "with-data": true,
          "notify-url": true,
        },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("forwards an explicit --git-branch in the request body", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* branchesCreate({
        ...baseFlags,
        name: Option.some("feat-x"),
        gitBranch: Option.some("feature/login-page"),
      });
      expect(api.requests[0]?.body).toMatchObject({
        branch_name: "feat-x",
        git_branch: "feature/login-page",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a missing name before contacting the API outside a git repository", () => {
    const { layer, api } = setup();
    return withConfigEnv(
      { GITHUB_HEAD_REF: "" },
      Effect.gen(function* () {
        const exit = yield* branchesCreate(baseFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("BranchesBranchNameEmptyError");
          expect(classifyCliCauseActionability(exit.cause)).toMatchObject({
            error_kind: "user_actionable",
            error_category: "invalid_input",
            suggestion_type: "provide_flags",
          });
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer)),
    );
  });

  // `GITHUB_HEAD_REF` drives `detectGitBranch` deterministically (its highest-priority source).
  const withGitBranch = <A, E, R>(effect: Effect.Effect<A, E, R>, branch = "feat-y") =>
    withConfigEnv({ GITHUB_HEAD_REF: branch }, effect);

  it.effect(
    "--yes names the branch after the current git branch and echoes the confirmation",
    () => {
      const { layer, out, api } = setup({ yes: true });
      return withGitBranch(
        Effect.gen(function* () {
          yield* branchesCreate(baseFlags);
          expect(out.stderrText).toContain("Confirmed by --yes: Create preview branch feat-y on ");
          expect(api.requests[0]?.body).toMatchObject({
            branch_name: "feat-y",
            git_branch: "feat-y",
          });
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.effect("asks once on a TTY and says the name came from the git branch", () => {
    const { layer, out, api } = setup({
      yes: false,
      stdinIsTty: true,
      promptConfirmResponses: [true],
    });
    return withGitBranch(
      Effect.gen(function* () {
        yield* branchesCreate(baseFlags);
        expect(out.promptConfirmCalls).toHaveLength(1);
        expect(out.promptConfirmCalls[0]?.message).toContain("Create preview branch feat-y");
        expect(out.stderrText).toContain("Branch name taken from the current git branch");
        expect(api.requests[0]?.body).toMatchObject({ branch_name: "feat-y" });
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect("emits a success event for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* branchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ name: "feat-x" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits byte-exact indented JSON for --output json", () => {
    const { layer, out } = setup({ outputFlag: "json" });
    return Effect.gen(function* () {
      yield* branchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      expect(out.stdoutText).toContain("Created preview branch:");
      expect(out.stdoutText).toContain('"name": "feat-x"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesCreateNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesCreate({ ...baseFlags, name: Option.some("feat-x") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesCreateNetworkError");
        expect(causeText).toContain("failed to create preview branch");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with BranchesCreateUnexpectedStatusError on non-201", () => {
    const { layer } = setup({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesCreate({ ...baseFlags, name: Option.some("feat-x") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BranchesCreateUnexpectedStatusError");
        expect(causeText).toContain("unexpected create branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fires cli_upgrade_suggested with feature_key=branching_limit on 402 gated", () => {
    const { layer, analytics, api } = setup({ status: 402, gated: true });
    return Effect.gen(function* () {
      yield* Effect.exit(branchesCreate({ ...baseFlags, name: Option.some("feat-x") }));
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `POST https://api.supabase.com/v1/projects/${VALID_REF}/branches`,
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
        `GET https://api.supabase.com/v1/organizations/${ORG_SLUG}/entitlements`,
      ]);
      assertPermissionDrift({ command: "branches create", requests: api.requests });
      expect(analytics.captured).toEqual([
        {
          event: "cli_upgrade_suggested",
          properties: { feature_key: "branching_limit", org_slug: ORG_SLUG },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("envelope on 402 suggests upgrade with no extra API calls", () => {
    const { layer, out, analytics, api } = setup({
      status: 402,
      response: {
        message: "Branching is supported only on the Pro plan or above",
        error: {
          code: "entitlement_required",
          feature: "branching_limit",
          upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
        },
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        branchesCreate({ ...baseFlags, name: Option.some("feat-x") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain("/branches");
      assertPermissionDrift({ command: "branches create", requests: api.requests, exact: true });
      expect(out.stderrText).toContain("/org/env-org/billing");
      expect(analytics.captured).toEqual([
        {
          event: "cli_upgrade_suggested",
          properties: { feature_key: "branching_limit", org_slug: "env-org" },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does NOT fire upgrade suggested on 500", () => {
    const { layer, analytics } = setup({ status: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(branchesCreate({ ...baseFlags, name: Option.some("feat-x") }));
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes linked-project cache and telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* branchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes linked-project cache + telemetry on the upgrade-suggest failure path", () => {
    const { layer, telemetry, cache } = setupTracked({ status: 402, gated: true });
    return Effect.gen(function* () {
      yield* Effect.exit(branchesCreate({ ...baseFlags, name: Option.some("feat-x") }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --size nano at flag-parse time", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([branchesCreateCommand]),
      Command.withGlobalFlags(GLOBAL_FLAGS),
    );

    const { layer } = setup();
    const commandLayer = Layer.mergeAll(
      layer,
      CliOutput.layer(textCliOutputFormatter()),
      mockTelemetryRuntime(),
    );

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        Command.runWith(root, { version: "0.0.0-test" })(["create", "--size", "nano"]),
      );
      expect(rejectsInvalidSizeChoice(error)).toBe(true);
    }).pipe(Effect.provide(commandLayer));
  });
});

// Distinguishes "the --size flag itself was rejected at parse time" from any other failure, so
// the test above can't pass for the wrong reason.
function rejectsInvalidSizeChoice(error: unknown): boolean {
  return (
    Schema.is(CliError.ShowHelp)(error) &&
    error.errors.some(
      (candidate) => Schema.is(CliError.InvalidValue)(candidate) && candidate.option === "size",
    )
  );
}

describeHostedConsent("branches create", {
  api: apiOptions({}),
  invoke: () => ({ run: branchesCreate({ ...baseFlags, name: Option.some("feat-x") }) }),
});
