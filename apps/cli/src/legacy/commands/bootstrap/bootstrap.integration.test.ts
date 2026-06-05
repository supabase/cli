import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Schedule } from "effect";

import {
  mockAnalytics,
  mockBrowser,
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import {
  type LegacyApiHandler,
  LEGACY_VALID_REF,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyCredentialsTracked,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyLoginApi,
  mockLegacyLoginCrypto,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyDebugFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
  LegacyOutputFlag,
} from "../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import { LegacyTemplateService, type LegacyStarterTemplate } from "./bootstrap.templates.ts";
import { legacyBootstrap } from "./bootstrap.handler.ts";
import type { LegacyBootstrapFlags } from "./bootstrap.command.ts";

const FAST_BACKOFF = Schedule.exponential("1 milli");

const CREATED = {
  id: LEGACY_VALID_REF,
  ref: LEGACY_VALID_REF,
  organization_id: "org-1",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  created_at: "2026-01-01T00:00:00Z",
  status: "COMING_UP",
};

const ORGS = [{ id: "org-1", slug: "acme", name: "Acme Inc" }];

const API_KEYS = [
  { name: "anon", api_key: "anon-key" },
  { name: "service_role", api_key: "svc-key" },
];

const HEALTHY = [{ name: "db", healthy: true, status: "ACTIVE_HEALTHY" }];

const tempRoot = useLegacyTempWorkdir("supabase-bootstrap-int-");

const NEXTJS_TEMPLATE: LegacyStarterTemplate = {
  name: "nextjs",
  description: "Next.js starter.",
  url: "https://github.com/supabase/supabase/tree/master/examples/nextjs",
  start: "npm ci && npm run dev",
};

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly workdir?: Option.Option<string>;
  readonly yes?: boolean;
  readonly stdinIsTty?: boolean;
  readonly loggedIn?: boolean;
  readonly debug?: boolean;
  readonly samples?: ReadonlyArray<LegacyStarterTemplate>;
  readonly apiKeysFailTimes?: number;
  readonly health?: { readonly status: number; readonly body: unknown };
  readonly promptTextResponses?: ReadonlyArray<string>;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptTextResponses: opts.promptTextResponses,
    promptConfirmResponses: opts.promptConfirmResponses,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedCache = mockLegacyLinkedProjectCacheTracked();
  const analytics = mockAnalytics();
  const credentials = mockLegacyCredentialsTracked();

  let apiKeysCalls = 0;
  const handler: LegacyApiHandler = (request, recorded) => {
    const url = recorded.urlWithParams;
    if (recorded.method === "POST" && /\/v1\/projects(\?|$)/.test(url)) {
      return Effect.succeed(legacyJsonResponse(request, 201, CREATED));
    }
    if (url.includes("/api-keys")) {
      apiKeysCalls += 1;
      // 403 (not 5xx) so the api client's internal 5xx retry does not absorb it,
      // forcing the bootstrap-level backoff to drive the retry.
      if (apiKeysCalls <= (opts.apiKeysFailTimes ?? 0)) {
        return Effect.succeed(legacyJsonResponse(request, 403, { message: "not ready" }));
      }
      return Effect.succeed(legacyJsonResponse(request, 200, API_KEYS));
    }
    if (url.includes("/health")) {
      const health = opts.health ?? { status: 200, body: HEALTHY };
      return Effect.succeed(legacyJsonResponse(request, health.status, health.body));
    }
    if (url.includes("/v1/organizations")) {
      return Effect.succeed(legacyJsonResponse(request, 200, ORGS));
    }
    // storage/pooler config + tenant version probes — best-effort, ignored.
    return Effect.succeed(legacyJsonResponse(request, 404, {}));
  };
  const api = mockLegacyPlatformApi({ handler });

  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    projectHost: "supabase.co",
    accessToken: opts.loggedIn === false ? Option.none() : undefined,
  });

  const samples = opts.samples ?? [];
  const downloads: Array<{ url: string; targetDir: string }> = [];
  const templateLayer = Layer.succeed(LegacyTemplateService, {
    listSamples: Effect.succeed(samples),
    download: (url: string, targetDir: string) =>
      Effect.sync(() => {
        downloads.push({ url, targetDir });
      }),
  });

  const proxyCalls: Array<ReadonlyArray<string>> = [];
  const proxyLayer = Layer.succeed(LegacyGoProxy, {
    exec: (args: ReadonlyArray<string>) =>
      Effect.sync(() => {
        proxyCalls.push(args);
      }),
  });

  const loginApi = mockLegacyLoginApi({ gotrueId: "gotrue-user" });
  const loginCrypto = mockLegacyLoginCrypto();

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    api.layer,
    api.httpClientLayer,
    cliConfig,
    mockTty({ stdinIsTty: opts.stdinIsTty ?? true, stdoutIsTty: false }),
    // cwd differs from the (absolute) workdir so the "Using workdir" line prints,
    // matching Go's `cwd != CurrentDirAbs` guard.
    mockRuntimeInfo({ cwd: dirname(tempRoot.current) }),
    telemetry.layer,
    linkedCache.layer,
    analytics.layer,
    credentials.layer,
    templateLayer,
    proxyLayer,
    loginApi.layer,
    loginCrypto.layer,
    mockBrowser(),
    mockStdin(opts.stdinIsTty ?? true),
    Layer.succeed(LegacyOutputFlag, Option.none()),
    Layer.succeed(LegacyWorkdirFlag, opts.workdir ?? Option.some(tempRoot.current)),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyDebugFlag, opts.debug ?? false),
  );

  return {
    layer,
    out,
    telemetry,
    linkedCache,
    analytics,
    credentials,
    api,
    workdir: tempRoot.current,
    downloads,
    proxyCalls,
    loginApi,
    get apiKeysCalls() {
      return apiKeysCalls;
    },
  };
}

