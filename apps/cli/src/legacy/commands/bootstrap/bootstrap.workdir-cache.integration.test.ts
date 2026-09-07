import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schedule } from "effect";

import {
  mockAnalytics,
  mockBrowser,
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import {
  type LegacyApiHandler,
  LEGACY_VALID_REF,
  legacyJsonResponse,
  mockLegacyCredentialsTracked,
  mockLegacyLoginApi,
  mockLegacyLoginCrypto,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
} from "../../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
} from "../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { SuccessTrailer, successTrailerLayer } from "../../../shared/cli/success-trailer.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../shared/legacy-db-connection.service.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyIdentityStitchLayer } from "../../shared/legacy-identity-stitch.ts";
import { legacyCliSettingsLayer } from "../../config/legacy-cli-settings.layer.ts";
import { legacyLinkedProjectCacheLayer } from "../../telemetry/legacy-linked-project-cache.layer.ts";
import { LegacyTemplateService } from "./bootstrap.templates.ts";
import { legacyBootstrap } from "./bootstrap.handler.ts";
import type { LegacyBootstrapFlags } from "./bootstrap.command.ts";

const FAST_BACKOFF = Schedule.exponential("1 milli");

const PROJECT = {
  id: LEGACY_VALID_REF,
  ref: LEGACY_VALID_REF,
  organization_id: "org-1",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  status: "COMING_UP",
};
const ORGS = [{ id: "org-1", slug: "acme", name: "Acme Inc" }];
const API_KEYS = [{ name: "anon", api_key: "anon-key" }];
const HEALTHY = [{ name: "db", healthy: true, status: "ACTIVE_HEALTHY" }];

