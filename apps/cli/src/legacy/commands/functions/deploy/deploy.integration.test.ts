import { describe, expect, it } from "@effect/vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Exit, Layer, Option, Stdio } from "effect";

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
import { mockChildProcessSpawner } from "../../../../../../../packages/process-compose/tests/helpers/mocks.ts";
import {
  deployFunctions,
  shouldChmodBundleOutputDirectory,
} from "../../../../shared/functions/deploy.ts";
import { legacyFunctionsGoConfigCompat } from "../../../shared/legacy-functions-go-config.ts";
import {
  ConflictingFunctionDeployFlagsError,
  InvalidFunctionDeploySlugError,
  NoFunctionsToDeployError,
} from "../../../../shared/functions/deploy.errors.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
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

// Strip ANSI SGR (color/bold) sequences — `legacyBold` styles the pruned slugs
// only when stderr supports color, so byte-assertions normalize first.
// eslint-disable-next-line no-control-regex
const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

function resolveDockerOutputPath(args: ReadonlyArray<string>): string {
  const outputIndex = args.indexOf("--output");
  if (outputIndex < 0 || args[outputIndex + 1] === undefined) {
    throw new Error("missing docker bundle output flag");
  }
  return args[outputIndex + 1]!;
}

/**
 * Every `docker image inspect` call is a cache hit (exit 0) — no real pull,
 * no real registry candidate fallback (that path has its own coverage in
 * `functions/download`'s integration tests) — and every `docker run`
 * synthesizes the eszip the bundler container would otherwise have produced,
 * so `bundleFunctionWithDocker` can read it back and complete the deploy.
 */
