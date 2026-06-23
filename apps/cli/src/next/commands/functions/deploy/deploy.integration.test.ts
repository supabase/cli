import { describe, expect, it } from "@effect/vitest";
import { makeApiClient, FunctionResponse } from "@supabase/api/effect";
import { BunServices } from "@effect/platform-bun";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { Effect, Layer, Option, Sink, Stdio, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as UrlParams from "effect/unstable/http/UrlParams";
import { ChildProcessSpawner } from "effect/unstable/process";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import type { ProjectLinkStateValue } from "../../../config/project-link-state.service.ts";
import {
  ConflictingFunctionDeployFlagsError,
  InvalidFunctionDeploySlugError,
} from "../../../../shared/functions/deploy.errors.ts";
import {
  mockOutput,
  mockProjectLinkState,
  mockRuntimeInfo,
} from "../../../../../tests/helpers/mocks.ts";
import { functionsDeploy } from "./deploy.handler.ts";
import type { FunctionsDeployFlags } from "./deploy.command.ts";

const PROJECT_REF = "abcdefghijklmnopqrst";
const BRANCH_REF = "branchrefabcdefghij";

const LINK_STATE: ProjectLinkStateValue = {
  project: {
    ref: PROJECT_REF,
    name: "Linked Project",
    organization_id: "org-id",
    organization_slug: "org-slug",
  },
  active_branch: {
    ref: BRANCH_REF,
    name: "main",
    is_default: true,
  },
  fetchedAt: "2026-01-01T00:00:00.000Z",
  versions: {},
};

const BASE_FLAGS: FunctionsDeployFlags = {
  functionNames: [],
  projectRef: Option.none(),
  noVerifyJwt: false,
  useApi: false,
  importMap: Option.none(),
  prune: false,
  yes: false,
  jobs: Option.none(),
  useDocker: false,
  legacyBundle: false,
};

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly urlParams: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

interface RecordedMultipart {
  readonly metadata?: string;
  readonly fileNames: ReadonlyArray<string>;
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-functions-deploy-"));
}

function compressedBundleHash(contents: string): string {
  const compressed = Buffer.concat([
    Buffer.from("EZBR"),
    brotliCompressSync(Buffer.from(contents), {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
      },
    }),
  ]);
  return createHash("sha256").update(compressed).digest("hex");
}

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

function mockProjectHome(projectRoot: string) {
  const projectHomeDir = join(projectRoot, ".supabase");
  return Layer.succeed(
    ProjectHome,
    ProjectHome.of({
      projectRoot,
      supabaseDir: join(projectRoot, "supabase"),
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
  );
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

function jsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
    }),
  );
}

function readMultipart(
  request: HttpClientRequest.HttpClientRequest,
): RecordedMultipart | undefined {
  if (request.body._tag !== "FormData") {
    return undefined;
  }
  const metadata = request.body.formData.get("metadata");
  return {
    metadata: typeof metadata === "string" ? metadata : undefined,
    fileNames: request.body.formData
      .getAll("file")
      .flatMap((part) => (part instanceof File ? [part.name] : [])),
  };
}