function flags(overrides: Partial<LegacyBootstrapFlags> = {}): LegacyBootstrapFlags {
  return {
    template: Option.none(),
    password: Option.some("s3cret"),
    ...overrides,
  };
}

describe("legacy bootstrap integration", () => {
  it.live("bootstraps the scratch template into the workdir (blank init, logged in)", () => {
    const s = setup();
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      // Blank init scaffolded config.toml.
      expect(existsSync(join(s.workdir, "supabase", "config.toml"))).toBe(true);
      // Project ref written for the delegated db push.
      expect(readFileSync(join(s.workdir, "supabase", ".temp", "project-ref"), "utf8")).toBe(
        LEGACY_VALID_REF,
      );
      // .env populated with derived keys.
      const env = readFileSync(join(s.workdir, ".env"), "utf8");
      expect(env).toContain('SUPABASE_ANON_KEY="anon-key"');
      expect(env).toContain("SUPABASE_URL=");
      expect(env).toContain("POSTGRES_URL=");
      // Progress + create echo on stderr.
      expect(s.out.stderrText).toContain("Using workdir");
      expect(s.out.stderrText).toContain("Created a new project at");
      expect(s.out.stderrText).toContain("To start your app:");
    }).pipe(Effect.provide(s.layer));
  });

  it.live("downloads a named template matched by argument", () => {
    const s = setup({ samples: [NEXTJS_TEMPLATE] });
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("NextJS") }), FAST_BACKOFF);
      expect(s.downloads).toHaveLength(1);
      expect(s.downloads[0]).toEqual({ url: NEXTJS_TEMPLATE.url, targetDir: s.workdir });
      // No blank config.toml when a template is downloaded.
      expect(existsSync(join(s.workdir, "supabase", "config.toml"))).toBe(false);
      expect(s.out.stdoutText).toContain(`Downloading: ${NEXTJS_TEMPLATE.url}`);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("rejects an unknown template argument", () => {
    const s = setup({ samples: [NEXTJS_TEMPLATE] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBootstrap(flags({ template: Option.some("nope") }), FAST_BACKOFF),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyBootstrapInvalidTemplateError");
        expect(json).toContain("Invalid template: nope");
      }
    }).pipe(Effect.provide(s.layer));
  });

  it.live("prompts for a template when none is given", () => {
    const s = setup({ samples: [NEXTJS_TEMPLATE] });
    return Effect.gen(function* () {
      // Default mock promptSelect picks the first option (the nextjs template).
      yield* legacyBootstrap(flags(), FAST_BACKOFF);
      expect(s.out.promptSelectCalls[0]?.message).toBe(
        "Which starter template do you want to use?",
      );
      expect(s.downloads).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("prompts for a workdir when none is configured", () => {
    const s = setup({
      workdir: Option.none(),
      promptTextResponses: [tempRoot.current],
    });
    const prevWorkdir = process.env["SUPABASE_WORKDIR"];
    delete process.env["SUPABASE_WORKDIR"];
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      expect(existsSync(join(s.workdir, "supabase", "config.toml"))).toBe(true);
    }).pipe(
      Effect.provide(s.layer),
      Effect.ensuring(
        Effect.sync(() => {
          if (prevWorkdir !== undefined) process.env["SUPABASE_WORKDIR"] = prevWorkdir;
        }),
      ),
    );
  });

  it.live("aborts when the user declines to overwrite a non-empty workdir", () => {
    const s = setup({ promptConfirmResponses: [false] });
    writeFileSync(join(tempRoot.current, "existing.txt"), "keep me");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyBootstrapOverwriteDeclinedError");
      }
    }).pipe(Effect.provide(s.layer));
  });

  it.live("proceeds past a non-empty workdir with --yes", () => {
    const s = setup({ yes: true });
    writeFileSync(join(tempRoot.current, "existing.txt"), "keep me");
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      expect(existsSync(join(s.workdir, "supabase", "config.toml"))).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("runs the browser login flow when no token is present (one cli_login_completed)", () => {
    const s = setup({ loggedIn: false });
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      expect(s.credentials.savedToken).toBeDefined();
      expect(
        s.analytics.captured.map((c) => c.event).filter((e) => e === "cli_login_completed"),
      ).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.live(
    "skips login when already authenticated (no login event, no project-linked event)",
    () => {
      const s = setup({ loggedIn: true });
      return Effect.gen(function* () {
        yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
        const events = s.analytics.captured.map((c) => c.event);
        expect(events).not.toContain("cli_login_completed");
        // Go's bootstrap calls link.LinkServices (not link.Run) — no cli_project_linked.
        expect(events).not.toContain("cli_project_linked");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.live("retries fetching api keys until they are available", () => {
    const s = setup({ apiKeysFailTimes: 2 });
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      expect(s.apiKeysCalls).toBe(3);
      const linkingLines = s.out.stderrText.match(/Linking project\.\.\./g) ?? [];
      expect(linkingLines.length).toBeGreaterThanOrEqual(3);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("fails when a service stays unhealthy", () => {
    const s = setup({
      health: { status: 200, body: [{ name: "db", healthy: false, status: "UNHEALTHY" }] },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("Service not healthy: db (UNHEALTHY)");
      }
    }).pipe(Effect.provide(s.layer));
  });

  it.live("fails with an Error status when the health endpoint returns non-200", () => {
    const s = setup({ health: { status: 503, body: { message: "down" } } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("Error status 503");
      }
    }).pipe(Effect.provide(s.layer));
  });

  it.live("merges .env.example derived keys", () => {
    const s = setup();
    mkdirSync(tempRoot.current, { recursive: true });
    writeFileSync(
      join(tempRoot.current, ".env.example"),
      "POSTGRES_USER=example\nNEXT_PUBLIC_SUPABASE_ANON_KEY=example\n",
    );
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      const env = readFileSync(join(s.workdir, ".env"), "utf8");
      expect(env).toContain('POSTGRES_USER="postgres"');
      expect(env).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY="anon-key"');
    }).pipe(Effect.provide(s.layer));
  });

  it.live("continues (non-fatal) when the .env.example is malformed", () => {
    const s = setup();
    mkdirSync(tempRoot.current, { recursive: true });
    writeFileSync(join(tempRoot.current, ".env.example"), "!=");
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      expect(s.out.stderrText).toContain("Failed to create .env file:");
      // Bootstrap still completes through the db push step.
      expect(s.proxyCalls).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("delegates the db push step to the Go proxy with the resolved password", () => {
    const s = setup();
    return Effect.gen(function* () {
      yield* legacyBootstrap(
        flags({ template: Option.some("scratch"), password: Option.some("pw123") }),
        FAST_BACKOFF,
      );
      expect(s.proxyCalls).toHaveLength(1);
      expect(s.proxyCalls[0]).toEqual([
        "db",
        "push",
        "--include-roles",
        "--include-seed",
        "--password",
        "pw123",
      ]);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("flushes telemetry and caches the linked project via ensuring", () => {
    const s = setup();
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      expect(s.telemetry.flushed).toBe(true);
      expect(s.linkedCache.cached).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("emits a single structured result in json mode", () => {
    const s = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      const successes = s.out.messages.filter((m) => m.type === "success");
      expect(successes).toHaveLength(1);
      expect(successes[0]?.data).toMatchObject({
        project_ref: LEGACY_VALID_REF,
        template: "scratch",
        start_command: "supabase start",
        workdir: s.workdir,
      });
      // No human progress banners on stdout in json mode.
      expect(s.out.stdoutText).not.toContain("To start your app:");
    }).pipe(Effect.provide(s.layer));
  });

  it.live("reports env_file: null in the json result when the .env write fails", () => {
    const s = setup({ format: "json" });
    mkdirSync(tempRoot.current, { recursive: true });
    writeFileSync(join(tempRoot.current, ".env.example"), "!=");
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ env_file: null });
    }).pipe(Effect.provide(s.layer));
  });
});
