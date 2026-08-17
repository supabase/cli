import type { V1CreateABranchOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { errorEntitlement } from "../../../../shared/api/plan-gate.ts";
import { Command } from "effect/unstable/cli";

import {
  mockAnalytics,
  mockOutput,
  mockStdin,
  mockTty,
} from "../../../../../tests/helpers/mocks.ts";
import { LEGACY_GLOBAL_FLAGS, LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyBranchesCreateCommand, type LegacyBranchesCreateFlags } from "./create.command.ts";
import { legacyBranchesCreate } from "./create.handler.ts";
import { classifyCliCauseActionability } from "../../../../shared/telemetry/error-actionability.ts";

type CreatedBranch = typeof V1CreateABranchOutput.Type;

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
    id: LEGACY_VALID_REF,
    ref: LEGACY_VALID_REF,
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

const tempRoot = useLegacyTempWorkdir("supabase-branches-create-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly response?: CreatedBranch;
  readonly status?: number;
  readonly network?: "fail";
  readonly gated?: boolean;
  readonly featureKey?: string;
  /** Resolved `--yes`/`SUPABASE_YES` for the git-branch auto-name confirm. */
  readonly yes?: boolean;
  readonly stdinIsTty?: boolean;
  /** Piped stdin lines consumed by the non-TTY confirm read. */
  readonly stdinInput?: string;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
}

function buildApiLayer(opts: SetupOpts) {
  const status = opts.status ?? 201;
  const body = opts.response ?? CREATED;
  const featureKey = opts.featureKey ?? "branching_limit";
  return mockLegacyPlatformApi({
    network: opts.network,
    handler: (request) =>
      Effect.sync(() => {
        if (request.method === "POST" && request.url.includes("/branches")) {
          return legacyJsonResponse(request, status, body);
        }
        if (request.method === "GET" && request.url.endsWith(`/v1/projects/${LEGACY_VALID_REF}`)) {
          return legacyJsonResponse(request, 200, projectResponse());
        }
        if (request.method === "GET" && request.url.includes("/entitlements")) {
          return legacyJsonResponse(
            request,
            200,
            entitlementResponse({ featureKey, hasAccess: !(opts.gated ?? false) }),
          );
        }
        return legacyJsonResponse(request, 200, null);
      }),
  });
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.promptConfirmResponses,
  });
  const analytics = mockAnalytics();
  const api = buildApiLayer(opts);
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      analytics,
      tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
      stdin: mockStdin(opts.stdinIsTty ?? false, opts.stdinInput),
      goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
  );
  return { layer, out, api, analytics };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const analytics = mockAnalytics();
  const api = buildApiLayer(opts);
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      analytics,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
  );
  return { layer, out, api, telemetry, cache, analytics };
}

const baseFlags: LegacyBranchesCreateFlags = {
  name: Option.none(),
  projectRef: Option.none(),
  region: Option.none(),
  size: Option.none(),
  persistent: Option.none(),
  withData: Option.none(),
  notifyUrl: Option.none(),
  gitBranch: Option.none(),
};

