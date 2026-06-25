import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  legacyJsonResponse,
  legacyTransportFailure,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { legacyConfigPush } from "./push.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-config-push-int-");

function writeConfig(toml: string): void {
  const dir = join(tempRoot.current, "supabase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), toml);
}

// Schema-valid PostgREST GET response with the api disabled remotely (empty
// schema). The real API client validates GET bodies against the generated
// output schema, so every postgrest GET must carry these fields.
const POSTGREST_DISABLED = {
  db_schema: "",
  db_extra_search_path: "",
  max_rows: 0,
  db_pool: null,
};

/** Routes mock HTTP responses by URL path so a single handler serves every endpoint. */
interface RouteOpts {
  readonly addons?: { status: number; body: unknown };
  readonly postgrestGet?: { status: number; body: unknown };
  readonly postgrestPatch?: { status: number; body: unknown } | "fail";
  readonly postgresGet?: { status: number; body: unknown };
  readonly postgresPut?: { status: number; body: unknown };
}

function setup(opts: {
  readonly toml: string;
  readonly routes?: RouteOpts;
  readonly format?: "text" | "json" | "stream-json";
  readonly yes?: boolean;
  readonly confirm?: ReadonlyArray<boolean>;
  readonly promptFail?: boolean;
}) {
  writeConfig(opts.toml);
  const routes = opts.routes ?? {};
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm,
    promptConfirmFail: opts.promptFail,
  });
  const api = mockLegacyPlatformApi({
    handler: (request) => {
      const url = request.url;
      if (url.includes("/billing/addons")) {
        const a = routes.addons ?? { status: 200, body: { available_addons: [] } };
        return Effect.succeed(legacyJsonResponse(request, a.status, a.body));
      }
      if (url.includes("/postgrest")) {
        if (request.method === "GET") {
          const g = routes.postgrestGet ?? { status: 200, body: POSTGREST_DISABLED };
          return Effect.succeed(legacyJsonResponse(request, g.status, g.body));
        }
        if (routes.postgrestPatch === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        const p = routes.postgrestPatch ?? { status: 200, body: POSTGREST_DISABLED };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      if (url.includes("/config/database/postgres")) {
        if (request.method === "GET") {
          const g = routes.postgresGet ?? { status: 200, body: {} };
          return Effect.succeed(legacyJsonResponse(request, g.status, g.body));
        }
        const p = routes.postgresPut ?? { status: 200, body: {} };
        return Effect.succeed(legacyJsonResponse(request, p.status, p.body));
      }
      // Anything else (auth/storage/etc.) — succeed with empty so unconfigured
      // gated services don't hang if a test enables them.
      return Effect.succeed(legacyJsonResponse(request, 200, {}));
    },
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
    }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
  );
  return { layer, out, api, telemetry, linkedProjectCache };
}

// A config where only the api service is enabled (auth/db.settings/storage stay
// at defaults; auth/storage GETs are served empty, db.settings always runs).
const API_ONLY_TOML = `project_id = "test"
[auth]
enabled = false
[storage]
enabled = false
`;

describe("legacy config push integration", () => {
  it.live("pushes local config (text, Go parity) and surfaces a PATCH failure", () => {
    const { layer, out } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: {
        addons: { status: 200, body: { available_addons: [] } },
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgrestPatch: "fail",
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.stderrText).toContain("Pushing config to project: abcdefghijklmnopqrst");
      expect(out.stderrText).toContain("Updating API service with config:");
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts on malformed config.toml before any network call", () => {
    const { layer, api } = setup({ toml: "malformed", yes: true });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("merges a matching [remotes.*] block over the base and pushes it", () => {
    const { layer, out, api } = setup({
      toml: `${API_ONLY_TOML}[api]
enabled = true
schemas = ["public"]

[remotes.staging]
project_id = "abcdefghijklmnopqrst"
[remotes.staging.api]
schemas = ["public", "remote_schema"]
`,
      yes: true,
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      // Go prints the override line, before the "Pushing config to project" line.
      expect(out.stderrText).toContain("Loading config override: [remotes.staging]");
      expect(out.stderrText.indexOf("Loading config override: [remotes.staging]")).toBeLessThan(
        out.stderrText.indexOf("Pushing config to project:"),
      );
      // The remote's schema override is what gets pushed (proving the merge).
      const patch = api.requests.find((r) => r.method === "PATCH" && r.url.includes("/postgrest"));
      expect(patch).toBeDefined();
      expect(patch?.body).toMatchObject({ db_schema: "public,remote_schema" });
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts when two [remotes.*] blocks share the target project_id", () => {
    const { layer, api } = setup({
      toml: `${API_ONLY_TOML}[remotes.a]
project_id = "abcdefghijklmnopqrst"
[remotes.b]
project_id = "abcdefghijklmnopqrst"
`,
      yes: true,
    });
    return Effect.gen(function* () {
      const message = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(
        Effect.catchTag("LegacyConfigPushLoadConfigError", (error) =>
          Effect.succeed(error.message),
        ),
      );
      expect(message).toContain("duplicate project_id for [remotes.");
      // The guard runs during config load, before any network call.
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when listing addons returns 503", () => {
    const { layer } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: { addons: { status: 503, body: {} } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports up-to-date when the remote api matches local", () => {
    const { layer, out, api } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: {
        postgrestGet: {
          status: 200,
          body: {
            db_schema: "public,graphql_public",
            db_extra_search_path: "public,extensions",
            max_rows: 1000,
            db_pool: null,
            jwt_secret: "x",
          },
        },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Remote API config is up to date.");
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        false,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("stops a service when the user declines the prompt (exit 0)", () => {
    const { layer, out, api } = setup({
      toml: API_ONLY_TOML,
      confirm: [false],
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Updating API service with config:");
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        false,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("auto-confirms with --yes (echoes the prompt)", () => {
    const { layer, out } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Do you want to push api config to remote? [Y/n] y");
    }).pipe(Effect.provide(layer));
  });

  it.live("defaults to yes in non-TTY text without --yes", () => {
    const { layer, api } = setup({
      toml: API_ONLY_TOML,
      promptFail: true,
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(api.requests.some((r) => r.method === "PATCH" && r.url.includes("/postgrest"))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a structured summary in json mode without prompts", () => {
    const { layer, out } = setup({
      toml: API_ONLY_TOML,
      format: "json",
      routes: {
        postgrestGet: { status: 200, body: POSTGREST_DISABLED },
        postgresGet: { status: 200, body: {} },
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data?.project_ref).toBe("abcdefghijklmnopqrst");
      expect(Array.isArray(success?.data?.services)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry + linked-project cache on failure", () => {
    const { layer, telemetry, linkedProjectCache } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: { addons: { status: 503, body: {} } },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the api GET returns an unexpected status", () => {
    const { layer } = setup({
      toml: API_ONLY_TOML,
      yes: true,
      routes: { postgrestGet: { status: 500, body: { message: "boom" } } },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts with exit 1 when no config.toml exists", () => {
    // Fresh temp workdir, but no supabase/config.toml written.
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) =>
        Effect.succeed(legacyJsonResponse(request, 200, { available_addons: [] })),
    });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      Layer.succeed(LegacyYesFlag, true),
    );
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

// ---------------------------------------------------------------------------
// Gated services (auth / storage / db.network_restrictions / db.ssl_enforcement
// / experimental). These use the direct-service mock (no response-schema
// validation) because the typed auth/storage GET responses have ~200 required
// fields; a raw HttpClient still serves the cost-matrix /billing/addons call.
// ---------------------------------------------------------------------------

function addonsHttpLayer(): Layer.Layer<HttpClient.HttpClient> {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ available_addons: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  );
}

// api + db.settings run before every gated service; keep them up-to-date so
// only the service under test produces a diff.
const baseStubs = {
  getPostgrestServiceConfig: () =>
    Effect.succeed({
      db_schema: "public,graphql_public",
      db_extra_search_path: "public,extensions",
      max_rows: 1000,
    }),
  getPostgresConfig: () => Effect.succeed({}),
};

// Disables auth + storage by default so a test can enable just its target service.
const BASE_DISABLED = `project_id = "test"\n[auth]\nenabled = false\n[storage]\nenabled = false\n`;

function setupService(opts: {
  readonly toml: string;
  readonly v1: Record<string, (input: unknown) => Effect.Effect<unknown, unknown>>;
  readonly yes?: boolean;
  readonly confirm?: ReadonlyArray<boolean>;
  readonly runtimeCwd?: string;
}) {
  writeConfig(opts.toml);
  const out = mockOutput({ format: "text", promptConfirmResponses: opts.confirm });
  const apiMock = mockLegacyPlatformApiService({ v1: { ...baseStubs, ...opts.v1 } });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api: { layer: apiMock.layer, httpClientLayer: addonsHttpLayer() },
      cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
      runtimeInfo: mockRuntimeInfo({ cwd: opts.runtimeCwd ?? tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
    }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
  );
  return { layer, out, apiMock };
}

function methodsOf(apiMock: ReturnType<typeof setupService>["apiMock"]): Array<string> {
  return apiMock.requests.map((r) => r.method);
}

describe("legacy config push gated services", () => {
  it.live("pushes auth email HTML loaded from content_path", () => {
    const templateDir = join(tempRoot.current, "templates");
    const notificationDir = join(tempRoot.current, "supabase", "templates");
    mkdirSync(templateDir, { recursive: true });
    mkdirSync(notificationDir, { recursive: true });
    writeFileSync(join(templateDir, "invite.html"), "<h1>Invite</h1>");
    writeFileSync(join(notificationDir, "password_changed.html"), "<p>Password changed</p>");

    const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = true
site_url = "http://localhost:3000"
[auth.email.template.invite]
subject = "You are invited"
content_path = "./templates/invite.html"
[auth.email.notification.password_changed]
enabled = true
subject = "Password changed"
content_path = "./templates/password_changed.html"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: {
        getAuthServiceConfig: () => Effect.succeed({}),
        updateAuthServiceConfig: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["mailer_subjects_invite"]).toBe("You are invited");
      expect(input["mailer_templates_invite_content"]).toBe("<h1>Invite</h1>");
      expect(input["mailer_subjects_password_changed_notification"]).toBe("Password changed");
      expect(input["mailer_templates_password_changed_notification_content"]).toBe(
        "<p>Password changed</p>",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("aborts before network I/O when auth email content_path is unreadable", () => {
    const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = true
site_url = "http://localhost:3000"
[auth.email.template.invite]
subject = "You are invited"
content_path = "./templates/missing.html"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: {
        getAuthServiceConfig: () => Effect.succeed({}),
        updateAuthServiceConfig: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      const exit = yield* legacyConfigPush({ projectRef: Option.none() }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(apiMock.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves auth template paths from the discovered project root", () => {
    const nestedCwd = join(tempRoot.current, "packages", "app");
    const templateDir = join(tempRoot.current, "templates");
    mkdirSync(nestedCwd, { recursive: true });
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "invite.html"), "<h1>Nested invite</h1>");

    const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = true
site_url = "http://localhost:3000"
[auth.email.template.invite]
subject = "Nested invite"
content_path = "./templates/invite.html"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      runtimeCwd: nestedCwd,
      v1: {
        getAuthServiceConfig: () => Effect.succeed({}),
        updateAuthServiceConfig: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
      expect(update).toBeDefined();
      const input = update?.input as Record<string, unknown>;
      expect(input["mailer_templates_invite_content"]).toBe("<h1>Nested invite</h1>");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "sends the raw captcha secret (not the hash) when pushing auth (security regression)",
    () => {
      const toml = `project_id = "test"
[storage]
enabled = false
[auth]
enabled = true
site_url = "http://localhost:3000"
[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "my-plaintext-secret"
`;
      const { layer, apiMock } = setupService({
        toml,
        yes: true,
        v1: {
          getAuthServiceConfig: () => Effect.succeed({}),
          updateAuthServiceConfig: () => Effect.succeed({}),
        },
      });
      return Effect.gen(function* () {
        yield* legacyConfigPush({ projectRef: Option.none() });
        const update = apiMock.requests.find((r) => r.method === "updateAuthServiceConfig");
        expect(update).toBeDefined();
        const input = update?.input as Record<string, unknown>;
        expect(input["security_captcha_secret"]).toBe("my-plaintext-secret");
        expect(String(input["security_captcha_secret"])).not.toContain("hash:");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("pushes storage when enabled and changed", () => {
    const toml = `project_id = "test"
[auth]
enabled = false
[storage]
enabled = true
file_size_limit = "100MiB"
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: {
        getStorageConfig: () =>
          Effect.succeed({
            fileSizeLimit: 0,
            features: {
              imageTransformation: { enabled: false },
              s3Protocol: { enabled: false },
              icebergCatalog: { enabled: false, maxNamespaces: 0, maxTables: 0, maxCatalogs: 0 },
              vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
            },
          }),
        updateStorageConfig: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).toContain("updateStorageConfig");
    }).pipe(Effect.provide(layer));
  });

  it.live("pushes db.network_restrictions when enabled and changed", () => {
    const toml = `${BASE_DISABLED}[db.network_restrictions]
enabled = true
allowed_cidrs = ["1.2.3.4/32"]
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: {
        getNetworkRestrictions: () =>
          Effect.succeed({ config: { dbAllowedCidrs: ["0.0.0.0/0"], dbAllowedCidrsV6: [] } }),
        updateNetworkRestrictions: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).toContain("updateNetworkRestrictions");
    }).pipe(Effect.provide(layer));
  });

  it.live("pushes db.ssl_enforcement only when declared in config", () => {
    const toml = `${BASE_DISABLED}[db.ssl_enforcement]
enabled = true
`;
    const { layer, apiMock } = setupService({
      toml,
      yes: true,
      v1: {
        getSslEnforcementConfig: () => Effect.succeed({ currentConfig: { database: false } }),
        updateSslEnforcementConfig: () => Effect.succeed({}),
      },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).toContain("updateSslEnforcementConfig");
    }).pipe(Effect.provide(layer));
  });

  it.live("does not touch ssl_enforcement when the section is absent", () => {
    const { layer, apiMock } = setupService({ toml: BASE_DISABLED, yes: true, v1: {} });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(methodsOf(apiMock)).not.toContain("getSslEnforcementConfig");
    }).pipe(Effect.provide(layer));
  });

  it.live("enables webhooks when experimental.webhooks is enabled (no GET/diff)", () => {
    const toml = `${BASE_DISABLED}[experimental.webhooks]
enabled = true
`;
    const { layer, apiMock, out } = setupService({
      toml,
      yes: true,
      v1: { enableDatabaseWebhook: () => Effect.succeed({}) },
    });
    return Effect.gen(function* () {
      yield* legacyConfigPush({ projectRef: Option.none() });
      expect(out.stderrText).toContain("Enabling webhooks for project:");
      expect(methodsOf(apiMock)).toContain("enableDatabaseWebhook");
    }).pipe(Effect.provide(layer));
  });
});