// Drives the handler through the *prompt* workdir path (no `--workdir` flag and no
// `SUPABASE_WORKDIR` env) with the real config + linked-project-cache layers. This is
// the case the rest of the suite never covers: when the workdir comes from the prompt,
// `cliSettings.workdir` (the cwd-walk result) diverges from the bootstrap workdir, and the
// cache must follow the bootstrap workdir so `linked-project.json` lands beside
// `project-ref` (matching the established config-load-after-chdir ordering).
describe("legacy bootstrap linked-project cache location", () => {
  it.live(
    "writes linked-project.json into the prompted bootstrap workdir, not cliSettings.workdir",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "bootstrap-cache-"));
      const subdir = "myproj";
      const bootstrapWorkdir = join(parent, subdir);

      // Pre-seed a migration file at the bootstrap workdir (before it even exists) so
      // the push step's migrations lookup is empirically provable: `legacyDbPushCore`
      // must find it via the `workdir` local variable — the prompted bootstrap
      // workdir — never `cliSettings.workdir` (the cwd-walk result from `parent`, which
      // has no `supabase/migrations` of its own and would wrongly report "up to date").
      const migrationsDir = join(bootstrapWorkdir, "supabase", "migrations");
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, "20240101000000_test.sql"), "create table t ();");
      // Also pre-seed `supabase/roles.sql` so the push step's `includeRoles: true`
      // (bootstrap always passes it) is actually pinned under test — without a
      // roles.sql file present, the
      // custom-roles branch is a no-op and `includeRoles`'s value is unasserted.
      writeFileSync(join(bootstrapWorkdir, "supabase", "roles.sql"), "create role app;");

      // Token via env => ensure-login is a no-op and the cache has a bearer token.
      const prevToken = process.env["SUPABASE_ACCESS_TOKEN"];
      const prevWorkdir = process.env["SUPABASE_WORKDIR"];
      process.env["SUPABASE_ACCESS_TOKEN"] = "sbp_" + "a".repeat(40);
      delete process.env["SUPABASE_WORKDIR"];

      const out = mockOutput({ format: "text", promptTextResponses: [subdir] });

      const handler: LegacyApiHandler = (request, recorded) => {
        const url = recorded.urlWithParams;
        if (recorded.method === "POST" && /\/v1\/projects(\?|$)/.test(url)) {
          return Effect.succeed(legacyJsonResponse(request, 201, PROJECT));
        }
        if (url.includes("/api-keys")) {
          return Effect.succeed(legacyJsonResponse(request, 200, API_KEYS));
        }
        if (url.includes("/health")) {
          return Effect.succeed(legacyJsonResponse(request, 200, HEALTHY));
        }
        if (url.includes("/v1/organizations")) {
          return Effect.succeed(legacyJsonResponse(request, 200, ORGS));
        }
        // Pooler config: the direct db host is never reachable in-process, so
        // `legacyResolveLinkedConn`'s push-connection resolution always falls
        // back to the IPv4 pooler (CLI-1953). `legacyLinkServicesCore`'s own
        // `linkPooler` step (step I) fetches this same route and saves it to
        // `<bootstrapWorkdir>/supabase/.temp/pooler-url`, which the fallback reads.
        // Checked before the broader `/v1/projects/{ref}` GET below, which would
        // otherwise also match this path.
        if (recorded.method === "GET" && url.includes("/config/database/pooler")) {
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
                connection_string: `postgres://postgres.${LEGACY_VALID_REF}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                connectionString: `postgres://postgres.${LEGACY_VALID_REF}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                default_pool_size: null,
                max_client_conn: null,
                pool_mode: "transaction",
              },
            ]),
          );
        }
        // GET /v1/projects/{ref} — read by the linked-project cache.
        if (recorded.method === "GET" && url.includes(`/v1/projects/${LEGACY_VALID_REF}`)) {
          return Effect.succeed(legacyJsonResponse(request, 200, PROJECT));
        }
        return Effect.succeed(legacyJsonResponse(request, 404, {}));
      };
      const api = mockLegacyPlatformApi({ handler });

      // Native push (CLI-1953): `legacyDbPushCore` needs a `LegacyDbConnection` —
      // tracked here so the test can assert it targets the created project's ref,
      // not a divergent one.
      const pushConnectCalls: Array<LegacyPgConnInput> = [];
      const dbConnectionLayer = Layer.succeed(LegacyDbConnection, {
        connect: (conn: LegacyPgConnInput) =>
          Effect.sync(() => {
            pushConnectCalls.push(conn);
            return {
              extensionExists: () => Effect.succeed(false),
              copyToCsv: () => Effect.succeed(new Uint8Array()),
              queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
              exec: () => Effect.void,
              execBatch: () => Effect.void,
              query: () => Effect.succeed([]),
            };
          }),
      });
      const templateLayer = Layer.succeed(LegacyTemplateService, {
        listSamples: Effect.succeed([]),
        download: () => Effect.void,
      });

      // GlobalFlag services don't cross sibling boundaries in Layer.mergeAll
      // (apps/cli/CLAUDE.md item 5), so provide them explicitly into the real config layer.
      const flagsLayer = Layer.mergeAll(
        Layer.succeed(LegacyProfileFlag, "supabase"),
        Layer.succeed(LegacyWorkdirFlag, Option.none()),
        Layer.succeed(LegacyYesFlag, false),
        Layer.succeed(LegacyOutputFlag, Option.none()),
        Layer.succeed(LegacyDebugFlag, false),
        Layer.succeed(LegacyDnsResolverFlag, "native"),
        Layer.succeed(LegacyNetworkIdFlag, Option.none()),
        Layer.succeed(CliArgs, { args: [] }),
      );
      const runtime = mockRuntimeInfo({ cwd: parent });
      const credentials = mockLegacyCredentialsTracked();
      const debugLoggerLayer = legacyDebugLoggerLayer.pipe(Layer.provide(flagsLayer));

      const configLayer = legacyCliSettingsLayer.pipe(
        Layer.provide(flagsLayer),
        Layer.provide(debugLoggerLayer),
        Layer.provide(runtime),
        Layer.provide(BunServices.layer),
      );
      const cacheLayer = legacyLinkedProjectCacheLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(credentials.layer),
        Layer.provide(api.httpClientLayer),
        // The cache GET stitches identity from X-Gotrue-Id (the established
        // identityTransport) via the single `LegacyIdentityStitch` service. Consent "denied" makes the
        // stitch a no-op so this workdir-caching test's assertions are unchanged.
        Layer.provide(
          legacyIdentityStitchLayer.pipe(
            Layer.provide(mockAnalytics().layer),
            Layer.provide(mockTelemetryRuntime({ consent: "denied" })),
            Layer.provide(BunServices.layer),
          ),
        ),
        // The cache also fires org/project groupIdentify, reading
        // Analytics directly.
        Layer.provide(mockAnalytics().layer),
        Layer.provide(BunServices.layer),
      );

      const layer = Layer.mergeAll(
        BunServices.layer,
        out.layer,
        api.layer,
        api.factoryLayer,
        api.httpClientLayer,
        configLayer,
        cacheLayer,
        credentials.layer,
        mockTty({ stdinIsTty: true, stdoutIsTty: false }),
        runtime,
        mockLegacyTelemetryStateTracked().layer,
        mockAnalytics().layer,
        templateLayer,
        dbConnectionLayer,
        mockLegacyLoginApi({ gotrueId: "gotrue-user" }).layer,
        mockLegacyLoginCrypto().layer,
        mockBrowser(),
        mockStdin(true),
        flagsLayer,
        debugLoggerLayer,
        successTrailerLayer,
      );

      const flags: LegacyBootstrapFlags = {
        template: Option.some("scratch"),
        password: Option.some("s3cret"),
      };

      return Effect.gen(function* () {
        const successTrailer = yield* SuccessTrailer;
        yield* legacyBootstrap(flags, FAST_BACKOFF);

        expect(yield* successTrailer.workingDirectory).toBe(bootstrapWorkdir);

        const projectRef = join(bootstrapWorkdir, "supabase", ".temp", "project-ref");
        const cacheInWorkdir = join(bootstrapWorkdir, "supabase", ".temp", "linked-project.json");
        const cacheInParent = join(parent, "supabase", ".temp", "linked-project.json");

        // project-ref already goes to the right place...
        expect(existsSync(projectRef)).toBe(true);
        // ...so linked-project.json must land beside it (Go writes both into workdir).
        expect(existsSync(cacheInWorkdir)).toBe(true);
        expect(existsSync(cacheInParent)).toBe(false);

        // Native push (CLI-1953) correctness: `legacyDbPushCore` connects to the
        // just-created project (the `projectRef` bootstrap already holds in
        // memory, never re-resolved via `LegacyProjectRefResolver`) and finds the
        // pre-seeded migration under `<bootstrapWorkdir>/supabase/migrations` — the
        // `workdir` local variable, not `cliSettings.workdir` (which cwd-walks from
        // `parent` and would find nothing, wrongly reporting "up to date"). The
        // direct db host is never reachable in-process, so `legacyResolveLinkedConn`
        // falls back to the IPv4 pooler (CLI-1953) — reading the saved
        // `<bootstrapWorkdir>/supabase/.temp/pooler-url` `legacyLinkServicesCore`
        // (step I) wrote, which is itself proof the fallback is workdir-scoped
        // correctly too.
        expect(pushConnectCalls).toHaveLength(1);
        expect(pushConnectCalls[0]?.host).toBe("aws-0-us-east-1.pooler.supabase.com");
        expect(pushConnectCalls[0]?.user).toBe(`postgres.${LEGACY_VALID_REF}`);
        expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
        // Pins `includeRoles: true` (the pre-seeded `supabase/roles.sql` above):
        // without it, the custom-roles prompt/apply below is unreachable and
        // `includeRoles`'s value goes unasserted. The confirm prompt itself is
        // interactive UI (clack), not `output.raw` text, so it's recorded in
        // `promptConfirmCalls`, not `stderrText`.
        expect(
          out.promptConfirmCalls.some((c) =>
            c.message.includes("Do you want to create custom roles in the database cluster?"),
          ),
        ).toBe(true);
        expect(out.stderrText).toContain("Seeding globals from roles.sql...");
        // Pins `includeSeed: true`: with no `supabase/seed.sql` file, the seed
        // glob matches nothing, so the push step reports seeds up to date — a
        // line that only prints at all when `includeSeed` is true.
        expect(out.stderrText).toContain("Seed files are up to date.");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (prevToken !== undefined) process.env["SUPABASE_ACCESS_TOKEN"] = prevToken;
            else delete process.env["SUPABASE_ACCESS_TOKEN"];
            if (prevWorkdir !== undefined) process.env["SUPABASE_WORKDIR"] = prevWorkdir;
            rmSync(parent, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});
