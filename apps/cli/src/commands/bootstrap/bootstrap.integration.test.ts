import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schedule,
} from "effect";

import {
  mockAnalytics,
  mockBrowser,
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import {
  type ApiHandler,
  VALID_REF,
  jsonResponse,
  mockCommandSettings,
  mockCommandCredentialsTracked,
  mockLinkedProjectCacheTracked,
  mockLoginApi,
  mockLoginCrypto,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
  withEnvVar,
} from "../../../tests/helpers/command-mocks.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  NetworkIdFlag,
  WorkdirFlag,
  YesFlag,
  OutputFlag,
} from "../../command-internal/global-flags.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { DbConnectError } from "../../command-internal/db-connection.errors.ts";
import { DbConnection, type PgConnInput } from "../../command-internal/db-connection.service.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { TemplateService, type StarterTemplate } from "./bootstrap.templates.ts";
import { bootstrap } from "./bootstrap.handler.ts";
import type { BootstrapFlags } from "./bootstrap.command.ts";

const FAST_BACKOFF = Schedule.exponential("1 milli");

const CREATED = {
  id: VALID_REF,
  ref: VALID_REF,
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

const tempRoot = useTempWorkdir("supabase-bootstrap-int-");

const NEXTJS_TEMPLATE: StarterTemplate = {
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
  readonly samples?: ReadonlyArray<StarterTemplate>;
  readonly apiKeysFailTimes?: number;
  readonly pushConnectFailTimes?: number;
  /**
   * When `false`, the pooler-config route reports no PRIMARY pooler, so `linkServicesCore` never
   * writes `<workdir>/supabase/.temp/pooler-url` and `resolveLinkedConn` has no pooler URL to
   * fall back to.
   */
  readonly poolerAvailable?: boolean;
  readonly health?: { readonly status: number; readonly body: unknown };
  readonly promptTextResponses?: ReadonlyArray<string>;
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
  readonly promptPasswordResponses?: ReadonlyArray<string>;
  /** Seeds `CommandSettings.dbPassword`, the captured `SUPABASE_DB_PASSWORD`. */
  readonly dbPassword?: string;
  /** Raw `SUPABASE_WORKDIR` the settings captured; used verbatim, so no prompt fires. */
  readonly workdirEnvValue?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function setup(path: Path.Path, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptTextResponses: opts.promptTextResponses,
    promptConfirmResponses: opts.promptConfirmResponses,
    promptPasswordResponses: opts.promptPasswordResponses,
  });
  const telemetry = mockTelemetryStateTracked();
  const linkedCache = mockLinkedProjectCacheTracked();
  const analytics = mockAnalytics();
  const credentials = mockCommandCredentialsTracked();

  let apiKeysCalls = 0;
  const createBodies: Array<unknown> = [];
  const handler: ApiHandler = (request, recorded) => {
    const url = recorded.urlWithParams;
    if (recorded.method === "POST" && /\/v1\/projects(\?|$)/.test(url)) {
      createBodies.push(recorded.body);
      return Effect.succeed(jsonResponse(request, 201, CREATED));
    }
    if (url.includes("/api-keys")) {
      apiKeysCalls += 1;
      // 403 (not 5xx) so the api client's internal 5xx retry does not absorb it,
      // forcing the bootstrap-level backoff to drive the retry.
      if (apiKeysCalls <= (opts.apiKeysFailTimes ?? 0)) {
        return Effect.succeed(jsonResponse(request, 403, { message: "not ready" }));
      }
      return Effect.succeed(jsonResponse(request, 200, API_KEYS));
    }
    if (url.includes("/health")) {
      const health = opts.health ?? { status: 200, body: HEALTHY };
      return Effect.succeed(jsonResponse(request, health.status, health.body));
    }
    if (url.includes("/v1/organizations")) {
      return Effect.succeed(jsonResponse(request, 200, ORGS));
    }
    // Pooler config: the test's direct db host is never reachable, so `resolveLinkedConn` always
    // falls back to the IPv4 pooler. `linkServicesCore`'s `linkPooler` step fetches this route
    // and saves it to `<workdir>/supabase/.temp/pooler-url`, which the fallback then reads.
    if (recorded.method === "GET" && url.includes("/config/database/pooler")) {
      if (opts.poolerAvailable === false) {
        return Effect.succeed(jsonResponse(request, 200, []));
      }
      return Effect.succeed(
        jsonResponse(request, 200, [
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
    return Effect.succeed(jsonResponse(request, 404, {}));
  };
  const api = mockCommandPlatformApi({ handler });

  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    workdirEnvValue: opts.workdirEnvValue,
    projectHost: "supabase.co",
    accessToken: opts.loggedIn === false ? Option.none() : undefined,
    dbPassword:
      opts.dbPassword === undefined ? undefined : Option.some(Redacted.make(opts.dbPassword)),
  });

  const samples = opts.samples ?? [];
  const downloads: Array<{ url: string; targetDir: string }> = [];
  const templateLayer = Layer.succeed(TemplateService, {
    listSamples: Effect.succeed(samples),
    download: (url: string, targetDir: string) =>
      Effect.sync(() => {
        downloads.push({ url, targetDir });
      }),
  });

  // The scratch/downloaded-template fixtures never scaffold migrations/seed.sql/roles.sql, so
  // `dbPushCore` always reaches the "up to date" short-circuit right after connecting — no query
  // results or edge-runtime invocation are needed.
  const pushConnectCalls: Array<PgConnInput> = [];
  const dbConnectionLayer = Layer.succeed(DbConnection, {
    connect: (conn: PgConnInput) =>
      Effect.suspend(() => {
        pushConnectCalls.push(conn);
        // Fails the first N connect attempts (retry coverage for the push step's own retry
        // wrap), succeeding after, mirroring `apiKeysFailTimes` above.
        if (pushConnectCalls.length <= (opts.pushConnectFailTimes ?? 0)) {
          return Effect.fail(new DbConnectError({ message: "connection refused" }));
        }
        return Effect.succeed({
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
          exec: () => Effect.void,
          execBatch: () => Effect.void,
          query: () => Effect.succeed([]),
        });
      }),
  });
  const loginApi = mockLoginApi({ gotrueId: "gotrue-user" });
  const loginCrypto = mockLoginCrypto();

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    api.layer,
    api.factoryLayer,
    api.httpClientLayer,
    cliSettings,
    mockTty({ stdinIsTty: opts.stdinIsTty ?? true, stdoutIsTty: false }),
    // cwd differs from the workdir so the "Using workdir" line prints.
    mockRuntimeInfo({ cwd: path.dirname(tempRoot.current) }),
    telemetry.layer,
    linkedCache.layer,
    analytics.layer,
    credentials.layer,
    templateLayer,
    dbConnectionLayer,
    loginApi.layer,
    loginCrypto.layer,
    mockBrowser(),
    mockStdin(opts.stdinIsTty ?? true),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(WorkdirFlag, opts.workdir ?? Option.some(tempRoot.current)),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(DebugFlag, opts.debug ?? false),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(NetworkIdFlag, Option.none()),
    Layer.succeed(CliArgs, { args: [] }),
    debugLoggerLayer.pipe(Layer.provide(Layer.succeed(DebugFlag, opts.debug ?? false))),
    ConfigProvider.layer(
      ConfigProvider.fromEnvRecord(opts.env ?? {}, { preserveEmptyStrings: true }),
    ),
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
    createBodies,
    pushConnectCalls,
    loginApi,
    get apiKeysCalls() {
      return apiKeysCalls;
    },
  };
}

function flags(overrides: Partial<BootstrapFlags> = {}): BootstrapFlags {
  return {
    template: Option.none(),
    password: Option.some("s3cret"),
    ...overrides,
  };
}

describe("bootstrap integration", () => {
  it.live("bootstraps the scratch template into the workdir (blank init, logged in)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const s = setup(path);
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(yield* fs.exists(path.join(s.workdir, "supabase", "config.toml"))).toBe(true);
      expect(
        yield* fs.readFileString(path.join(s.workdir, "supabase", ".temp", "project-ref")),
      ).toBe(VALID_REF);
      const env = yield* fs.readFileString(path.join(s.workdir, ".env"));
      expect(env).toContain('SUPABASE_ANON_KEY="anon-key"');
      expect(env).toContain("SUPABASE_URL=");
      expect(env).toContain("POSTGRES_URL=");
      expect(s.out.stderrText).toContain("Using workdir");
      expect(s.out.stderrText).toContain("Created a new project at");
      expect(s.out.stderrText).toContain("To start your app:");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "scratch scaffolding writes the stack-opt-in template when SUPABASE_EXPERIMENTAL_STACK=1",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const s = setup(path, { env: { SUPABASE_EXPERIMENTAL_STACK: "1" } });
        yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
          Effect.provide(s.layer),
        );
        const content = yield* fs.readFileString(path.join(s.workdir, "supabase", "config.toml"));
        expect(content).toContain("stack = true");
        expect(content).not.toMatch(/^port = 54321$/m);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "scratch scaffolding fails closed on an invalid SUPABASE_EXPERIMENTAL_STACK before writing config",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const s = setup(path, { env: { SUPABASE_EXPERIMENTAL_STACK: "yes" } });
        const exit = yield* Effect.exit(
          bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
            Effect.provide(s.layer),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("ExperimentalFeatureFlagError");
          expect(Cause.pretty(exit.cause)).toContain(
            "SUPABASE_EXPERIMENTAL_STACK must be 0 or 1 when set",
          );
        }
        expect(yield* fs.exists(path.join(s.workdir, "supabase", "config.toml"))).toBe(false);
        expect(s.out.stderrText).not.toContain("Created a new project at");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("downloads a named template matched by argument", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const s = setup(path, { samples: [NEXTJS_TEMPLATE] });
      yield* bootstrap(flags({ template: Option.some("NextJS") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(s.downloads).toHaveLength(1);
      expect(s.downloads[0]).toEqual({ url: NEXTJS_TEMPLATE.url, targetDir: s.workdir });
      expect(yield* fs.exists(path.join(s.workdir, "supabase", "config.toml"))).toBe(false);
      expect(s.out.stdoutText).toContain(`Downloading: ${NEXTJS_TEMPLATE.url}`);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("ignores SUPABASE_EXPERIMENTAL_STACK on a downloaded template", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, {
        samples: [NEXTJS_TEMPLATE],
        env: { SUPABASE_EXPERIMENTAL_STACK: "yes" },
      });
      yield* bootstrap(flags({ template: Option.some("NextJS") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(s.downloads).toHaveLength(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects an unknown template argument", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, { samples: [NEXTJS_TEMPLATE] });
      const exit = yield* Effect.exit(
        bootstrap(flags({ template: Option.some("nope") }), FAST_BACKOFF).pipe(
          Effect.provide(s.layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("BootstrapInvalidTemplateError");
        expect(causeText).toContain("Invalid template: nope");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("prompts for a template when none is given", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, { samples: [NEXTJS_TEMPLATE] });
      // Default mock promptSelect picks the first option (the nextjs template).
      yield* bootstrap(flags(), FAST_BACKOFF).pipe(Effect.provide(s.layer));
      expect(s.out.promptSelectCalls[0]?.message).toBe(
        "Which starter template do you want to use?",
      );
      expect(s.downloads).toHaveLength(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("prompts for a workdir when none is configured", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const s = setup(path, {
        workdir: Option.none(),
        promptTextResponses: [tempRoot.current],
      });
      // No `--workdir` flag and no captured `SUPABASE_WORKDIR`, so the handler must prompt.
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(yield* fs.exists(path.join(s.workdir, "supabase", "config.toml"))).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("uses the SUPABASE_WORKDIR env value without prompting", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // No `--workdir` flag; the settings carry the captured `SUPABASE_WORKDIR`, which the
      // handler uses verbatim instead of prompting.
      const s = setup(path, { workdir: Option.none(), workdirEnvValue: tempRoot.current });
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(s.out.promptTextCalls).toEqual([]);
      expect(yield* fs.exists(path.join(s.workdir, "supabase", "config.toml"))).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("aborts when the user declines to overwrite a non-empty workdir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const s = setup(path, { promptConfirmResponses: [false] });
      yield* fs.writeFileString(path.join(tempRoot.current, "existing.txt"), "keep me");
      const exit = yield* Effect.exit(
        bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
          Effect.provide(s.layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("BootstrapOverwriteDeclinedError");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("proceeds past a non-empty workdir with --yes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const s = setup(path, { yes: true });
      yield* fs.writeFileString(path.join(tempRoot.current, "existing.txt"), "keep me");
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(s.out.stderrText).toContain("Do you want to overwrite existing files in ");
      expect(s.out.stderrText).toContain(" directory? [Y/n] y\n");
      expect(yield* fs.exists(path.join(s.workdir, "supabase", "config.toml"))).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("runs the browser login flow when no token is present (one cli_login_completed)", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, { loggedIn: false });
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(s.credentials.savedToken).toBeDefined();
      expect(
        s.analytics.captured.map((c) => c.event).filter((e) => e === "cli_login_completed"),
      ).toHaveLength(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("skips login when already authenticated (no login event, no project-linked event)", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, { loggedIn: true });
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      const events = s.analytics.captured.map((c) => c.event);
      expect(events).not.toContain("cli_login_completed");
      expect(events).not.toContain("cli_project_linked");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("retries fetching api keys until they are available", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, { apiKeysFailTimes: 2 });
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(s.apiKeysCalls).toBe(3);
      const linkingLines = s.out.stderrText.match(/Linking project\.\.\./g) ?? [];
      expect(linkingLines.length).toBeGreaterThanOrEqual(3);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("retries the native push connection until it succeeds", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, { pushConnectFailTimes: 2, debug: true });
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(s.pushConnectCalls).toHaveLength(3);
      // The stderr retry notice needs 3+ failures to fire; asserting via the debug logger
      // (`debug: true` above) catches both attempts with only 2 failures here.
      const retryLines = s.out.stderrText.match(/connection refused\nRetry \(\d\/8\): /g) ?? [];
      expect(retryLines.length).toBe(2);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails when a service stays unhealthy", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, {
        health: { status: 200, body: [{ name: "db", healthy: false, status: "UNHEALTHY" }] },
      });
      const exit = yield* Effect.exit(
        bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
          Effect.provide(s.layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Service not healthy: db (UNHEALTHY)");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails with an Error status when the health endpoint returns non-200", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, { health: { status: 503, body: { message: "down" } } });
      const exit = yield* Effect.exit(
        bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
          Effect.provide(s.layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Error status 503");
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("merges .env.example derived keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const s = setup(path);
      yield* fs.makeDirectory(tempRoot.current, { recursive: true });
      yield* fs.writeFileString(
        path.join(tempRoot.current, ".env.example"),
        "POSTGRES_USER=example\nNEXT_PUBLIC_SUPABASE_ANON_KEY=example\n",
      );
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      const env = yield* fs.readFileString(path.join(s.workdir, ".env"));
      expect(env).toContain('POSTGRES_USER="postgres"');
      expect(env).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY="anon-key"');
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("continues (non-fatal) when the .env.example is malformed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const s = setup(path);
      yield* fs.makeDirectory(tempRoot.current, { recursive: true });
      yield* fs.writeFileString(path.join(tempRoot.current, ".env.example"), "!=");
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(s.out.stderrText).toContain("Failed to create .env file:");
      // Bootstrap still completes through the native db push step.
      expect(s.pushConnectCalls).toHaveLength(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "pushes natively — falls back to the IPv4 pooler when the direct host is unreachable, no Go subprocess",
    () =>
      // The test's direct db host is never reachable, so `resolveLinkedConn` falls back to the
      // IPv4 pooler fed by `setup()`'s pooler-config mock via the saved pooler-url file.
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const s = setup(path);
        yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
          Effect.provide(s.layer),
        );
        expect(s.pushConnectCalls).toHaveLength(1);
        expect(s.pushConnectCalls[0]?.host).toBe("aws-0-us-east-1.pooler.supabase.com");
        expect(s.pushConnectCalls[0]?.user).toBe(`postgres.${VALID_REF}`);
        expect(s.out.stderrText).toContain("Connecting to remote database...");
        expect(s.out.stdoutText).toContain("Remote database is up to date.");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "falls back to the direct-host config and keeps retrying push when connection resolution itself fails",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const s = setup(path, { poolerAvailable: false, pushConnectFailTimes: 1 });
        yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
          Effect.provide(s.layer),
        );
        expect(s.out.stderrText).toContain("IPv6 is not supported on your current network");
        expect(s.pushConnectCalls).toHaveLength(2);
        expect(s.pushConnectCalls[0]?.host).toBe(`db.${VALID_REF}.supabase.co`);
        expect(s.pushConnectCalls[0]?.port).toBe(5432);
        expect(s.pushConnectCalls[0]?.user).toBe("postgres");
        expect(s.pushConnectCalls[0]?.database).toBe("postgres");
        expect(s.pushConnectCalls[0]?.password).toBe("s3cret");
        expect(s.out.stdoutText).toContain("Remote database is up to date.");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("pushes with the flag-sourced password (used as the create password too)", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path);
      yield* bootstrap(
        flags({ template: Option.some("scratch"), password: Option.some("pw123") }),
        FAST_BACKOFF,
      ).pipe(Effect.provide(s.layer));
      expect(s.pushConnectCalls[0]?.password).toBe("pw123");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("pushes with the prompted password when --password is empty", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // An explicit `--password ""` (e.g. unset `$SUPABASE_DB_PASSWORD` expanded by the shell)
      // leaves the password empty, so the create step prompts, and the push reuses that same
      // resolved connection.
      const s = setup(path, { promptPasswordResponses: ["prompted-pw"] });
      yield* withEnvVar(
        "SUPABASE_DB_PASSWORD",
        undefined,
        bootstrap(
          flags({ template: Option.some("scratch"), password: Option.some("") }),
          FAST_BACKOFF,
        ).pipe(Effect.provide(s.layer)),
      );
      expect(s.pushConnectCalls[0]?.password).toBe("prompted-pw");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("pushes with the settings-captured SUPABASE_DB_PASSWORD password", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // The create seed reads the captured password from settings, and the push reuses the
      // created project's password — no live env read on this path.
      const s = setup(path, { dbPassword: "env-pw" });
      yield* bootstrap(
        flags({ template: Option.some("scratch"), password: Option.none() }),
        FAST_BACKOFF,
      ).pipe(Effect.provide(s.layer));
      expect(s.pushConnectCalls[0]?.password).toBe("env-pw");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("seeds the project create request with the settings-captured password", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, { dbPassword: "settings-pw" });
      yield* bootstrap(
        flags({ template: Option.some("scratch"), password: Option.none() }),
        FAST_BACKOFF,
      ).pipe(Effect.provide(s.layer));
      expect(s.createBodies).toHaveLength(1);
      expect(s.createBodies[0]).toMatchObject({ db_pass: "settings-pw" });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("flushes telemetry and caches the linked project via ensuring", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path);
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      expect(s.telemetry.flushed).toBe(true);
      expect(s.linkedCache.cached).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("emits a single structured result in json mode", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const s = setup(path, { format: "json" });
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      const successes = s.out.messages.filter((m) => m.type === "success");
      expect(successes).toHaveLength(1);
      expect(successes[0]?.data).toMatchObject({
        project_ref: VALID_REF,
        template: "scratch",
        start_command: "supabase start",
        workdir: s.workdir,
      });
      expect(s.out.stdoutText).not.toContain("To start your app:");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("reports env_file: null in the json result when the .env write fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const s = setup(path, { format: "json" });
      yield* fs.makeDirectory(tempRoot.current, { recursive: true });
      yield* fs.writeFileString(path.join(tempRoot.current, ".env.example"), "!=");
      yield* bootstrap(flags({ template: Option.some("scratch") }), FAST_BACKOFF).pipe(
        Effect.provide(s.layer),
      );
      const success = s.out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ env_file: null });
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
