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
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
  LegacyOutputFlag,
} from "../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { LegacyDbConnectError } from "../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../shared/legacy-db-connection.service.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { LegacyEdgeRuntimeScript } from "../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../shared/legacy-pgdelta-ssl-probe.service.ts";
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
  readonly pushConnectFailTimes?: number;
  /**
   * When `false`, the pooler-config route reports no PRIMARY pooler (Go's
   * `utils.GetPoolerConfig` returning nil) — `legacyLinkServicesCore`'s
   * best-effort `linkPooler` step then never writes `<workdir>/supabase/.temp/
   * pooler-url`, so `legacyResolveLinkedConn`'s push-connection resolution has
   * neither a reachable direct host nor a saved pooler URL to fall back to.
   */
  readonly poolerAvailable?: boolean;
  readonly health?: { readonly status: number; readonly body: unknown };
  readonly promptTextResponses?: ReadonlyArray<string>;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
  readonly promptPasswordResponses?: ReadonlyArray<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptTextResponses: opts.promptTextResponses,
    promptConfirmResponses: opts.promptConfirmResponses,
    promptPasswordResponses: opts.promptPasswordResponses,
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
    // Pooler config: the in-process test's direct db host is never reachable (no
    // real network), so `legacyResolveLinkedConn`'s push-connection resolution
    // always falls back to the IPv4 pooler — matching the real-world "common
    // case" this fallback exists for (CLI-1953). `legacyLinkServicesCore`'s own
    // `linkPooler` step (step I) fetches this same route and saves it to
    // `<workdir>/supabase/.temp/pooler-url`, which the fallback then reads.
    if (recorded.method === "GET" && url.includes("/config/database/pooler")) {
      if (opts.poolerAvailable === false) {
        // No PRIMARY entry — mirrors Go's `utils.GetPoolerConfig` returning nil.
        return Effect.succeed(legacyJsonResponse(request, 200, []));
      }
      return Effect.succeed(
        legacyJsonResponse(request, 200, [
          {
            identifier: "primary",
            database_type: "PRIMARY",
            is_using_scram_auth: true,
            db_user: "postgres",
            db_host: "db.example",
            db_port: 5432,
            db_name: "postgres",
            connection_string: `postgres://postgres.${CREATED.ref}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
            connectionString: `postgres://postgres.${CREATED.ref}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
            default_pool_size: null,
            max_client_conn: null,
            pool_mode: "transaction",
          },
        ]),
      );
    }
    // storage/tenant version probes — best-effort, ignored.
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

  // Native push (CLI-1953): the scratch/downloaded-template fixtures never scaffold
  // migrations/seed.sql/roles.sql, so `legacyDbPushCore` always reaches the "up to
  // date" short-circuit right after connecting — no query results or edge-runtime
  // invocation are needed beyond a successful connect.
  const pushConnectCalls: Array<LegacyPgConnInput> = [];
  const dbConnectionLayer = Layer.succeed(LegacyDbConnection, {
    connect: (conn: LegacyPgConnInput) =>
      Effect.suspend(() => {
        pushConnectCalls.push(conn);
        // Fails the first N connect attempts (retry coverage for the push step's
        // own `legacyBootstrapRetryNotify()` + `Effect.retry(retry)` wrap, CLI-1953)
        // before succeeding, mirroring `apiKeysFailTimes`'s pattern above.
        if (pushConnectCalls.length <= (opts.pushConnectFailTimes ?? 0)) {
          return Effect.fail(new LegacyDbConnectError({ message: "connection refused" }));
        }
        return Effect.succeed({
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
          exec: () => Effect.void,
          query: () => Effect.succeed([]),
        });
      }),
  });
  const edgeRuntimeLayer = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: () =>
      Effect.die("edge-runtime not needed: scratch/template fixtures never push migrations"),
  });
  const sslProbeLayer = Layer.succeed(LegacyPgDeltaSslProbe, {
    requireSsl: () => Effect.die("pg-delta ssl probe not needed for this test"),
    requireSslForHost: () => Effect.die("pg-delta ssl probe not needed for this test"),
  });

  const loginApi = mockLegacyLoginApi({ gotrueId: "gotrue-user" });
  const loginCrypto = mockLegacyLoginCrypto();

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    api.layer,
    api.factoryLayer,
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
    dbConnectionLayer,
    edgeRuntimeLayer,
    sslProbeLayer,
    loginApi.layer,
    loginCrypto.layer,
    mockBrowser(),
    mockStdin(opts.stdinIsTty ?? true),
    Layer.succeed(LegacyOutputFlag, Option.none()),
    Layer.succeed(LegacyWorkdirFlag, opts.workdir ?? Option.some(tempRoot.current)),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    Layer.succeed(LegacyDebugFlag, opts.debug ?? false),
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
    Layer.succeed(CliArgs, { args: [] }),
    legacyDebugLoggerLayer.pipe(Layer.provide(Layer.succeed(LegacyDebugFlag, opts.debug ?? false))),
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
    pushConnectCalls,
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
      // Go's PromptYesNo echoes the auto-accepted overwrite question to stderr
      // under the global YES flag (`bootstrap.go:47-48`, `console.go:70-72`).
      expect(s.out.stderrText).toContain("Do you want to overwrite existing files in ");
      expect(s.out.stderrText).toContain(" directory? [Y/n] y\n");
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

  it.live("retries the native push connection until it succeeds", () => {
    // Regression coverage: `legacyBootstrapRetryNotify()` + `Effect.retry(retry)`
    // wraps the push step the same way as the api-keys/health-poll retries above
    // (`bootstrap.go:122-127`'s `backoff.RetryNotify`). Deleting that wrap would
    // leave this test's second and third connect attempts unreached.
    const s = setup({ pushConnectFailTimes: 2, debug: true });
    return Effect.gen(function* () {
      yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
      expect(s.pushConnectCalls).toHaveLength(3);
      // Failures 1-2 go to the debug logger; the notice reaches stderr only from
      // the 3rd failure onward (`legacyBootstrapRetryNotify`'s `failureCount * 3 >
      // maxRetries` gate) — with only 2 failures here, this never fires, so assert
      // via `--debug` instead (`debug: true` above) that both attempts were logged.
      const retryLines = s.out.stderrText.match(/connection refused\nRetry \(\d\/8\): /g) ?? [];
      expect(retryLines.length).toBe(2);
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
      // Bootstrap still completes through the native db push step.
      expect(s.pushConnectCalls).toHaveLength(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.live(
    "pushes natively — falls back to the IPv4 pooler when the direct host is unreachable, no Go subprocess",
    () => {
      // The in-process test's direct db host is never reachable (no real network),
      // so `legacyResolveLinkedConn` transparently falls back to the IPv4 pooler
      // (CLI-1953) — exactly the real-world path new (IPv6-only) Supabase projects
      // take. `setup()`'s pooler-config mock feeds `legacyLinkServicesCore`'s saved
      // `<workdir>/supabase/.temp/pooler-url`, which this fallback reads.
      const s = setup();
      return Effect.gen(function* () {
        yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
        expect(s.pushConnectCalls).toHaveLength(1);
        expect(s.pushConnectCalls[0]?.host).toBe("aws-0-us-east-1.pooler.supabase.com");
        expect(s.pushConnectCalls[0]?.user).toBe(`postgres.${LEGACY_VALID_REF}`);
        expect(s.out.stderrText).toContain("Connecting to remote database...");
        expect(s.out.stdoutText).toContain("Remote database is up to date.");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.live(
    "falls back to the direct-host config and keeps retrying push when connection resolution itself fails",
    () => {
      // Regression coverage (review thread on CLI-1953): when the direct host is
      // unreachable AND no pooler URL was ever saved, `legacyResolveLinkedConn`
      // fails with `LegacyDbConfigIpv6Error`. Go's `NewDbConfigWithPassword`
      // (`db_url.go:161-163`) logs that same error and presses on with its
      // best-effort direct-host config, letting the retry-wrapped `push.Run`
      // (`bootstrap.go:115-127`) get real reconnect attempts instead of aborting
      // bootstrap outright. This asserts the native flow does the same instead of
      // failing before `legacyDbPushCore` ever runs.
      const s = setup({ poolerAvailable: false, pushConnectFailTimes: 1 });
      return Effect.gen(function* () {
        yield* legacyBootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF);
        expect(s.out.stderrText).toContain("IPv6 is not supported on your current network");
        // Falls back to the same direct-host shape as the `.env` config (step K),
        // not the pooler — and still reaches/retries the native push.
        expect(s.pushConnectCalls).toHaveLength(2);
        expect(s.pushConnectCalls[0]?.host).toBe(`db.${LEGACY_VALID_REF}.supabase.co`);
        expect(s.pushConnectCalls[0]?.port).toBe(5432);
        expect(s.pushConnectCalls[0]?.user).toBe("postgres");
        expect(s.pushConnectCalls[0]?.database).toBe("postgres");
        expect(s.pushConnectCalls[0]?.password).toBe("s3cret");
        expect(s.out.stdoutText).toContain("Remote database is up to date.");
      }).pipe(Effect.provide(s.layer));
    },
  );

  it.live("pushes with the flag-sourced password (used as the create password too)", () => {
    const s = setup();
    return Effect.gen(function* () {
      yield* legacyBootstrap(
        flags({ template: Option.some("scratch"), password: Option.some("pw123") }),
        FAST_BACKOFF,
      );
      expect(s.pushConnectCalls[0]?.password).toBe("pw123");
    }).pipe(Effect.provide(s.layer));
  });

  it.live("pushes with the prompted password when --password is empty", () => {
    // An explicit `--password ""` (e.g. unset `$SUPABASE_DB_PASSWORD` expanded by
    // the shell) leaves the password empty, so the create step prompts — and the
    // in-process push reuses that exact same resolved connection (Go's push step
    // always uses the create-resolved password; there is no separate flag/env
    // channel to preserve once the call is in-process, CLI-1953).
    const s = setup({ promptPasswordResponses: ["prompted-pw"] });
    const prev = process.env["SUPABASE_DB_PASSWORD"];
    delete process.env["SUPABASE_DB_PASSWORD"];
    return Effect.gen(function* () {
      yield* legacyBootstrap(
        flags({ template: Option.some("scratch"), password: Option.some("") }),
        FAST_BACKOFF,
      );
      expect(s.pushConnectCalls[0]?.password).toBe("prompted-pw");
    }).pipe(
      Effect.provide(s.layer),
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_DB_PASSWORD"];
          else process.env["SUPABASE_DB_PASSWORD"] = prev;
        }),
      ),
    );
  });

  it.live("pushes with a SUPABASE_DB_PASSWORD env var-sourced password", () => {
    const s = setup();
    const prev = process.env["SUPABASE_DB_PASSWORD"];
    process.env["SUPABASE_DB_PASSWORD"] = "env-pw";
    return Effect.gen(function* () {
      yield* legacyBootstrap(
        flags({ template: Option.some("scratch"), password: Option.none() }),
        FAST_BACKOFF,
      );
      expect(s.pushConnectCalls[0]?.password).toBe("env-pw");
    }).pipe(
      Effect.provide(s.layer),
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_DB_PASSWORD"];
          else process.env["SUPABASE_DB_PASSWORD"] = prev;
        }),
      ),
    );
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