function mockDeployApi(
  opts: {
    readonly deployStatuses?: ReadonlyArray<number>;
    readonly bulkStatuses?: ReadonlyArray<number>;
    readonly listFunctions?: ReadonlyArray<unknown>;
  } = {},
) {
  const requests: RecordedRequest[] = [];
  const multiparts: RecordedMultipart[] = [];
  let deployCalls = 0;
  let bulkCalls = 0;

  const layer = Layer.effect(
    PlatformApi,
    makeApiClient({
      baseUrl: "https://api.supabase.com",
      accessToken: "test-token",
      userAgent: "supabase",
      headers: {
        "X-Supabase-Command": "functions deploy",
        "X-Supabase-Command-Run-ID": "run-123",
      },
    }),
  ).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const path = new URL(request.url).pathname;
            const urlParams = UrlParams.toString(request.urlParams);
            requests.push({
              method: request.method,
              path,
              urlParams,
              headers: request.headers,
            });
            const multipart = readMultipart(request);
            if (multipart !== undefined) {
              multiparts.push(multipart);
            }

            if (request.method === "GET" && path === `/v1/projects/${PROJECT_REF}/functions`) {
              return jsonResponse(request, 200, opts.listFunctions ?? []);
            }

            if (
              request.method === "POST" &&
              path === `/v1/projects/${PROJECT_REF}/functions/deploy`
            ) {
              const status = opts.deployStatuses?.[deployCalls] ?? 201;
              deployCalls += 1;
              if (status === 429) {
                return jsonResponse(
                  request,
                  429,
                  { message: "Too Many Requests" },
                  { "Retry-After": "0" },
                );
              }
              const slug = Option.getOrElse(
                UrlParams.getFirst(request.urlParams, "slug"),
                () => "hello-world",
              );
              return jsonResponse(request, 201, {
                ...makeFunction({
                  slug,
                  name: slug,
                  entrypoint_path: `functions/${slug}/index.ts`,
                }),
                import_map_path: null,
              });
            }

            if (request.method === "PUT" && path === `/v1/projects/${PROJECT_REF}/functions`) {
              const status = opts.bulkStatuses?.[bulkCalls] ?? 200;
              bulkCalls += 1;
              if (status === 429) {
                return jsonResponse(
                  request,
                  429,
                  { message: "Too Many Requests" },
                  { "Retry-After": "0" },
                );
              }
              return jsonResponse(request, 200, {
                functions: [],
              });
            }

            if (request.method === "POST" && path === `/v1/projects/${PROJECT_REF}/functions`) {
              const slug = Option.getOrElse(
                UrlParams.getFirst(request.urlParams, "slug"),
                () => "hello-world",
              );
              const verifyJwt = Option.getOrElse(
                UrlParams.getFirst(request.urlParams, "verify_jwt"),
                () => "",
              );
              return jsonResponse(
                request,
                201,
                makeFunction({
                  slug,
                  name: slug,
                  verify_jwt: verifyJwt === "false" ? false : true,
                  entrypoint_path: `functions/${slug}/index.ts`,
                }),
              );
            }

            if (
              request.method === "PATCH" &&
              path === `/v1/projects/${PROJECT_REF}/functions/hello-world`
            ) {
              return jsonResponse(request, 200, makeFunction());
            }

            return jsonResponse(request, 404, { error: "not found" });
          }),
        ),
      ),
    ),
  );

  return {
    layer,
    get requests() {
      return requests;
    },
    get multiparts() {
      return multiparts;
    },
  };
}

function resolveDockerOutputPath(args: ReadonlyArray<string>): string {
  const outputIndex = args.indexOf("--output");
  if (outputIndex < 0 || args[outputIndex + 1] === undefined) {
    throw new Error("missing docker bundle output flag");
  }
  const dockerOutputPath = args[outputIndex + 1]!;
  const bindSpecs = args.flatMap((arg, index) => (args[index - 1] === "-v" ? [arg] : []));

  for (const bind of bindSpecs) {
    const match = /^(.*):(\/.*):(ro|rw)$/.exec(bind);
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    const hostPath = match[1];
    const containerPath = match[2];
    if (dockerOutputPath === containerPath || dockerOutputPath.startsWith(`${containerPath}/`)) {
      const suffix = dockerOutputPath.slice(containerPath.length).replaceAll("/", sep);
      return `${hostPath}${suffix}`;
    }
  }

  throw new Error(`unable to resolve host output path for ${dockerOutputPath}`);
}

async function expectedDockerBind(pathname: string, mode: "ro" | "rw" = "ro") {
  const hostPath = await realpath(pathname);
  return `${hostPath}:${hostPath.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "")}:${mode}`;
}

function mockChildProcessSpawner(
  opts: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly onSpawn?: (record: { command: string; args: ReadonlyArray<string> }) => void;
  } = {},
) {
  const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];

  return {
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const cmd = command._tag === "StandardCommand" ? command.command : "";
          const args = command._tag === "StandardCommand" ? command.args : [];
          const record = { command: cmd, args };
          spawned.push(record);
          opts.onSpawn?.(record);

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1000 + spawned.length),
            stdout:
              opts.stdout === undefined
                ? Stream.empty
                : Stream.make(new TextEncoder().encode(opts.stdout)),
            stderr:
              opts.stderr === undefined
                ? Stream.empty
                : Stream.make(new TextEncoder().encode(opts.stderr)),
            all: Stream.empty,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(opts.exitCode ?? 0)),
            isRunning: Effect.succeed(false),
            stdin: Sink.drain,
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    get spawned() {
      return spawned;
    },
  };
}

function cleanupTempDir(path: string) {
  return Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie);
}

function setup(
  cwd: string,
  opts: {
    readonly rawArgs?: ReadonlyArray<string>;
    readonly linked?: boolean;
    readonly projectRoot?: string;
    readonly format?: "text" | "json" | "stream-json";
    readonly childLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, never, never>;
    readonly api?: Parameters<typeof mockDeployApi>[0];
  } = {},
) {
  const out = mockOutput({ format: opts.format ?? "text", interactive: false });
  const api = mockDeployApi(opts.api);
  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    api.layer,
    cliConfigLayer(),
    mockRuntimeInfo({ cwd }),
    mockProjectHome(opts.projectRoot ?? cwd),
    mockProjectLinkState(opts.linked === false ? undefined : LINK_STATE),
    Stdio.layerTest({
      args: Effect.succeed(opts.rawArgs ?? ["functions", "deploy"]),
    }),
    opts.childLayer ?? mockChildProcessSpawner({ exitCode: 0 }).layer,
  );

  return { out, api, layer };
}

