import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { V1GetDatabaseOpenapiOutput } from "@supabase/api/effect";
import { Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  buildLegacyTestRuntime,
  LEGACY_VALID_REF,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import type { LegacyGenTanstackDbFlags } from "./tanstack-db.command.ts";
import { legacyGenTanstackDb } from "./tanstack-db.handler.ts";

function writeConfig(workdir: string, contents: string) {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), contents);
}

function defaultFlags(overrides: Partial<LegacyGenTanstackDbFlags> = {}): LegacyGenTanstackDbFlags {
  return {
    local: false,
    linked: false,
    projectId: Option.none(),
    schema: [],
    ...overrides,
  };
}

type OpenapiOutput = typeof V1GetDatabaseOpenapiOutput.Type;

function todosOpenapi(): OpenapiOutput {
  return {
    definitions: {
      todos: {
        properties: {
          id: { type: "integer", description: "Note:\nThis is a Primary Key.<pk/>" },
          title: { type: "string" },
        },
        required: ["id", "title"],
      },
    },
  };
}

function setup(
  opts: {
    readonly workdir?: string;
    readonly projectId?: Option.Option<string>;
    readonly getDatabaseOpenapi?: (input: {
      readonly ref: string;
      readonly schema?: string;
    }) => Effect.Effect<OpenapiOutput, unknown>;
    readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  } = {},
) {
  const workdir = opts.workdir ?? mkdtempSync(join(tmpdir(), "supabase-gen-tanstack-db-"));
  const out = mockOutput({ format: "text", interactive: false });
  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
  const api = mockLegacyPlatformApiService({
    v1: {
      getDatabaseOpenapi: opts.getDatabaseOpenapi ?? (() => Effect.succeed(todosOpenapi())),
    },
  });

  const runtime = buildLegacyTestRuntime({
    out,
    api: { layer: api.layer, httpClientLayer: opts.httpClientLayer },
    cliConfig: mockLegacyCliConfig({
      workdir,
      projectId: opts.projectId ?? Option.some(LEGACY_VALID_REF),
    }),
    telemetry: telemetry.layer,
    linkedProjectCache: linkedProjectCache.layer,
  });

  return { workdir, out, telemetry, linkedProjectCache, api, layer: runtime };
}

