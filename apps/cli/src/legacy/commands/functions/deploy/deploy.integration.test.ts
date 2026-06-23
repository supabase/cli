import { describe, expect, it } from "@effect/vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Option, Stdio } from "effect";

import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  buildLegacyTestRuntime,
  legacyJsonResponse,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import { legacyFunctionsDeploy } from "./deploy.handler.ts";
import type { LegacyFunctionsDeployFlags } from "./deploy.command.ts";

const tempRoot = useLegacyTempWorkdir("supabase-functions-deploy-legacy-");

const baseFlags: LegacyFunctionsDeployFlags = {
  functionNames: ["hello-world"],
  projectRef: Option.none(),
  noVerifyJwt: false,
  useApi: true,
  importMap: Option.none(),
  prune: false,
  jobs: Option.none(),
  useDocker: false,
  legacyBundle: false,
};

async function writeProjectConfig(cwd: string, content = 'project_id = "test-project"\n') {
  await mkdir(join(cwd, "supabase"), { recursive: true });
  await writeFile(join(cwd, "supabase", "config.toml"), content);
}

async function writeLocalFunction(
  cwd: string,
  slug: string,
  source = "Deno.serve(() => new Response())\n",
) {
  const functionDir = join(cwd, "supabase", "functions", slug);
  await mkdir(functionDir, { recursive: true });
  await writeFile(join(functionDir, "index.ts"), source);
  await writeFile(join(functionDir, "deno.json"), '{"imports":{}}\n');
}