describe("functions deploy", () => {
  it.live("deploys multiple local functions through the API by default", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({ exitCode: 0 });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "bye-world"));

      const { out, api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy"],
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world", "bye-world"],
      }).pipe(Effect.provide(layer));

      expect(child.spawned).toHaveLength(0);
      expect(api.requests).toHaveLength(4);
      expect(api.requests[0]).toMatchObject({
        method: "GET",
        path: `/v1/projects/${PROJECT_REF}/functions`,
      });
      expect(api.requests[1]).toMatchObject({
        method: "POST",
        path: `/v1/projects/${PROJECT_REF}/functions/deploy`,
      });
      expect(api.requests[1]?.urlParams).toContain("slug=hello-world");
      expect(api.requests[1]?.urlParams).toContain("bundleOnly=true");
      expect(api.requests[2]?.urlParams).toContain("slug=bye-world");
      expect(api.requests[2]?.urlParams).toContain("bundleOnly=true");
      expect(api.requests[3]).toMatchObject({
        method: "PUT",
        path: `/v1/projects/${PROJECT_REF}/functions`,
      });
      expect(out.stderrText).toContain("Deploying Function: hello-world\n");
      expect(out.stderrText).toContain("Deploying Function: bye-world\n");
      expect(out.stdoutText).toContain(
        `Deployed Functions on project ${PROJECT_REF}: hello-world, bye-world\n`,
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("reports each discovered function once", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { out, layer } = setup(tempDir);

      yield* functionsDeploy(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain(
        `Deployed Functions on project ${PROJECT_REF}: hello-world\n`,
      );
      expect(out.stdoutText).not.toContain("hello-world, hello-world");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("omits verify_jwt for functions without a config override", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toBeDefined();
      const metadata = JSON.parse(api.multiparts[0]!.metadata!);
      expect(metadata).not.toHaveProperty("verify_jwt");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("preserves remote verify_jwt for existing functions without a config override", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { api, layer } = setup(tempDir, {
        api: { listFunctions: [makeFunction({ slug: "hello-world", verify_jwt: false })] },
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toContain('"verify_jwt":false');
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("sends verify_jwt when explicitly configured", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "test-project"',
            '[functions."hello-world"]',
            "verify_jwt = false",
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toContain('"verify_jwt":false');
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("sends verify_jwt when the no-verify-jwt flag is explicitly disabled", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--no-verify-jwt=false"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toContain('"verify_jwt":true');
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("deploys config-declared custom entrypoints when deploying all functions", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "test-project"',
            '[functions."custom-entry"]',
            'entrypoint = "./functions/custom-entry/handler.ts"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        mkdir(join(tempDir, "supabase", "functions", "custom-entry"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "custom-entry", "handler.ts"),
          'Deno.serve(() => new Response("custom"))\n',
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "custom-entry", "deno.json"),
          '{"imports":{}}\n',
        ),
      );

      const { out, api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy"],
      });

      yield* functionsDeploy(BASE_FLAGS).pipe(Effect.provide(layer));

      const deployRequest = api.requests.find(
        (request) => request.method === "POST" && request.path.endsWith("/functions/deploy"),
      );
      expect(deployRequest?.urlParams).toContain("slug=custom-entry");
      expect(out.stdoutText).toContain(
        `Deployed Functions on project ${PROJECT_REF}: custom-entry\n`,
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("retries API deploy and bulk update rate limits", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "bye-world"));

      const { out, api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy"],
        api: {
          deployStatuses: [429, 201, 201],
          bulkStatuses: [429, 200],
        },
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world", "bye-world"],
      }).pipe(Effect.provide(layer));

      expect(
        api.requests.filter((request) => request.path.endsWith("/functions/deploy")),
      ).toHaveLength(3);
      expect(api.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
      expect(out.stderrText).toContain(
        "Rate limit exceeded while deploying function hello-world. Retrying in 0s.\n",
      );
      expect(out.stderrText).toContain(
        "Rate limit exceeded while bulk updating functions. Retrying in 0s.\n",
      );
      expect(out.stdoutText).toContain(
        `Deployed Functions on project ${PROJECT_REF}: hello-world, bye-world\n`,
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("uploads import maps using the same relative path as metadata", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "test-project"',
            '[functions."hello-world"]',
            'import_map = "./custom_import_map.json"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() =>
        writeFile(join(tempDir, "supabase", "custom_import_map.json"), '{"imports":{}}\n'),
      );

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toContain(
        '"import_map_path":"supabase/custom_import_map.json"',
      );
      expect(api.multiparts[0]?.fileNames).toContain("supabase/custom_import_map.json");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("uploads an explicit import map outside the project root", () => {
    const tempDir = makeTempDir();
    const projectDir = join(tempDir, "project");
    const sharedDir = join(tempDir, "shared");

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(projectDir));
      yield* Effect.promise(() => writeLocalFunction(projectDir, "hello-world"));
      yield* Effect.promise(() => mkdir(sharedDir, { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(join(sharedDir, "import_map.json"), '{"imports":{}}\n'),
      );

      const { api, layer } = setup(projectDir, {
        rawArgs: [
          "functions",
          "deploy",
          "hello-world",
          "--import-map",
          "../shared/import_map.json",
        ],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        importMap: Option.some("../shared/import_map.json"),
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toContain(
        '"import_map_path":"../shared/import_map.json"',
      );
      expect(api.multiparts[0]?.fileNames).toContain("../shared/import_map.json");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live(
    "uploads local targets referenced by an explicit import map outside the project root",
    () => {
      const tempDir = makeTempDir();
      const projectDir = join(tempDir, "project");
      const sharedDir = join(tempDir, "shared");

      return Effect.gen(function* () {
        yield* Effect.promise(() => writeProjectConfig(projectDir));
        yield* Effect.promise(() =>
          writeLocalFunction(
            projectDir,
            "hello-world",
            'import { value } from "lib"\nDeno.serve(() => new Response(value))\n',
          ),
        );
        yield* Effect.promise(() => mkdir(sharedDir, { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(join(sharedDir, "import_map.json"), '{"imports":{"lib":"./lib.ts"}}\n'),
        );
        yield* Effect.promise(() =>
          writeFile(
            join(sharedDir, "lib.ts"),
            'import { helper } from "./helper.ts"\nexport const value = helper\n',
          ),
        );
        yield* Effect.promise(() =>
          writeFile(join(sharedDir, "helper.ts"), 'export const helper = "ok"\n'),
        );

        const { api, layer } = setup(projectDir, {
          rawArgs: [
            "functions",
            "deploy",
            "hello-world",
            "--import-map",
            "../shared/import_map.json",
          ],
        });

        yield* functionsDeploy({
          ...BASE_FLAGS,
          functionNames: ["hello-world"],
          importMap: Option.some("../shared/import_map.json"),
        }).pipe(Effect.provide(layer));

        expect(api.multiparts[0]?.fileNames).toContain("../shared/import_map.json");
        expect(api.multiparts[0]?.fileNames).toContain("../shared/lib.ts");
        expect(api.multiparts[0]?.fileNames).toContain("../shared/helper.ts");
      }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
    },
  );

  it.live("sends an empty import_map_path when a function has no local import map", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() =>
        mkdir(join(tempDir, "supabase", "functions", "hello-world"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "index.ts"),
          "Deno.serve(() => new Response())\n",
        ),
      );

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toContain('"import_map_path":""');
      expect(api.multiparts[0]?.fileNames).not.toContain(
        "supabase/functions/hello-world/deno.json",
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("rediscovers deno.json next to an overridden entrypoint", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "test-project"',
            '[functions."hello-world"]',
            'entrypoint = "./functions/hello-world/src/main.ts"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() =>
        mkdir(join(tempDir, "supabase", "functions", "hello-world", "src")),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "src", "main.ts"),
          "Deno.serve(() => new Response())\n",
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "src", "deno.json"),
          '{"imports":{}}\n',
        ),
      );

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toContain(
        '"entrypoint_path":"supabase/functions/hello-world/src/main.ts"',
      );
      expect(api.multiparts[0]?.metadata).toContain(
        '"import_map_path":"supabase/functions/hello-world/src/deno.json"',
      );
      expect(api.multiparts[0]?.fileNames).toContain(
        "supabase/functions/hello-world/src/deno.json",
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("preserves an explicit root import map with an overridden entrypoint", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "test-project"',
            '[functions."hello-world"]',
            'entrypoint = "./functions/hello-world/src/main.ts"',
            'import_map = "./functions/hello-world/deno.json"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() =>
        mkdir(join(tempDir, "supabase", "functions", "hello-world", "src")),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "src", "main.ts"),
          "Deno.serve(() => new Response())\n",
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "src", "deno.json"),
          '{"imports":{}}\n',
        ),
      );

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toContain(
        '"entrypoint_path":"supabase/functions/hello-world/src/main.ts"',
      );
      expect(api.multiparts[0]?.metadata).toContain(
        '"import_map_path":"supabase/functions/hello-world/deno.json"',
      );
      expect(api.multiparts[0]?.fileNames).toContain("supabase/functions/hello-world/deno.json");
      expect(api.multiparts[0]?.fileNames).not.toContain(
        "supabase/functions/hello-world/src/deno.json",
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("uploads local files referenced through scoped import maps", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() =>
        writeLocalFunction(
          tempDir,
          "hello-world",
          'import { value } from "lib"\nDeno.serve(() => new Response(value))\n',
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "deno.json"),
          '{"scopes":{"./":{"lib":"./lib.ts"}}}\n',
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "lib.ts"),
          'export const value = "ok"\n',
        ),
      );

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.fileNames).toContain("supabase/functions/hello-world/lib.ts");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("fails on malformed import map entries", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "deno.json"),
          '{"imports":{"lib":{"path":"./lib.ts"}}}\n',
        ),
      );

      const { layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      const error = yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("failed to parse import map");
        expect(error.message).toContain("imports.lib");
      }
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("uploads local scope targets referenced only from remote scopes", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() =>
        writeLocalFunction(
          tempDir,
          "hello-world",
          'import "https://deno.land/x/example/mod.ts"\nDeno.serve(() => new Response("ok"))\n',
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "deno.json"),
          '{"scopes":{"https://deno.land/x/example/":{"dep":"./dep.ts"}}}\n',
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "dep.ts"),
          'export const value = "remote-scope"\n',
        ),
      );

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.fileNames).toContain("supabase/functions/hello-world/dep.ts");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("builds upload paths relative to the project root", () => {
    const tempDir = makeTempDir();
    const nestedDir = join(tempDir, "nested");

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() => mkdir(nestedDir));

      const { api, layer } = setup(nestedDir, {
        projectRoot: tempDir,
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toContain(
        '"entrypoint_path":"supabase/functions/hello-world/index.ts"',
      );
      expect(api.multiparts[0]?.fileNames).toContain("supabase/functions/hello-world/index.ts");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("warns with a project-relative path when the entrypoint is missing", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));

      const { out, layer } = setup(tempDir);

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain(
        "WARN: failed to read file: open supabase/functions/hello-world/index.ts: no such file or directory\n",
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("fails when a configured static file is a directory", () => {
    const tempDir = makeTempDir();
    const staticDir = join(tempDir, "supabase", "functions", "hello-world", "assets");

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "test-project"',
            '[functions."hello-world"]',
            'static_files = ["./functions/hello-world/assets"]',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() => mkdir(staticDir));

      const { layer } = setup(tempDir);
      const error = yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("file path is a directory:");
      }
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("does not upload imports outside the project root", () => {
    const tempDir = makeTempDir();
    const outsideDir = makeTempDir();
    const secretPath = join(outsideDir, "access-token.txt");

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "test-project"',
            '[functions."hello-world"]',
            'import_map = "./custom_import_map.json"',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        writeLocalFunction(
          tempDir,
          "hello-world",
          'import { secret } from "creds"\nDeno.serve(() => new Response(secret))\n',
        ),
      );
      yield* Effect.promise(() => writeFile(secretPath, "secret-token"));
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "custom_import_map.json"),
          JSON.stringify({ imports: { creds: secretPath } }),
        ),
      );

      const { out, api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.fileNames).not.toContain(secretPath);
      expect(api.multiparts[0]?.fileNames).not.toContain("access-token.txt");
      expect(out.stderrText).toContain("WARN: Skipping import path outside project root:");
    }).pipe(Effect.ensuring(Effect.all([cleanupTempDir(tempDir), cleanupTempDir(outsideDir)])));
  });

  it.live("falls back to source upload and warns when explicit Docker is not running", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({ exitCode: 1 });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { out, api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world"],
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(child.spawned).toHaveLength(1);
      expect(child.spawned[0]).toEqual({
        command: "docker",
        args: ["info"],
      });
      expect(api.requests).toHaveLength(2);
      expect(api.requests[1]).toMatchObject({
        method: "POST",
        path: `/v1/projects/${PROJECT_REF}/functions/deploy`,
      });
      expect(out.stderrText).toContain("WARNING: Docker is not running\n");
      expect(out.stdoutText).toContain(
        `Deployed Functions on project ${PROJECT_REF}: hello-world\n`,
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("emits a structured success payload in json mode", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({ exitCode: 1 });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { out, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--output-format", "json"],
        format: "json",
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
      }).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual({
        type: "success",
        message: "Deployed Functions.",
        data: {
          project_ref: PROJECT_REF,
          functions: ["hello-world"],
          dashboard_url: `https://supabase.com/dashboard/project/${PROJECT_REF}/functions`,
        },
      });
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).not.toContain("WARNING: Docker is not running\n");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("bundles with Docker when explicitly requested and creates the remote function", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({
      exitCode: 0,
      onSpawn: (record) => {
        if (record.command !== "docker" || record.args[0] !== "run") {
          return;
        }
        const outputPath = resolveDockerOutputPath(record.args);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, "eszip-test-output");
      },
    });

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "test-project"',
            "[edge_runtime]",
            "deno_version = 1",
            '[functions."hello-world"]',
            'import_map = "./custom_import_map.json"',
            "verify_jwt = false",
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() =>
        writeFile(join(tempDir, "supabase", "custom_import_map.json"), '{"imports":{}}\n'),
      );

      const { out, api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--use-docker"],
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(child.spawned).toHaveLength(4);
      expect(child.spawned[0]).toEqual({
        command: "docker",
        args: ["info"],
      });
      expect(child.spawned[1]).toEqual({
        command: "docker",
        args: ["network", "inspect", "supabase_network_test-project"],
      });
      expect(child.spawned[2]).toEqual({
        command: "docker",
        args: [
          "volume",
          "create",
          "--label",
          "com.supabase.cli.project=test-project",
          "--label",
          "com.docker.compose.project=test-project",
          "supabase_edge_runtime_test-project",
        ],
      });
      expect(api.requests[0]).toMatchObject({
        method: "GET",
        path: `/v1/projects/${PROJECT_REF}/functions`,
      });
      expect(api.requests[1]).toMatchObject({
        method: "POST",
        path: `/v1/projects/${PROJECT_REF}/functions`,
      });
      expect(api.requests[1]?.urlParams).toContain("slug=hello-world");
      expect(api.requests[1]?.urlParams).toContain("verify_jwt=false");
      expect(child.spawned.at(-1)?.args).toContain("public.ecr.aws/supabase/edge-runtime:v1.68.4");
      expect(child.spawned.at(-1)?.args).toContain(
        yield* Effect.promise(() =>
          expectedDockerBind(join(tempDir, "supabase", "custom_import_map.json")),
        ),
      );
      expect(out.stderrText).toContain("Bundling Function: hello-world\n");
      expect(out.stderrText).toContain("Deploying Function: hello-world (script size:");
      expect(out.stdoutText).toContain(
        `Deployed Functions on project ${PROJECT_REF}: hello-world\n`,
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("forwards npm auth environment to the Docker bundler", () => {
    const tempDir = makeTempDir();
    const previousRegistry = process.env["NPM_CONFIG_REGISTRY"];
    const previousToken = process.env["NPM_AUTH_TOKEN"];
    const child = mockChildProcessSpawner({
      exitCode: 0,
      onSpawn: (record) => {
        if (record.command !== "docker" || record.args[0] !== "run") {
          return;
        }
        const outputPath = resolveDockerOutputPath(record.args);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, "eszip-test-output");
      },
    });

    const restoreEnv = Effect.sync(() => {
      if (previousRegistry === undefined) {
        delete process.env["NPM_CONFIG_REGISTRY"];
      } else {
        process.env["NPM_CONFIG_REGISTRY"] = previousRegistry;
      }
      if (previousToken === undefined) {
        delete process.env["NPM_AUTH_TOKEN"];
      } else {
        process.env["NPM_AUTH_TOKEN"] = previousToken;
      }
    });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.sync(() => {
        process.env["NPM_CONFIG_REGISTRY"] = "https://npm.pkg.github.com";
        process.env["NPM_AUTH_TOKEN"] = "test-token";
      });

      const { layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--use-docker"],
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        useDocker: true,
      }).pipe(Effect.provide(layer));

      const dockerRun = child.spawned.find(
        (record) => record.command === "docker" && record.args[0] === "run",
      );
      const forwardedEnv = dockerRun?.args.flatMap((arg, index, args) =>
        args[index - 1] === "-e" ? [arg] : [],
      );

      expect(forwardedEnv).toEqual(
        expect.arrayContaining(["NPM_CONFIG_REGISTRY", "NPM_AUTH_TOKEN"]),
      );
      expect(forwardedEnv).not.toContain("NPM_AUTH_TOKEN=test-token");
    }).pipe(Effect.ensuring(Effect.all([cleanupTempDir(tempDir), restoreEnv])));
  });

  it.live("rejects unsupported edge runtime Deno versions for Docker bundling", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          ['project_id = "test-project"', "[edge_runtime]", "deno_version = 3", ""].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--use-docker"],
      });

      const error = yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        useDocker: true,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toBe("Failed reading config: Invalid edge_runtime.deno_version: 3.");
      }
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("routes Docker bundle output to stderr in json mode", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({
      exitCode: 0,
      stdout: "verbose bundle output\n",
      onSpawn: (record) => {
        if (record.command !== "docker" || record.args[0] !== "run") {
          return;
        }
        const outputPath = resolveDockerOutputPath(record.args);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, "eszip-test-output");
      },
    });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { out, layer } = setup(tempDir, {
        format: "json",
        rawArgs: ["functions", "deploy", "hello-world", "--use-docker", "--output-format", "json"],
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toContain("verbose bundle output\n");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live(
    "accepts nullable optional fields when listing remote functions for Docker deploys",
    () => {
      const tempDir = makeTempDir();
      const child = mockChildProcessSpawner({
        exitCode: 0,
        onSpawn: (record) => {
          if (record.command !== "docker" || record.args[0] !== "run") {
            return;
          }
          const outputPath = resolveDockerOutputPath(record.args);
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, "eszip-test-output");
        },
      });

      return Effect.gen(function* () {
        yield* Effect.promise(() => writeProjectConfig(tempDir));
        yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

        const { api, layer } = setup(tempDir, {
          rawArgs: ["functions", "deploy", "hello-world", "--use-docker"],
          childLayer: child.layer,
          api: {
            listFunctions: [
              {
                ...makeFunction(),
                ezbr_sha256: null,
                import_map_path: null,
              },
            ],
          },
        });

        yield* functionsDeploy({
          ...BASE_FLAGS,
          functionNames: ["hello-world"],
          useDocker: true,
        }).pipe(Effect.provide(layer));

        expect(api.requests[0]).toMatchObject({
          method: "GET",
          path: `/v1/projects/${PROJECT_REF}/functions`,
        });
        expect(api.requests[1]).toMatchObject({
          method: "PATCH",
          path: `/v1/projects/${PROJECT_REF}/functions/hello-world`,
        });
        expect(api.requests[1]?.urlParams).not.toContain("name=");
        expect(child.spawned).toHaveLength(4);
      }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
    },
  );

  it.live("skips unchanged Docker deploys when verify_jwt is not configured", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({
      exitCode: 0,
      onSpawn: (record) => {
        if (record.command !== "docker" || record.args[0] !== "run") {
          return;
        }
        const outputPath = resolveDockerOutputPath(record.args);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, "eszip-test-output");
      },
    });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      const expectedHash = compressedBundleHash("eszip-test-output");

      const { api, out, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--use-docker"],
        childLayer: child.layer,
        api: {
          listFunctions: [
            {
              ...makeFunction({
                verify_jwt: false,
                ezbr_sha256: expectedHash,
              }),
            },
          ],
        },
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(api.requests).toHaveLength(1);
      expect(out.stderrText).toContain("No change found in Function: hello-world\n");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("omits undefined import_map_path on bundled function updates", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({
      exitCode: 0,
      onSpawn: (record) => {
        if (record.command !== "docker" || record.args[0] !== "run") {
          return;
        }
        const outputPath = resolveDockerOutputPath(record.args);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, "eszip-test-output");
      },
    });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() =>
        rm(join(tempDir, "supabase", "functions", "hello-world", "deno.json")),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "package.json"),
          '{"dependencies":{"chalk":"^5.0.0"}}\n',
        ),
      );

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--use-docker"],
        childLayer: child.layer,
        api: {
          listFunctions: [
            {
              ...makeFunction(),
              ezbr_sha256: null,
              import_map_path: null,
            },
          ],
        },
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(api.requests[1]).toMatchObject({
        method: "PATCH",
        path: `/v1/projects/${PROJECT_REF}/functions/hello-world`,
      });
      expect(api.requests[1]?.urlParams).not.toContain("import_map_path=");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("passes --verbose to the Docker bundler when --debug is set", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({
      exitCode: 0,
      onSpawn: (record) => {
        if (record.command !== "docker" || record.args[0] !== "run") {
          return;
        }
        const outputPath = resolveDockerOutputPath(record.args);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, "eszip-test-output");
      },
    });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { layer } = setup(tempDir, {
        rawArgs: ["--debug", "functions", "deploy", "hello-world", "--use-docker"],
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(child.spawned.at(-1)?.args).toContain("--verbose");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("uses the pinned edge runtime version from .temp for Docker bundling", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({
      exitCode: 0,
      onSpawn: (record) => {
        if (record.command !== "docker" || record.args[0] !== "run") {
          return;
        }
        const outputPath = resolveDockerOutputPath(record.args);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, "eszip-test-output");
      },
    });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() => mkdir(join(tempDir, "supabase", ".temp"), { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(join(tempDir, "supabase", ".temp", "edge-runtime-version"), "9.9.9\n"),
      );

      const { layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--use-docker"],
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(child.spawned.at(-1)?.args).toContain("public.ecr.aws/supabase/edge-runtime:v9.9.9");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("mounts static files outside the functions directory for Docker bundling", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({
      exitCode: 0,
      onSpawn: (record) => {
        if (record.command !== "docker" || record.args[0] !== "run") {
          return;
        }
        const outputPath = resolveDockerOutputPath(record.args);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, "eszip-test-output");
      },
    });
    const staticFile = join(tempDir, "supabase", "shared", "index.html");

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "test-project"',
            '[functions."hello-world"]',
            'static_files = ["./shared/*.html"]',
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() => mkdir(dirname(staticFile), { recursive: true }));
      yield* Effect.promise(() => writeFile(staticFile, "<h1>hello</h1>\n"));

      const { layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--use-docker"],
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(child.spawned).toHaveLength(4);
      expect(child.spawned.at(-1)?.args).toContain(
        yield* Effect.promise(() => expectedDockerBind(staticFile)),
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("prints the no-op deploy message without a success banner", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({ exitCode: 1 });

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          ['project_id = "test-project"', '[functions."disabled-fn"]', "enabled = false", ""].join(
            "\n",
          ),
        ),
      );

      const { out, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "disabled-fn", "--use-api"],
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["disabled-fn"],
        useApi: true,
      }).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain("All Functions are up to date.\n");
      expect(out.stdoutText).not.toContain("Deployed Functions on project");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("emits a structured success payload for no-op deploys in json mode", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({ exitCode: 1 });

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          ['project_id = "test-project"', '[functions."disabled-fn"]', "enabled = false", ""].join(
            "\n",
          ),
        ),
      );

      const { out, layer } = setup(tempDir, {
        format: "json",
        rawArgs: ["functions", "deploy", "disabled-fn", "--use-api", "--output-format", "json"],
        childLayer: child.layer,
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["disabled-fn"],
        useApi: true,
      }).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual({
        type: "success",
        message: "All Functions are up to date.",
        data: {
          project_ref: PROJECT_REF,
          functions: ["disabled-fn"],
          dashboard_url: `https://supabase.com/dashboard/project/${PROJECT_REF}/functions`,
        },
      });
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("merges matching remote function overrides without dropping base fields", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "base-project"',
            '[functions."hello-world"]',
            'entrypoint = "./functions/hello-world/src/main.ts"',
            "",
            "[remotes.preview]",
            `project_id = "${PROJECT_REF}"`,
            '[remotes.preview.functions."hello-world"]',
            "verify_jwt = false",
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));
      yield* Effect.promise(() =>
        mkdir(join(tempDir, "supabase", "functions", "hello-world", "src"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(tempDir, "supabase", "functions", "hello-world", "src", "main.ts"),
          'Deno.serve(() => new Response("remote"))\n',
        ),
      );

      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--project-ref", PROJECT_REF],
      });

      yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        projectRef: Option.some(PROJECT_REF),
      }).pipe(Effect.provide(layer));

      expect(api.multiparts[0]?.metadata).toContain('"verify_jwt":false');
      expect(api.multiparts[0]?.metadata).toContain(
        '"entrypoint_path":"supabase/functions/hello-world/src/main.ts"',
      );
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("applies matching remote edge runtime overrides for Docker bundling", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        writeProjectConfig(
          tempDir,
          [
            'project_id = "base-project"',
            "[remotes.preview]",
            'project_id = "qrstuvwxyzabcdefghij"',
            "[remotes.preview.edge_runtime]",
            "deno_version = 3",
            "",
          ].join("\n"),
        ),
      );
      yield* Effect.promise(() => writeLocalFunction(tempDir, "hello-world"));

      const { layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello-world", "--project-ref", "qrstuvwxyzabcdefghij"],
      });

      const error = yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello-world"],
        projectRef: Option.some("qrstuvwxyzabcdefghij"),
        useDocker: true,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toBe("Failed reading config: Invalid edge_runtime.deno_version: 3.");
      }
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("fails for invalid slugs before calling the API or Docker", () => {
    const tempDir = makeTempDir();
    const child = mockChildProcessSpawner({ exitCode: 0 });

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      const { api, layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "hello.world"],
        childLayer: child.layer,
      });

      const error = yield* functionsDeploy({
        ...BASE_FLAGS,
        functionNames: ["hello.world"],
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidFunctionDeploySlugError);
      expect(api.requests).toHaveLength(0);
      expect(child.spawned).toHaveLength(0);
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });

  it.live("fails when multiple deploy modes are selected", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.promise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        rawArgs: ["functions", "deploy", "--use-api", "--use-docker"],
      });

      const error = yield* functionsDeploy({
        ...BASE_FLAGS,
        useApi: true,
        useDocker: true,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(ConflictingFunctionDeployFlagsError);
      if (!(error instanceof ConflictingFunctionDeployFlagsError)) {
        throw new Error(`unexpected error: ${String(error)}`);
      }
      expect(error.message).toContain("--use-api");
      expect(error.message).toContain("--use-docker");
    }).pipe(Effect.ensuring(cleanupTempDir(tempDir)));
  });
});
