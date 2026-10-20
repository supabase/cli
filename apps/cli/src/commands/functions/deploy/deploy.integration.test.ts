import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Queue,
  Schema,
  Stdio,
} from "effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";

import { YesFlag } from "../../../command-internal/global-flags.ts";
import { HostedMutationDeclinedError } from "../../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { rootCommandForFeatures } from "../../../cli/root.ts";
import { cliArgsLayer, prepareCliArgs } from "../../../shared/cli/run.ts";
import { stripControlSequences } from "../../../shared/output/strip-control-sequences.ts";
import {
  type ApiHandler,
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
  withConfigEnv,
  withEnvVar,
} from "../../../../tests/helpers/command-mocks.ts";
import { cliConfigValuesTestLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { mockOutput, mockRuntimeInfo, mockTty } from "../../../../tests/helpers/mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { mockChildProcessSpawner } from "../../../../tests/helpers/child-process-spawner.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { describeHostedTargetSelection } from "../../../../tests/helpers/hosted-target-selection.ts";
import {
  deployFunctions,
  shouldChmodBundleOutputDirectory,
} from "../../../shared/functions/deploy.ts";
import { toDockerPath } from "../../../shared/functions/functions-docker.ts";
import { functionsLocalConfigLoader } from "../../../command-internal/functions-local-config.ts";
import {
  ConflictingFunctionDeployFlagsError,
  FunctionImportMapSyntaxError,
  InvalidFunctionDeploySlugError,
  NoFunctionsToDeployError,
} from "../../../shared/functions/deploy.errors.ts";
import { FunctionsApiStatusError } from "../../../shared/functions/functions-api.errors.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { functionsDeploy } from "./deploy.handler.ts";
import type { FunctionsDeployFlags } from "./deploy.command.ts";
import { branchRow } from "../../../../tests/helpers/remote-selection.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const tempRoot = useTempWorkdir("supabase-functions-deploy-legacy-");

const approvedHostedMutation = Layer.mergeAll(
  Layer.succeed(YesFlag, true),
  Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
);

const apiPathFlags = {
  "use-api": true,
  "use-docker": true,
  prune: false,
  "no-verify-jwt": false,
} as const;

const dockerPathFlags = { ...apiPathFlags, "use-api": false } as const;

const requestLines = (requests: ReadonlyArray<{ readonly method: string; readonly url: string }>) =>
  requests.map(({ method, url }) => `${method} ${url}`);

const baseFlags: FunctionsDeployFlags = {
  functionNames: ["hello-world"],
  remote: Option.none(),
  projectRef: Option.none(),
  noVerifyJwt: false,
  useApi: true,
  importMap: Option.none(),
  prune: false,
  jobs: Option.none(),
  useDocker: false,
  legacyBundle: false,
};

const deployedFunction = (slug: string) => ({
  id: `${slug}-id`,
  slug,
  name: slug,
  status: "ACTIVE",
  version: 2,
  created_at: 1_687_423_025_152,
  updated_at: 1_687_423_025_152,
  verify_jwt: true,
  import_map: true,
  entrypoint_path: `functions/${slug}/index.ts`,
  import_map_path: `functions/${slug}/deno.json`,
});

const removeTempRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(tempRoot.current, { recursive: true, force: true });
}).pipe(Effect.provide(BunServices.layer), Effect.orDie);

const writeCliConfig = Effect.fnUntraced(function* (
  cwd: string,
  content = 'project_id = "test-project"\n',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(cwd, "supabase"), { recursive: true });
  yield* fs.writeFileString(path.join(cwd, "supabase", "config.toml"), content);
});

const writeLocalFunction = Effect.fnUntraced(function* (
  cwd: string,
  slug: string,
  source = "Deno.serve(() => new Response())\n",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const functionDir = path.join(cwd, "supabase", "functions", slug);
  yield* fs.makeDirectory(functionDir, { recursive: true });
  yield* fs.writeFileString(path.join(functionDir, "index.ts"), source);
  yield* fs.writeFileString(path.join(functionDir, "deno.json"), '{"imports":{}}\n');
});

function resolveDockerOutputPath(args: ReadonlyArray<string>): string {
  const outputIndex = args.indexOf("--output");
  const outputPath = outputIndex < 0 ? undefined : args[outputIndex + 1];
  if (outputPath === undefined) {
    throw new Error("missing docker bundle output flag");
  }
  return outputPath;
}

/**
 * Mocks `docker image inspect` as a cache hit and `docker run` as writing a
 * fake eszip output, so `bundleFunctionWithDocker` completes without a real
 * Docker pull or build.
 */
