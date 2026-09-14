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
} from "../../../tests/helpers/mocks.ts";
import {
  type ApiHandler,
  VALID_REF,
  jsonResponse,
  mockCommandCredentialsTracked,
  mockLoginApi,
  mockLoginCrypto,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
} from "../../../tests/helpers/command-mocks.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  NetworkIdFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
  YesFlag,
} from "../../command-internal/global-flags.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { SuccessTrailer, successTrailerLayer } from "../../shared/cli/success-trailer.ts";
import { DbConnection, type PgConnInput } from "../../command-internal/db-connection.service.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { linkedProjectCacheLayer } from "../../telemetry/linked-project-cache.layer.ts";
import { TemplateService } from "./bootstrap.templates.ts";
import { bootstrap } from "./bootstrap.handler.ts";
import type { BootstrapFlags } from "./bootstrap.command.ts";

const FAST_BACKOFF = Schedule.exponential("1 milli");

const PROJECT = {
  id: VALID_REF,
  ref: VALID_REF,
  organization_id: "org-1",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  status: "COMING_UP",
};
const ORGS = [{ id: "org-1", slug: "acme", name: "Acme Inc" }];
const API_KEYS = [{ name: "anon", api_key: "anon-key" }];
const HEALTHY = [{ name: "db", healthy: true, status: "ACTIVE_HEALTHY" }];

