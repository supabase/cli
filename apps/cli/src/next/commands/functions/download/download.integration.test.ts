import { describe, expect, it } from "@effect/vitest";
import { FunctionResponse, makeApiClient } from "@supabase/api/effect";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import {
  ProjectNotLinkedError,
  type ProjectLinkStateValue,
} from "../../../config/project-link-state.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import {
  emptyEnv,
  mockOutput,
  mockProjectLinkState,
  mockRuntimeInfo,
} from "../../../../../tests/helpers/mocks.ts";
import type { FunctionsDownloadFlags } from "./download.command.ts";
import {
  ConflictingFunctionDownloadFlagsError,
  InvalidFunctionDownloadResponseError,
  InvalidFunctionSlugError,
  UnsafeFunctionDownloadPathError,
} from "../../../../shared/functions/download.errors.ts";
import { functionsDownload } from "./download.handler.ts";

const PROJECT_REF = "abcdefghijklmnopqrst";
const BRANCH_REF = "branchrefabcdefghij";
type ResponseBody = string | Blob;

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

const BASE_FLAGS: FunctionsDownloadFlags = {
  functionName: Option.some("hello-world"),
  projectRef: Option.none(),
  useApi: false,
  useDocker: false,
  legacyBundle: false,
};

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-functions-download-"));
}

async function writeProjectConfig(cwd: string) {
  await mkdir(join(cwd, "supabase"), { recursive: true });
  await writeFile(join(cwd, "supabase", "config.toml"), "");
}

function textResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: ResponseBody = "",
  contentType = "text/plain",
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(body, {
      status,
      headers: {
        "content-type": contentType,
      },
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

function transportFailure(
  request: HttpClientRequest.HttpClientRequest,
  error: Error,
): HttpClientError.HttpClientError {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      cause: error,
      description: error.message,
    }),
  });
}

function multipartBody(parts: Array<{ headers: Record<string, string>; body: string }>) {
  const boundary = "supabase-test-boundary";
  const body = [
    ...parts.map((part) => {
      const headers = Object.entries(part.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n");
      return `--${boundary}\r\n${headers}\r\n\r\n${part.body}\r\n`;
    }),
    `--${boundary}--\r\n`,
  ].join("");

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function binaryMultipartBody(parts: Array<{ headers: Record<string, string>; body: Uint8Array }>) {
  const boundary = "supabase-binary-boundary";
  const encoder = new TextEncoder();
  const chunks = parts.flatMap((part) => {
    const headers = Object.entries(part.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n");
    return [
      encoder.encode(`--${boundary}\r\n${headers}\r\n\r\n`),
      part.body,
      encoder.encode("\r\n"),
    ];
  });
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  return {
    body: new Blob(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
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

function mockDownloadApi(opts: {
  list?: ReadonlyArray<typeof FunctionResponse.Type>;
  listStatus?: number;
  listBody?: unknown;
  listError?: Error;
  functionBySlug?: Readonly<Record<string, typeof FunctionResponse.Type>>;
  functionStatusBySlug?: Readonly<Record<string, number>>;
  functionBodyBySlug?: Readonly<Record<string, unknown>>;
  bodyBySlug?: Readonly<
    Record<string, { status?: number; body: ResponseBody; contentType: string }>
  >;
  bodyErrorBySlug?: Readonly<Record<string, Error>>;
}) {
  const requests: string[] = [];
  const acceptHeaders: Array<string | undefined> = [];

  const layer = Layer.effect(
    PlatformApi,
    makeApiClient({
      baseUrl: "https://api.supabase.com",
      accessToken: "test-token",
      userAgent: "supabase",
      headers: {
        "X-Supabase-Command": "functions download",
        "X-Supabase-Command-Run-ID": "run-123",
      },
    }),
  ).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request.url);
          acceptHeaders.push(request.headers.accept);
          const url = new URL(request.url);
          if (url.pathname === `/v1/projects/${PROJECT_REF}/functions`) {
            if (opts.listError !== undefined) {
              return Effect.fail(transportFailure(request, opts.listError));
            }
            return Effect.succeed(
              jsonResponse(request, opts.listStatus ?? 200, opts.listBody ?? opts.list ?? []),
            );
          }

          const bodyMatch = url.pathname.match(
            new RegExp(`^/v1/projects/${PROJECT_REF}/functions/([^/]+)/body$`),
          );
          if (bodyMatch?.[1] !== undefined) {
            const slug = decodeURIComponent(bodyMatch[1]);
            const responseError = opts.bodyErrorBySlug?.[slug];
            if (responseError !== undefined) {
              return Effect.fail(transportFailure(request, responseError));
            }
            const response = opts.bodyBySlug?.[slug];
            return Effect.succeed(
              textResponse(
                request,
                response?.status ?? 200,
                response?.body ?? "",
                response?.contentType ?? "multipart/form-data; boundary=missing",
              ),
            );
          }

          const functionMatch = url.pathname.match(
            new RegExp(`^/v1/projects/${PROJECT_REF}/functions/([^/]+)$`),
          );
          if (functionMatch?.[1] !== undefined) {
            const slug = decodeURIComponent(functionMatch[1]);
            return Effect.succeed(
              jsonResponse(
                request,
                opts.functionStatusBySlug?.[slug] ?? 200,
                opts.functionBodyBySlug?.[slug] ??
                  opts.functionBySlug?.[slug] ??
                  makeFunction({ slug }),
              ),
            );
          }

          return Effect.succeed(textResponse(request, 404, "not found"));
        }),
      ),
    ),
  );

  return {
    layer,
    get requests() {
      return requests;
    },
    get acceptHeaders() {
      return acceptHeaders;
    },
  };
}