describe("legacy gen tanstack-db", () => {
  it.live("generates a TanStack DB file for the linked project by default", () => {
    const { layer, out, api, linkedProjectCache, telemetry } = setup();

    return Effect.gen(function* () {
      yield* legacyGenTanstackDb(defaultFlags()).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("export const todosSchema = z.object({");
      expect(out.stdoutText).toContain("export const todosCollection = createCollection(");
      expect(api.requests).toEqual([
        { method: "getDatabaseOpenapi", input: { ref: LEGACY_VALID_REF, schema: "public" } },
      ]);
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
    });
  });

  it.live("generates a TanStack DB file for the explicit --linked flag", () => {
    const { layer, out, api } = setup();

    return Effect.gen(function* () {
      yield* legacyGenTanstackDb(defaultFlags({ linked: true })).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("export const todosSchema = z.object({");
      expect(api.requests).toEqual([
        { method: "getDatabaseOpenapi", input: { ref: LEGACY_VALID_REF, schema: "public" } },
      ]);
    });
  });

  it.live("generates a TanStack DB file for an explicit --project-id", () => {
    const { layer, out, api } = setup({ projectId: Option.none() });

    return Effect.gen(function* () {
      yield* legacyGenTanstackDb(defaultFlags({ projectId: Option.some(LEGACY_VALID_REF) })).pipe(
        Effect.provide(layer),
      );

      expect(out.stdoutText).toContain("export const todosSchema = z.object({");
      expect(api.requests).toEqual([
        { method: "getDatabaseOpenapi", input: { ref: LEGACY_VALID_REF, schema: "public" } },
      ]);
    });
  });

  it.live("fetches one document per requested --schema and merges the tables", () => {
    const { layer, api } = setup({
      getDatabaseOpenapi: ({ schema }) =>
        Effect.succeed({
          definitions: {
            [`${schema}_table`]: {
              properties: {
                id: { type: "string", description: "Note:\nThis is a Primary Key.<pk/>" },
              },
              required: ["id"],
            },
          },
        }),
    });

    return Effect.gen(function* () {
      yield* legacyGenTanstackDb(defaultFlags({ linked: true, schema: ["public", "auth"] })).pipe(
        Effect.provide(layer),
      );

      expect(api.requests).toEqual([
        { method: "getDatabaseOpenapi", input: { ref: LEGACY_VALID_REF, schema: "public" } },
        { method: "getDatabaseOpenapi", input: { ref: LEGACY_VALID_REF, schema: "auth" } },
      ]);
    });
  });

  it.live("fails when no target resolves and the project isn't linked", () => {
    const { layer } = setup({ projectId: Option.none() });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTanstackDb(defaultFlags()).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "Must specify one of --local, --linked, or --project-id",
        );
      }
    });
  });

  it.live("rejects combining --local and --linked", () => {
    const { layer } = setup();

    return Effect.gen(function* () {
      const exit = yield* legacyGenTanstackDb(defaultFlags({ local: true, linked: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "if any flags in the group [local linked project-id] are set none of the others can be; [linked local] were all set",
        );
      }
    });
  });

  it.live("fails with a typed error when a table has no primary key", () => {
    const { layer } = setup({
      getDatabaseOpenapi: () =>
        Effect.succeed({
          definitions: { orphans: { properties: { name: { type: "string" } }, required: [] } },
        }),
    });

    return Effect.gen(function* () {
      const exit = yield* legacyGenTanstackDb(defaultFlags({ linked: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("has no primary key columns");
      }
    });
  });

  describe("--local", () => {
    function setupLocal(opts: {
      readonly port?: number;
      readonly configExtra?: string;
      readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
    }) {
      const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-tanstack-db-local-"));
      writeConfig(
        workdir,
        [
          'project_id = "demo"',
          "",
          "[api]",
          `port = ${opts.port ?? 54321}`,
          'schemas = ["public"]',
          opts.configExtra ?? "",
        ].join("\n"),
      );
      return setup({ workdir, httpClientLayer: opts.httpClientLayer });
    }

    it.live("generates a TanStack DB file from the local stack", () => {
      const requests: Array<{ url: string; headers: Record<string, string | undefined> }> = [];
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push({ url: request.url, headers: { ...request.headers } });
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(todosOpenapi()), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        }),
      );
      const { layer, out } = setupLocal({ port: 54329, httpClientLayer });

      return Effect.gen(function* () {
        yield* legacyGenTanstackDb(defaultFlags({ local: true })).pipe(Effect.provide(layer));

        expect(out.stdoutText).toContain("export const todosSchema = z.object({");
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe("http://127.0.0.1:54329/rest/v1/");
        expect(requests[0]?.headers["accept-profile"]).toBe("public");
        expect(requests[0]?.headers["apikey"]).toBe(
          "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH",
        );
      });
    });

    it.live("reports a friendly error when the local stack isn't running", () => {
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "ECONNREFUSED" }),
            }),
          ),
        ),
      );
      const { layer } = setupLocal({ httpClientLayer });

      return Effect.gen(function* () {
        const exit = yield* legacyGenTanstackDb(defaultFlags({ local: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("supabase start is not running.");
        }
      });
    });

    it.live("fails when supabase/config.toml is missing", () => {
      const workdir = mkdtempSync(join(tmpdir(), "supabase-gen-tanstack-db-no-config-"));
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected HttpClient.execute — no config present")),
      );
      const { layer } = setup({ workdir, httpClientLayer });

      return Effect.gen(function* () {
        const exit = yield* legacyGenTanstackDb(defaultFlags({ local: true })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("supabase/config.toml not found");
        }
      });
    });
  });
});
