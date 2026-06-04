import { describe, expect, it } from "@effect/vitest";
import { FunctionResponse } from "@supabase/api/effect";
import { BunServices } from "@effect/platform-bun";
import { unixHttpClientLayer } from "@supabase/stack";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Stdio } from "effect";
import { Command } from "effect/unstable/cli";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import {
  InvalidProjectLinkStateError,
  ProjectLinkState,
  type ProjectLinkStateValue,
} from "../../../config/project-link-state.service.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import {
  mockAnalytics,
  mockCredentials,
  mockOutput,
  mockProcessControl,
  mockProjectLinkState,
  mockRuntimeInfo,
} from "../../../../../tests/helpers/mocks.ts";
import { functionsCommand } from "../functions.command.ts";
import { functionsList } from "./list.handler.ts";

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

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-functions-list-"));
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

function commandTreeSupportLayer(cwd: string) {
  const projectHomeDir = join(cwd, ".supabase");
  return Layer.mergeAll(
    unixHttpClientLayer,
    cliConfigLayer(),
    Layer.succeed(
      ProjectHome,
      ProjectHome.of({
        projectRoot: cwd,
        supabaseDir: join(cwd, "supabase"),
        projectHomeDir,
        projectLinkPath: join(projectHomeDir, "project.json"),
        projectLocalVersionsPath: join(projectHomeDir, "local-versions.json"),
        ensureProjectHomeDir: Effect.void,
        stackDir: (name) => join(projectHomeDir, "stacks", name),
        stackStatePath: (name) => join(projectHomeDir, "stacks", name, "state.json"),
        stackMetadataPath: (name) => join(projectHomeDir, "stacks", name, "stack.json"),
        stackDataDir: (name) => join(projectHomeDir, "stacks", name, "data"),
        stackLogsDir: (name) => join(projectHomeDir, "stacks", name, "logs"),
      }),
    ),
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

async function writeLocalFunction(cwd: string, slug: string, opts: { denoJson?: boolean } = {}) {
  const functionDir = join(cwd, "supabase", "functions", slug);
  await mkdir(functionDir, { recursive: true });
  await writeFile(join(functionDir, "index.ts"), "Deno.serve(() => new Response())\n");
  if (opts.denoJson ?? true) {
    await writeFile(join(functionDir, "deno.json"), '{"imports":{}}\n');
  }
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
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      const { out, layer, api } = setup({ cwd: tempDir, linked: false });

      yield* functionsList().pipe(Effect.provide(layer));

      expect(api.requests).toHaveLength(0);
      const info = out.messages.filter((message) => message.type === "info").map((m) => m.message);
      expect(info.some((message) => message.includes("hello-world"))).toBe(true);
      expect(info.some((message) => message.includes("enabled"))).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Showing local functions only. Link a project to include deployed functions.",
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("merges local and remote functions by slug in JSON mode", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
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
          local: unknown | null;
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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("keeps local-only functions when remote enrichment succeeds", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeLocalFunction(tempDir, "local-only"));
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
        functions: Array<{ slug: string; local: unknown | null; remote: unknown | null }>;
      };
      expect(data.functions).toEqual([
        expect.objectContaining({
          slug: "local-only",
          local: expect.objectContaining({ entrypoint: "./functions/local-only/index.ts" }),
          remote: null,
        }),
      ]);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails when the linked project state is invalid", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      const out = mockOutput({ format: "text", interactive: false });
      const api = mockFunctionsApi([]);
      const layer = Layer.mergeAll(
        BunServices.layer,
        out.layer,
        mockRuntimeInfo({ cwd: tempDir }),
        cliConfigLayer(),
        mockInvalidProjectLinkState(),
        mockCredentials({ existingToken: "test-token" }).layer,
        commandRuntimeLayer(["functions", "list"]),
        api.layer,
      );

      const error = yield* functionsList().pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidProjectLinkStateError);
      expect(api.requests).toHaveLength(0);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("reports not_authenticated while keeping local inventory", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("reports request_failed while keeping local inventory", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("prints an empty state when no local or remote functions exist", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
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
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("registers the command under functions list", () => {
    const tempDir = makeTempDir();
    const out = mockOutput({ format: "text", interactive: false });
    const analytics = mockAnalytics();
    const processControl = mockProcessControl();
    const api = mockFunctionsApi([]);
    const layer = Layer.mergeAll(
      BunServices.layer,
      out.layer,
      analytics.layer,
      processControl.layer,
      mockRuntimeInfo({ cwd: tempDir }),
      commandTreeSupportLayer(tempDir),
      mockProjectLinkState(),
      mockCredentials().layer,
      api.layer,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "list"]),
      }),
    );

    return Effect.gen(function* () {
      yield* Command.runWith(functionsCommand, { version: "0.1.0" })(["list"]).pipe(
        Effect.provide(layer),
      );

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "outro", message: "No Edge Functions found." }),
      );
      expect(analytics.captured).toContainEqual(
        expect.objectContaining({
          event: "cli_command_executed",
          properties: expect.objectContaining({ exit_code: 0 }),
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