describe("legacy branches create integration", () => {
  it.live("creates a branch with explicit name and prints text-mode header + table", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      expect(out.stdoutText).toContain("Created preview branch:");
      expect(out.stdoutText).toContain("feat-x");
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/branches`);
      expect(api.requests[0]?.body).toMatchObject({
        branch_name: "feat-x",
        is_default: false,
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("includes optional flags in the request body only when set", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({
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
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards an explicit --git-branch in the request body", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({
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

  it.live("reports a missing name before contacting the API outside a git repository", () => {
    const previousHead = process.env["GITHUB_HEAD_REF"];
    delete process.env["GITHUB_HEAD_REF"];
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const exit = yield* legacyBranchesCreate(baseFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyBranchesBranchNameEmptyError");
        expect(classifyCliCauseActionability(exit.cause)).toMatchObject({
          error_kind: "user_actionable",
          error_category: "invalid_input",
          suggestion_type: "provide_flags",
        });
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousHead === undefined) delete process.env["GITHUB_HEAD_REF"];
          else process.env["GITHUB_HEAD_REF"] = previousHead;
        }),
      ),
      Effect.provide(layer),
    );
  });

  // ---------------------------------------------------------------------------
  // Git-branch auto-name confirmation — Go `create.go:17-28` routes it through
  // `PromptYesNo(title, true)` (`console.go:64-82`). `GITHUB_HEAD_REF` drives
  // `detectGitBranch` deterministically (its highest-priority source).
  // ---------------------------------------------------------------------------

  const withGitBranch = <A, E, R>(effect: Effect.Effect<A, E, R>, branch = "feat-y") => {
    const prevHead = process.env["GITHUB_HEAD_REF"];
    process.env["GITHUB_HEAD_REF"] = branch;
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prevHead === undefined) delete process.env["GITHUB_HEAD_REF"];
          else process.env["GITHUB_HEAD_REF"] = prevHead;
        }),
      ),
    );
  };

  it.live("--yes auto-confirms the git-branch name with the [Y/n] y echo", () => {
    const { layer, out, api } = setup({ yes: true, stdinIsTty: true });
    return withGitBranch(
      Effect.gen(function* () {
        yield* legacyBranchesCreate(baseFlags);
        // Established behavior: the `--yes` branch echoes `<title> [Y/n] y`
        // to stderr instead of blocking the TTY prompt.
        expect(out.stderrText).toContain("Do you want to create a branch named ");
        expect(out.stderrText).toContain("? [Y/n] y\n");
        expect(api.requests[0]?.body).toMatchObject({
          branch_name: "feat-y",
          git_branch: "feat-y",
        });
      }).pipe(Effect.provide(layer)),
    );
  });

  it.live("SUPABASE_YES=1 auto-confirms the git-branch name like --yes", () => {
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    const { layer, out, api } = setup({ stdinIsTty: true });
    return withGitBranch(
      Effect.gen(function* () {
        yield* legacyBranchesCreate(baseFlags);
        expect(out.stderrText).toContain("? [Y/n] y\n");
        expect(api.requests[0]?.body).toMatchObject({ branch_name: "feat-y" });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env["SUPABASE_YES"];
            else process.env["SUPABASE_YES"] = prev;
          }),
        ),
        Effect.provide(layer),
      ),
    );
  });

  it.live("non-TTY with piped `n` declines the git-branch name like Go", () => {
    const { layer, out, api } = setup({ stdinIsTty: false, stdinInput: "n\n" });
    return withGitBranch(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyBranchesCreate(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyBranchesCreateCancelledError");
        }
        // The piped answer is echoed to stderr, matching the non-TTY prompt.
        expect(out.stderrText).toContain("? [Y/n] n\n");
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.live("non-TTY with empty stdin takes the Yes default and creates the branch", () => {
    const { layer, out, api } = setup({ stdinIsTty: false });
    return withGitBranch(
      Effect.gen(function* () {
        yield* legacyBranchesCreate(baseFlags);
        // Label printed, empty scan echoed, true default wins (`console.go:64-102`).
        expect(out.stderrText).toContain("? [Y/n] \n");
        expect(api.requests[0]?.body).toMatchObject({ branch_name: "feat-y" });
      }).pipe(Effect.provide(layer)),
    );
  });

  it.live("TTY decline of the git-branch name cancels without creating", () => {
    const { layer, api } = setup({ stdinIsTty: true, promptConfirmResponses: [false] });
    return withGitBranch(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyBranchesCreate(baseFlags));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyBranchesCreateCancelledError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.live("emits a success event for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ name: "feat-x" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact indented JSON for --output json", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      expect(out.stdoutText).toContain("Created preview branch:");
      expect(out.stdoutText).toContain('"name": "feat-x"');
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesCreateNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesCreateNetworkError");
        expect(json).toContain("failed to create preview branch");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBranchesCreateUnexpectedStatusError on non-201", () => {
    const { layer } = setup({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBranchesCreateUnexpectedStatusError");
        expect(json).toContain("unexpected create branch status 500");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fires cli_upgrade_suggested with feature_key=branching_limit on 402 gated", () => {
    const { layer, analytics } = setup({ status: 402, gated: true });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }));
      expect(analytics.captured).toEqual([
        {
          event: "cli_upgrade_suggested",
          properties: { feature_key: "branching_limit", org_slug: ORG_SLUG },
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "envelope on 402 carries entitlement and fires central telemetry with no extra API calls",
    () => {
      const { layer, out, analytics, api } = setup({
        status: 402,
        response: {
          message: "Branching is supported only on the Pro plan or above",
          error: {
            code: "entitlement_required",
            feature: "branching_limit",
            upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
          },
        } as unknown as CreatedBranch,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(errorEntitlement(Option.getOrUndefined(Exit.findErrorOption(exit)))).toEqual({
          feature: "branching_limit",
          upgrade_url: "https://supabase.com/dashboard/org/env-org/billing",
        });
        expect(api.requests).toHaveLength(1);
        expect(api.requests[0]?.url).toContain("/branches");
        expect(out.stderrText).not.toContain("Upgrade your plan:");
        expect(analytics.captured).toEqual([
          {
            event: "cli_upgrade_suggested",
            properties: { feature_key: "branching_limit", org_slug: "env-org" },
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("does NOT fire upgrade suggested on 500 (Go skips 5xx)", () => {
    const { layer, analytics } = setup({ status: 500 });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }));
      expect(analytics.captured).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache and telemetry state on success", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry on the upgrade-suggest failure path", () => {
    const { layer, telemetry, cache } = setupTracked({ status: 402, gated: true });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyBranchesCreate({ ...baseFlags, name: Option.some("feat-x") }));
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  // The established --size enum is an 18-value list that does not include
  // "nano" (or "pico") and rejects any other value at flag-parse time. TS
  // previously listed "nano" as a valid choice, silently succeeding where
  // it should error.
  it.live("rejects --size nano at flag-parse time, matching Go's 18-value enum", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([legacyBranchesCreateCommand]),
      Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Command.runWith(root, { version: "0.0.0-test" })(["create", "--size", "nano"]),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(rejectsInvalidSizeChoice(Cause.squash(exit.cause))).toBe(true);
      }
    }) as Effect.Effect<void>;
  });
});

// Distinguishes "the --size flag itself was rejected at parse time" from any
// other failure (e.g. a missing runtime service in this minimal test setup),
// so the regression test above can't pass for the wrong reason.
function rejectsInvalidSizeChoice(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errors" in error)) return false;
  const { errors } = error;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (candidate: unknown) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "_tag" in candidate &&
      candidate._tag === "InvalidValue" &&
      "option" in candidate &&
      candidate.option === "size",
  );
}