describe("legacy functions deploy", () => {
  it.live("deploys a function natively through the Management API", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) => {
        if (request.method === "GET") {
          return Effect.succeed(legacyJsonResponse(request, 200, []));
        }
        if (request.url.endsWith("/functions/deploy")) {
          return Effect.succeed(
            legacyJsonResponse(request, 201, {
              id: "function-id",
              slug: "hello-world",
              name: "hello-world",
              status: "ACTIVE",
              version: 2,
              created_at: 1_687_423_025_152,
              updated_at: 1_687_423_025_152,
              verify_jwt: true,
              import_map: true,
              entrypoint_path: "functions/hello-world/index.ts",
              import_map_path: "functions/hello-world/deno.json",
            }),
          );
        }
        return Effect.succeed(legacyJsonResponse(request, 404, { error: "not found" }));
      },
    });
    const linkedProjectCache = mockLegacyLinkedProjectCacheTracked();
    const telemetry = mockLegacyTelemetryStateTracked();
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        linkedProjectCache: linkedProjectCache.layer,
        telemetry: telemetry.layer,
      }),
      Layer.succeed(LegacyYesFlag, false),
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
      yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

      yield* legacyFunctionsDeploy(baseFlags);

      expect(api.requests).toHaveLength(2);
      const deployRequest = api.requests.find(
        (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
      );
      expect(deployRequest?.url).toBe(
        "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/functions/deploy",
      );
      expect(deployRequest?.urlParams).toContain("slug=hello-world");
      expect(out.stdoutText).toContain(
        "Deployed Functions on project abcdefghijklmnopqrst: hello-world\n",
      );
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
      ),
    );
  });

  it.live("uses an explicit project ref when provided", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) => {
        if (request.method === "GET") {
          return Effect.succeed(legacyJsonResponse(request, 200, []));
        }
        return Effect.succeed(
          legacyJsonResponse(request, 201, {
            id: "function-id",
            slug: "hello-world",
            name: "hello-world",
            status: "ACTIVE",
            version: 2,
            created_at: 1_687_423_025_152,
            updated_at: 1_687_423_025_152,
            verify_jwt: true,
            import_map: true,
            entrypoint_path: "functions/hello-world/index.ts",
            import_map_path: "functions/hello-world/deno.json",
          }),
        );
      },
    });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({
          workdir: tempRoot.current,
          projectId: Option.none(),
        }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      Layer.succeed(LegacyYesFlag, false),
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "deploy",
          "hello-world",
          "--use-api",
          "--project-ref",
          "qrstuvwxyzabcdefghij",
        ]),
      }),
    );

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
      yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

      yield* legacyFunctionsDeploy({
        ...baseFlags,
        projectRef: Option.some("qrstuvwxyzabcdefghij"),
      });

      const deployRequest = api.requests.find(
        (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
      );
      expect(deployRequest?.url).toContain("/projects/qrstuvwxyzabcdefghij/functions/deploy");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
      ),
    );
  });

  it.live("resolves --import-map relative to the caller cwd", () => {
    const callerDir = join(tempRoot.current, "caller");
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) => {
        if (request.method === "GET") {
          return Effect.succeed(legacyJsonResponse(request, 200, []));
        }
        return Effect.succeed(
          legacyJsonResponse(request, 201, {
            id: "function-id",
            slug: "hello-world",
            name: "hello-world",
            status: "ACTIVE",
            version: 2,
            created_at: 1_687_423_025_152,
            updated_at: 1_687_423_025_152,
            verify_jwt: true,
            import_map: true,
            entrypoint_path: "supabase/functions/hello-world/index.ts",
            import_map_path: "import_map.json",
          }),
        );
      },
    });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: callerDir }),
      }),
      Layer.succeed(LegacyYesFlag, false),
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "deploy",
          "hello-world",
          "--use-api",
          "--import-map",
          "./import_map.json",
        ]),
      }),
    );

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
      yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));
      yield* Effect.tryPromise(() => mkdir(callerDir, { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(join(callerDir, "import_map.json"), '{"imports":{}}'),
      );

      yield* legacyFunctionsDeploy({
        ...baseFlags,
        importMap: Option.some("./import_map.json"),
      });

      expect(api.requests).toHaveLength(2);
      expect(out.stdoutText).toContain(
        "Deployed Functions on project abcdefghijklmnopqrst: hello-world\n",
      );
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
      ),
    );
  });

  it.live("loads project config from the resolved workdir", () => {
    const callerDir = join(tempRoot.current, "caller");
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) =>
        Effect.succeed(
          legacyJsonResponse(request, 201, {
            id: "function-id",
            slug: "configured",
            name: "configured",
            status: "ACTIVE",
            version: 2,
            created_at: 1_687_423_025_152,
            updated_at: 1_687_423_025_152,
            verify_jwt: false,
            import_map: true,
            entrypoint_path: "../supabase/functions/configured/index.ts",
            import_map_path: "../supabase/functions/configured/deno.json",
          }),
        ),
    });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: callerDir }),
      }),
      Layer.succeed(LegacyYesFlag, false),
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeProjectConfig(
          tempRoot.current,
          ['project_id = "test-project"', "[functions.configured]", "verify_jwt = false", ""].join(
            "\n",
          ),
        ),
      );
      yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "configured"));
      yield* Effect.tryPromise(() => mkdir(callerDir, { recursive: true }));

      yield* legacyFunctionsDeploy({
        ...baseFlags,
        functionNames: [],
      });

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.urlParams).toContain("slug=configured");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
      ),
    );
  });

  it.live("deploys config-declared custom entrypoints when deploying all functions", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) => {
        if (request.method === "GET") {
          return Effect.succeed(legacyJsonResponse(request, 200, []));
        }
        return Effect.succeed(
          legacyJsonResponse(request, 201, {
            id: "function-id",
            slug: "custom-entry",
            name: "custom-entry",
            status: "ACTIVE",
            version: 2,
            created_at: 1_687_423_025_152,
            updated_at: 1_687_423_025_152,
            verify_jwt: true,
            import_map: true,
            entrypoint_path: "functions/custom-entry/handler.ts",
            import_map_path: "functions/custom-entry/deno.json",
          }),
        );
      },
    });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      Layer.succeed(LegacyYesFlag, false),
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        writeProjectConfig(
          tempRoot.current,
          [
            'project_id = "test-project"',
            '[functions."custom-entry"]',
            'entrypoint = "./functions/custom-entry/handler.ts"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.tryPromise(() =>
        mkdir(join(tempRoot.current, "supabase", "functions", "custom-entry"), {
          recursive: true,
        }),
      );
      yield* Effect.tryPromise(() =>
        writeFile(
          join(tempRoot.current, "supabase", "functions", "custom-entry", "handler.ts"),
          'Deno.serve(() => new Response("custom"))\n',
        ),
      );
      yield* Effect.tryPromise(() =>
        writeFile(
          join(tempRoot.current, "supabase", "functions", "custom-entry", "deno.json"),
          '{"imports":{}}\n',
        ),
      );

      yield* legacyFunctionsDeploy({
        ...baseFlags,
        functionNames: [],
      });

      expect(api.requests).toHaveLength(2);
      const deployRequest = api.requests.find(
        (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
      );
      expect(deployRequest?.urlParams).toContain("slug=custom-entry");
      expect(out.stdoutText).toContain(
        "Deployed Functions on project abcdefghijklmnopqrst: custom-entry\n",
      );
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
      ),
    );
  });

  it.live("honors global --yes when pruning remote functions", () => {
    const out = mockOutput({ format: "text", promptConfirmFail: true });
    const api = mockLegacyPlatformApi({
      handler: (request) => {
        if (request.method === "POST") {
          return Effect.succeed(
            legacyJsonResponse(request, 201, {
              id: "function-id",
              slug: "hello-world",
              name: "hello-world",
              status: "ACTIVE",
              version: 2,
              created_at: 1_687_423_025_152,
              updated_at: 1_687_423_025_152,
              verify_jwt: true,
              import_map: true,
              entrypoint_path: "functions/hello-world/index.ts",
              import_map_path: "functions/hello-world/deno.json",
            }),
          );
        }
        if (request.method === "GET") {
          return Effect.succeed(
            legacyJsonResponse(request, 200, [
              {
                id: "remote-id",
                slug: "remote-only",
                name: "remote-only",
                status: "ACTIVE",
                version: 1,
                created_at: 1_687_423_025_152,
                updated_at: 1_687_423_025_152,
                verify_jwt: true,
                import_map: false,
              },
            ]),
          );
        }
        return Effect.succeed(legacyJsonResponse(request, 200, {}));
      },
    });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      Layer.succeed(LegacyYesFlag, true),
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "deploy",
          "hello-world",
          "--use-api",
          "--prune",
          "--yes",
        ]),
      }),
    );

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
      yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

      yield* legacyFunctionsDeploy({ ...baseFlags, prune: true });

      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(api.requests.some((request) => request.method === "DELETE")).toBe(true);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
      ),
    );
  });
});