function setup(
  cwd: string,
  opts: Parameters<typeof mockDownloadApi>[0] & {
    format?: "text" | "json" | "stream-json";
    linked?: boolean;
    projectRoot?: string;
  } = {},
) {
  const out = mockOutput({ format: opts.format ?? "text", interactive: false });
  const api = mockDownloadApi(opts);
  const proxy = mockLegacyGoProxy();
  const layer = Layer.mergeAll(
    emptyEnv(),
    out.layer,
    api.layer,
    proxy.layer,
    mockRuntimeInfo({ cwd }),
    mockProjectLinkState(opts.linked === false ? undefined : LINK_STATE),
    mockProjectHome(opts.projectRoot ?? cwd),
  );

  return { out, api, layer, proxy };
}

function mockLegacyGoProxy() {
  const calls: string[][] = [];
  return {
    layer: Layer.succeed(LegacyGoProxy, {
      exec: (args: ReadonlyArray<string>) =>
        Effect.sync(() => {
          calls.push([...args]);
        }),
    }),
    get calls() {
      return calls;
    },
  };
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

describe("functions download", () => {
  it.live("downloads a function from the linked project using multipart metadata", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/utils.ts"',
        },
        body: "export const value = 1;",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { out, api, layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(api.requests).toContain(
        "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/functions/hello-world/body",
      );
      expect(api.acceptHeaders).toContain("multipart/form-data");
      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('hello')");
      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "utils.ts"), "utf8"),
        ),
      ).toBe("export const value = 1;");
      expect(out.stderrText).toContain("Downloading Function: hello-world\n");
      expect(out.stderrText).toContain(
        `Extracting file: ${join(tempDir, "supabase", "functions", "hello-world", "index.ts")}\n`,
      );
      expect(out.stderrText).toContain(
        `Downloaded Function hello-world from project abcdefghijklmnopqrst.\n`,
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("downloads multipart file parts under any field name", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="source"; filename="source/index.ts"',
        },
        body: "console.log('source')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('source')");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "falls back to function metadata when multipart metadata has an empty entrypoint path",
    () => {
      const tempDir = makeTempDir();
      const absoluteEntrypoint = "/tmp/functions-download-empty/source/index.ts";
      const multipart = multipartBody([
        {
          headers: {
            "Content-Disposition": 'form-data; name="metadata"',
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ deno2_entrypoint_path: "" }),
        },
        {
          headers: {
            "Content-Disposition": `form-data; name="file"; filename="${absoluteEntrypoint}"`,
          },
          body: "console.log('empty metadata')",
        },
      ]);

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
        const { layer } = setup(tempDir, {
          functionBySlug: {
            "hello-world": makeFunction({
              slug: "hello-world",
              entrypoint_path: `file://${absoluteEntrypoint}`,
            }),
          },
          bodyBySlug: {
            "hello-world": multipart,
          },
        });

        yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

        expect(
          yield* Effect.tryPromise(() =>
            readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
          ),
        ).toBe("console.log('empty metadata')");
        expect(
          existsSync(join(tempDir, "supabase", "functions", "hello-world", "source", "index.ts")),
        ).toBe(false);
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live("downloads into the linked project root when run from a subdirectory", () => {
    const tempDir = makeTempDir();
    const subdirectory = join(tempDir, "nested", "directory");
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(subdirectory, { recursive: true }));
      const { layer } = setup(subdirectory, {
        projectRoot: tempDir,
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('hello')");
      expect(existsSync(join(subdirectory, "supabase", "functions"))).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("preserves binary file bytes from multipart responses", () => {
    const tempDir = makeTempDir();
    const binary = new Uint8Array([0, 255, 128, 13, 10, 45, 45, 1]);
    const multipart = binaryMultipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: new TextEncoder().encode(
          JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
        ),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/asset.bin"',
        },
        body: binary,
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(
        new Uint8Array(
          yield* Effect.tryPromise(() =>
            readFile(join(tempDir, "supabase", "functions", "hello-world", "asset.bin")),
          ),
        ),
      ).toEqual(binary);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live(
    "falls back to function metadata when multipart metadata omits the entrypoint path",
    () => {
      const tempDir = makeTempDir();
      const absoluteEntrypoint = "/tmp/functions-download-abs/My Project/source/index.ts";
      const absoluteUtil = "/tmp/functions-download-abs/My Project/source/lib/utils.ts";
      const multipart = multipartBody([
        {
          headers: {
            "Content-Disposition": 'form-data; name="metadata"',
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
        {
          headers: {
            "Content-Disposition": `form-data; name="file"; filename="${absoluteEntrypoint}"`,
          },
          body: "console.log('abs')",
        },
        {
          headers: {
            "Content-Disposition": `form-data; name="file"; filename="${absoluteUtil}"`,
          },
          body: "export const util = 2;",
        },
      ]);

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
        const { layer } = setup(tempDir, {
          functionBySlug: {
            "hello-world": makeFunction({
              slug: "hello-world",
              entrypoint_path: `file://${absoluteEntrypoint.replaceAll(" ", "%20")}`,
            }),
          },
          bodyBySlug: {
            "hello-world": multipart,
          },
        });

        yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

        expect(
          yield* Effect.tryPromise(() =>
            readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
          ),
        ).toBe("console.log('abs')");
        expect(
          yield* Effect.tryPromise(() =>
            readFile(
              join(tempDir, "supabase", "functions", "hello-world", "lib", "utils.ts"),
              "utf8",
            ),
          ),
        ).toBe("export const util = 2;");
      }).pipe(
        Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
      );
    },
  );

  it.live("downloads every function when no name is provided", () => {
    const tempDir = makeTempDir();
    const helloBody = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);
    const byeBody = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('bye')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { out, layer } = setup(tempDir, {
        list: [
          makeFunction({ slug: "hello-world", name: "Hello World" }),
          makeFunction({ slug: "goodbye-world", name: "Goodbye World" }),
        ],
        bodyBySlug: {
          "hello-world": helloBody,
          "goodbye-world": byeBody,
        },
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "hello-world", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('hello')");
      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "goodbye-world", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('bye')");
      expect(out.stderrText).toContain("Found 2 function(s) to download\n");
      expect(out.stderrText).toContain(
        "Successfully downloaded all functions from project abcdefghijklmnopqrst\n",
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("downloads remote slugs from download-all without local slug validation", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('remote')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        list: [makeFunction({ slug: "1remote" })],
        bodyBySlug: {
          "1remote": multipart,
        },
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "1remote", "index.ts"), "utf8"),
        ),
      ).toBe("console.log('remote')");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("prints the download-all success line when the project has one function", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { out, layer } = setup(tempDir, {
        list: [makeFunction({ slug: "hello-world" })],
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain(
        "Successfully downloaded all functions from project abcdefghijklmnopqrst\n",
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("uses --use-api without delegating to the Go proxy", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer, proxy } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        useApi: true,
      }).pipe(Effect.provide(layer));

      expect(proxy.calls).toEqual([]);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("delegates --legacy-bundle with the linked project ref to the Go proxy", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer, proxy } = setup(tempDir);

      yield* functionsDownload({
        ...BASE_FLAGS,
        legacyBundle: true,
      }).pipe(Effect.provide(layer));

      expect(proxy.calls).toEqual([
        ["functions", "download", "hello-world", "--project-ref", PROJECT_REF, "--legacy-bundle"],
      ]);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("delegates --use-docker with the linked project ref to the Go proxy", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer, proxy } = setup(tempDir);

      yield* functionsDownload({
        ...BASE_FLAGS,
        useDocker: true,
      }).pipe(Effect.provide(layer));

      expect(proxy.calls).toEqual([
        ["functions", "download", "hello-world", "--project-ref", PROJECT_REF, "--use-docker"],
      ]);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects mutually exclusive compatibility flags", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      const { api, layer, proxy } = setup(tempDir);

      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        useApi: true,
        legacyBundle: true,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(ConflictingFunctionDownloadFlagsError);
      expect(api.requests).toHaveLength(0);
      expect(proxy.calls).toHaveLength(0);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects invalid slugs before calling the API", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { api, layer } = setup(tempDir);

      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.some("hello.world"),
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidFunctionSlugError);
      expect(api.requests).toHaveLength(0);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails when neither a linked project nor --project-ref is available", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, { linked: false });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(ProjectNotLinkedError);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("prints the Go-style empty-state line when no functions exist", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { out, layer } = setup(tempDir, {
        list: [],
      });

      yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer));

      expect(out.stderrText).toBe("No functions found in project  abcdefghijklmnopqrst\n");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails when the response is not multipart", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": {
            body: `{"error":"no multipart"}`,
            contentType: "application/json",
          },
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidFunctionDownloadResponseError);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails when the multipart boundary is absent from the response body", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": {
            body: "not a multipart body",
            contentType: "multipart/form-data; boundary=missing",
          },
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidFunctionDownloadResponseError);
      expect(error.message).toBe(
        "failed to read form: multipart response is missing its opening boundary",
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("fails when a multipart file has malformed content disposition", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(InvalidFunctionDownloadResponseError);
      expect(error.message).toBe("failed to parse content disposition: malformed filename");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("writes structured success data in JSON mode for native downloads", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { out, layer } = setup(tempDir, {
        format: "json",
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Downloaded Edge Function source.",
          data: {
            function_slugs: ["hello-world"],
            project_ref: PROJECT_REF,
          },
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps list transport errors with Go-style wording", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        listError: new Error("network error"),
      });

      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("failed to list functions: network error");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps unexpected list statuses with Go-style wording", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        listStatus: 503,
        listBody: { message: "unavailable" },
      });

      const error = yield* functionsDownload({
        ...BASE_FLAGS,
        functionName: Option.none(),
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('unexpected list functions status 503: {"message":"unavailable"}');
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps body transport errors with Go-style wording", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyErrorBySlug: {
          "hello-world": new Error("network error"),
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("failed to download function: network error");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps unexpected body statuses with Go-style wording", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": {
            status: 503,
            body: "unavailable",
            contentType: "text/plain",
          },
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("Error status 503: unavailable");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("maps metadata fallback transport errors with Go-style wording", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="/tmp/source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
        functionStatusBySlug: {
          "hello-world": 503,
        },
        functionBodyBySlug: {
          "hello-world": { message: "downstream unavailable" },
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(
        'Failed to download Function hello-world on the Supabase project: {"message":"downstream unavailable"}',
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("honors Supabase-Path headers for files shared across functions", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/secret.env"',
          "Supabase-Path": "../secret.env",
        },
        body: "SECRET=1",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
        functionBySlug: {
          "hello-world": makeFunction({
            slug: "hello-world",
            entrypoint_path: "file:///source/index.ts",
          }),
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer));

      expect(
        yield* Effect.tryPromise(() =>
          readFile(join(tempDir, "supabase", "functions", "secret.env"), "utf8"),
        ),
      ).toBe("SECRET=1");
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects Supabase-Path headers that escape the functions directory", () => {
    const tempDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/secret.env"',
          "Supabase-Path": "../../../../../../outside.env",
        },
        body: "SECRET=1",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(UnsafeFunctionDownloadPathError);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects a functions directory symlinked outside the project", () => {
    const tempDir = makeTempDir();
    const outsideDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      yield* Effect.tryPromise(() =>
        symlink(outsideDir, join(tempDir, "supabase", "functions"), "junction"),
      );
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(UnsafeFunctionDownloadPathError);
    }).pipe(
      Effect.ensuring(
        Effect.all([
          Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true })),
          Effect.tryPromise(() => rm(outsideDir, { recursive: true, force: true })),
        ]).pipe(Effect.orDie),
      ),
    );
  });

  it.live("rejects a symlinked supabase directory before creating the functions directory", () => {
    const tempDir = makeTempDir();
    const outsideDir = makeTempDir();
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition": 'form-data; name="file"; filename="source/index.ts"',
        },
        body: "console.log('hello')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => symlink(outsideDir, join(tempDir, "supabase"), "junction"));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(UnsafeFunctionDownloadPathError);
      expect(existsSync(join(outsideDir, "functions"))).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.all([
          Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true })),
          Effect.tryPromise(() => rm(outsideDir, { recursive: true, force: true })),
        ]).pipe(Effect.orDie),
      ),
    );
  });

  it.live("rejects symlinked parent directories before creating descendants", () => {
    const tempDir = makeTempDir();
    const outsideDir = makeTempDir();
    const functionDir = join(tempDir, "supabase", "functions", "hello-world");
    const multipart = multipartBody([
      {
        headers: {
          "Content-Disposition": 'form-data; name="metadata"',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }),
      },
      {
        headers: {
          "Content-Disposition":
            'form-data; name="file"; filename="source/lib/new-directory/file.ts"',
        },
        body: "console.log('outside')",
      },
    ]);

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(functionDir, { recursive: true }));
      yield* Effect.tryPromise(() => symlink(outsideDir, join(functionDir, "lib"), "junction"));
      const { layer } = setup(tempDir, {
        bodyBySlug: {
          "hello-world": multipart,
        },
      });

      const error = yield* functionsDownload(BASE_FLAGS).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(UnsafeFunctionDownloadPathError);
      expect(existsSync(join(outsideDir, "new-directory"))).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.all([
          Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true })),
          Effect.tryPromise(() => rm(outsideDir, { recursive: true, force: true })),
        ]).pipe(Effect.orDie),
      ),
    );
  });

  it.live("emits a JSON failure payload instead of throwing in JSON mode", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => writeProjectConfig(tempDir));
      const { out, layer } = setup(tempDir, {
        format: "json",
        bodyBySlug: {
          "hello-world": {
            body: `{"error":"no multipart"}`,
            contentType: "application/json",
          },
        },
      });

      yield* functionsDownload(BASE_FLAGS).pipe(withJsonErrorHandling, Effect.provide(layer));

      expect(out.messages).toContainEqual(expect.objectContaining({ type: "fail" }));
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
