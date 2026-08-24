import { describe, expect, it } from "@effect/vitest";
import { FunctionResponse } from "@supabase/api/effect";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as PlatformError from "effect/PlatformError";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { CliConfig } from "../../../config/cli-config.service.ts";
import {
  InvalidProjectLinkStateError,
  ProjectLinkState,
  type ProjectLinkStateValue,
} from "../../../config/project-link-state.service.ts";
import { commandRuntimeLayer as rawCommandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import {
  mockCredentials,
  mockOutput,
  mockProjectContext,
  mockProjectLinkState,
  mockRuntimeInfo,
} from "../../../../../tests/helpers/mocks.ts";
import { functionsList } from "./list.handler.ts";

const commandRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  rawCommandRuntimeLayer(commandPath).pipe(Layer.provide(BunServices.layer));

const PROJECT_REF = "abcdefghijklmnopqrst";

const LINK_STATE: ProjectLinkStateValue = {
  project: {
    ref: PROJECT_REF,
    name: "Linked Project",
    organization_id: "org-id",
    organization_slug: "org-slug",
  },
  active_branch: {
    ref: PROJECT_REF,
    name: "main",
    is_default: true,
  },
  fetchedAt: "2026-01-01T00:00:00.000Z",
  versions: {},
};

function makeTempDir(): Effect.Effect<string, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectory({ prefix: "supabase-functions-list-" });
  }).pipe(Effect.provide(BunServices.layer));
}

function makeFunction(
  overrides: Partial<typeof FunctionResponse.Type> = {},
): typeof FunctionResponse.Type {
  return {
    id: "function-id",
    slug: "hello-world",
    name: "Hello World",
    status: "ACTIVE",
    version: 2,
    created_at: 1_687_423_025_152,
    updated_at: 1_687_423_025_152,
    verify_jwt: true,
    import_map: true,
    entrypoint_path: "functions/hello-world/index.ts",
    import_map_path: "functions/hello-world/deno.json",
    ...overrides,
  };
}

function cliConfigLayer() {
  return Layer.succeed(
    CliConfig,
    CliConfig.of({
      apiUrl: "https://api.supabase.com",
      dashboardUrl: "https://supabase.com/dashboard",
      projectHost: "supabase.co",
      telemetryPosthogHost: "https://us.i.posthog.com",
      telemetryPosthogKey: Option.some("phc_test_key"),
      accessToken: Option.none(),
      noKeyring: Option.none(),
      supabaseHome: "/tmp/supabase-cli-test-home",
      debug: Option.none(),
      telemetryDebug: Option.none(),
      telemetryDisabled: Option.none(),
      doNotTrack: Option.none(),
    }),
  );
}

function jsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
      },
    }),
  );
}

function mockFunctionsApi(
  functions: ReadonlyArray<typeof FunctionResponse.Type>,
  opts: { status?: number } = {},
) {
  const requests: Array<{
    url: string;
    headers: Readonly<Record<string, string | undefined>>;
  }> = [];

  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          headers: request.headers,
        });
        return jsonResponse(request, opts.status ?? 200, functions);
      }),
    ),
  );

  return {
    layer: http,
    get requests() {
      return requests;
    },
  };
}

function mockInvalidProjectLinkState() {
  const error = new InvalidProjectLinkStateError({
    detail: "The linked project state file is invalid or unreadable.",
    suggestion: "Fix or remove project.json, then retry the command.",
  });

  return Layer.succeed(
    ProjectLinkState,
    ProjectLinkState.of({
      load: Effect.fail(error),
      save: () => Effect.void,
      clear: Effect.void,
      getActiveBranch: Effect.fail(error),
      setActiveBranch: () => Effect.fail(error),
    }),
  );
}

function writeLocalFunction(
  cwd: string,
  slug: string,
  opts: { denoJson?: boolean } = {},
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const functionDir = path.join(cwd, "supabase", "functions", slug);
    yield* fs.makeDirectory(functionDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(functionDir, "index.ts"),
      "Deno.serve(() => new Response())\n",
    );
    if (opts.denoJson ?? true) {
      yield* fs.writeFileString(path.join(functionDir, "deno.json"), '{"imports":{}}\n');
    }
  }).pipe(Effect.provide(BunServices.layer));
}

function removeTempDir(tempDir: string): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(tempDir, { recursive: true });
  }).pipe(Effect.provide(BunServices.layer), Effect.orDie);
}

