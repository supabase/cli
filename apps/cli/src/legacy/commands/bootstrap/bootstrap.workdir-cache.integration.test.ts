import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
} from "../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { legacyIdentityStitchLayer } from "../../shared/legacy-identity-stitch.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
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
// `cliConfig.workdir` (the cwd-walk result) diverges from the bootstrap workdir, and the
// cache must follow the bootstrap workdir so `linked-project.json` lands beside
// `project-ref` (matching Go's `flags.LoadConfig` after `ChangeWorkDir`).
describe("legacy bootstrap linked-project cache location", () => {
  it.live(
    "writes linked-project.json into the prompted bootstrap workdir, not cliConfig.workdir",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "bootstrap-cache-"));
      const subdir = "myproj";
      const bootstrapWorkdir = join(parent, subdir);

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
        // GET /v1/projects/{ref} — read by the linked-project cache.
        if (recorded.method === "GET" && url.includes(`/v1/projects/${LEGACY_VALID_REF}`)) {
          return Effect.succeed(legacyJsonResponse(request, 200, PROJECT));
        }
        return Effect.succeed(legacyJsonResponse(request, 404, {}));
      };
      const api = mockLegacyPlatformApi({ handler });

      const proxyLayer = Layer.succeed(LegacyGoProxy, {
        exec: () => Effect.void,
        execCapture: () => Effect.succeed(""),
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
      );
      const runtime = mockRuntimeInfo({ cwd: parent });
      const credentials = mockLegacyCredentialsTracked();
      const debugLoggerLayer = legacyDebugLoggerLayer.pipe(Layer.provide(flagsLayer));

      const configLayer = legacyCliConfigLayer.pipe(
        Layer.provide(flagsLayer),
        Layer.provide(debugLoggerLayer),
        Layer.provide(runtime),
        Layer.provide(BunServices.layer),
      );
      const cacheLayer = legacyLinkedProjectCacheLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(credentials.layer),
        Layer.provide(api.httpClientLayer),
        // The cache GET stitches identity from X-Gotrue-Id (Go's identityTransport)
        // via the single `LegacyIdentityStitch` service. Consent "denied" makes the
        // stitch a no-op so this workdir-caching test's assertions are unchanged.
        Layer.provide(
          legacyIdentityStitchLayer.pipe(
            Layer.provide(mockAnalytics().layer),
            Layer.provide(mockTelemetryRuntime({ consent: "denied" })),
            Layer.provide(BunServices.layer),
          ),
        ),
        // The cache also fires org/project groupIdentify (Go parity), reading
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
        proxyLayer,
        mockLegacyLoginApi({ gotrueId: "gotrue-user" }).layer,
        mockLegacyLoginCrypto().layer,
        mockBrowser(),
        mockStdin(true),
        flagsLayer,
      );

      const flags: LegacyBootstrapFlags = {
        template: Option.some("scratch"),
        password: Option.some("s3cret"),
      };

      return Effect.gen(function* () {
        yield* legacyBootstrap(flags, FAST_BACKOFF);

        const projectRef = join(bootstrapWorkdir, "supabase", ".temp", "project-ref");
        const cacheInWorkdir = join(bootstrapWorkdir, "supabase", ".temp", "linked-project.json");
        const cacheInParent = join(parent, "supabase", ".temp", "linked-project.json");

        // project-ref already goes to the right place...
        expect(existsSync(projectRef)).toBe(true);
        // ...so linked-project.json must land beside it (Go writes both into workdir).
        expect(existsSync(cacheInWorkdir)).toBe(true);
        expect(existsSync(cacheInParent)).toBe(false);
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