function mockDockerBundleSpawner() {
  const spawnerOpts: {
    exitCode?: number;
    beforeSpawn?: (record: { command: string; args: ReadonlyArray<string> }) => Effect.Effect<void>;
  } = { exitCode: 0 };
  spawnerOpts.beforeSpawn = (record) =>
    Effect.gen(function* () {
      if (record.command !== "docker" || record.args[0] !== "run") {
        return;
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outputPath = resolveDockerOutputPath(record.args);
      yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
      yield* fs.writeFileString(outputPath, "eszip-test-output");
    }).pipe(Effect.provide(BunServices.layer), Effect.orDie);
  return mockChildProcessSpawner(spawnerOpts);
}

describe("functions deploy", () => {
  it.effect("deploys a function natively through the Management API", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.method === "GET") {
          return Effect.succeed(jsonResponse(request, 200, []));
        }
        if (request.url.endsWith("/functions/deploy")) {
          return Effect.succeed(
            jsonResponse(request, 201, {
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
        return Effect.succeed(jsonResponse(request, 404, { error: "not found" }));
      },
    });
    const linkedProjectCache = mockLinkedProjectCacheTracked();
    const telemetry = mockTelemetryStateTracked();
    const layer = Layer.mergeAll(
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        linkedProjectCache: linkedProjectCache.layer,
        telemetry: telemetry.layer,
      }),
      approvedHostedMutation,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");

      yield* functionsDeploy(baseFlags);

      expect(api.requests).toHaveLength(2);
      const deployRequest = api.requests.find(
        (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
      );
      expect(deployRequest?.url).toBe(
        "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/functions/deploy",
      );
      expect(deployRequest?.urlParams).toContain("slug=hello-world");
      expect(stripControlSequences(out.stdoutText)).toContain(
        "Deployed Functions on project abcdefghijklmnopqrst: hello-world\n",
      );
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(requestLines(api.requests)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
        `POST https://api.supabase.com/v1/projects/${VALID_REF}/functions/deploy`,
      ]);
      assertPermissionDrift({
        command: "functions deploy",
        activeFlags: apiPathFlags,
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect("picks a project interactively and fills the linked-project cache on --use-api", () => {
    const out = mockOutput({ format: "text", promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.succeed(
          request.url === "https://api.supabase.com/v1/projects"
            ? jsonResponse(request, 200, [projectResponse(VALID_REF)])
            : request.url === `https://api.supabase.com/v1/projects/${VALID_REF}`
              ? jsonResponse(request, 200, projectResponse(VALID_REF))
              : request.method === "GET"
                ? jsonResponse(request, 200, [])
                : jsonResponse(request, 201, deployedFunction("hello-world")),
        ),
    });
    const cliSettings = mockCommandSettings({
      workdir: tempRoot.current,
      projectId: Option.none(),
    });
    const layer = Layer.mergeAll(
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out,
        api,
        cliSettings,
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        tty: mockTty({ stdinIsTty: true, stdoutIsTty: true }),
        linkedProjectCache: realLinkedProjectCache({
          httpClient: api.httpClientLayer,
          cliSettings,
        }),
      }),
      approvedHostedMutation,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");
      expect(yield* fs.exists(cachePath)).toBe(false);

      yield* functionsDeploy(baseFlags);

      expect(requestLines(api.requests)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `GET https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
        `POST https://api.supabase.com/v1/projects/${VALID_REF}/functions/deploy`,
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(stripControlSequences(out.stdoutText)).toContain(
        `Deployed Functions on project ${VALID_REF}: hello-world\n`,
      );
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "functions deploy",
        activeFlags: apiPathFlags,
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect("skips the function list on --use-api --no-verify-jwt", () => {
    const { api, layer } = apiDeployHarness(deployedHelloWorld, [
      "functions",
      "deploy",
      "hello-world",
      "--use-api",
      "--no-verify-jwt",
    ]);

    return Effect.gen(function* () {
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");

      yield* functionsDeploy({ ...baseFlags, noVerifyJwt: true });

      expect(requestLines(api.requests)).toEqual([
        `POST https://api.supabase.com/v1/projects/${VALID_REF}/functions/deploy`,
      ]);
      const flags = { ...apiPathFlags, "no-verify-jwt": true };
      assertPermissionDrift({
        command: "functions deploy",
        activeFlags: flags,
        requests: api.requests,
        exact: true,
      });
      expect(() =>
        assertPermissionDrift({
          command: "functions deploy",
          activeFlags: flags,
          requests: [
            ...api.requests,
            { method: "GET", url: `https://api.supabase.com/v1/projects/${VALID_REF}/functions` },
          ],
        }),
      ).toThrow(/condition doesn't hold/);
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect("deploys through the API when --use-docker=false is passed alone", () => {
    const { api, layer } = apiDeployHarness(deployedHelloWorld, [
      "functions",
      "deploy",
      "hello-world",
      "--use-docker=false",
    ]);

    return Effect.gen(function* () {
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");

      yield* functionsDeploy({ ...baseFlags, useApi: false, useDocker: false });

      expect(requestLines(api.requests)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
        `POST https://api.supabase.com/v1/projects/${VALID_REF}/functions/deploy`,
      ]);
      assertPermissionDrift({
        command: "functions deploy",
        activeFlags: { ...apiPathFlags, "use-api": false, "use-docker": false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect("prints a duplicated slug argument verbatim", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.method === "GET") {
          return Effect.succeed(jsonResponse(request, 200, []));
        }
        if (request.url.endsWith("/functions/deploy")) {
          return Effect.succeed(
            jsonResponse(request, 201, {
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
        return Effect.succeed(jsonResponse(request, 404, { error: "not found" }));
      },
    });
    const layer = Layer.mergeAll(
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      approvedHostedMutation,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "hello-world", "hello-world", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");

      yield* functionsDeploy({
        ...baseFlags,
        functionNames: ["hello-world", "hello-world"],
      });

      expect(
        api.requests.filter(
          (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
        ),
      ).toHaveLength(1);
      expect(stripControlSequences(out.stdoutText)).toContain(
        "Deployed Functions on project abcdefghijklmnopqrst: hello-world, hello-world\n",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  describe("project selection", () => {
    const selectionHarness = (args: ReadonlyArray<string>) => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) =>
          Effect.succeed(
            request.url.endsWith("/branches")
              ? jsonResponse(request, 200, [branchRow("feature-x")])
              : request.method === "GET"
                ? jsonResponse(request, 200, [])
                : jsonResponse(request, 201, deployedFunction("hello-world")),
          ),
      });
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current, projectId: Option.none() }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        commandRuntimeLayer(["functions", "deploy"]).pipe(Layer.provide(BunServices.layer)),
        approvedHostedMutation,
        cliArgsLayer(prepareCliArgs(rootCommandForFeatures(), args)).pipe(
          Layer.provideMerge(Stdio.layerTest({ args: Effect.succeed(args) })),
        ),
      );
      const deployedTo = () =>
        api.requests
          .filter(
            (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
          )
          .map((request) => request.url);
      return { layer, deployedTo };
    };

    const linkParent = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${tempRoot.current}/supabase/.temp`, { recursive: true });
      yield* fs.writeFileString(`${tempRoot.current}/supabase/.temp/project-ref`, VALID_REF);
    }).pipe(Effect.provide(BunServices.layer));

    it.effect("fails with the branches that exist when no branch has that name", () => {
      const { layer, deployedTo } = selectionHarness([
        "functions",
        "deploy",
        "hello-world",
        "--remote=feature-y",
      ]);
      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");
        yield* linkParent;

        const error = yield* functionsDeploy({
          ...baseFlags,
          remote: Option.some({ _tag: "Branch", name: "feature-y" }),
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "LinkBranchNotFoundError",
          message: expect.stringContaining("Available branches: feature-x"),
        });
        expect(deployedTo()).toEqual([]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("stops a bare --remote that swallowed a function name that is also a branch", () => {
      const { layer, deployedTo } = selectionHarness([
        "functions",
        "deploy",
        "--remote",
        "feature-x",
      ]);
      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "feature-x");
        yield* linkParent;

        const error = yield* functionsDeploy({
          ...baseFlags,
          functionNames: ["feature-x"],
          remote: Option.some({ _tag: "Linked" }),
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "TargetRemoteAmbiguousError",
          message: `"feature-x" is a branch of project ${VALID_REF}. For the branch: supabase functions deploy --remote=feature-x. For the linked project: supabase functions deploy feature-x --remote`,
        });
        expect(deployedTo()).toEqual([]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });
  });

  it.effect("resolves --import-map relative to the caller cwd", () => {
    const callerDir = `${tempRoot.current}/caller`;
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.method === "GET") {
          return Effect.succeed(jsonResponse(request, 200, []));
        }
        return Effect.succeed(
          jsonResponse(request, 201, {
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
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: callerDir }),
      }),
      approvedHostedMutation,
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");
      yield* fs.makeDirectory(callerDir, { recursive: true });
      yield* fs.writeFileString(path.join(callerDir, "import_map.json"), '{"imports":{}}');

      yield* functionsDeploy({
        ...baseFlags,
        importMap: Option.some("./import_map.json"),
      });

      expect(api.requests).toHaveLength(2);
      expect(stripControlSequences(out.stdoutText)).toContain(
        "Deployed Functions on project abcdefghijklmnopqrst: hello-world\n",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect("loads project config from the resolved workdir", () => {
    const callerDir = `${tempRoot.current}/caller`;
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.succeed(
          jsonResponse(request, 201, {
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
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: callerDir }),
      }),
      approvedHostedMutation,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* writeCliConfig(
        tempRoot.current,
        ['project_id = "test-project"', "[functions.configured]", "verify_jwt = false", ""].join(
          "\n",
        ),
      );
      yield* writeLocalFunction(tempRoot.current, "configured");
      yield* fs.makeDirectory(callerDir, { recursive: true });

      yield* functionsDeploy({
        ...baseFlags,
        functionNames: [],
      });

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.urlParams).toContain("slug=configured");
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect(
    "rejects a bundled file whose workdir-relative name escapes with a `..` segment",
    () => {
      // Uploaded paths are anchored at the workdir, not the git root, so this
      // monorepo import fails the `fs.FS` boundary check before upload.
      const repoRoot = tempRoot.current;
      const workdir = `${repoRoot}/app`;
      const multiparts: Array<{ metadata?: string; fileNames: ReadonlyArray<string> }> = [];
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          if (Predicate.isTagged(request.body, "FormData")) {
            const metadata = request.body.formData.get("metadata");
            multiparts.push({
              metadata: typeof metadata === "string" ? metadata : undefined,
              fileNames: request.body.formData
                .getAll("file")
                .flatMap((part) => (part instanceof File ? [part.name] : [])),
            });
          }
          if (request.method === "GET") {
            return Effect.succeed(jsonResponse(request, 200, []));
          }
          return Effect.succeed(
            jsonResponse(request, 201, {
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
              import_map_path: "supabase/functions/hello-world/deno.json",
            }),
          );
        },
      });
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir }),
          runtimeInfo: mockRuntimeInfo({ cwd: workdir }),
        }),
        approvedHostedMutation,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api"]),
        }),
      );

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(repoRoot, ".git"), { recursive: true });
        yield* writeCliConfig(workdir);
        yield* writeLocalFunction(
          workdir,
          "hello-world",
          'import { shared } from "@repo/shared"\nDeno.serve(() => new Response(shared))\n',
        );
        yield* fs.makeDirectory(path.join(repoRoot, "packages", "shared", "src"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(repoRoot, "packages", "shared", "src", "index.ts"),
          'export const shared = "ok"\n',
        );
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "functions", "hello-world", "deno.json"),
          '{"imports":{"@repo/shared":"../../../../packages/shared/src/index.ts"}}',
        );

        const exit = yield* Effect.exit(functionsDeploy(baseFlags));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain(
            "failed to read file: open ../packages/shared/src/index.ts: invalid argument",
          );
        }
        expect(multiparts).toHaveLength(0);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    },
  );

  function apiDeployHarness(
    handler: ApiHandler,
    args: ReadonlyArray<string> = ["functions", "deploy", "hello-world", "--use-api"],
    rateLimitNotices?: Queue.Enqueue<string>,
  ) {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ handler });
    const layer = Layer.mergeAll(
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out:
          rateLimitNotices === undefined
            ? out
            : {
                ...out,
                layer: Layer.effect(
                  Output,
                  Effect.gen(function* () {
                    const output = yield* Output;
                    return {
                      ...output,
                      raw: (text: string, stream?: "stdout" | "stderr") =>
                        output
                          .raw(text, stream)
                          .pipe(
                            Effect.tap(() =>
                              text.startsWith("Rate limit exceeded")
                                ? Queue.offer(rateLimitNotices, text)
                                : Effect.void,
                            ),
                          ),
                    };
                  }),
                ).pipe(Layer.provide(out.layer)),
              },
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      approvedHostedMutation,
      Stdio.layerTest({ args: Effect.succeed(args) }),
    );
    return { out, api, layer };
  }

  const deployedHelloWorld: ApiHandler = (request) =>
    Effect.succeed(
      request.method === "GET"
        ? jsonResponse(request, 200, [])
        : jsonResponse(request, 201, {
            id: "function-id",
            slug: "hello-world",
            name: "hello-world",
            status: "ACTIVE",
            version: 2,
          }),
    );

  it.effect("warns about an invalid static_files glob instead of failing the deploy", () => {
    const { out, api, layer } = apiDeployHarness(deployedHelloWorld);

    return Effect.gen(function* () {
      yield* writeCliConfig(
        tempRoot.current,
        'project_id = "test-project"\n[functions.hello-world]\nstatic_files = ["./assets/[z-a].txt"]\n',
      );
      yield* writeLocalFunction(tempRoot.current, "hello-world");

      yield* functionsDeploy(baseFlags);

      expect(out.stderrText).toContain("WARN: Invalid regular expression");
      expect(
        api.requests.some(
          (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect("reports a malformed deno.json with the schema decoder's message", () => {
    const { api, layer } = apiDeployHarness(deployedHelloWorld);

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");
      yield* fs.writeFileString(
        path.join(tempRoot.current, "supabase", "functions", "hello-world", "deno.json"),
        "{",
      );

      const error = yield* functionsDeploy(baseFlags).pipe(Effect.flip);

      expect(error).toBeInstanceOf(FunctionImportMapSyntaxError);
      expect(error).toMatchObject({ name: "SyntaxError", message: "Expected a valid JSON string" });
      expect(api.requests.some((request) => request.method === "POST")).toBe(false);
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect(
    "reports a failed progress write while collecting upload files as a typed failure",
    () => {
      const out = mockOutput({ format: "text" });
      const brokenPipe = new Error("EPIPE: broken pipe, write");
      const api = mockCommandPlatformApi({ handler: deployedHelloWorld });
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out: {
            ...out,
            layer: Layer.effect(
              Output,
              Effect.gen(function* () {
                const output = yield* Output;
                return {
                  ...output,
                  raw: (text: string, stream?: "stdout" | "stderr") =>
                    text.startsWith("Uploading asset")
                      ? Effect.die(brokenPipe)
                      : output.raw(text, stream),
                };
              }),
            ).pipe(Layer.provide(out.layer)),
          },
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api"]),
        }),
      );

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        const error = yield* functionsDeploy(baseFlags).pipe(Effect.flip);

        expect(error).toBe(brokenPipe);
        expect(api.requests.some((request) => request.method === "POST")).toBe(false);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    },
  );

  describe("per-function import_map.json", () => {
    const functionDir = (slug: string) => `${tempRoot.current}/supabase/functions/${slug}`;

    const harnessRecordingImportMapPaths = () => {
      const importMapPaths: Array<string> = [];
      const harness = apiDeployHarness((request, recorded) => {
        if (Predicate.isTagged(request.body, "FormData")) {
          const metadata = request.body.formData.get("metadata");
          if (typeof metadata === "string")
            importMapPaths.push(JSON.parse(metadata).import_map_path);
        }
        return deployedHelloWorld(request, recorded);
      });
      return { ...harness, importMapPaths };
    };

    it.effect(
      "fails every function that only has import_map.json before anything is uploaded",
      () => {
        const { api, layer } = apiDeployHarness(deployedHelloWorld);

        return Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* writeCliConfig(tempRoot.current);
          for (const slug of ["hello-world", "other-fn"]) {
            yield* writeLocalFunction(tempRoot.current, slug);
            yield* fs.remove(`${functionDir(slug)}/deno.json`);
            yield* fs.writeFileString(`${functionDir(slug)}/import_map.json`, '{"imports":{}}\n');
          }

          const error = yield* functionsDeploy({
            ...baseFlags,
            functionNames: [],
          }).pipe(Effect.flip);

          expect(error).toMatchObject({
            message: expect.stringContaining("hello-world, other-fn"),
            suggestion:
              'Rename it to deno.json, or set functions.hello-world.import_map = "./functions/hello-world/import_map.json" in config.toml to keep the file.',
          });
          expect(api.requests).toEqual([]);
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
      },
    );

    it.effect(
      "suggests a parent-relative import_map path for an entrypoint outside supabase/",
      () => {
        const { api, layer } = apiDeployHarness(deployedHelloWorld);

        return Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* writeCliConfig(
            tempRoot.current,
            [
              'project_id = "test-project"',
              '[functions."hello-world"]',
              'entrypoint = "../src/hello-world/index.ts"',
              "",
            ].join("\n"),
          );
          const sourceDir = `${tempRoot.current}/src/hello-world`;
          yield* fs.makeDirectory(sourceDir, { recursive: true });
          yield* fs.writeFileString(`${sourceDir}/index.ts`, "Deno.serve(() => new Response())\n");
          yield* fs.writeFileString(`${sourceDir}/import_map.json`, '{"imports":{}}\n');

          const error = yield* functionsDeploy(baseFlags).pipe(Effect.flip);

          expect(error).toMatchObject({
            suggestion:
              'Rename it to deno.json, or set functions.hello-world.import_map = "../src/hello-world/import_map.json" in config.toml to keep the file.',
          });
          expect(api.requests).toEqual([]);
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
      },
    );

    it.effect("deploys with deno.json when the function directory has both files", () => {
      const { importMapPaths, layer } = harnessRecordingImportMapPaths();

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");
        yield* fs.writeFileString(
          `${functionDir("hello-world")}/import_map.json`,
          '{"imports":{}}\n',
        );

        yield* functionsDeploy(baseFlags);

        expect(importMapPaths).toEqual(["supabase/functions/hello-world/deno.json"]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("deploys an import_map.json that config.toml names explicitly", () => {
      const { importMapPaths, layer } = harnessRecordingImportMapPaths();

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeCliConfig(
          tempRoot.current,
          [
            'project_id = "test-project"',
            '[functions."hello-world"]',
            'import_map = "./functions/hello-world/import_map.json"',
            "",
          ].join("\n"),
        );
        yield* writeLocalFunction(tempRoot.current, "hello-world");
        yield* fs.remove(`${functionDir("hello-world")}/deno.json`);
        yield* fs.writeFileString(
          `${functionDir("hello-world")}/import_map.json`,
          '{"imports":{}}\n',
        );

        yield* functionsDeploy(baseFlags);

        expect(importMapPaths).toEqual(["supabase/functions/hello-world/import_map.json"]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect(
      "uses the shared fallback import map for an entrypoint directly under functions/",
      () => {
        const { importMapPaths, out, layer } = harnessRecordingImportMapPaths();

        return Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* writeCliConfig(
            tempRoot.current,
            [
              'project_id = "test-project"',
              '[functions."hello-world"]',
              'entrypoint = "./functions/hello-world.ts"',
              "",
            ].join("\n"),
          );
          yield* fs.makeDirectory(`${tempRoot.current}/supabase/functions`, { recursive: true });
          yield* fs.writeFileString(
            `${tempRoot.current}/supabase/functions/hello-world.ts`,
            "Deno.serve(() => new Response())\n",
          );
          yield* fs.writeFileString(
            `${tempRoot.current}/supabase/functions/import_map.json`,
            '{"imports":{}}\n',
          );

          yield* functionsDeploy(baseFlags);

          expect(importMapPaths).toEqual(["supabase/functions/import_map.json"]);
          expect(out.stderrText).toContain(
            "WARNING: Functions using fallback import map: hello-world\n",
          );
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
      },
    );

    it.effect(
      "skips a disabled function that only has import_map.json and deploys the enabled ones",
      () => {
        const { out, api, layer } = apiDeployHarness(deployedHelloWorld);

        return Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* writeCliConfig(
            tempRoot.current,
            ['project_id = "test-project"', '[functions."legacy-fn"]', "enabled = false", ""].join(
              "\n",
            ),
          );
          yield* writeLocalFunction(tempRoot.current, "hello-world");
          yield* writeLocalFunction(tempRoot.current, "legacy-fn");
          yield* fs.remove(`${functionDir("legacy-fn")}/deno.json`);
          yield* fs.writeFileString(
            `${functionDir("legacy-fn")}/import_map.json`,
            '{"imports":{}}\n',
          );

          yield* functionsDeploy({ ...baseFlags, functionNames: [] });

          const deployRequests = api.requests.filter(
            (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
          );
          expect(deployRequests).toHaveLength(1);
          expect(deployRequests[0]?.urlParams).toContain("slug=hello-world");
          expect(api.requests.some((request) => request.urlWithParams.includes("legacy-fn"))).toBe(
            false,
          );
          expect(out.stderrText).toContain("Skipping disabled Function: legacy-fn\n");
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
      },
    );
  });

  it.effect("keeps collecting upload files after the deploy is interrupted", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ handler: deployedHelloWorld });
    const started = Deferred.makeUnsafe<void>();
    const gate = Deferred.makeUnsafe<void>();
    const continued = Deferred.makeUnsafe<void>();
    const layer = Layer.mergeAll(
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out: {
          ...out,
          layer: Layer.effect(
            Output,
            Effect.gen(function* () {
              const output = yield* Output;
              return {
                ...output,
                raw: (text: string, stream?: "stdout" | "stderr") =>
                  text.startsWith("Uploading asset")
                    ? Deferred.succeed(started, undefined).pipe(
                        Effect.flatMap((first) =>
                          first
                            ? Deferred.await(gate).pipe(Effect.andThen(output.raw(text, stream)))
                            : output
                                .raw(text, stream)
                                .pipe(Effect.tap(Deferred.succeed(continued, undefined))),
                        ),
                      )
                    : output.raw(text, stream),
              };
            }),
          ).pipe(Layer.provide(out.layer)),
        },
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      approvedHostedMutation,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");

      const deploy = yield* Effect.forkChild(functionsDeploy(baseFlags));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(deploy);
      yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(continued);

      expect(out.stderrText).toContain(
        "Uploading asset (hello-world): supabase/functions/hello-world/deno.json\n",
      );
      expect(out.stderrText).toContain(
        "Uploading asset (hello-world): supabase/functions/hello-world/index.ts\n",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect("reports a malformed deploy response with the schema decoder's message", () => {
    const { layer } = apiDeployHarness((request) =>
      Effect.succeed(
        request.method === "GET"
          ? jsonResponse(request, 200, [])
          : HttpClientResponse.fromWeb(request, new Response("{", { status: 201 })),
      ),
    );

    return Effect.gen(function* () {
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");

      const error = yield* functionsDeploy(baseFlags).pipe(Effect.flip);

      expect(error).toBeInstanceOf(FunctionsApiStatusError);
      expect(error).toMatchObject({
        status: 201,
        decode: true,
        message: "failed to read deploy response: Expected a valid JSON string",
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect("retries a rate-limited deploy only through the command's own loop", () => {
    let deployAttempts = 0;
    const { layer, out, api } = apiDeployHarness((request) => {
      if (request.method === "GET") return Effect.succeed(jsonResponse(request, 200, []));
      deployAttempts += 1;
      if (deployAttempts === 1) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
          ),
        );
      }
      return Effect.succeed(
        jsonResponse(request, 201, {
          id: "function-id",
          slug: "hello-world",
          name: "hello-world",
          status: "ACTIVE",
          version: 1,
        }),
      );
    });

    return Effect.gen(function* () {
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");

      yield* functionsDeploy(baseFlags);

      expect(api.requests.filter((request) => request.method === "POST")).toHaveLength(2);
      expect(out.stderrText).toContain("Rate limit exceeded while deploying function hello-world.");
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect("gives up on a persistent rate limit after the command's backoff schedule", () =>
    Effect.gen(function* () {
      const notices = yield* Queue.unbounded<string>();
      const deployTimes: Array<number> = [];
      const { layer } = apiDeployHarness(
        (request) =>
          request.method === "GET"
            ? Effect.succeed(jsonResponse(request, 200, []))
            : Effect.gen(function* () {
                deployTimes.push(yield* Clock.currentTimeMillis);
                return HttpClientResponse.fromWeb(request, new Response("{}", { status: 429 }));
              }),
        undefined,
        notices,
      );

      yield* Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        const deploy = yield* Effect.forkChild(functionsDeploy(baseFlags));
        for (const seconds of [1, 2, 4, 8, 16, 32, 32, 32]) {
          expect(yield* Queue.take(notices)).toBe(
            `Rate limit exceeded while deploying function hello-world. Retrying in ${seconds}s.\n`,
          );
          yield* TestClock.adjust(Duration.seconds(seconds));
        }
        const error = yield* Fiber.join(deploy).pipe(Effect.flip);

        expect(error).toBeInstanceOf(FunctionsApiStatusError);
        expect(error).toMatchObject({ status: 429 });
        expect(deployTimes).toEqual([
          0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 95_000, 127_000,
        ]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    }),
  );

  it.effect("waits for the server's retry-after before retrying a rate-limited deploy", () =>
    Effect.gen(function* () {
      const notices = yield* Queue.unbounded<string>();
      let deployAttempts = 0;
      const { layer, api } = apiDeployHarness(
        (request, recorded) => {
          if (request.method === "GET") return Effect.succeed(jsonResponse(request, 200, []));
          deployAttempts += 1;
          if (deployAttempts === 1) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("{}", { status: 429, headers: { "retry-after": "3" } }),
              ),
            );
          }
          return deployedHelloWorld(request, recorded);
        },
        undefined,
        notices,
      );
      const deployRequests = () => api.requests.filter((request) => request.method === "POST");

      yield* Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        const deploy = yield* Effect.forkChild(functionsDeploy(baseFlags));
        expect(yield* Queue.take(notices)).toBe(
          "Rate limit exceeded while deploying function hello-world. Retrying in 3s.\n",
        );
        yield* TestClock.adjust(Duration.millis(2_999));
        expect(deployRequests()).toHaveLength(1);
        yield* TestClock.adjust(Duration.millis(1));
        yield* Fiber.join(deploy);

        expect(deployRequests()).toHaveLength(2);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    }),
  );

  it.effect("reports a malformed functions list with the schema decoder's message", () => {
    const { layer } = apiDeployHarness((request) =>
      Effect.succeed(
        request.method === "GET" && request.url.endsWith("/functions")
          ? HttpClientResponse.fromWeb(request, new Response("{", { status: 200 }))
          : jsonResponse(request, 200, []),
      ),
    );

    return Effect.gen(function* () {
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");

      const error = yield* functionsDeploy(baseFlags).pipe(Effect.flip);

      expect(error).toBeInstanceOf(FunctionsApiStatusError);
      expect(error).toMatchObject({
        status: 200,
        decode: true,
        message: "failed to read functions list: Expected a valid JSON string",
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.live(
    "reports a malformed Docker-bundled function response with the schema decoder's message",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) =>
          Effect.succeed(
            request.method === "GET"
              ? jsonResponse(request, 200, [])
              : HttpClientResponse.fromWeb(request, new Response("{", { status: 201 })),
          ),
      });
      const child = mockDockerBundleSpawner();
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
        }),
      );

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        const error = yield* functionsDeploy({ ...baseFlags, useApi: false, useDocker: true }).pipe(
          Effect.flip,
        );

        expect(error).toBeInstanceOf(FunctionsApiStatusError);
        expect(error).toMatchObject({
          status: 201,
          decode: true,
          message: "failed to read function response: Expected a valid JSON string",
        });
        expect(requestLines(api.requests)).toEqual([
          `GET https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
          `POST https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
        ]);
        assertPermissionDrift({
          command: "functions deploy",
          activeFlags: dockerPathFlags,
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    },
  );

  it.live(
    "creates an undeployed function, updates a deployed one and bulk-updates both via Docker",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          if (request.method === "GET") {
            return Effect.succeed(
              jsonResponse(request, 200, [
                { ...deployedFunction("bye-world"), ezbr_sha256: "stale-digest" },
              ]),
            );
          }
          if (request.method === "PUT") {
            return Effect.succeed(jsonResponse(request, 200, {}));
          }
          const slug = request.url.endsWith("/functions/bye-world") ? "bye-world" : "hello-world";
          return Effect.succeed(
            jsonResponse(request, request.method === "POST" ? 201 : 200, deployedFunction(slug)),
          );
        },
      });
      const child = mockDockerBundleSpawner();
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "bye-world"]),
        }),
      );

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");
        yield* writeLocalFunction(tempRoot.current, "bye-world");

        yield* functionsDeploy({
          ...baseFlags,
          functionNames: ["hello-world", "bye-world"],
          useApi: false,
          useDocker: true,
        });

        expect(requestLines(api.requests)).toEqual([
          `GET https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
          `POST https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
          `PATCH https://api.supabase.com/v1/projects/${VALID_REF}/functions/bye-world`,
          `PUT https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
        ]);
        assertPermissionDrift({
          command: "functions deploy",
          activeFlags: dockerPathFlags,
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    },
  );

  it.effect("reports a NUL byte in an imported path as the raw host TypeError", () => {
    const { layer } = apiDeployHarness(deployedHelloWorld);

    return Effect.gen(function* () {
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(
        tempRoot.current,
        "hello-world",
        'import "./a\u0000b.ts";\nDeno.serve(() => new Response())\n',
      );

      const error = yield* functionsDeploy(baseFlags).pipe(Effect.flip);

      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({
        code: "ERR_INVALID_ARG_VALUE",
        message: expect.stringContaining("without null bytes"),
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.live("reports a bundle output directory that cannot be created as an unknown error", () => {
    const out = mockOutput({ format: "text" });
    const child = mockDockerBundleSpawner();
    const layer = Layer.mergeAll(
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out,
        api: mockCommandPlatformApi({ handler: deployedHelloWorld }),
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      approvedHostedMutation,
      child.layer,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");
      // A dangling `.temp` link reads as unlinked yet cannot be created.
      yield* fs.symlink(
        path.join(tempRoot.current, "missing-target"),
        path.join(tempRoot.current, "supabase", ".temp"),
      );

      const error = yield* functionsDeploy({ ...baseFlags, useApi: false, useDocker: true }).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(Cause.UnknownError);
      expect(error).toMatchObject({
        message: "An error occurred in Effect.tryPromise",
        cause: expect.objectContaining({ code: "EEXIST" }),
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  it.effect("deploys config-declared custom entrypoints when deploying all functions", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.method === "GET") {
          return Effect.succeed(jsonResponse(request, 200, []));
        }
        return Effect.succeed(
          jsonResponse(request, 201, {
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
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      approvedHostedMutation,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeCliConfig(
        tempRoot.current,
        [
          'project_id = "test-project"',
          '[functions."custom-entry"]',
          'entrypoint = "./functions/custom-entry/handler.ts"',
          "",
        ].join("\n"),
      );
      yield* fs.makeDirectory(
        path.join(tempRoot.current, "supabase", "functions", "custom-entry"),
        { recursive: true },
      );
      yield* fs.writeFileString(
        path.join(tempRoot.current, "supabase", "functions", "custom-entry", "handler.ts"),
        'Deno.serve(() => new Response("custom"))\n',
      );
      yield* fs.writeFileString(
        path.join(tempRoot.current, "supabase", "functions", "custom-entry", "deno.json"),
        '{"imports":{}}\n',
      );

      yield* functionsDeploy({
        ...baseFlags,
        functionNames: [],
      });

      expect(api.requests).toHaveLength(2);
      const deployRequest = api.requests.find(
        (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
      );
      expect(deployRequest?.urlParams).toContain("slug=custom-entry");
      expect(stripControlSequences(out.stdoutText)).toContain(
        "Deployed Functions on project abcdefghijklmnopqrst: custom-entry\n",
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  describe("--prune consent", () => {
    const pruneArgs = ["functions", "deploy", "hello-world", "--use-api", "--prune"];
    const pruneApiHandler: ApiHandler = (request) => {
      if (request.method === "POST") {
        return Effect.succeed(jsonResponse(request, 201, deployedFunction("hello-world")));
      }
      if (request.method === "GET") {
        return Effect.succeed(
          jsonResponse(request, 200, [{ ...deployedFunction("remote-only"), version: 1 }]),
        );
      }
      return Effect.succeed(jsonResponse(request, 200, {}));
    };

    const setupPrune = (opts: {
      readonly yes: boolean;
      readonly interactive?: boolean;
      readonly confirmResponses?: ReadonlyArray<boolean>;
      readonly format?: "text" | "json";
      readonly handler?: ApiHandler;
    }) => {
      const out = mockOutput({
        format: opts.format ?? "text",
        interactive: opts.interactive,
        promptConfirmResponses: opts.confirmResponses,
      });
      const api = mockCommandPlatformApi({ handler: opts.handler ?? pruneApiHandler });
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          tty: mockTty({
            stdinIsTty: opts.interactive ?? false,
            stdoutIsTty: opts.interactive ?? false,
          }),
        }),
        Layer.succeed(YesFlag, opts.yes),
        Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
        Stdio.layerTest({ args: Effect.succeed(opts.yes ? [...pruneArgs, "--yes"] : pruneArgs) }),
      );
      return { out, api, layer };
    };

    const mutations = (api: { readonly requests: ReadonlyArray<{ readonly method: string }> }) =>
      api.requests.filter((request) => request.method !== "GET");

    it.effect(
      "deletes pruned functions under --yes after echoing one combined confirmation",
      () => {
        const { out, api, layer } = setupPrune({ yes: true });

        return Effect.gen(function* () {
          yield* writeCliConfig(tempRoot.current);
          yield* writeLocalFunction(tempRoot.current, "hello-world");

          yield* functionsDeploy({ ...baseFlags, prune: true });

          expect(stripControlSequences(out.stderrText)).toContain(
            "Confirmed by --yes: Deploy 1 Function and delete 1 Function with --prune on project",
          );
          expect(out.promptConfirmCalls).toHaveLength(0);
          expect(api.requests.some((request) => request.method === "DELETE")).toBe(true);
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
      },
    );

    it.effect("asks one question covering the deploy and the prune before deploying", () => {
      const { out, api, layer } = setupPrune({
        yes: false,
        interactive: true,
        confirmResponses: [true],
      });

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        yield* functionsDeploy({ ...baseFlags, prune: true });

        expect(out.promptConfirmCalls).toHaveLength(1);
        expect(out.promptConfirmCalls[0]?.message).toContain(
          "Deploy 1 Function and delete 1 Function with --prune",
        );
        expect(out.promptConfirmCalls[0]?.opts?.defaultValue).toBe(false);
        expect(stripControlSequences(out.stderrText)).toContain(
          "Functions to deploy:\n • hello-world\nFunctions to delete (not found locally):\n • remote-only\n",
        );
        expect(mutations(api).map((request) => request.method)).toEqual(["POST", "DELETE"]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("emits one json success envelope once the prune has finished", () => {
      let messagesWhenDeleting: number | undefined;
      const { out, layer } = setupPrune({
        yes: true,
        format: "json",
        handler: (request, recorded) => {
          if (request.method === "DELETE") messagesWhenDeleting = out.messages.length;
          return pruneApiHandler(request, recorded);
        },
      });

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        yield* functionsDeploy({ ...baseFlags, prune: true }).pipe(withJsonErrorHandling);

        expect(messagesWhenDeleting).toBe(0);
        expect(out.messages).toEqual([
          {
            type: "success",
            message: "Deployed Functions.",
            data: {
              project_ref: VALID_REF,
              functions: ["hello-world"],
              dashboard_url: `https://supabase.com/dashboard/project/${VALID_REF}/functions`,
            },
          },
        ]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("emits only the failure envelope when the prune fails after a deploy", () => {
      const { out, api, layer } = setupPrune({
        yes: true,
        format: "json",
        handler: (request, recorded) =>
          request.method === "DELETE"
            ? Effect.succeed(jsonResponse(request, 500, { message: "boom" }))
            : pruneApiHandler(request, recorded),
      });

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        yield* functionsDeploy({ ...baseFlags, prune: true }).pipe(withJsonErrorHandling);

        expect(api.requests.some((request) => request.method === "POST")).toBe(true);
        expect(out.messages.map((message) => message.type)).toEqual(["fail"]);
        expect(out.failures[0]?.message).toContain("unexpected delete function status 500");
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("emits the up-to-date json envelope after pruning when nothing is enabled", () => {
      let messagesWhenDeleting: number | undefined;
      const { out, layer } = setupPrune({
        yes: true,
        format: "json",
        handler: (request, recorded) => {
          if (request.method === "DELETE") messagesWhenDeleting = out.messages.length;
          return pruneApiHandler(request, recorded);
        },
      });

      return Effect.gen(function* () {
        yield* writeCliConfig(
          tempRoot.current,
          ['project_id = "test-project"', '[functions."hello-world"]', "enabled = false", ""].join(
            "\n",
          ),
        );
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        yield* functionsDeploy({ ...baseFlags, prune: true }).pipe(withJsonErrorHandling);

        expect(messagesWhenDeleting).toBe(0);
        expect(out.messages.map((message) => [message.type, message.message])).toEqual([
          ["success", "All Functions are up to date."],
        ]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("deploys and deletes nothing when the combined question is declined", () => {
      const { api, layer } = setupPrune({
        yes: false,
        interactive: true,
        confirmResponses: [false],
      });

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        const error = yield* functionsDeploy({ ...baseFlags, prune: true }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(HostedMutationDeclinedError);
        expect(mutations(api)).toEqual([]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });
  });

  it.effect("lists remote functions only for --prune when --no-verify-jwt is passed", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.method === "POST") {
          return Effect.succeed(jsonResponse(request, 201, deployedFunction("hello-world")));
        }
        if (request.method === "GET") {
          return Effect.succeed(
            jsonResponse(request, 200, [{ ...deployedFunction("remote-only"), import_map: false }]),
          );
        }
        return Effect.succeed(jsonResponse(request, 200, {}));
      },
    });
    const layer = Layer.mergeAll(
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      approvedHostedMutation,
      Stdio.layerTest({
        args: Effect.succeed([
          "functions",
          "deploy",
          "hello-world",
          "--use-api",
          "--no-verify-jwt",
          "--prune",
          "--yes",
        ]),
      }),
    );

    return Effect.gen(function* () {
      yield* writeCliConfig(tempRoot.current);
      yield* writeLocalFunction(tempRoot.current, "hello-world");

      yield* functionsDeploy({ ...baseFlags, noVerifyJwt: true, prune: true });

      expect(requestLines(api.requests)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
        `POST https://api.supabase.com/v1/projects/${VALID_REF}/functions/deploy`,
        `DELETE https://api.supabase.com/v1/projects/${VALID_REF}/functions/remote-only`,
      ]);
      assertPermissionDrift({
        command: "functions deploy",
        activeFlags: { ...apiPathFlags, "no-verify-jwt": true, prune: true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
  });

  // A `bundleOnly` upload bumps the remote version without persisting metadata,
  // so a partially failed bulk deploy must still send the final PUT for whatever
  // uploaded, or the remote metadata is stranded and later deploys conflict.
  describe("partial bulk upload failures (INC-699)", () => {
    function setupBulkDeploy(opts: {
      readonly deployStatuses: ReadonlyArray<number>;
      readonly bulkStatuses?: ReadonlyArray<number>;
      readonly functionStatuses?: Readonly<Record<string, string>>;
    }) {
      const out = mockOutput({ format: "text" });
      let deployCalls = 0;
      let bulkCalls = 0;
      const api = mockCommandPlatformApi({
        handler: (request, recorded) => {
          if (request.method === "GET") {
            return Effect.succeed(jsonResponse(request, 200, []));
          }
          if (request.method === "POST") {
            const status = opts.deployStatuses[deployCalls] ?? 201;
            deployCalls += 1;
            const slug = recorded.urlParams.includes("slug=bye-world")
              ? "bye-world"
              : "hello-world";
            if (status !== 201) {
              return Effect.succeed(jsonResponse(request, status, { message: `rejected ${slug}` }));
            }
            return Effect.succeed(
              jsonResponse(request, 201, {
                id: `${slug}-id`,
                slug,
                name: slug,
                status: opts.functionStatuses?.[slug] ?? "ACTIVE",
                version: 2,
                created_at: 1_687_423_025_152,
                updated_at: 1_687_423_025_152,
                verify_jwt: true,
                import_map: true,
                entrypoint_path: `functions/${slug}/index.ts`,
                import_map_path: `functions/${slug}/deno.json`,
              }),
            );
          }
          if (request.method === "PUT") {
            const status = opts.bulkStatuses?.[bulkCalls] ?? 200;
            bulkCalls += 1;
            if (status !== 200) {
              return Effect.succeed(
                jsonResponse(request, status, { message: "bulk update rejected" }),
              );
            }
          }
          return Effect.succeed(jsonResponse(request, 200, {}));
        },
      });
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "bye-world", "--use-api"]),
        }),
      );
      return { out, api, layer };
    }

    it.effect("still persists the functions that uploaded when one upload fails", () => {
      const { out, api, layer } = setupBulkDeploy({ deployStatuses: [201, 409] });

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");
        yield* writeLocalFunction(tempRoot.current, "bye-world");

        const error = yield* functionsDeploy({
          ...baseFlags,
          functionNames: ["hello-world", "bye-world"],
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          message: 'unexpected deploy status 409: {"message":"rejected bye-world"}',
        });

        expect(
          api.requests.filter(
            (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
          ),
        ).toHaveLength(2);
        const bulkUpdate = api.requests.find((request) => request.method === "PUT");
        expect(bulkUpdate?.body).toMatchObject([{ slug: "hello-world" }]);
        expect(out.stdoutText).not.toContain("Deployed Functions on project");
        assertPermissionDrift({
          command: "functions deploy",
          activeFlags: apiPathFlags,
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("skips the bulk update entirely when every upload fails", () => {
      const { out, api, layer } = setupBulkDeploy({ deployStatuses: [409, 400] });

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");
        yield* writeLocalFunction(tempRoot.current, "bye-world");

        const error = yield* functionsDeploy({
          ...baseFlags,
          functionNames: ["hello-world", "bye-world"],
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          message: [
            'unexpected deploy status 409: {"message":"rejected hello-world"}',
            'unexpected deploy status 400: {"message":"rejected bye-world"}',
          ].join("\n"),
        });
        expect(
          api.requests.filter(
            (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
          ),
        ).toHaveLength(2);
        expect(api.requests.some((request) => request.method === "PUT")).toBe(false);
        expect(out.stdoutText).not.toContain("Deployed Functions on project");
        assertPermissionDrift({
          command: "functions deploy",
          activeFlags: apiPathFlags,
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("fails loudly instead of coercing a function status the API newly reports", () => {
      const { api, layer } = setupBulkDeploy({
        deployStatuses: [201, 201],
        functionStatuses: { "bye-world": "SUSPENDED" },
      });

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");
        yield* writeLocalFunction(tempRoot.current, "bye-world");

        const error = yield* functionsDeploy({
          ...baseFlags,
          functionNames: ["hello-world", "bye-world"],
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          message: "failed to read function bye-world: unexpected status SUSPENDED",
        });
        const bulkUpdate = api.requests.find((request) => request.method === "PUT");
        expect(bulkUpdate?.body).toMatchObject([{ slug: "hello-world", status: "ACTIVE" }]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("reports the upload failure and the bulk update failure together", () => {
      const { api, layer } = setupBulkDeploy({
        deployStatuses: [201, 409],
        bulkStatuses: [400],
      });

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");
        yield* writeLocalFunction(tempRoot.current, "bye-world");

        const error = yield* functionsDeploy({
          ...baseFlags,
          functionNames: ["hello-world", "bye-world"],
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          message: [
            'unexpected deploy status 409: {"message":"rejected bye-world"}',
            'unexpected bulk update status 400: {"message":"bulk update rejected"}',
          ].join("\n"),
        });
        expect(api.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
        assertPermissionDrift({
          command: "functions deploy",
          activeFlags: apiPathFlags,
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });
  });

  it.effect("rejects the bundler mutex with the exact error text", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const layer = Layer.mergeAll(
      cliConfigValuesTestLayer,
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      approvedHostedMutation,
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api", "--use-docker"]),
      }),
    );

    return Effect.gen(function* () {
      const error = yield* functionsDeploy({ ...baseFlags, useDocker: true }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConflictingFunctionDeployFlagsError);
      if (!(error instanceof ConflictingFunctionDeployFlagsError)) {
        throw new Error(`unexpected error: ${String(error)}`);
      }
      expect(error.message).toBe(
        "if any flags in the group [use-api use-docker legacy-bundle] are set none of the others can be; [use-api use-docker] were all set",
      );
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  describe("--jobs validation", () => {
    function setupJobsTest(rawArgs: ReadonlyArray<string>) {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) => Effect.succeed(jsonResponse(request, 200, [])),
      });
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        Stdio.layerTest({ args: Effect.succeed(rawArgs) }),
      );
      return { out, api, layer };
    }

    it.effect("rejects --jobs > 1 without --use-api, even with default --use-docker", () => {
      const { layer } = setupJobsTest(["functions", "deploy", "hello-world", "--jobs", "2"]);

      return Effect.gen(function* () {
        const error = yield* functionsDeploy({
          ...baseFlags,
          useApi: false,
          useDocker: true,
          jobs: Option.some(2),
        }).pipe(Effect.provide(layer), Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ message: "--jobs must be used together with --use-api" });
      });
    });

    it.effect("rejects --jobs > 1 with --use-docker=false and no --use-api", () => {
      const { layer } = setupJobsTest([
        "functions",
        "deploy",
        "hello-world",
        "--use-docker=false",
        "--jobs",
        "2",
      ]);

      return Effect.gen(function* () {
        const error = yield* functionsDeploy({
          ...baseFlags,
          useApi: false,
          useDocker: false,
          jobs: Option.some(2),
        }).pipe(Effect.provide(layer), Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ message: "--jobs must be used together with --use-api" });
      });
    });

    it.effect("allows --jobs > 1 together with --use-api", () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          if (request.method === "GET") {
            return Effect.succeed(jsonResponse(request, 200, []));
          }
          return Effect.succeed(
            jsonResponse(request, 201, {
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
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api", "--jobs", "2"]),
        }),
      );

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        yield* functionsDeploy({
          ...baseFlags,
          useApi: true,
          jobs: Option.some(2),
        });

        expect(stripControlSequences(out.stdoutText)).toContain(
          "Deployed Functions on project abcdefghijklmnopqrst: hello-world\n",
        );
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("treats --jobs 0 as 1 and does not require --use-api", () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          if (request.method === "GET") {
            return Effect.succeed(jsonResponse(request, 200, []));
          }
          return Effect.succeed(
            jsonResponse(request, 201, {
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
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--jobs", "0"]),
        }),
      );

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        yield* functionsDeploy({
          ...baseFlags,
          useApi: false,
          jobs: Option.some(0),
        });

        expect(stripControlSequences(out.stdoutText)).toContain(
          "Deployed Functions on project abcdefghijklmnopqrst: hello-world\n",
        );
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });
  });

  describe("bundler routing with --use-api=false", () => {
    it.live("falls through to Docker bundling, not the API path, when --use-api=false", () => {
      // `useDocker` forces the API path only when `useApi` resolves to true, so
      // `--use-api=false` alone leaves `useDocker`'s own default (true) in effect.
      const out = mockOutput({ format: "text" });
      const child = mockChildProcessSpawner({ exitCode: 1 });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          if (request.method === "GET") {
            return Effect.succeed(jsonResponse(request, 200, []));
          }
          return Effect.succeed(
            jsonResponse(request, 201, {
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
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
        }),
      );

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        yield* functionsDeploy({
          ...baseFlags,
          useApi: false,
          useDocker: true,
        });

        expect(child.spawned).toEqual([{ command: "docker", args: ["info"] }]);
        expect(out.stderrText).toContain("WARNING: Docker is not running\n");
        expect(stripControlSequences(out.stdoutText)).toContain(
          "Deployed Functions on project abcdefghijklmnopqrst: hello-world\n",
        );
        expect(requestLines(api.requests)).toEqual([
          `GET https://api.supabase.com/v1/projects/${VALID_REF}/functions`,
          `POST https://api.supabase.com/v1/projects/${VALID_REF}/functions/deploy`,
        ]);
        assertPermissionDrift({
          command: "functions deploy",
          activeFlags: dockerPathFlags,
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });
  });

  describe("Docker bundle output permissions", () => {
    it.effect("skips the POSIX chmod on Windows only", () =>
      Effect.sync(() => {
        expect(shouldChmodBundleOutputDirectory("win32")).toBe(false);
        expect(shouldChmodBundleOutputDirectory("darwin")).toBe(true);
        expect(shouldChmodBundleOutputDirectory("linux")).toBe(true);
      }),
    );
  });

  describe("no-functions error styling (structured output stays plain)", () => {
    // Uses a marker `styleEmphasis` instead of `functionsDeploy`'s real `bold`
    // hook, which is TTY-gated and inert under vitest.
    function setupNoFunctionsTest(format: "text" | "json") {
      const out = mockOutput({ format });
      const api = mockCommandPlatformApi();
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        Stdio.layerTest({ args: Effect.succeed(["functions", "deploy"]) }),
      );
      const deployNoFunctions = Effect.gen(function* () {
        const platformApi = yield* CommandPlatformApi;
        const path = yield* Path.Path;
        return yield* deployFunctions(
          { ...baseFlags, functionNames: [] },
          {
            api: platformApi,
            cwd: tempRoot.current,
            flagCwd: tempRoot.current,
            projectRoot: tempRoot.current,
            supabaseDir: path.join(tempRoot.current, "supabase"),
            dashboardUrl: "https://supabase.com/dashboard",
            localConfigLoader: functionsLocalConfigLoader,
            rawArgs: ["functions", "deploy"],
            edgeRuntimeVersion: "1.69.12",
            resolveProjectRef: Effect.succeed("abcdefghijklmnopqrst"),
            styleEmphasis: (text) => `<sgr>${text}</sgr>`,
          },
        );
      });
      return { out, layer, deployNoFunctions };
    }

    it.effect("keeps the injected styling out of the json error payload", () => {
      const { out, layer, deployNoFunctions } = setupNoFunctionsTest("json");
      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);

        yield* deployNoFunctions.pipe(withJsonErrorHandling);

        expect(out.messages).toContainEqual({
          type: "fail",
          message: "No Functions specified or found in supabase/functions",
        });
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("still emphasizes the functions dir in the text-mode error", () => {
      const { layer, deployNoFunctions } = setupNoFunctionsTest("text");
      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);

        const error = yield* deployNoFunctions.pipe(Effect.flip);

        expect(error).toBeInstanceOf(NoFunctionsToDeployError);
        if (!(error instanceof NoFunctionsToDeployError)) {
          throw new Error(`unexpected error: ${String(error)}`);
        }
        expect(error.message).toBe(
          "No Functions specified or found in <sgr>supabase/functions</sgr>",
        );
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });
  });

  describe("Config.Validate parity (CLI-1963)", () => {
    it.effect(
      "fails before any Docker/API work when config.toml has an explicit empty project_id",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi();
        const layer = Layer.mergeAll(
          cliConfigValuesTestLayer,
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          approvedHostedMutation,
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world"]),
          }),
        );

        return Effect.gen(function* () {
          yield* writeCliConfig(tempRoot.current, 'project_id = ""\n');
          yield* writeLocalFunction(tempRoot.current, "hello-world");

          const error = yield* functionsDeploy(baseFlags).pipe(Effect.flip);

          expect(error).toBeInstanceOf(Error);
          expect(error).toMatchObject({ message: "Missing required field in config: project_id" });
          expect(api.requests).toEqual([]);
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
      },
    );

    it.effect(
      "fails before any Docker/API work on an unrelated Config.Validate branch (unsupported Postgres major version)",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi();
        const layer = Layer.mergeAll(
          cliConfigValuesTestLayer,
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          approvedHostedMutation,
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world"]),
          }),
        );

        return Effect.gen(function* () {
          yield* writeCliConfig(
            tempRoot.current,
            ['project_id = "test-project"', "", "[db]", "major_version = 12", ""].join("\n"),
          );
          yield* writeLocalFunction(tempRoot.current, "hello-world");

          const error = yield* functionsDeploy(baseFlags).pipe(Effect.flip);

          expect(error).toBeInstanceOf(Error);
          expect(error).toMatchObject({
            message:
              "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.",
          });
          expect(api.requests).toEqual([]);
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
      },
    );

    it.effect("reports a Config.Validate failure before an invalid slug's format error", () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi();
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "1-invalid-slug"]),
        }),
      );

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current, 'project_id = ""\n');

        const error = yield* functionsDeploy({
          ...baseFlags,
          functionNames: ["1-invalid-slug"],
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ message: "Missing required field in config: project_id" });
        expect(api.requests).toEqual([]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.effect("still rejects an invalid slug once the config itself is valid", () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi();
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "1-invalid-slug"]),
        }),
      );

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);

        const error = yield* functionsDeploy({
          ...baseFlags,
          functionNames: ["1-invalid-slug"],
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(InvalidFunctionDeploySlugError);
        expect(api.requests).toEqual([]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });
  });

  describe("Docker bundling path config/env wiring (CLI-1963)", () => {
    function mockFunctionCreateApi() {
      return mockCommandPlatformApi({
        handler: (request) => {
          if (request.method === "GET") {
            return Effect.succeed(jsonResponse(request, 200, []));
          }
          return Effect.succeed(
            jsonResponse(request, 201, {
              id: "function-id",
              slug: "hello-world",
              name: "hello-world",
              status: "ACTIVE",
              version: 1,
              created_at: 1_687_423_025_152,
              updated_at: 1_687_423_025_152,
              verify_jwt: true,
              import_map: false,
              entrypoint_path: "functions/hello-world/index.ts",
            }),
          );
        },
      });
    }

    it.live(
      "resolves the deno v1 edge-runtime image tag when SUPABASE_EDGE_RUNTIME_DENO_VERSION=1 overrides an unset config value",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockFunctionCreateApi();
        const child = mockDockerBundleSpawner();
        const layer = Layer.mergeAll(
          cliConfigValuesTestLayer,
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          approvedHostedMutation,
          child.layer,
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
          }),
        );

        return Effect.gen(function* () {
          yield* writeCliConfig(tempRoot.current);
          yield* writeLocalFunction(tempRoot.current, "hello-world");

          yield* functionsDeploy({ ...baseFlags, useApi: false, useDocker: true });

          // `docker info` is spawned[0]; the bundler's first image-inspect
          // candidate (a cache hit here) is spawned[1].
          expect(child.spawned[1]).toEqual({
            command: "docker",
            args: ["image", "inspect", "public.ecr.aws/supabase/edge-runtime:v1.68.4"],
          });
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot), (body) =>
          withEnvVar("SUPABASE_EDGE_RUNTIME_DENO_VERSION", "1", body),
        );
      },
    );

    it.live("passes --verbose to the bundler container when DEBUG=true", () => {
      const out = mockOutput({ format: "text" });
      const api = mockFunctionCreateApi();
      const child = mockDockerBundleSpawner();
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
        }),
      );

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        yield* withConfigEnv(
          { DEBUG: "true" },
          functionsDeploy({ ...baseFlags, useApi: false, useDocker: true }),
        );

        const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
        expect(runCommand?.args).toContain("--verbose");
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.live("keeps --verbose off the bundler container when DEBUG=false", () => {
      const out = mockOutput({ format: "text" });
      const api = mockFunctionCreateApi();
      const child = mockDockerBundleSpawner();
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
        }),
      );

      return Effect.gen(function* () {
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        yield* withConfigEnv(
          { DEBUG: "false" },
          functionsDeploy({ ...baseFlags, useApi: false, useDocker: true }),
        );

        const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
        expect(runCommand?.args).toContain("run");
        expect(runCommand?.args).not.toContain("--verbose");
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.live(
      "uses SUPABASE_NETWORK_ID as the bundler's docker network when no --network-id flag is passed",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockFunctionCreateApi();
        const child = mockDockerBundleSpawner();
        const layer = Layer.mergeAll(
          cliConfigValuesTestLayer,
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          approvedHostedMutation,
          child.layer,
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
          }),
        );

        return Effect.gen(function* () {
          yield* writeCliConfig(tempRoot.current);
          yield* writeLocalFunction(tempRoot.current, "hello-world");

          yield* functionsDeploy({ ...baseFlags, useApi: false, useDocker: true });

          expect(child.spawned[2]).toEqual({
            command: "docker",
            args: ["network", "inspect", "env-network"],
          });
          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args).toContain("env-network");
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot), (body) =>
          withConfigEnv({ SUPABASE_NETWORK_ID: "env-network" }, body),
        );
      },
    );

    it.live(
      "prefers an explicit --network-id flag over SUPABASE_NETWORK_ID for the bundler container",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockFunctionCreateApi();
        const child = mockDockerBundleSpawner();
        const layer = Layer.mergeAll(
          cliConfigValuesTestLayer,
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          approvedHostedMutation,
          child.layer,
          Stdio.layerTest({
            args: Effect.succeed([
              "functions",
              "deploy",
              "hello-world",
              "--use-api=false",
              "--network-id",
              "flag-network",
            ]),
          }),
        );

        return Effect.gen(function* () {
          yield* writeCliConfig(tempRoot.current);
          yield* writeLocalFunction(tempRoot.current, "hello-world");

          yield* functionsDeploy({ ...baseFlags, useApi: false, useDocker: true });

          expect(child.spawned[2]).toEqual({
            command: "docker",
            args: ["network", "inspect", "flag-network"],
          });
          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args).toContain("flag-network");
          expect(runCommand?.args).not.toContain("env-network");
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot), (body) =>
          withConfigEnv({ SUPABASE_NETWORK_ID: "env-network" }, body),
        );
      },
    );

    it.live("labels the bundler container with the resolved project id", () => {
      const out = mockOutput({ format: "text" });
      const api = mockFunctionCreateApi();
      const child = mockDockerBundleSpawner();
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
        }),
      );

      return Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* writeCliConfig(tempRoot.current, 'project_id = "test-project"\n');
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        yield* functionsDeploy({ ...baseFlags, useApi: false, useDocker: true });

        const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
        expect(runCommand?.args).toEqual(
          expect.arrayContaining([
            "--label",
            "com.supabase.cli.project=test-project",
            "--label",
            "com.docker.compose.project=test-project",
          ]),
        );
        // Assert adjacent `--label KEY=VALUE` pairs, not merely present anywhere in argv.
        const cliLabelIndex = runCommand?.args.indexOf("--label") ?? -1;
        expect(runCommand?.args.slice(cliLabelIndex, cliLabelIndex + 4)).toEqual([
          "--label",
          "com.supabase.cli.project=test-project",
          "--label",
          "com.docker.compose.project=test-project",
        ]);
        // `-w` sets WorkingDir to the resolved `cliSettings.workdir` (`tempRoot.current` here).
        const workingDirIndex = runCommand?.args.indexOf("-w") ?? -1;
        expect(runCommand?.args.slice(workingDirIndex, workingDirIndex + 2)).toEqual([
          "-w",
          toDockerPath(tempRoot.current, path),
        ]);
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });

    it.live(
      "does not climb to an ancestor project's config.toml for the Docker bundling path",
      () => {
        const nestedWorkdir = `${tempRoot.current}/nested`;
        const out = mockOutput({ format: "text" });
        const api = mockFunctionCreateApi();
        const child = mockDockerBundleSpawner();
        const layer = Layer.mergeAll(
          cliConfigValuesTestLayer,
          buildTestRuntime({
            out,
            api,
            cliSettings: mockCommandSettings({ workdir: nestedWorkdir }),
            runtimeInfo: mockRuntimeInfo({ cwd: nestedWorkdir }),
          }),
          approvedHostedMutation,
          child.layer,
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
          }),
        );

        return Effect.gen(function* () {
          yield* writeCliConfig(tempRoot.current, 'project_id = "ancestor-project"\n');
          yield* writeLocalFunction(nestedWorkdir, "hello-world");

          yield* functionsDeploy({ ...baseFlags, useApi: false, useDocker: true });

          expect(child.spawned[2]).toEqual({
            command: "docker",
            args: ["network", "inspect", "supabase_network_nested"],
          });
          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args).toContain("supabase_network_nested");
          expect(runCommand?.args).not.toContain("supabase_network_ancestor-project");
        }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
      },
    );
  });

  it.effect(
    "does not treat an ancestor project's deno.json as this project's own import map when --workdir names a config-less subdirectory of it",
    () => {
      const nestedWorkdir = `${tempRoot.current}/nested`;
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          if (request.method === "GET") {
            return Effect.succeed(jsonResponse(request, 200, []));
          }
          if (request.url.endsWith("/functions/deploy")) {
            return Effect.succeed(
              jsonResponse(request, 201, {
                id: "function-id",
                slug: "hello-world",
                name: "hello-world",
                status: "ACTIVE",
                version: 2,
                created_at: 1_687_423_025_152,
                updated_at: 1_687_423_025_152,
                verify_jwt: true,
                import_map: false,
                entrypoint_path: "functions/hello-world/index.ts",
              }),
            );
          }
          return Effect.succeed(jsonResponse(request, 404, { error: "not found" }));
        },
      });
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: nestedWorkdir }),
          runtimeInfo: mockRuntimeInfo({ cwd: nestedWorkdir }),
        }),
        approvedHostedMutation,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api"]),
        }),
      );

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Ancestor project: a config.toml plus a function with an entrypoint and a deno.json.
        yield* writeCliConfig(tempRoot.current, 'project_id = "ancestor-project"\n');
        yield* writeLocalFunction(tempRoot.current, "hello-world");
        // The sub-project has its own entrypoint but no deno.json.
        yield* fs.makeDirectory(path.join(nestedWorkdir, "supabase", "functions", "hello-world"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(nestedWorkdir, "supabase", "functions", "hello-world", "index.ts"),
          "Deno.serve(() => new Response())\n",
        );

        yield* functionsDeploy(baseFlags);

        const deployRequest = api.requests.find(
          (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
        );
        expect(deployRequest).toBeDefined();
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    },
  );

  describe("docker-not-running warning styling (only WARNING: is styled)", () => {
    it.live("wraps only the WARNING token, not the rest of the fallback line", () => {
      // Uses a marker `styleWarning` instead of `functionsDeploy`'s real
      // `yellow` hook, which is TTY-gated and inert under vitest.
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        handler: (request) => {
          if (request.method === "GET") {
            return Effect.succeed(jsonResponse(request, 200, []));
          }
          return Effect.succeed(
            jsonResponse(request, 201, {
              id: "function-id",
              slug: "hello-world",
              name: "hello-world",
              status: "ACTIVE",
              version: 1,
              created_at: 1_687_423_025_152,
              updated_at: 1_687_423_025_152,
              verify_jwt: true,
              import_map: false,
              entrypoint_path: "functions/hello-world/index.ts",
            }),
          );
        },
      });
      const child = mockChildProcessSpawner({ exitCode: 1 });
      const layer = Layer.mergeAll(
        cliConfigValuesTestLayer,
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        approvedHostedMutation,
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
        }),
      );

      return Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* writeCliConfig(tempRoot.current);
        yield* writeLocalFunction(tempRoot.current, "hello-world");

        const platformApi = yield* CommandPlatformApi;
        yield* deployFunctions(
          { ...baseFlags, useApi: false, useDocker: true },
          {
            api: platformApi,
            cwd: tempRoot.current,
            flagCwd: tempRoot.current,
            projectRoot: tempRoot.current,
            supabaseDir: path.join(tempRoot.current, "supabase"),
            dashboardUrl: "https://supabase.com/dashboard",
            localConfigLoader: functionsLocalConfigLoader,
            rawArgs: ["functions", "deploy", "hello-world", "--use-api=false"],
            edgeRuntimeVersion: "1.69.12",
            resolveProjectRef: Effect.succeed("abcdefghijklmnopqrst"),
            styleWarning: (text) => `<warn>${text}</warn>`,
          },
        );

        expect(out.stderrText).toContain("<warn>WARNING:</warn> Docker is not running\n");
      }).pipe(Effect.provide(layer), Effect.ensuring(removeTempRoot));
    });
  });
});