// Drives the handler through the prompt workdir path (no `--workdir` flag, no `SUPABASE_WORKDIR`
// env): `cliSettings.workdir` (the cwd-walk result) then diverges from the bootstrap workdir, so
// the cache must follow the bootstrap workdir for `linked-project.json` to land beside `project-ref`.
describe("bootstrap linked-project cache location", () => {
  it.live(
    "writes linked-project.json into the prompted bootstrap workdir, not cliSettings.workdir",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "bootstrap-cache-"));
      const subdir = "myproj";
      const bootstrapWorkdir = join(parent, subdir);

      // Pre-seeds a migration file at the bootstrap workdir (before it exists) so the push step
      // must find it via the `workdir` local variable, never `cliSettings.workdir` (the cwd-walk
      // result from `parent`, which has no `supabase/migrations` and would report "up to date").
      const migrationsDir = join(bootstrapWorkdir, "supabase", "migrations");
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, "20240101000000_test.sql"), "create table t ();");
      // Also pre-seeds `supabase/roles.sql` so `includeRoles: true` is pinned under test; without
      // it, the custom-roles branch is a no-op and that value goes unasserted.
      writeFileSync(join(bootstrapWorkdir, "supabase", "roles.sql"), "create role app;");

      // Token via env => ensure-login is a no-op and the cache has a bearer token.
      const prevToken = process.env["SUPABASE_ACCESS_TOKEN"];
      const prevWorkdir = process.env["SUPABASE_WORKDIR"];
      process.env["SUPABASE_ACCESS_TOKEN"] = "sbp_" + "a".repeat(40);
      delete process.env["SUPABASE_WORKDIR"];

      const out = mockOutput({ format: "text", promptTextResponses: [subdir] });

      const handler: ApiHandler = (request, recorded) => {
        const url = recorded.urlWithParams;
        if (recorded.method === "POST" && /\/v1\/projects(\?|$)/.test(url)) {
          return Effect.succeed(jsonResponse(request, 201, PROJECT));
        }
        if (url.includes("/api-keys")) {
          return Effect.succeed(jsonResponse(request, 200, API_KEYS));
        }
        if (url.includes("/health")) {
          return Effect.succeed(jsonResponse(request, 200, HEALTHY));
        }
        if (url.includes("/v1/organizations")) {
          return Effect.succeed(jsonResponse(request, 200, ORGS));
        }
        // Pooler config: the direct db host is never reachable in-process, so `resolveLinkedConn`
        // falls back to the IPv4 pooler fed by the saved pooler-url file. Checked before the
        // broader `/v1/projects/{ref}` GET below, which would otherwise also match this path.
        if (recorded.method === "GET" && url.includes("/config/database/pooler")) {
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
                connection_string: `postgres://postgres.${VALID_REF}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                connectionString: `postgres://postgres.${VALID_REF}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                default_pool_size: null,
                max_client_conn: null,
                pool_mode: "transaction",
              },
            ]),
          );
        }
        // GET /v1/projects/{ref} — read by the linked-project cache.
        if (recorded.method === "GET" && url.includes(`/v1/projects/${VALID_REF}`)) {
          return Effect.succeed(jsonResponse(request, 200, PROJECT));
        }
        return Effect.succeed(jsonResponse(request, 404, {}));
      };
      const api = mockCommandPlatformApi({ handler });

      // `dbPushCore` needs a `DbConnection`; tracked here so the test can assert it targets the
      // created project's ref, not a divergent one.
      const pushConnectCalls: Array<PgConnInput> = [];
      const dbConnectionLayer = Layer.succeed(DbConnection, {
        connect: (conn: PgConnInput) =>
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
      const templateLayer = Layer.succeed(TemplateService, {
        listSamples: Effect.succeed([]),
        download: () => Effect.void,
      });

      // GlobalFlag services don't cross sibling boundaries in `Layer.mergeAll` (CLAUDE.md
      // invariant 5), so provide them explicitly into the real config layer.
      const flagsLayer = Layer.mergeAll(
        Layer.succeed(ProfileFlag, "supabase"),
        Layer.succeed(WorkdirFlag, Option.none()),
        Layer.succeed(YesFlag, false),
        Layer.succeed(OutputFlag, Option.none()),
        Layer.succeed(DebugFlag, false),
        Layer.succeed(DnsResolverFlag, "native"),
        Layer.succeed(NetworkIdFlag, Option.none()),
        Layer.succeed(CliArgs, { args: [] }),
      );
      const runtime = mockRuntimeInfo({ cwd: parent });
      const credentials = mockCommandCredentialsTracked();
      const debugLogger = debugLoggerLayer.pipe(Layer.provide(flagsLayer));

      const configLayer = commandSettingsLayer.pipe(
        Layer.provide(flagsLayer),
        Layer.provide(debugLogger),
        Layer.provide(runtime),
        Layer.provide(BunServices.layer),
      );
      const cacheLayer = linkedProjectCacheLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(credentials.layer),
        Layer.provide(api.httpClientLayer),
        // Stitches identity from X-Gotrue-Id via the single `IdentityStitch` service; consent
        // "denied" makes the stitch a no-op, so this test's assertions are unchanged.
        Layer.provide(
          identityStitchLayer.pipe(
            Layer.provide(mockAnalytics().layer),
            Layer.provide(mockTelemetryRuntime({ consent: "denied" })),
            Layer.provide(BunServices.layer),
          ),
        ),
        // The cache also fires org/project groupIdentify, reading Analytics directly.
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
        mockTelemetryStateTracked().layer,
        mockAnalytics().layer,
        templateLayer,
        dbConnectionLayer,
        mockLoginApi({ gotrueId: "gotrue-user" }).layer,
        mockLoginCrypto().layer,
        mockBrowser(),
        mockStdin(true),
        flagsLayer,
        debugLogger,
        successTrailerLayer,
      );

      const flags: BootstrapFlags = {
        template: Option.some("scratch"),
        password: Option.some("s3cret"),
      };

      return Effect.gen(function* () {
        const successTrailer = yield* SuccessTrailer;
        yield* bootstrap(flags, FAST_BACKOFF);

        expect(yield* successTrailer.workingDirectory).toBe(bootstrapWorkdir);

        const projectRef = join(bootstrapWorkdir, "supabase", ".temp", "project-ref");
        const cacheInWorkdir = join(bootstrapWorkdir, "supabase", ".temp", "linked-project.json");
        const cacheInParent = join(parent, "supabase", ".temp", "linked-project.json");

        expect(existsSync(projectRef)).toBe(true);
        expect(existsSync(cacheInWorkdir)).toBe(true);
        expect(existsSync(cacheInParent)).toBe(false);

        expect(pushConnectCalls).toHaveLength(1);
        expect(pushConnectCalls[0]?.host).toBe("aws-0-us-east-1.pooler.supabase.com");
        expect(pushConnectCalls[0]?.user).toBe(`postgres.${VALID_REF}`);
        expect(out.stderrText).toContain("Applying migration 20240101000000_test.sql...");
        // The confirm prompt is interactive UI (clack), not `output.raw` text, so it's recorded
        // in `promptConfirmCalls`, not `stderrText`.
        expect(
          out.promptConfirmCalls.some((c) =>
            c.message.includes("Do you want to create custom roles in the database cluster?"),
          ),
        ).toBe(true);
        expect(out.stderrText).toContain("Seeding globals from roles.sql...");
        // With no `supabase/seed.sql` file, the seed glob matches nothing, so this line only
        // prints when `includeSeed` is true.
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