function withTempDir<A, E, R>(
  use: (tempDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PlatformError.PlatformError, R> {
  return Effect.acquireUseRelease(makeTempDir(), use, (tempDir) => removeTempDir(tempDir));
}

function setup(opts: {
  cwd: string;
  linked?: boolean;
  accessToken?: string;
  remoteFunctions?: ReadonlyArray<typeof FunctionResponse.Type>;
  remoteStatus?: number;
  format?: "text" | "json" | "stream-json";
}) {
  const out = mockOutput({ format: opts.format ?? "text", interactive: false });
  const credentials =
    opts.accessToken === undefined
      ? mockCredentials()
      : mockCredentials({ existingToken: opts.accessToken });
  const api = mockFunctionsApi(opts.remoteFunctions ?? [], { status: opts.remoteStatus });
  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    mockRuntimeInfo({ cwd: opts.cwd }),
    mockProjectContext(),
    cliConfigLayer(),
    mockProjectLinkState(opts.linked ? LINK_STATE : undefined),
    credentials.layer,
    commandRuntimeLayer(["functions", "list"]),
    api.layer,
  );

  return { out, layer, api };
}

describe("functions list", () => {
  it.live("lists local functions when the project is not linked and does not call the API", () => {
    return withTempDir((tempDir) =>
      Effect.gen(function* () {
        yield* writeLocalFunction(tempDir, "hello-world");
        const { out, layer, api } = setup({ cwd: tempDir, linked: false });

        yield* functionsList().pipe(Effect.provide(layer));

        expect(api.requests).toHaveLength(0);
        const info = out.messages
          .filter((message) => message.type === "info")
          .map((m) => m.message);
        expect(info.some((message) => message.includes("hello-world"))).toBe(true);
        expect(info.some((message) => message.includes("enabled"))).toBe(true);
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "info",
            message: "Showing local functions only. Link a project to include deployed functions.",
          }),
        );
      }),
    );
  });

  it.live("merges local and remote functions by slug in JSON mode", () => {
    return withTempDir((tempDir) =>
      Effect.gen(function* () {
        yield* writeLocalFunction(tempDir, "hello-world");
        const { out, layer, api } = setup({
          cwd: tempDir,
          linked: true,
          accessToken: "test-token",
          format: "json",
          remoteFunctions: [
            makeFunction(),
            makeFunction({
              id: "remote-only-id",
              slug: "remote-only",
              name: "Remote Only",
              entrypoint_path: "functions/remote-only/index.ts",
              import_map_path: "functions/remote-only/deno.json",
            }),
          ],
        });

        yield* functionsList().pipe(Effect.provide(layer));

        expect(api.requests).toHaveLength(1);
        expect(api.requests[0]?.url).toBe(
          "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/functions",
        );
        expect(api.requests[0]?.headers["x-supabase-command"]).toBe("functions list");
        const success = out.messages.find((message) => message.type === "success");
        const data = success?.data as {
          functions: Array<{
            slug: string;
            local: object | null;
            remote: { slug: string } | null;
          }>;
          sources: { remote: { checked: boolean; project_ref?: string } };
        };

        expect(data.sources.remote).toEqual({ checked: true, project_ref: PROJECT_REF });
        expect(data.functions).toHaveLength(2);
        expect(data.functions.find((item) => item.slug === "hello-world")).toMatchObject({
          local: expect.objectContaining({ entrypoint: "./functions/hello-world/index.ts" }),
          remote: expect.objectContaining({ slug: "hello-world" }),
        });
        expect(data.functions.find((item) => item.slug === "remote-only")).toMatchObject({
          local: null,
          remote: expect.objectContaining({ slug: "remote-only" }),
        });
      }),
    );
  });

  it.live("accepts null import_map_path values from the management API", () => {
    return withTempDir((tempDir) =>
      Effect.gen(function* () {
        yield* writeLocalFunction(tempDir, "hello-world");
        const { out, layer } = setup({
          cwd: tempDir,
          linked: true,
          accessToken: "test-token",
          format: "json",
          remoteFunctions: [makeFunction({ import_map_path: null })],
        });

        yield* functionsList().pipe(Effect.provide(layer));

        const success = out.messages.find((message) => message.type === "success");
        const data = success?.data as {
          functions: Array<{
            slug: string;
            local: object | null;
            remote: { slug: string; import_map_path?: string | null } | null;
          }>;
          sources: { remote: { checked: boolean; project_ref?: string; reason?: string } };
        };

        expect(data.sources.remote).toEqual({ checked: true, project_ref: PROJECT_REF });
        expect(data.functions).toHaveLength(1);
        expect(data.functions[0]).toMatchObject({
          slug: "hello-world",
          local: expect.objectContaining({ entrypoint: "./functions/hello-world/index.ts" }),
          remote: expect.objectContaining({ slug: "hello-world" }),
        });
        expect(data.functions[0]?.remote?.import_map_path).toBeNull();
      }),
    );
  });

  it.live("keeps local-only functions when remote enrichment succeeds", () => {
    return withTempDir((tempDir) =>
      Effect.gen(function* () {
        yield* writeLocalFunction(tempDir, "local-only");
        const { out, layer } = setup({
          cwd: tempDir,
          linked: true,
          accessToken: "test-token",
          format: "json",
          remoteFunctions: [],
        });

        yield* functionsList().pipe(Effect.provide(layer));

        const success = out.messages.find((message) => message.type === "success");
        const data = success?.data as {
          functions: Array<{ slug: string; local: object | null; remote: object | null }>;
        };
        expect(data.functions).toEqual([
          expect.objectContaining({
            slug: "local-only",
            local: expect.objectContaining({ entrypoint: "./functions/local-only/index.ts" }),
            remote: null,
          }),
        ]);
      }),
    );
  });

  it.live("fails when the linked project state is invalid", () => {
    return withTempDir((tempDir) =>
      Effect.gen(function* () {
        yield* writeLocalFunction(tempDir, "hello-world");
        const out = mockOutput({ format: "text", interactive: false });
        const api = mockFunctionsApi([]);
        const layer = Layer.mergeAll(
          BunServices.layer,
          out.layer,
          mockRuntimeInfo({ cwd: tempDir }),
          mockProjectContext(),
          cliConfigLayer(),
          mockInvalidProjectLinkState(),
          mockCredentials({ existingToken: "test-token" }).layer,
          commandRuntimeLayer(["functions", "list"]),
          api.layer,
        );

        const error = yield* functionsList().pipe(Effect.provide(layer), Effect.flip);

        expect(error).toBeInstanceOf(InvalidProjectLinkStateError);
        expect(api.requests).toHaveLength(0);
      }),
    );
  });

  it.live("reports not_authenticated while keeping local inventory", () => {
    return withTempDir((tempDir) =>
      Effect.gen(function* () {
        yield* writeLocalFunction(tempDir, "hello-world");
        const { out, layer, api } = setup({
          cwd: tempDir,
          linked: true,
          format: "json",
        });

        yield* functionsList().pipe(Effect.provide(layer));

        expect(api.requests).toHaveLength(0);
        const success = out.messages.find((message) => message.type === "success");
        const data = success?.data as {
          sources: { remote: { checked: boolean; project_ref?: string; reason?: string } };
          functions: Array<{ slug: string }>;
        };
        expect(data.sources.remote).toEqual({
          checked: false,
          project_ref: PROJECT_REF,
          reason: "not_authenticated",
        });
        expect(data.functions).toHaveLength(1);
      }),
    );
  });

  it.live("reports request_failed while keeping local inventory", () => {
    return withTempDir((tempDir) =>
      Effect.gen(function* () {
        yield* writeLocalFunction(tempDir, "hello-world");
        const { out, layer } = setup({
          cwd: tempDir,
          linked: true,
          accessToken: "test-token",
          format: "json",
          remoteStatus: 503,
        });

        yield* functionsList().pipe(Effect.provide(layer));

        const success = out.messages.find((message) => message.type === "success");
        const data = success?.data as {
          sources: { remote: { checked: boolean; project_ref?: string; reason?: string } };
          functions: Array<{ slug: string }>;
        };
        expect(data.sources.remote).toEqual({
          checked: false,
          project_ref: PROJECT_REF,
          reason: "request_failed",
        });
        expect(data.functions).toHaveLength(1);
      }),
    );
  });

  it.live("prints an empty state when no local or remote functions exist", () => {
    return withTempDir((tempDir) =>
      Effect.gen(function* () {
        const { out, layer } = setup({
          cwd: tempDir,
          linked: true,
          accessToken: "test-token",
          remoteFunctions: [],
        });

        yield* functionsList().pipe(Effect.provide(layer));

        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "outro", message: "No Edge Functions found." }),
        );
      }),
    );
  });
});