function mockDockerBundleSpawner() {
  const spawnerOpts: {
    exitCode?: number;
    onSpawn?: (record: { command: string; args: ReadonlyArray<string> }) => void;
  } = { exitCode: 0 };
  spawnerOpts.onSpawn = (record) => {
    if (record.command !== "docker" || record.args[0] !== "run") {
      return;
    }
    const outputPath = resolveDockerOutputPath(record.args);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "eszip-test-output");
  };
  return mockChildProcessSpawner(spawnerOpts);
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
      expect(stripSgr(out.stdoutText)).toContain(
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

  it.live("prints a duplicated slug argument verbatim, matching Go's raw strings.Join", () => {
    // Go: `strings.Join(slugs, ", ")` (`internal/functions/deploy/deploy.go:70`)
    // joins the raw CLI-arg slugs, not a deduped set, so a repeated slug prints
    // twice even though only one deploy request is made for it.
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
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      Layer.succeed(LegacyYesFlag, false),
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "hello-world", "hello-world", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
      yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

      yield* legacyFunctionsDeploy({
        ...baseFlags,
        functionNames: ["hello-world", "hello-world"],
      });

      expect(
        api.requests.filter(
          (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
        ),
      ).toHaveLength(1);
      expect(stripSgr(out.stdoutText)).toContain(
        "Deployed Functions on project abcdefghijklmnopqrst: hello-world, hello-world\n",
      );
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
      expect(stripSgr(out.stdoutText)).toContain(
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

  it.live("rejects a bundled file whose workdir-relative name escapes with a `..` segment", () => {
    // Go parity (CLI-1985): Go's `toRelPath` (`pkg/function/deploy.go:94-103`)
    // anchors uploaded file names and the server-recorded `entrypoint_path` /
    // `import_map_path` at `os.Getwd()` — the workdir — never at the git root.
    // A monorepo import outside the workdir but inside the git root (allowed
    // by the source-root containment check since #5755) would otherwise
    // upload with a Go-style `../`-relative name. Go's `writeForm`/`addFile`
    // (`pkg/function/deploy.go:251-284`) opens every uploaded path through an
    // `fs.FS`, which rejects any path containing a `..` element (`fs.ValidPath`)
    // before the read — and thus the upload — happens. This asserts the CLI
    // hard-fails the same way instead of letting the `..`-relative name reach
    // the server.
    const repoRoot = tempRoot.current;
    const workdir = join(repoRoot, "app");
    const multiparts: Array<{ metadata?: string; fileNames: ReadonlyArray<string> }> = [];
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      handler: (request) => {
        if (request.body._tag === "FormData") {
          const metadata = request.body.formData.get("metadata");
          multiparts.push({
            metadata: typeof metadata === "string" ? metadata : undefined,
            fileNames: request.body.formData
              .getAll("file")
              .flatMap((part) => (part instanceof File ? [part.name] : [])),
          });
        }
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
            import_map_path: "supabase/functions/hello-world/deno.json",
          }),
        );
      },
    });
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir }),
        runtimeInfo: mockRuntimeInfo({ cwd: workdir }),
      }),
      Layer.succeed(LegacyYesFlag, false),
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api"]),
      }),
    );

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(repoRoot, ".git"), { recursive: true }));
      yield* Effect.tryPromise(() => writeProjectConfig(workdir));
      yield* Effect.tryPromise(() =>
        writeLocalFunction(
          workdir,
          "hello-world",
          'import { shared } from "@repo/shared"\nDeno.serve(() => new Response(shared))\n',
        ),
      );
      yield* Effect.tryPromise(() =>
        mkdir(join(repoRoot, "packages", "shared", "src"), { recursive: true }),
      );
      yield* Effect.tryPromise(() =>
        writeFile(
          join(repoRoot, "packages", "shared", "src", "index.ts"),
          'export const shared = "ok"\n',
        ),
      );
      yield* Effect.tryPromise(() =>
        writeFile(
          join(workdir, "supabase", "functions", "hello-world", "deno.json"),
          JSON.stringify({
            imports: { "@repo/shared": "../../../../packages/shared/src/index.ts" },
          }),
        ),
      );

      const exit = yield* Effect.exit(legacyFunctionsDeploy(baseFlags));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain(
          "failed to read file: open ../packages/shared/src/index.ts: invalid argument",
        );
      }
      expect(multiparts).toHaveLength(0);
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
      expect(stripSgr(out.stdoutText)).toContain(
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
      // Go's `PromptYesNo` echoes the accepted prompt to stderr under the global
      // YES flag (`console.go:70-72`) — byte-match `confirmPruneAll` + choices
      // (each slug is bolded like Go's `utils.Bold`, so strip SGR codes first).
      expect(stripSgr(out.stderrText)).toContain(
        "Do you want to delete the following Functions from your project?\n • remote-only\n\n [y/N] y\n",
      );
      expect(api.requests.some((request) => request.method === "DELETE")).toBe(true);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
      ),
    );
  });

  // INC-699: a `bundleOnly` upload bumps the remote version without persisting
  // metadata, so a partially failed bulk deploy must still send the final PUT for
  // whatever uploaded — otherwise the remote metadata is stranded and every later
  // deploy conflicts.
  describe("partial bulk upload failures (INC-699)", () => {
    function setupBulkDeploy(opts: {
      readonly deployStatuses: ReadonlyArray<number>;
      readonly bulkStatuses?: ReadonlyArray<number>;
    }) {
      const out = mockOutput({ format: "text" });
      let deployCalls = 0;
      let bulkCalls = 0;
      const api = mockLegacyPlatformApi({
        handler: (request, recorded) => {
          if (request.method === "GET") {
            return Effect.succeed(legacyJsonResponse(request, 200, []));
          }
          if (request.method === "POST") {
            const status = opts.deployStatuses[deployCalls] ?? 201;
            deployCalls += 1;
            const slug = recorded.urlParams.includes("slug=bye-world")
              ? "bye-world"
              : "hello-world";
            if (status !== 201) {
              return Effect.succeed(
                legacyJsonResponse(request, status, { message: `rejected ${slug}` }),
              );
            }
            return Effect.succeed(
              legacyJsonResponse(request, 201, {
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
              }),
            );
          }
          if (request.method === "PUT") {
            const status = opts.bulkStatuses?.[bulkCalls] ?? 200;
            bulkCalls += 1;
            if (status !== 200) {
              return Effect.succeed(
                legacyJsonResponse(request, status, { message: "bulk update rejected" }),
              );
            }
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
        Layer.succeed(LegacyYesFlag, false),
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "bye-world", "--use-api"]),
        }),
      );
      return { out, api, layer };
    }

    it.live("still persists the functions that uploaded when one upload fails", () => {
      const { out, api, layer } = setupBulkDeploy({ deployStatuses: [201, 409] });

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
        yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));
        yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "bye-world"));

        const error = yield* legacyFunctionsDeploy({
          ...baseFlags,
          functionNames: ["hello-world", "bye-world"],
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          'unexpected deploy status 409: {"message":"rejected bye-world"}',
        );

        // Both uploads ran — the 201 was not interrupted by the sibling 409.
        expect(
          api.requests.filter(
            (request) => request.method === "POST" && request.url.endsWith("/functions/deploy"),
          ),
        ).toHaveLength(2);
        const bulkUpdate = api.requests.find((request) => request.method === "PUT");
        expect(bulkUpdate?.body).toMatchObject([{ slug: "hello-world" }]);
        expect(out.stdoutText).not.toContain("Deployed Functions on project");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
        ),
      );
    });

    it.live("skips the bulk update entirely when every upload fails", () => {
      const { out, api, layer } = setupBulkDeploy({ deployStatuses: [409, 400] });

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
        yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));
        yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "bye-world"));

        const error = yield* legacyFunctionsDeploy({
          ...baseFlags,
          functionNames: ["hello-world", "bye-world"],
        }).pipe(Effect.flip);

        // Go's `errors.Join`: one message per failed upload, in input order.
        expect((error as Error).message).toBe(
          [
            'unexpected deploy status 409: {"message":"rejected hello-world"}',
            'unexpected deploy status 400: {"message":"rejected bye-world"}',
          ].join("\n"),
        );
        expect(api.requests.some((request) => request.method === "PUT")).toBe(false);
        expect(out.stdoutText).not.toContain("Deployed Functions on project");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
        ),
      );
    });

    it.live("reports the upload failure and the bulk update failure together", () => {
      const { api, layer } = setupBulkDeploy({
        deployStatuses: [201, 409],
        bulkStatuses: [400],
      });

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
        yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));
        yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "bye-world"));

        const error = yield* legacyFunctionsDeploy({
          ...baseFlags,
          functionNames: ["hello-world", "bye-world"],
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          [
            'unexpected deploy status 409: {"message":"rejected bye-world"}',
            'unexpected bulk update status 400: {"message":"bulk update rejected"}',
          ].join("\n"),
        );
        expect(api.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
        ),
      );
    });
  });

  it.live("rejects the bundler mutex with cobra's exact error text", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const layer = Layer.mergeAll(
      buildLegacyTestRuntime({
        out,
        api,
        cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
        runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
      }),
      Layer.succeed(LegacyYesFlag, false),
      Stdio.layerTest({
        args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api", "--use-docker"]),
      }),
    );

    return Effect.gen(function* () {
      const error = yield* legacyFunctionsDeploy({ ...baseFlags, useDocker: true }).pipe(
        Effect.flip,
      );

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

  describe("--jobs validation (Go parity: cmd/functions.go:79-82)", () => {
    function setupJobsTest(rawArgs: ReadonlyArray<string>) {
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi({
        handler: (request) => Effect.succeed(legacyJsonResponse(request, 200, [])),
      });
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        Layer.succeed(LegacyYesFlag, false),
        Stdio.layerTest({ args: Effect.succeed(rawArgs) }),
      );
      return { out, api, layer };
    }

    it.live("rejects --jobs > 1 without --use-api, even with default --use-docker", () => {
      const { layer } = setupJobsTest(["functions", "deploy", "hello-world", "--jobs", "2"]);

      return Effect.gen(function* () {
        const error = yield* legacyFunctionsDeploy({
          ...baseFlags,
          useApi: false,
          useDocker: true,
          jobs: Option.some(2),
        }).pipe(Effect.provide(layer), Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("--jobs must be used together with --use-api");
      });
    });

    it.live("rejects --jobs > 1 with --use-docker=false and no --use-api (Go parity gap)", () => {
      // Divergence this test guards: previously the guard only fired when local
      // bundling (Docker/legacy-bundle) was active, so `--use-docker=false --jobs 2`
      // (no --use-api) silently passed in TS while Go rejected it.
      const { layer } = setupJobsTest([
        "functions",
        "deploy",
        "hello-world",
        "--use-docker=false",
        "--jobs",
        "2",
      ]);

      return Effect.gen(function* () {
        const error = yield* legacyFunctionsDeploy({
          ...baseFlags,
          useApi: false,
          useDocker: false,
          jobs: Option.some(2),
        }).pipe(Effect.provide(layer), Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("--jobs must be used together with --use-api");
      });
    });

    it.live("allows --jobs > 1 together with --use-api", () => {
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
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        Layer.succeed(LegacyYesFlag, false),
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api", "--jobs", "2"]),
        }),
      );

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
        yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

        yield* legacyFunctionsDeploy({
          ...baseFlags,
          useApi: true,
          jobs: Option.some(2),
        });

        expect(stripSgr(out.stdoutText)).toContain(
          "Deployed Functions on project abcdefghijklmnopqrst: hello-world\n",
        );
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
        ),
      );
    });

    it.live("treats --jobs 0 as 1 and does not require --use-api", () => {
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
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        Layer.succeed(LegacyYesFlag, false),
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--jobs", "0"]),
        }),
      );

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
        yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

        yield* legacyFunctionsDeploy({
          ...baseFlags,
          useApi: false,
          jobs: Option.some(0),
        });

        expect(stripSgr(out.stdoutText)).toContain(
          "Deployed Functions on project abcdefghijklmnopqrst: hello-world\n",
        );
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
        ),
      );
    });
  });

  describe("bundler routing with --use-api=false (Go parity: cmd/functions.go:79-80)", () => {
    it.live("falls through to Docker bundling, not the API path, when --use-api=false", () => {
      // Divergence this test guards: Go's `if useApi { useDocker = false }` only forces
      // the API path when the RESOLVED value is true. `--use-api=false` alone must leave
      // `useDocker`'s own value (default true) in effect, routing to Docker — previously
      // `useLocalBundler` keyed off flag *presence* (`explicitUseApi`), so typing
      // `--use-api=false` silently forced the API path instead.
      const out = mockOutput({ format: "text" });
      const child = mockChildProcessSpawner({ exitCode: 1 });
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
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        Layer.succeed(LegacyYesFlag, false),
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
        }),
      );

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
        yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

        yield* legacyFunctionsDeploy({
          ...baseFlags,
          useApi: false,
          useDocker: true,
        });

        // Docker was actually attempted (proves useLocalBundler resolved to true);
        // it wasn't running, so the command fell back to the API and still succeeded.
        expect(child.spawned).toEqual([{ command: "docker", args: ["info"] }]);
        expect(out.stderrText).toContain("WARNING: Docker is not running\n");
        expect(stripSgr(out.stdoutText)).toContain(
          "Deployed Functions on project abcdefghijklmnopqrst: hello-world\n",
        );
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
        ),
      );
    });
  });

  describe("Docker bundle output permissions", () => {
    it.live("skips the POSIX chmod on Windows only", () =>
      Effect.sync(() => {
        expect(shouldChmodBundleOutputDirectory("win32")).toBe(false);
        expect(shouldChmodBundleOutputDirectory("darwin")).toBe(true);
        expect(shouldChmodBundleOutputDirectory("linux")).toBe(true);
      }),
    );
  });

  describe("no-functions error styling (Go parity: deploy.go:35; structured output stays plain)", () => {
    // Calls the shared `deployFunctions` with a marker `styleEmphasis` instead of
    // going through `legacyFunctionsDeploy`: the real hook (`legacyBold`) is
    // TTY-gated and therefore inert under vitest, so only an injected marker can
    // deterministically observe which output formats apply the styling.
    function setupNoFunctionsTest(format: "text" | "json") {
      const out = mockOutput({ format });
      const api = mockLegacyPlatformApi();
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        Layer.succeed(LegacyYesFlag, false),
        Stdio.layerTest({ args: Effect.succeed(["functions", "deploy"]) }),
      );
      const deployNoFunctions = Effect.gen(function* () {
        const platformApi = yield* LegacyPlatformApi;
        return yield* deployFunctions(
          { ...baseFlags, functionNames: [] },
          {
            api: platformApi,
            cwd: tempRoot.current,
            flagCwd: tempRoot.current,
            projectRoot: tempRoot.current,
            supabaseDir: join(tempRoot.current, "supabase"),
            dashboardUrl: "https://supabase.com/dashboard",
            goConfigCompat: legacyFunctionsGoConfigCompat,
            yes: false,
            rawArgs: ["functions", "deploy"],
            edgeRuntimeVersion: "1.69.12",
            resolveProjectRef: () => Effect.succeed("abcdefghijklmnopqrst"),
            styleEmphasis: (text) => `<sgr>${text}</sgr>`,
          },
        );
      });
      return { out, layer, deployNoFunctions };
    }

    it.live("keeps the injected styling out of the json error payload", () => {
      const { out, layer, deployNoFunctions } = setupNoFunctionsTest("json");
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));

        yield* deployNoFunctions.pipe(withJsonErrorHandling);

        expect(out.messages).toContainEqual({
          type: "fail",
          message: "No Functions specified or found in supabase/functions",
        });
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
        ),
      );
    });

    it.live("still emphasizes the functions dir in the text-mode error", () => {
      const { layer, deployNoFunctions } = setupNoFunctionsTest("text");
      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));

        const error = yield* deployNoFunctions.pipe(Effect.flip);

        expect(error).toBeInstanceOf(NoFunctionsToDeployError);
        if (!(error instanceof NoFunctionsToDeployError)) {
          throw new Error(`unexpected error: ${String(error)}`);
        }
        expect(error.message).toBe(
          "No Functions specified or found in <sgr>supabase/functions</sgr>",
        );
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
        ),
      );
    });
  });

  describe("Config.Validate parity (CLI-1963)", () => {
    it.live(
      "fails before any Docker/API work when config.toml has an explicit empty project_id",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockLegacyPlatformApi();
        const layer = Layer.mergeAll(
          buildLegacyTestRuntime({
            out,
            api,
            cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          Layer.succeed(LegacyYesFlag, false),
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world"]),
          }),
        );

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current, 'project_id = ""\n'));
          yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

          const error = yield* legacyFunctionsDeploy(baseFlags).pipe(Effect.flip);

          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe("Missing required field in config: project_id");
          expect(api.requests).toEqual([]);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
          ),
        );
      },
    );

    it.live(
      "fails before any Docker/API work on an unrelated Config.Validate branch (unsupported Postgres major version)",
      () => {
        // Proves the WHOLE resolved config is validated, not just `project_id`
        // — `db.major_version = 12` is a genuinely unrelated Go `Config.Validate`
        // branch (`config.go:1034-1062`).
        const out = mockOutput({ format: "text" });
        const api = mockLegacyPlatformApi();
        const layer = Layer.mergeAll(
          buildLegacyTestRuntime({
            out,
            api,
            cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          Layer.succeed(LegacyYesFlag, false),
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world"]),
          }),
        );

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            writeProjectConfig(
              tempRoot.current,
              ['project_id = "test-project"', "", "[db]", "major_version = 12", ""].join("\n"),
            ),
          );
          yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

          const error = yield* legacyFunctionsDeploy(baseFlags).pipe(Effect.flip);

          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(
            "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.",
          );
          expect(api.requests).toEqual([]);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
          ),
        );
      },
    );

    it.live(
      "reports a Config.Validate failure before an invalid slug's format error, matching Go's flags.LoadConfig-before-slug-validation order (deploy.go:22-28)",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockLegacyPlatformApi();
        const layer = Layer.mergeAll(
          buildLegacyTestRuntime({
            out,
            api,
            cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          Layer.succeed(LegacyYesFlag, false),
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "1-invalid-slug"]),
          }),
        );

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current, 'project_id = ""\n'));

          const error = yield* legacyFunctionsDeploy({
            ...baseFlags,
            functionNames: ["1-invalid-slug"],
          }).pipe(Effect.flip);

          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe("Missing required field in config: project_id");
          expect(api.requests).toEqual([]);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
          ),
        );
      },
    );

    it.live("still rejects an invalid slug once the config itself is valid", () => {
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi();
      const layer = Layer.mergeAll(
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        Layer.succeed(LegacyYesFlag, false),
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "1-invalid-slug"]),
        }),
      );

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));

        const error = yield* legacyFunctionsDeploy({
          ...baseFlags,
          functionNames: ["1-invalid-slug"],
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(InvalidFunctionDeploySlugError);
        expect(api.requests).toEqual([]);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
        ),
      );
    });
  });

  describe("Docker bundling path Go-parity config/env wiring (CLI-1963)", () => {
    function mockFunctionCreateApi() {
      return mockLegacyPlatformApi({
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
          buildLegacyTestRuntime({
            out,
            api,
            cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          Layer.succeed(LegacyYesFlag, false),
          child.layer,
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
          }),
        );

        const previous = process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
        process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "1";

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
          yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

          yield* legacyFunctionsDeploy({ ...baseFlags, useApi: false, useDocker: true });

          // `docker info` is spawned[0]; the bundler's first image-inspect
          // candidate (a cache hit here) is spawned[1].
          expect(child.spawned[1]).toEqual({
            command: "docker",
            args: ["image", "inspect", "public.ecr.aws/supabase/edge-runtime:v1.68.4"],
          });
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
              } else {
                process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = previous;
              }
            }),
          ),
        );
      },
    );

    it.live(
      "uses SUPABASE_NETWORK_ID as the bundler's docker network when no --network-id flag is passed",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockFunctionCreateApi();
        const child = mockDockerBundleSpawner();
        const layer = Layer.mergeAll(
          buildLegacyTestRuntime({
            out,
            api,
            cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          Layer.succeed(LegacyYesFlag, false),
          child.layer,
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
          }),
        );

        const previous = process.env["SUPABASE_NETWORK_ID"];
        process.env["SUPABASE_NETWORK_ID"] = "env-network";

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
          yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

          yield* legacyFunctionsDeploy({ ...baseFlags, useApi: false, useDocker: true });

          expect(child.spawned[2]).toEqual({
            command: "docker",
            args: ["network", "inspect", "env-network"],
          });
          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args).toContain("env-network");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env["SUPABASE_NETWORK_ID"];
              } else {
                process.env["SUPABASE_NETWORK_ID"] = previous;
              }
            }),
          ),
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
          buildLegacyTestRuntime({
            out,
            api,
            cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          Layer.succeed(LegacyYesFlag, false),
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

        const previous = process.env["SUPABASE_NETWORK_ID"];
        process.env["SUPABASE_NETWORK_ID"] = "env-network";

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
          yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

          yield* legacyFunctionsDeploy({ ...baseFlags, useApi: false, useDocker: true });

          expect(child.spawned[2]).toEqual({
            command: "docker",
            args: ["network", "inspect", "flag-network"],
          });
          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args).toContain("flag-network");
          expect(runCommand?.args).not.toContain("env-network");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env["SUPABASE_NETWORK_ID"];
              } else {
                process.env["SUPABASE_NETWORK_ID"] = previous;
              }
            }),
          ),
        );
      },
    );

    it.live(
      "labels the bundler container with the resolved project id (Go parity: docker.go:349-386)",
      () => {
        const out = mockOutput({ format: "text" });
        const api = mockFunctionCreateApi();
        const child = mockDockerBundleSpawner();
        const layer = Layer.mergeAll(
          buildLegacyTestRuntime({
            out,
            api,
            cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
            runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
          }),
          Layer.succeed(LegacyYesFlag, false),
          child.layer,
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
          }),
        );

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            writeProjectConfig(tempRoot.current, 'project_id = "test-project"\n'),
          );
          yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

          yield* legacyFunctionsDeploy({ ...baseFlags, useApi: false, useDocker: true });

          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args).toEqual(
            expect.arrayContaining([
              "--label",
              "com.supabase.cli.project=test-project",
              "--label",
              "com.docker.compose.project=test-project",
            ]),
          );
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
          ),
        );
      },
    );

    it.live(
      "does not climb to an ancestor project's config.toml for the Docker bundling path",
      () => {
        // Go's `flags.LoadConfig` only ever resolves `supabase/config.toml`
        // from the already-resolved workdir, with no ancestor climb
        // (`NewPathBuilder`, `pkg/config/utils.go:43-48`) — mirrored by
        // `loadFunctionsProjectConfig`'s `search: false` (a real behavior
        // change: deploy did NOT have this before CLI-1963, unlike download).
        const nestedWorkdir = join(tempRoot.current, "nested");
        const out = mockOutput({ format: "text" });
        const api = mockFunctionCreateApi();
        const child = mockDockerBundleSpawner();
        const layer = Layer.mergeAll(
          buildLegacyTestRuntime({
            out,
            api,
            cliConfig: mockLegacyCliConfig({ workdir: nestedWorkdir }),
            runtimeInfo: mockRuntimeInfo({ cwd: nestedWorkdir }),
          }),
          Layer.succeed(LegacyYesFlag, false),
          child.layer,
          Stdio.layerTest({
            args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
          }),
        );

        return Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            writeProjectConfig(tempRoot.current, 'project_id = "ancestor-project"\n'),
          );
          yield* Effect.tryPromise(() => writeLocalFunction(nestedWorkdir, "hello-world"));

          yield* legacyFunctionsDeploy({ ...baseFlags, useApi: false, useDocker: true });

          expect(child.spawned[2]).toEqual({
            command: "docker",
            args: ["network", "inspect", "supabase_network_abcdefghijklmnopqrst"],
          });
          const runCommand = child.spawned.find((spawned) => spawned.args[0] === "run");
          expect(runCommand?.args).toContain("supabase_network_abcdefghijklmnopqrst");
          expect(runCommand?.args).not.toContain("supabase_network_ancestor-project");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
          ),
        );
      },
    );
  });

  describe("docker-not-running warning styling (Go parity: deploy.go:60; only WARNING: is styled)", () => {
    it.live("wraps only the WARNING token, not the rest of the fallback line", () => {
      // Calls the shared `deployFunctions` with a marker `styleWarning` instead
      // of going through `legacyFunctionsDeploy`: the real hook (`legacyYellow`)
      // is TTY-gated and therefore inert under vitest, so only an injected
      // marker can deterministically observe styling scope — same pattern as
      // the "no-functions error styling" block above.
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
        buildLegacyTestRuntime({
          out,
          api,
          cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
          runtimeInfo: mockRuntimeInfo({ cwd: tempRoot.current }),
        }),
        Layer.succeed(LegacyYesFlag, false),
        child.layer,
        Stdio.layerTest({
          args: Effect.succeed(["functions", "deploy", "hello-world", "--use-api=false"]),
        }),
      );

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempRoot.current));
        yield* Effect.tryPromise(() => writeLocalFunction(tempRoot.current, "hello-world"));

        const platformApi = yield* LegacyPlatformApi;
        yield* deployFunctions(
          { ...baseFlags, useApi: false, useDocker: true },
          {
            api: platformApi,
            cwd: tempRoot.current,
            flagCwd: tempRoot.current,
            projectRoot: tempRoot.current,
            supabaseDir: join(tempRoot.current, "supabase"),
            dashboardUrl: "https://supabase.com/dashboard",
            goConfigCompat: legacyFunctionsGoConfigCompat,
            yes: false,
            rawArgs: ["functions", "deploy", "hello-world", "--use-api=false"],
            edgeRuntimeVersion: "1.69.12",
            resolveProjectRef: () => Effect.succeed("abcdefghijklmnopqrst"),
            styleWarning: (text) => `<warn>${text}</warn>`,
          },
        );

        expect(out.stderrText).toContain("<warn>WARNING:</warn> Docker is not running\n");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.tryPromise(() => rm(tempRoot.current, { recursive: true, force: true })),
        ),
      );
    });
  });
});