describeHostedTargetSelection("functions deploy", {
  operands: ["hello-world"],
  activeFlags: apiPathFlags,
  files: {
    "supabase/config.toml": 'project_id = "test-project"\n',
    "supabase/functions/hello-world/index.ts": "Deno.serve(() => new Response())\n",
    "supabase/functions/hello-world/deno.json": '{"imports":{}}\n',
  },
  respond: (request) =>
    Effect.succeed(
      request.method === "GET"
        ? jsonResponse(request, 200, [])
        : jsonResponse(request, 201, deployedFunction("hello-world")),
    ),
  run: (flags) =>
    functionsDeploy({ ...baseFlags, ...flags }).pipe(Effect.provide(cliConfigValuesTestLayer)),
});

describeHostedConsent("functions deploy", {
  api: {
    handler: (request) =>
      Effect.succeed(
        request.method === "POST"
          ? jsonResponse(request, 201, deployedFunction("hello-world"))
          : jsonResponse(request, 200, []),
      ),
  },
  setup: (workdir) =>
    Effect.gen(function* () {
      yield* writeCliConfig(workdir);
      yield* writeLocalFunction(workdir, "hello-world");
    }).pipe(Effect.provide(BunServices.layer)),
  invoke: () => ({
    run: functionsDeploy(baseFlags).pipe(
      Effect.provide(
        Layer.mergeAll(
          cliConfigValuesTestLayer,
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api"]),
          }),
        ),
      ),
    ),
  }),
});
